/**
 * 工单列表：抓取、合并、过滤、渲染（阶段 4）
 */
(function initTickets(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
  const { TICKET_CATEGORY_RULES, TARGET_RG_IDS, TARGET_FILTER_IDS } = C;
  const {
    formatDateTime,
    formatEpochToMMDDHHmm,
    parseCreatedAtEpoch,
    resolveCreatedAtEpoch,
    normalizeTicketCreatedFields,
    ticketEpochMs
  } = TD.time;
  const {
    formatElapsedSinceCreated,
    ticketElapsedLevelClass,
    getSlaSettings,
    getTicketSlaStage,
    runSlaScan,
    updateTicketElapsedDisplays
  } = TD.sla;

  /** @typedef {{ id: string|null, title: string, handler: string, priorityText: string, priorityRank: number, createdAtText: string, createdAtEpoch: number|null, statusText: string, statusRank: number, isActive: boolean, fingerprint: string }} TicketItem */
  /** @type {TicketItem[]} */
  let tickets = [];
  /** @type {Map<string, TicketItem>} */
  let ticketIndex = new Map();
  let ticketLastUpdatedAt = null;
  let ticketRefreshInFlight = false;
  let prioritySortDir = -1;
  let createdSortDir = -1;
  let ticketSortMode = "system";
  let ticketTitleSearch = "";
  let ticketCategoryFilter = "all";
  let ticketOnlyMine = true;
  let ticketHideClosed = true;

  /** API 轮询：自动接单/来单改标题时加快，以便尽早触发 TT 页面同步 */
  const API_TICKET_POLL_IDLE_MS = 30000;
  const API_TICKET_POLL_ACTIVE_MS = 10000;
  /** 仅开「来单改标题」时：检测到来单后延迟刷新 TT（与 API 轮询配合，不必立刻 F5） */
  const TT_DOM_SYNC_DEFER_MS = 3000;
  /** @type {ReturnType<typeof setInterval> | null} */
  let apiTicketPollTimer = null;
  /** @type {Set<string>} */
  let knownApiSyncedTicketIds = new Set();
  let apiSyncedBaselineReady = false;
  let ttReloadRequestedThisRefresh = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let ttDomSyncTimer = null;
  /** @type {TicketItem[]} */
  let pendingDomSyncRows = [];

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHandler: () => "",
    getPendingCount: () => NaN,
    isApiConfigured: async () => false,
    getWebviewReady: () => false,
    getTtWebview: () => null,
    getRunning: () => false,
    getTitleOnNewAutoEnabled: () => false,
    isTicketBatchSelected: () => false,
    setTicketBatchSelected: () => {},
    updateBatchPrioritySelectionCount: () => {},
    getAutoPriorityBoostEnabled: () => false,
    requestAutoPriorityBoostFromRefresh: () => {},
    requestTitleOnNewAfterRefresh: () => {},
    requestHfIssueAfterRefresh: () => {},
    requestBurstOutbreakAfterRefresh: () => {},
    scheduleTitlePatrolFromRefresh: () => {},
    getTitlePatrolLogEnabled: () => false,
    requestTtWebviewReload: () => false,
    isTtWebviewReloadInFlight: () => false,
    requestBatchPageRefresh: () => false
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  function sleep(ms) {
    return deps.sleep(ms);
  }
  function getHandler() {
    return deps.getHandler();
  }

async function isApiPrimaryMode() {
  try {
    return !!(await deps.isApiConfigured?.());
  } catch {
    return false;
  }
}

/** 工单列表 API 的 RG 范围：优先 tt-api.local.json 的 rgIds */
async function getRgIds() {
  try {
    const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
    if (Array.isArray(st?.rgIds) && st.rgIds.length) {
      return st.rgIds.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    }
  } catch {
    // ignore
  }
  return Array.isArray(TARGET_RG_IDS) ? TARGET_RG_IDS.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
}

function buildFetchActiveIdScript() {
  return `
    (() => {
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ' '); }
      function parseTicketNoFromRoot(root) {
        const scope = root || document;
        const items = Array.from(scope.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(scope.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
      }
      const detail =
        document.querySelector('#ticket-detail') ||
        document.querySelector('.ticket-detail-container') ||
        document.querySelector('.detail-with-list-container');
      return detail ? parseTicketNoFromRoot(detail) : '';
    })();
  `;
}

async function fetchActiveIdFromDom() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) return "";
  try {
    const raw = await ttExecuteJavaScript(buildFetchActiveIdScript());
    return normalizeTicketId(raw) || "";
  } catch {
    return "";
  }
}

async function syncActiveHighlightFromDom() {
  const activeId = await fetchActiveIdFromDom();
  if (activeId) syncTicketActiveState(activeId);
}

function applyActiveIdToTickets(activeId) {
  const normActive = normalizeTicketId(activeId);
  if (normActive) {
    for (const t of tickets) {
      t.isActive = normalizeTicketId(t.id) === normActive;
    }
    return;
  }
  let found = false;
  for (const t of tickets) {
    if (t.isActive && !found) found = true;
    else if (t.isActive && found) t.isActive = false;
  }
}

function rebuildTicketIndex() {
  ticketIndex = new Map();
  for (const t of tickets) {
    const id = normalizeTicketId(t.id);
    if (id) ticketIndex.set(`id:${id}`, t);
  }
}

function stopApiTicketPollTimer() {
  if (apiTicketPollTimer) {
    clearInterval(apiTicketPollTimer);
    apiTicketPollTimer = null;
  }
}

function getApiTicketPollIntervalMs() {
  if (deps.getRunning?.() || deps.getTitleOnNewAutoEnabled?.()) return API_TICKET_POLL_ACTIVE_MS;
  return API_TICKET_POLL_IDLE_MS;
}

function startApiTicketPollTimer() {
  stopApiTicketPollTimer();
  const ms = getApiTicketPollIntervalMs();
  apiTicketPollTimer = setInterval(() => {
    void refreshTickets({ apiOnly: true }).catch(() => {});
  }, ms);
}

function restartApiTicketPollTimer() {
  if (!apiTicketPollTimer) return;
  startApiTicketPollTimer();
}

/**
 * TT 工单唯一编号：API 字段 id 与详情 DOM「编号」为同一值（如 337676282）。
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeTicketId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{6,}$/.test(s)) return s;
  const m = s.match(/\d{6,}/);
  return m ? m[0] : null;
}

function makeStableKey(item) {
  const title = (item?.title || "").trim();
  const handler = (item?.handler || "").trim();
  const createdAtText = (item?.createdAtText || "").trim();
  // 列表里的时间（right-wrapper）在同一工单内通常稳定，点击/状态变化也不会变
  return `${title}|${handler}|${createdAtText}`;
}

function buildTicketFingerprint(item) {
  const title = (item?.title || "").trim();
  const handler = (item?.handler || "").trim();
  const priorityText = (item?.priorityText || "").trim();
  const epoch = ticketEpochMs(item) ?? parseCreatedAtEpoch(item?.createdAtText);
  const timePart = epoch != null ? String(epoch) : (item?.createdAtText || "").trim();
  return `${title}|${handler}|${priorityText}|${timePart}`;
}

/** 去重主键：API id === DOM 编号，TT 工单编号全局唯一 */
function ticketDedupeKey(item) {
  const id = normalizeTicketId(item?.id);
  return id ? `id:${id}` : null;
}

function updateTicketMeta(visibleCount) {
  if (D.ticketLoadedCountEl) {
    const n = Number.isFinite(Number(visibleCount)) ? Number(visibleCount) : null;
    D.ticketLoadedCountEl.textContent = String(n == null ? tickets.length : n);
  }
  if (!D.ticketLastUpdatedEl) return;
  D.ticketLastUpdatedEl.textContent = ticketLastUpdatedAt ? formatDateTime(ticketLastUpdatedAt) : "—";
}

function normalizeTicketTitleForMatch(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeMis(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}

function mergeTicketRowFields(into, from) {
  if (!into || !from) return into;
  if (from.isActive) into.isActive = true;
  if (from.statusText) {
    into.statusText = from.statusText;
    into.statusRank = from.statusRank;
  }
  if (from.handler) into.handler = from.handler;
  if (from.priorityText) {
    into.priorityText = from.priorityText;
    into.priorityRank = from.priorityRank;
  }
  if (from.createdAtText) into.createdAtText = from.createdAtText;
  if (from.ownerMis) into.ownerMis = from.ownerMis;
  if (from.assigneeMis) into.assigneeMis = from.assigneeMis;
  if (from.title) into.title = from.title;
  const nid = normalizeTicketId(from.id);
  if (nid) into.id = nid;
  normalizeTicketCreatedFields(into);
  into.fingerprint = buildTicketFingerprint(into);
  return into;
}

/**
 * API ∪ DOM：两边应是同一批工单；仅当编号 id 相同时合并为一条（API 与 DOM 各一条 → 展示一条）。
 */
function unionApiDomTickets(apiRows, domRows) {
  const byId = new Map();

  function ingest(row) {
    if (!row) return;
    const id = normalizeTicketId(row.id);
    if (!id) return;
    normalizeTicketCreatedFields(row);
    row.fingerprint = buildTicketFingerprint(row);
    const prev = byId.get(id);
    if (prev) mergeTicketRowFields(prev, row);
    else byId.set(id, { ...row });
  }

  for (const t of apiRows || []) ingest(t);
  for (const t of domRows || []) ingest(t);
  return Array.from(byId.values());
}

/** 「仅看我的」时 API 行常缺 assignee 字段，补当前 MIS 避免被前端过滤掉 */
function applyMineOwnerFallback(list) {
  if (!ticketOnlyMine || !Array.isArray(list)) return list;
  const me = String(getHandler() || "").trim();
  if (!me) return list;
  for (const t of list) {
    if (!t) continue;
    if (!t.ownerMis) t.ownerMis = me;
    if (!t.assigneeMis) t.assigneeMis = me;
  }
  return list;
}

/** 刷新时保留缓存里仍有编号的工单，避免 TT 对焦单条后 DOM 只抓到 1 条把另一条覆盖掉 */
function preserveTicketsMissingFromMapped(mapped) {
  if (!Array.isArray(mapped)) return [];
  const mappedIds = new Set(mapped.map((t) => normalizeTicketId(t?.id)).filter(Boolean));
  const out = mapped.slice();
  for (const t of tickets) {
    const id = normalizeTicketId(t?.id);
    if (!id || mappedIds.has(id)) continue;
    const st = String(t?.statusText || "").trim();
    if (ticketHideClosed && (st.includes("已关闭") || st.includes("已完成"))) continue;
    out.push(t);
    mappedIds.add(id);
  }
  return out;
}

function syncTicketActiveState(activeId) {
  const normActive = normalizeTicketId(activeId);
  for (const t of tickets) {
    t.isActive = !!normActive && normalizeTicketId(t.id) === normActive;
  }
  renderTicketList();
}

/** 展示前去重：仅按 TT 编号 id */
function dedupeTicketsForDisplay(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const byId = new Map();
  for (const t of list) {
    if (!t) continue;
    const id = normalizeTicketId(t.id);
    if (!id) continue;
    const prev = byId.get(id);
    if (prev) mergeTicketRowFields(prev, t);
    else byId.set(id, t);
  }
  return Array.from(byId.values());
}

function classifyTicketTitle(rawTitle) {
  const title = normalizeTicketTitleForMatch(rawTitle);
  if (!title) return "other";
  for (const rule of TICKET_CATEGORY_RULES) {
    if (rule.keywords.some((kw) => title.includes(String(kw || "").toLowerCase()))) {
      return rule.key;
    }
  }
  return "other";
}

function applyTicketBaseFilters(list) {
  let out = Array.isArray(list) ? list.slice() : [];
  if (ticketHideClosed) {
    out = out.filter((item) => {
      const st = String(item?.statusText || "").trim();
      return !(st.includes("已关闭") || st.includes("已完成"));
    });
  }
  if (ticketOnlyMine) {
    const me = normalizeMis(getHandler());
    if (me) {
      out = out.filter((item) => {
        const owner = normalizeMis(item?.ownerMis || item?.assigneeMis || "");
        if (!owner) return false;
        return owner === me;
      });
    }
  }
  return out;
}

function updateTicketCategoryOptions(list) {
  if (!D.ticketCategorySelect) return;
  const rows = applyTicketBaseFilters(list);
  const counts = { all: rows.length, other: 0 };
  for (const r of TICKET_CATEGORY_RULES) counts[r.key] = 0;

  for (const item of rows) {
    const key = classifyTicketTitle(item?.title || "");
    if (counts[key] == null) counts[key] = 0;
    counts[key] += 1;
  }

  const byKey = {
    all: `全部（${counts.all || 0}）`,
    other: `其他（${counts.other || 0}）`
  };
  for (const r of TICKET_CATEGORY_RULES) {
    byKey[r.key] = `${r.label}（${counts[r.key] || 0}）`;
  }

  for (const op of Array.from(D.ticketCategorySelect.options)) {
    const key = op.value;
    if (byKey[key]) op.textContent = byKey[key];
  }
}

function applyTicketFilters(list) {
  let out = applyTicketBaseFilters(list);
  const kw = String(ticketTitleSearch || "").trim().toLowerCase();
  if (kw) {
    const tokens = kw.split(/\s+/).filter(Boolean);
    out = out.filter((item) => {
      const t = String(item?.title || "").toLowerCase();
      return tokens.every((x) => t.includes(x));
    });
  }
  if (ticketCategoryFilter && ticketCategoryFilter !== "all") {
    out = out.filter((item) => classifyTicketTitle(item?.title || "") === ticketCategoryFilter);
  }
  return out;
}

/** 标题巡检/标题检测：仅当前处理人（MIS）且未处理/处理中/暂停中 */
function getMyTodoTicketsForTitleOps(list) {
  const rows = Array.isArray(list) ? list.slice() : [];
  const me = normalizeMis(getHandler());
  return rows.filter((item) => {
    const st = String(item?.statusText || "").trim();
    const isTodo = st.includes("未处理") || st.includes("处理中") || st.includes("暂停");
    if (!isTodo) return false;
    if (!me) return true;
    const owner = normalizeMis(item?.ownerMis || item?.assigneeMis || "");
    if (!owner) return false;
    return owner === me;
  });
}

/** 来单改标题：仅当前处理人（MIS）且未处理状态 */
function isPendingTicketStatus(statusText) {
  const st = String(statusText || "").trim();
  if (!st) return true;
  const up = st.toUpperCase();
  if (st.includes("未处理") || st.includes("待处理")) return true;
  if (st.includes("暂停") || st.includes("处理中") || st.includes("已关闭") || st.includes("关闭")) return false;
  if (up === "TODO" || up === "PENDING" || up === "OPEN" || up === "NEW") return true;
  return false;
}

function getMyPendingTicketsForTitleOnNew(list) {
  const rows = Array.isArray(list) ? list.slice() : [];
  const me = normalizeMis(getHandler());
  return rows.filter((item) => {
    if (!isPendingTicketStatus(item?.statusText)) return false;
    if (!me) return true;
    const owner = normalizeMis(item?.ownerMis || item?.assigneeMis || "");
    if (!owner) return false;
    return owner === me;
  });
}

function parsePriorityRank(text) {
  const t = (text || "").trim();
  const up = t.toUpperCase();
  const m = t.match(/P\\s*([0-9])/i) || t.match(/优先级\\s*([0-9])/i);
  if (m) return Number(m[1]);
  const ms = up.match(/\\bS\\s*([1-5])\\b/);
  if (ms) return Number(ms[1]) - 1;
  // 你的优先级定义：非常紧急 > 紧急 > 高 > 中 > 低
  if (t.includes("非常紧急")) return 0;
  if (t.includes("紧急")) return 1;
  if (t.includes("高")) return 2;
  if (t.includes("中")) return 3;
  if (t.includes("低")) return 4;
  return 9;
}


function statusRank(text) {
  const t = (text || "").trim();
  if (!t) return 5;
  if (t.includes("未处理") || t.includes("待处理")) return 0;
  if (t.includes("处理中")) return 1;
  if (t.includes("暂停")) return 3;
  if (t.includes("已完成") || t.includes("已关闭")) return 4;
  return 2;
}

function statusBadgeClass(text) {
  const t = (text || "").trim();
  if (!t) return "badge-status-muted";
  if (t.includes("未处理") || t.includes("待处理")) return "badge-status-warning";
  if (t.includes("处理中")) return "badge-status-success";
  if (t.includes("暂停")) return "badge-status-muted";
  return "badge-status";
}

function syncSortButtonText() {
  if (D.prioritySortBtn) {
    D.prioritySortBtn.textContent = prioritySortDir === -1 ? "优先级：高→低" : "优先级：低→高";
  }
  if (D.createdSortBtn) {
    D.createdSortBtn.textContent = createdSortDir === -1 ? "创建时间：新→旧" : "创建时间：旧→新";
  }

  if (D.prioritySortBtn) D.prioritySortBtn.classList.toggle("ticket-sort-btn-active", ticketSortMode === "priority");
  if (D.createdSortBtn) D.createdSortBtn.classList.toggle("ticket-sort-btn-active", ticketSortMode === "created");
}

function sortTickets(list) {
  const getCreated = (x) => (x.createdAtEpoch == null ? -1 : x.createdAtEpoch);
  const getPriority = (x) => (Number.isFinite(x.priorityRank) ? x.priorityRank : 9);

  if (ticketSortMode === "system") {
    // 默认：完全按 TT 系统原始顺序（我们采集/追加的顺序）展示
    return [...list];
  }

  return [...list].sort((a, b) => {
    if (ticketSortMode === "priority") {
      const pdiff = getPriority(a) - getPriority(b);
      if (pdiff !== 0) return pdiff * prioritySortDir;
      // 同优先级时，保持系统顺序（不做叠加时间排序）
      return 0;
    }

    if (ticketSortMode === "created") {
      // TT 系统默认顺序就是“新→旧”，因此：
      // - 新→旧：直接保持系统顺序
      // - 旧→新：将系统顺序倒序即可（不依赖时间解析，稳定生效）
      if (createdSortDir === -1) return 0;
      return -1;
    }

    // 兜底：标题
    return a.title.localeCompare(b.title);
  });
}

/** @param {TicketItem} item */
function getTicketSelectKey(item) {
  const id = normalizeTicketId(item?.id);
  return id ? `id:${id}` : "";
}

function findMergeTarget(item) {
  const id = normalizeTicketId(item?.id);
  if (!id) return null;
  return ticketIndex.get(`id:${id}`) || tickets.find((t) => normalizeTicketId(t.id) === id) || null;
}

function mergeTickets(nextItems, { reset = false } = {}) {
  if (reset) {
    tickets = [];
    ticketIndex = new Map();
  }

  for (const item of nextItems) {
    const normId = normalizeTicketId(item.id);
    if (!normId) continue;

    normalizeTicketCreatedFields(item);
    const idKey = `id:${normId}`;

    const existing = findMergeTarget(item);
    if (!existing) {
      ticketIndex.set(idKey, item);
      tickets.push(item);
      continue;
    }

    existing.isActive = item.isActive;
    existing.statusText = item.statusText || existing.statusText;
    existing.statusRank = item.statusRank;
    existing.handler = item.handler || existing.handler;
    existing.priorityText = item.priorityText || existing.priorityText;
    existing.priorityRank = item.priorityRank;
    existing.createdAtText = item.createdAtText || existing.createdAtText;
    existing.createdAtEpoch = resolveCreatedAtEpoch(item) ?? resolveCreatedAtEpoch(existing) ?? existing.createdAtEpoch;
    normalizeTicketCreatedFields(existing);
    existing.title = item.title || existing.title;
    existing.id = normalizeTicketId(item.id) || normalizeTicketId(existing.id) || existing.id;
    existing.fingerprint = item.fingerprint || existing.fingerprint;
  }
}

function renderTicketList() {
  if (!D.ticketListEl) return;
  D.ticketListEl.innerHTML = "";

  updateTicketCategoryOptions(tickets);
  const filtered = applyTicketFilters(tickets);
  const sorted = sortTickets(filtered);
  if (!sorted.length) {
    const empty = document.createElement("div");
    empty.className = "log-item log-item-muted";
    empty.textContent = "未匹配到工单：请调整关键词或分类。";
    D.ticketListEl.append(empty);
  }
  for (const item of sorted) {
    const row = document.createElement("div");
    row.className = `ticket-item${item.isActive ? " ticket-item-active" : ""}`;
    row.setAttribute("role", "listitem");
    row.dataset.ticketId = normalizeTicketId(item.id) || "";
    row.dataset.fingerprint = item.fingerprint;

    const selectKey = getTicketSelectKey(item);
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "ticket-item-select";
    cb.setAttribute("aria-label", "勾选以加入批量设置优先级");
    cb.checked = !!selectKey && deps.isTicketBatchSelected(selectKey);
    cb.disabled = !selectKey;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (!selectKey) return;
      if (cb.checked) deps.setTicketBatchSelected(selectKey, true);
      else deps.setTicketBatchSelected(selectKey, false);
      deps.updateBatchPrioritySelectionCount();
    });

    const title = document.createElement("div");
    title.className = "ticket-title";
    title.textContent = item.title || "（无标题）";

    const sub = document.createElement("div");
    sub.className = "ticket-sub";
    const handler = document.createElement("span");
    handler.textContent = item.handler ? `发起人：${item.handler}` : "发起人：—";
    const created = document.createElement("span");
    const createdEpoch = resolveCreatedAtEpoch(item);
    const createdShow = createdEpoch ? formatEpochToMMDDHHmm(createdEpoch) : (item.createdAtText || "").trim();
    created.textContent = createdShow ? `创建：${createdShow}` : "创建：—";
    const elapsed = document.createElement("span");
    elapsed.className = "ticket-elapsed";
    if (createdEpoch) {
      elapsed.dataset.createdEpoch = String(createdEpoch);
      elapsed.textContent = `已历时：${formatElapsedSinceCreated(createdEpoch)}`;
      const level = ticketElapsedLevelClass(createdEpoch);
      if (level) elapsed.classList.add(level);
    } else {
      elapsed.textContent = "已历时：—";
    }
    sub.append(handler, created, elapsed);
    const ticketNo = normalizeTicketId(item.id);
    if (ticketNo) {
      const noEl = document.createElement("span");
      noEl.textContent = `编号：${ticketNo}`;
      sub.append(noEl);
    }

    const badges = document.createElement("div");
    badges.className = "ticket-badges";

    const status = document.createElement("span");
    status.className = `badge badge-status ${statusBadgeClass(item.statusText)}`;
    status.textContent = item.statusText || "—";

    const priority = document.createElement("span");
    priority.className = "badge badge-priority";
    priority.textContent = item.priorityText || "优先级：—";

    badges.append(status, priority);

    const slaSettings = getSlaSettings();
    const slaStage = slaSettings.enabled ? getTicketSlaStage(item, slaSettings) : null;
    if (slaStage) {
      const slaBadge = document.createElement("span");
      slaBadge.className = `badge badge-sla badge-sla-${slaStage}`;
      slaBadge.textContent = slaStage === "warn" ? "即将48h" : "已超48h";
      badges.append(slaBadge);
    }

    row.append(cb, title, sub, badges);
    row.addEventListener("click", () => {
      handleTicketClick(item).catch(() => {});
    });

    D.ticketListEl.append(row);
  }

  deps.updateBatchPrioritySelectionCount();
  updateTicketMeta(sorted.length);
  updateTicketElapsedDisplays();
  runSlaScan({ emitAlerts: false });
}

function buildExtractTicketsScript() {
  return `
    (async () => {
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ' '); }
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }

      function parsePriorityFromText(text) {
        const t = norm(text);
        if (t === '非常紧急' || t.includes('非常紧急')) return '非常紧急';
        if (t === '紧急' || t.includes('紧急')) return '紧急';
        if (t === '高' || t.includes('优先级高')) return '高';
        if (t === '中' || t.includes('优先级中')) return '中';
        if (t === '低' || t.includes('优先级低')) return '低';
        const m = t.match(/\\bP\\s*([0-9])\\b/i) || t.match(/优先级\\s*([0-9])/i);
        return m ? ('P' + m[1]) : '';
      }

      function guessInitiator(item) {
        const direct =
          item.querySelector('.user-name')?.textContent ||
          item.querySelector('.list-user-icon .user-wrapper .user-name')?.textContent ||
          item.querySelector('.nav-user')?.getAttribute('display-name') ||
          item.querySelector('.import-info .img-text')?.textContent ||
          item.querySelector('.import-info-header .img-text')?.textContent ||
          item.querySelector('.creator')?.textContent ||
          item.querySelector('.initiator')?.textContent ||
          item.querySelector('.reporter')?.textContent ||
          item.querySelector('.create-user')?.textContent ||
          '';
        const t = norm(direct);
        if (t) return t;

        const whole = norm(item.textContent || '');
        const m = whole.match(/发起人\\s*[:：]\\s*([^\\s|，,]+)/);
        return m ? norm(m[1]) : '';
      }

      function guessTime(item) {
        const direct =
          item.querySelector('.right-wrapper')?.textContent ||
          item.querySelector('.time-wrap')?.textContent ||
          item.querySelector('.ticket-time')?.textContent ||
          item.querySelector('.list-time')?.textContent ||
          item.querySelector('.time')?.textContent ||
          item.querySelector('.create-time')?.textContent ||
          item.querySelector('.update-time')?.textContent ||
          item.querySelector('.date')?.textContent ||
          '';
        const t = norm(direct);
        if (t) return t;

        const whole = norm(item.textContent || '');
        const m = whole.match(/(\\d{4}[-\\/]\\d{1,2}[-\\/]\\d{1,2}\\s+\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)/);
        if (m) return norm(m[1]);
        const m2 = whole.match(/(\\d{1,2}[-\\/]\\d{1,2}\\s+\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)/);
        return m2 ? norm(m2[1]) : '';
      }

      function guessStatus(item) {
        const direct =
          item.querySelector('.ticket-state-text')?.textContent ||
          item.querySelector('.state')?.textContent ||
          '';
        const t = norm(direct);
        if (t) return t;

        const icon = item.querySelector('.ticket-state-icon');
        if (icon?.classList.contains('ticket-state-todo')) return '未处理';
        if (icon?.classList.contains('ticket-state-doing')) return '处理中';
        if (icon?.classList.contains('ticket-state-pending')) return '暂停';
        return '';
      }

      function guessTitle(item) {
        const direct =
          item.querySelector('.ticket-name-text-display')?.textContent ||
          item.querySelector('.tt-hover-field .ticket-name-text-display')?.textContent ||
          item.querySelector('.content.title')?.textContent ||
          item.querySelector('.title')?.textContent ||
          item.querySelector('.content')?.textContent ||
          '';
        return norm(direct);
      }

      /** API id 与详情「编号」同源：<span class="info-label">编号：</span><span class="info-text">337676282</span> */
      function parseTicketNoFromRoot(root) {
        const scope = root || document;
        const items = Array.from(scope.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(scope.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
      }

      function getActiveIdFromDetail() {
        const detail =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        if (!detail) return '';
        return parseTicketNoFromRoot(detail);
      }

      function guessTicketNo(item) {
        const attrKeys = ['data-ticket-id', 'data-id', 'data-ticketid', 'ticket-id', 'ticketid'];
        for (const k of attrKeys) {
          const v = norm(item.getAttribute?.(k) || '');
          const m = v.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const ds = item.dataset || {};
        for (const k of ['ticketId', 'ticketid', 'id']) {
          const v = norm(ds[k] || '');
          const m = v.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const href = norm(
          item.getAttribute?.('href') ||
            item.querySelector?.('a[href]')?.getAttribute?.('href') ||
            ''
        );
        const hm = href.match(/(\\d{6,})/);
        if (hm) return hm[1];
        const fromItem = parseTicketNoFromRoot(item);
        if (fromItem) return fromItem;
        const raw = norm(item.textContent || '');
        const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return mid ? mid[1] : '';
      }

      function buildRow(item, activeId) {
        const title = guessTitle(item);
        const handler = guessInitiator(item);
        const statusText = guessStatus(item);
        const priorityFromSla = norm(item.querySelector('.ticket-sla-text')?.textContent || '');
        const priorityText =
          parsePriorityFromText(priorityFromSla) ||
          parsePriorityFromText(item.textContent || '') ||
          norm(item.querySelector('.priority')?.textContent || '');
        const createdAtText = guessTime(item);
        const id = guessTicketNo(item);
        const isActive = item.classList.contains('handle-ticket-nav-item-active') || item.classList.contains('active');
        const effectiveId = (id || (isActive ? activeId : '')) || '';
        return {
          id: effectiveId,
          title,
          handler,
          priorityText,
          createdAtText,
          statusText,
          isActive: !!isActive
        };
      }

      function rowCollectKey(row, item) {
        if (row.id) return 'id:' + row.id;
        const time = (row.createdAtText || '').trim();
        if (time) return 'sk:' + (row.title || '') + '|' + (row.handler || '') + '|' + time;
        const elKey =
          norm(item.getAttribute?.('id') || '') ||
          norm(item.dataset?.ticketId || item.dataset?.id || '');
        if (elKey) return 'el:' + elKey;
        const sig = norm(item.textContent || '').replace(/\\s+/g, ' ').slice(0, 200);
        return 'sig:' + sig;
      }

      const activeId = getActiveIdFromDetail();
      const collected = new Map();

      function scanVisible() {
        const wrapper = getListWrapper();
        let list = wrapper ? Array.from(wrapper.querySelectorAll('.handle-ticket-nav-item')) : [];
        if (!list.length) {
          list = Array.from(document.querySelectorAll('.handle-ticket-nav-item'));
        }
        for (const item of list) {
          const row = buildRow(item, activeId);
          if (!row.title && !row.id) continue;
          const key = rowCollectKey(row, item);
          const prev = collected.get(key);
          if (!prev) {
            collected.set(key, row);
            continue;
          }
          if (!prev.id && row.id) collected.set(key, row);
          else if (!prev.createdAtText && row.createdAtText) collected.set(key, { ...prev, createdAtText: row.createdAtText });
        }
      }

      const wrapper = getListWrapper();
      if (wrapper) {
        const prevTop = wrapper.scrollTop;
        wrapper.scrollTop = 0;
        await sleep(100);
        scanVisible();
        for (let i = 0; i < 100; i += 1) {
          const before = wrapper.scrollTop;
          const delta = Math.max(240, Math.floor(wrapper.clientHeight * 0.85));
          wrapper.scrollTop = before + delta;
          await sleep(120);
          scanVisible();
          if (wrapper.scrollTop === before) break;
        }
        wrapper.scrollTop = prevTop;
      } else {
        scanVisible();
      }

      return { items: Array.from(collected.values()), activeId };
    })();
  `;
}

async function refreshTickets({ reset = false, apiOnly = false } = {}) {
  const apiPrimary = await isApiPrimaryMode();
  if (apiOnly && !apiPrimary) return;
  if (!apiPrimary && !apiOnly && (!deps.getWebviewReady() || !deps.getTtWebview())) return;
  if (ticketRefreshInFlight) return;

  ticketRefreshInFlight = true;
  ttReloadRequestedThisRefresh = false;
  try {
    function mapToTicketItem(x, activeId = "") {
      const title = (x?.title || "").trim();
      const handler = (x?.handler || "").trim();
      const priorityText = (x?.priorityText || "").trim();
      const createdAtText = (x?.createdAtText || "").trim();
      const statusText = (x?.statusText || "").trim();
      const ownerMis = (x?.ownerMis || "").trim();
      const assigneeMis = (x?.assigneeMis || "").trim();
      const id = normalizeTicketId(x?.id);
      const isActive = (!!id && !!activeId && String(id) === String(activeId)) || !!x?.isActive;
      const pr = parsePriorityRank(priorityText);
      const createdEpoch = parseCreatedAtEpoch(createdAtText);
      const sr = statusRank(statusText);
      const row = {
        id,
        title,
        handler,
        ownerMis,
        assigneeMis,
        priorityText,
        priorityRank: pr,
        createdAtText,
        createdAtEpoch: createdEpoch,
        statusText,
        statusRank: sr,
        isActive,
        fingerprint: ""
      };
      normalizeTicketCreatedFields(row);
      row.fingerprint = buildTicketFingerprint(row);
      return row;
    }

    /** API 结构转内部模型（字段名因接口版本差异做多兜底） */
    function mapApiItem(api) {
      function pickAny(obj, keys) {
        for (const k of keys) {
          const v = obj?.[k];
          if (v != null && String(v).trim() !== "") return v;
        }
        return "";
      }
      function normalizePriorityFromApi(v) {
        let t = "";
        if (v && typeof v === "object") {
          t =
            String(
              v.name || v.label || v.text || v.levelName || v.level || v.slaName || v.priorityName || v.value || ""
            ).trim() || JSON.stringify(v);
        } else {
          t = String(v || "").trim();
        }
        if (!t) return "";
        const up = t.toUpperCase();
        if (up === "S1") return "非常紧急";
        if (up === "S2") return "紧急";
        if (up === "S3") return "高";
        if (up === "S4") return "中";
        if (up === "S5") return "低";
        if (t.includes("非常紧急") || t === "S1" || t === "1" || /^P?1$/i.test(t)) return "非常紧急";
        if (t.includes("紧急") || t === "S2" || t === "2" || /^P?2$/i.test(t)) return "紧急";
        if (t.includes("高") || t === "S3" || t === "3" || /^P?3$/i.test(t)) return "高";
        if (t.includes("中") || t === "S4" || t === "4" || /^P?4$/i.test(t)) return "中";
        if (t.includes("低") || t === "S5" || t === "5" || /^P?5$/i.test(t)) return "低";
        const m = t.match(/\bS([1-5])\b/i) || t.match(/\bP([1-5])\b/i);
        if (m) {
          const n = Number(m[1]);
          if (n === 1) return "非常紧急";
          if (n === 2) return "紧急";
          if (n === 3) return "高";
          if (n === 4) return "中";
          if (n === 5) return "低";
        }
        return t;
      }
      const id =
        normalizeTicketId(
          pickAny(api, ["id", "ticketId", "ticketID", "ticketNo", "serialId", "number", "sn"]) ||
            pickAny(api?.ticket || {}, ["id", "ticketId", "ticketID"])
        ) || "";
      const title = String(api?.name || api?.title || api?.ticketName || "").trim();
      const handler = String(api?.creatorName || api?.creator || api?.reporterName || api?.reporter || "").trim();
      const statusText = String(api?.state || api?.status || api?.ticketState || "").trim();
      const priorityText = normalizePriorityFromApi(
        pickAny(api, ["sla", "slaName", "priorityName", "priority", "slaLevel", "priorityLevel", "severity", "slaType"]) ||
          pickAny(api?.sla || {}, ["name", "label", "levelName", "level", "value"]) ||
          pickAny(api?.priorityInfo || {}, ["name", "label", "levelName", "level", "value"]) ||
          pickAny(api?.ticketSla || {}, ["name", "label", "levelName", "level", "value"])
      );
      const createdRaw = api?.createdAt || api?.createTime || api?.gmtCreate || "";
      let createdAtText = String(createdRaw || "").trim();
      if (createdRaw != null && typeof createdRaw === "number" && Number.isFinite(createdRaw)) {
        const n = createdRaw < 1e12 ? createdRaw * 1000 : createdRaw;
        createdAtText = String(n);
      }
      const ownerMis = String(
        pickAny(api, [
          "assigned",
          "processorMis",
          "dealUserMis",
          "handlerMis",
          "assignee",
          "assigneeMis",
          "currentAssigneeMis",
          "currentProcessorMis",
          "ownerMis"
        ]) ||
          pickAny(api?.processor || {}, ["mis", "username", "userName"]) ||
          pickAny(api?.assigneeInfo || {}, ["mis", "username", "userName"]) ||
          pickAny(api?.assignedDetail || {}, ["mis", "username", "userName"])
      ).trim();
      const assigneeMis = ownerMis;
      return { id, title, handler, statusText, priorityText, createdAtText, ownerMis, assigneeMis, isActive: false };
    }

    let mapped = [];
    let activeId = "";
    let usedApi = false;
    function buildBaseApiParams({ includeAssigneeFilter = true } = {}) {
      const p = {
        cn: 1,
        sn: 100,
        orderField: "createdAt",
        orderKind: "DESC"
      };
      if (ticketOnlyMine && includeAssigneeFilter) {
        // 在接口层直接收敛“只看我的工单”，避免拉回后前端再过滤仍出现同组他人单
        const me = getHandler();
        p.assigned = me;
        p.assignee = me;
        p.assigneeMis = me;
        p.handlerMis = me;
        p.processorMis = me;
        p.dealUserMis = me;
      }
      if (ticketHideClosed) {
        // 「我的待处理」包含暂停中，避免与 TT 右侧计数不一致
        p.state = ["未处理", "处理中", "暂停中"];
      }
      return p;
    }

    async function fetchApiListFromParams(baseApiParams) {
      const rgIds = await getRgIds();
      const apiCalls = [];
      if (rgIds.length) {
        apiCalls.push(
          window.ttDesktopApi?.queryTicketsByApi?.({
            username: getHandler(),
            params: { ...baseApiParams, rgIds }
          })
        );
      }
      // 补充 filter 组：必须带 rgIds，禁止无 RG 的 filter 查询（会混入其他 RG 工单）
      if (Array.isArray(TARGET_FILTER_IDS) && TARGET_FILTER_IDS.length && rgIds.length) {
        for (const fid of TARGET_FILTER_IDS) {
          const fidNum = Number(fid);
          const scopeRgIds = Number.isFinite(fidNum) && rgIds.includes(fidNum) ? [fidNum] : rgIds;
          apiCalls.push(
            window.ttDesktopApi?.queryTicketsByApi?.({
              username: getHandler(),
              params: {
                ...baseApiParams,
                rgIds: scopeRgIds,
                filterId: fid,
                filter: fid,
                filterIds: [fid]
              }
            })
          );
        }
      }
      const results = await Promise.all(apiCalls);
      const merged = new Map();
      for (const r of results) {
        if (!r?.ok || r?.data?.code !== 200) continue;
        const apiItems = Array.isArray(r?.data?.data?.items) ? r.data.data.items : [];
        for (const x of apiItems) {
          const it = mapApiItem(x);
          const nid = normalizeTicketId(it.id);
          if (!nid || merged.has(nid)) continue;
          merged.set(nid, it);
        }
      }
      return { results, apiList: Array.from(merged.values()) };
    }

    // 注意：后端可能把 rgIds 与 filterId 当作「交集」处理；filter 补充查询必须带 rgIds 限定范围。
    const baseApiParams = buildBaseApiParams();
    const { results, apiList } = await fetchApiListFromParams(baseApiParams);

    if (results.some((r) => r?.ok && r?.data?.code === 200)) {
      if (apiList.length > 0 || reset) {
        mapped = apiList.map((x) => mapToTicketItem(x, ""));
        usedApi = true;
      }
    }

    let domExtra = [];

    async function pullDomTicketRows(activeIdHint = "") {
      if (apiOnly || !deps.getWebviewReady() || !deps.getTtWebview()) return { rows: [], activeId: activeIdHint };
      try {
        const payload = await ttExecuteJavaScript(buildExtractTicketsScript());
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const activeId = normalizeTicketId(payload?.activeId) || activeIdHint || "";
        const rows = items.map((x) => {
          const t = mapToTicketItem(x, activeId);
          if (ticketOnlyMine) {
            const me = String(getHandler() || "").trim();
            if (me) {
              if (!t.ownerMis) t.ownerMis = me;
              if (!t.assigneeMis) t.assigneeMis = me;
            }
          }
          return t;
        });
        return { rows, activeId };
      } catch {
        return { rows: [], activeId: activeIdHint };
      }
    }

    if (apiPrimary && usedApi) {
      applyMineOwnerFallback(mapped);

      const pendingHint = deps.getPendingCount?.();
      const needRelaxedAssignee =
        ticketOnlyMine &&
        ((Number.isFinite(pendingHint) && pendingHint > mapped.length) || mapped.length <= 1);
      if (needRelaxedAssignee) {
        const relaxedParams = buildBaseApiParams({ includeAssigneeFilter: false });
        const { apiList: relaxedList } = await fetchApiListFromParams(relaxedParams);
        if (relaxedList.length) {
          let relaxedMapped = relaxedList.map((x) => mapToTicketItem(x, ""));
          const me = normalizeMis(getHandler());
          if (me) {
            relaxedMapped = relaxedMapped.filter((t) => {
              const owner = normalizeMis(t?.ownerMis || t?.assigneeMis || "");
              return !owner || owner === me;
            });
            applyMineOwnerFallback(relaxedMapped);
          }
          const prevLen = mapped.length;
          mapped = unionApiDomTickets(mapped, relaxedMapped);
          if (mapped.length > prevLen) {
            // relaxed assignee merge — no user-facing log
          }
        }
      }

      activeId = "";
      const domPull = await pullDomTicketRows("");
      domExtra = domPull.rows;
      activeId = domPull.activeId;
      if (domExtra.length) {
        const prevLen = mapped.length;
        mapped = unionApiDomTickets(mapped, domExtra);
        if (mapped.length > prevLen && domExtra.length > prevLen) {
          log(`API 与 TT 页面工单数不一致，已用页面数据补齐（${prevLen} → ${mapped.length}）。`, "muted");
        }
      }

      if (!reset) {
        mapped = preserveTicketsMissingFromMapped(mapped);
      }

      tickets = dedupeTicketsForDisplay(mapped);
      if (!activeId) activeId = await fetchActiveIdFromDom();
    } else if (apiPrimary && !usedApi) {
      const failed = results.find((r) => r && r.ok === false && r.message);
      if (failed?.message) log("工单数据获取失败，正在重试…", "warning");
      if (apiOnly) return;
      if (!deps.getWebviewReady() || !deps.getTtWebview()) return;
    }

    if (!apiPrimary || (apiPrimary && !usedApi)) {
      const domPull = await pullDomTicketRows("");
      domExtra = domPull.rows;
      activeId = domPull.activeId;

      if (!usedApi && results) {
        const failed = results.find((r) => r && r.ok === false && r.message);
        if (failed?.message) {
          // fallback to page data — no user-facing log
        }
      }

      const apiMapped = usedApi ? mapped.slice() : [];
      if (!usedApi) {
        mapped = unionApiDomTickets([], domExtra);
      } else {
        mapped = unionApiDomTickets(apiMapped, domExtra);
      }

      applyMineOwnerFallback(mapped);

      const pendingHint = deps.getPendingCount?.();
      const needMore =
        (Number.isFinite(pendingHint) && pendingHint > mapped.length) ||
        domExtra.length > mapped.length;
      if (usedApi && ticketOnlyMine && needMore) {
        const relaxedParams = buildBaseApiParams({ includeAssigneeFilter: false });
        const { apiList: relaxedList } = await fetchApiListFromParams(relaxedParams);
        if (relaxedList.length) {
          let relaxedMapped = relaxedList.map((x) => mapToTicketItem(x, ""));
          const me = normalizeMis(getHandler());
          if (me) {
            relaxedMapped = relaxedMapped.filter((t) => {
              const owner = normalizeMis(t?.ownerMis || t?.assigneeMis || "");
              return !owner || owner === me;
            });
            applyMineOwnerFallback(relaxedMapped);
          }
          const prevLen = mapped.length;
          mapped = unionApiDomTickets(mapped, relaxedMapped);
          mapped = unionApiDomTickets(mapped, domExtra);
          if (mapped.length > prevLen) {
            // relaxed assignee merge — no user-facing log
          }
        }
      }

      if (!reset) {
        mapped = preserveTicketsMissingFromMapped(mapped);
      }

      tickets = dedupeTicketsForDisplay(mapped);
    }

    applyActiveIdToTickets(activeId);
    rebuildTicketIndex();

    ticketLastUpdatedAt = new Date();
    if (tickets.length <= 8) {
      log(`已加载 ${tickets.length} 条工单。`, "muted");
    }
    if (apiPrimary && usedApi) {
      await maybeAutoReloadTtWebviewAfterApiSync(tickets, { reset });
    }

    renderTicketList();
    runSlaScan({ emitAlerts: true });

    // 自动升高优先级：刷新完成后触发一次（running 时采用“串行插队队列”）
    if (deps.getAutoPriorityBoostEnabled()) {
      deps.requestAutoPriorityBoostFromRefresh();
    }
    if (!ttReloadRequestedThisRefresh && !isTtDomSyncPending()) {
      deps.requestTitleOnNewAfterRefresh();
    }
    deps.requestHfIssueAfterRefresh();
    deps.requestBurstOutbreakAfterRefresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`工单列表刷新失败，请稍后重试。`, "warning");
  } finally {
    ticketRefreshInFlight = false;
    if (deps.getTitlePatrolLogEnabled()) {
      deps.scheduleTitlePatrolFromRefresh();
    }
  }
}

function buildCollectDomTicketIdsScript() {
  return `
    (() => {
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ' '); }
      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }
      function parseTicketNoFromRoot(root) {
        const scope = root || document;
        const items = Array.from(scope.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(scope.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
      }
      function guessTicketNo(item) {
        const fromItem = parseTicketNoFromRoot(item);
        if (fromItem) return fromItem;
        const raw = norm(item.textContent || '');
        const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return mid ? mid[1] : '';
      }

      const wrapper = getListWrapper();
      if (!wrapper) return { hasListWrapper: false, ids: [] };

      const ids = [];
      const seen = new Set();
      for (const it of wrapper.querySelectorAll('.handle-ticket-nav-item')) {
        const id = guessTicketNo(it);
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      return { hasListWrapper: true, ids };
    })();
  `;
}

async function collectDomTicketIdsQuick() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    return { hasListWrapper: false, ids: [], idSet: new Set() };
  }
  try {
    const res = await ttExecuteJavaScript(buildCollectDomTicketIdsScript());
    const ids = Array.isArray(res?.ids) ? res.ids.map((x) => String(x)).filter(Boolean) : [];
    return {
      hasListWrapper: !!res?.hasListWrapper,
      ids,
      idSet: new Set(ids)
    };
  } catch {
    return { hasListWrapper: false, ids: [], idSet: new Set() };
  }
}

/** 轻量扫描 TT 右侧 handleListNav 可见行（双通道·DOM 来单发现） */
function buildScanHandleListForTitleWatchScript() {
  return `
    (() => {
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ' '); }

      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }

      function guessTitle(item) {
        const direct =
          item.querySelector('.ticket-name-text-display')?.textContent ||
          item.querySelector('.content.title')?.textContent ||
          item.querySelector('.title')?.textContent ||
          '';
        return norm(direct);
      }

      function guessStatus(item) {
        const direct =
          item.querySelector('.ticket-state-text')?.textContent ||
          item.querySelector('.state')?.textContent ||
          '';
        const t = norm(direct);
        if (t) return t;
        const icon = item.querySelector('.ticket-state-icon');
        if (icon?.classList.contains('ticket-state-todo')) return '未处理';
        if (icon?.classList.contains('ticket-state-doing')) return '处理中';
        if (icon?.classList.contains('ticket-state-pending')) return '暂停中';
        return '';
      }

      function guessTime(item) {
        const direct = item.querySelector('.right-wrapper')?.textContent || '';
        return norm(direct);
      }

      function guessHandler(item) {
        const direct =
          item.querySelector('.user-name')?.textContent ||
          item.querySelector('.list-user-icon .user-wrapper .user-name')?.textContent ||
          item.querySelector('.nav-user')?.getAttribute('display-name') ||
          item.querySelector('.import-info .img-text')?.textContent ||
          item.querySelector('.import-info-header .img-text')?.textContent ||
          '';
        let t = norm(direct);
        if (t) return t;
        const whole = norm(item.textContent || '');
        const m = whole.match(/发起人\\s*[:：]\\s*([^\\s|，,]+)/);
        return m ? norm(m[1]) : '';
      }

      function parseTicketNoFromRoot(root) {
        const scope = root || document;
        const items = Array.from(scope.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(scope.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
      }

      function guessTicketNo(item) {
        const attrKeys = ['data-ticket-id', 'data-id', 'data-ticketid', 'ticket-id', 'ticketid'];
        for (const k of attrKeys) {
          const v = norm(item.getAttribute?.(k) || '');
          const m = v.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const ds = item.dataset || {};
        for (const k of ['ticketId', 'ticketid', 'id']) {
          const v = norm(ds[k] || '');
          const m = v.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const href = norm(
          item.getAttribute?.('href') ||
            item.querySelector?.('a[href]')?.getAttribute?.('href') ||
            ''
        );
        const hm = href.match(/(\\d{6,})/);
        if (hm) return hm[1];
        const fromItem = parseTicketNoFromRoot(item);
        if (fromItem) return fromItem;
        const raw = norm(item.textContent || '');
        const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return mid ? mid[1] : '';
      }

      function getActiveIdFromDetail() {
        const detail =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        if (!detail) return '';
        return parseTicketNoFromRoot(detail);
      }

      const wrapper = getListWrapper();
      if (!wrapper) return { hasListWrapper: false, items: [] };

      const activeId = getActiveIdFromDetail();
      const items = [];
      for (const el of wrapper.querySelectorAll('.handle-ticket-nav-item')) {
        const title = guessTitle(el);
        const handler = guessHandler(el);
        const statusText = guessStatus(el);
        const createdAtText = guessTime(el);
        let id = guessTicketNo(el);
        const isActive = el.classList.contains('handle-ticket-nav-item-active') || el.classList.contains('active');
        if (!id && isActive && activeId) id = activeId;
        if (!title && !id) continue;
        items.push({ id, title, handler, statusText, createdAtText, isActive: !!isActive });
      }
      return { hasListWrapper: true, items };
    })();
  `;
}

function parseOwnerMisFromHandlerText(handlerText) {
  const t = String(handlerText || "").trim();
  if (!t) return "";
  const parts = t.split("/");
  if (parts.length >= 2) {
    return normalizeMis(parts[parts.length - 1]);
  }
  return normalizeMis(t);
}

/** TT 左侧列表展示发起人；匹配行时用 handler 解析 MIS，不用 assigneeMis */
function listPersonMisForTicketMatch(item) {
  return normalizeMis(parseOwnerMisFromHandlerText(item?.handler) || "");
}

function mapDomWatchItemToTicket(row) {
  const ownerMis = parseOwnerMisFromHandlerText(row?.handler);
  const id = normalizeTicketId(row?.id) || "";
  const ticket = {
    id,
    title: String(row?.title || "").trim(),
    handler: String(row?.handler || "").trim(),
    statusText: String(row?.statusText || "").trim(),
    createdAtText: String(row?.createdAtText || "").trim(),
    ownerMis,
    assigneeMis: ownerMis,
    isActive: !!row?.isActive
  };
  ticket.fingerprint = buildTicketFingerprint(ticket);
  return ticket;
}

/** 工单是否已在 TT 左侧 handleListNav 列表中（按编号或标题+处理人匹配） */
async function isTicketItemInHandleList(item) {
  if (!deps.getWebviewReady() || !deps.getTtWebview() || !item) {
    return { found: false, reason: "webview_not_ready" };
  }
  const snap = await scanHandleListForTitleWatch();
  if (!snap.hasListWrapper) return { found: false, reason: "no_list_wrapper" };
  const target = item.fingerprint ? item : mapDomWatchItemToTicket(item);
  const rows = (snap.items || []).map(mapDomWatchItemToTicket);
  for (const row of rows) {
    if (ticketRowDomMatch(target, row)) {
      return { found: true, reason: "in_list", row };
    }
  }
  return { found: false, reason: "not_in_list", listCount: rows.length };
}

function ticketRowDomMatch(a, b) {
  const idA = normalizeTicketId(a?.id);
  const idB = normalizeTicketId(b?.id);
  if (idA && idB && idA === idB) return true;
  const titleA = normalizeTicketTitleForMatch(a?.title);
  const titleB = normalizeTicketTitleForMatch(b?.title);
  if (!titleA || !titleB) return false;
  const titlesMatch =
    titleA === titleB ||
    titleA.includes(titleB) ||
    titleB.includes(titleA);
  if (!titlesMatch) return false;
  const ownerA = listPersonMisForTicketMatch(a);
  const ownerB = listPersonMisForTicketMatch(b);
  if (ownerA && ownerB && ownerA !== ownerB) return false;
  return true;
}

async function scanHandleListForTitleWatch() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    return { hasListWrapper: false, items: [] };
  }
  try {
    const res = await ttExecuteJavaScript(buildScanHandleListForTitleWatchScript());
    const items = Array.isArray(res?.items) ? res.items : [];
    return { hasListWrapper: !!res?.hasListWrapper, items };
  } catch {
    return { hasListWrapper: false, items: [] };
  }
}

/** 页面刚刷新时列表可能尚未渲染，短时轮询避免误判「未同步」 */
async function pollNewTicketsInHandleList(targetRows, maxWaitMs = 6000, intervalMs = 300) {
  const targets = Array.isArray(targetRows) ? targetRows.filter(Boolean) : [];
  if (!targets.length) return false;
  const end = Date.now() + maxWaitMs;
  while (Date.now() < end) {
    if (await areNewTicketsVisibleInHandleList(targets)) return true;
    if (await areNewTicketsReachableInDom(targets)) return true;
    await sleep(intervalMs);
  }
  return false;
}

function titlesLooseMatchForDom(a, b) {
  const titleA = normalizeTicketTitleForMatch(a?.title);
  const titleB = normalizeTicketTitleForMatch(b?.title);
  if (!titleA || !titleB) return false;
  return titleA === titleB || titleA.includes(titleB) || titleB.includes(titleA);
}

/** API 通道：新单是否已出现在 TT handleListNav 列表（有则跳过页面刷新） */
async function areNewTicketsVisibleInHandleList(targetRows) {
  const targets = Array.isArray(targetRows) ? targetRows.filter(Boolean) : [];
  if (!targets.length) return false;

  const snap = await scanHandleListForTitleWatch();
  if (!snap.hasListWrapper || !snap.items.length) return false;

  const domTickets = snap.items.map(mapDomWatchItemToTicket);

  for (const t of targets) {
    const tid = normalizeTicketId(t.id);
    let found = domTickets.some((d) => {
      if (!isPendingTicketStatus(d.statusText)) return false;
      const did = normalizeTicketId(d.id);
      if (tid && did && tid === did) return true;
      return ticketRowDomMatch(t, d);
    });
    if (!found && tid) {
      found = domTickets.some((d) => {
        if (!isPendingTicketStatus(d.statusText)) return false;
        return normalizeTicketId(d.id) === tid;
      });
    }
    if (!found) {
      found = domTickets.some(
        (d) => isPendingTicketStatus(d.statusText) && titlesLooseMatchForDom(t, d)
      );
    }
    if (!found) return false;
  }
  return true;
}

/** 列表扫描未命中时，再按编号/标题逐项确认是否已在 DOM 可操作 */
async function areNewTicketsReachableInDom(targetRows) {
  const targets = Array.isArray(targetRows) ? targetRows.filter(Boolean) : [];
  if (!targets.length) return false;
  for (const t of targets) {
    const inList = await isTicketItemInHandleList(t);
    if (inList?.found) continue;
    const id = normalizeTicketId(t.id);
    if (id) {
      const vis = await isTicketVisibleInDom(id);
      if (vis?.found) continue;
    }
    return false;
  }
  return true;
}

function pendingDomSyncKey(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((t) => normalizeTicketId(t?.id) || makeStableKey(t))
    .filter(Boolean)
    .sort()
    .join(",");
}

function clearPendingDomSyncForTickets(rows) {
  const ids = new Set(
    (Array.isArray(rows) ? rows : []).map((t) => normalizeTicketId(t?.id)).filter(Boolean)
  );
  if (!ids.size || !pendingDomSyncRows.length) return;
  pendingDomSyncRows = pendingDomSyncRows.filter((t) => {
    const id = normalizeTicketId(t?.id);
    return !id || !ids.has(id);
  });
  if (!pendingDomSyncRows.length && ttDomSyncTimer) {
    clearTimeout(ttDomSyncTimer);
    ttDomSyncTimer = null;
  }
}

/** @returns {string[]} 相对上次 API 同步新出现的工单编号（未写入基线，刷新成功后再 commit） */
function noteNewApiTicketIds(mapped, reset) {
  const ids = mapped.map((t) => normalizeTicketId(t.id)).filter(Boolean);
  if (reset || !apiSyncedBaselineReady) {
    knownApiSyncedTicketIds = new Set(ids);
    apiSyncedBaselineReady = true;
    return [];
  }
  return ids.filter((id) => !knownApiSyncedTicketIds.has(id));
}

function commitApiTicketIdBaseline(mapped) {
  const rows = Array.isArray(mapped) ? mapped : [];
  for (const t of rows) {
    const id = normalizeTicketId(t.id);
    if (id) knownApiSyncedTicketIds.add(id);
  }
  apiSyncedBaselineReady = true;
}

/**
 * 检测到来单后排队刷新 TT：开着「开始」走批次 F5；仅改标题则延迟数秒后自动刷新。
 */
function scheduleDeferredTtDomSync(reason, targets) {
  const rows = Array.isArray(targets) ? targets.filter(Boolean) : [];
  if (!rows.length) return;

  const nextKey = pendingDomSyncKey(rows);
  if (nextKey && nextKey === pendingDomSyncKey(pendingDomSyncRows)) {
    return;
  }

  pendingDomSyncRows = rows;

  if (deps.getRunning?.()) {
    void (async () => {
      const visible = await pollNewTicketsInHandleList(rows, 5000);
      if (visible) {
        commitApiTicketIdBaseline(rows);
        clearPendingDomSyncForTickets(rows);
        deps.requestTitleOnNewAfterRefresh?.();
        return;
      }
      log(`发现 ${rows.length} 条新工单，正在刷新页面以同步列表…`, "info");
      const ok = deps.requestBatchPageRefresh?.(reason);
      if (!ok) {
        deps.requestTtWebviewReload?.(reason === "api_new_ticket" ? "api_new_ticket" : reason);
      }
    })();
    return;
  }

  if (ttDomSyncTimer) clearTimeout(ttDomSyncTimer);
  log(
    `发现 ${rows.length} 条新工单，约 ${Math.round(TT_DOM_SYNC_DEFER_MS / 1000)} 秒后自动刷新…`,
    "info"
  );
  ttDomSyncTimer = setTimeout(() => {
    ttDomSyncTimer = null;
    void flushDeferredTtDomSync(reason);
  }, TT_DOM_SYNC_DEFER_MS);
}

async function flushDeferredTtDomSync(reason) {
  if (!pendingDomSyncRows.length || !deps.getTtWebview?.()) return;
  if (deps.isTtWebviewReloadInFlight?.()) {
    ttDomSyncTimer = setTimeout(() => {
      void flushDeferredTtDomSync(reason);
    }, 2000);
    return;
  }

  const targets = pendingDomSyncRows.slice();
  const reloaded = !!deps.requestTtWebviewReload?.(reason);
  if (reloaded) {
    pendingDomSyncRows = [];
    ttReloadRequestedThisRefresh = true;
    commitApiTicketIdBaseline(targets);
  } else {
    log("页面刷新排队中，请稍候…", "muted");
  }
}

/** TT 页面 reload 完成后，提交待同步的新单基线 */
function commitPendingDomSyncAfterPageLoad() {
  if (!pendingDomSyncRows.length) return;
  commitApiTicketIdBaseline(pendingDomSyncRows);
  pendingDomSyncRows = [];
}

function isTtDomSyncPending() {
  return pendingDomSyncRows.length > 0 || !!ttDomSyncTimer;
}

/**
 * API 检测到来单：不立刻 F5，排队等程序自动刷新后再改标题/接单。
 */
async function maybeAutoReloadTtWebviewAfterApiSync(mapped, { reset = false } = {}) {
  if (!deps.getTtWebview?.()) return;
  if (deps.isTtWebviewReloadInFlight?.()) return;

  const rows = Array.isArray(mapped) ? mapped : [];
  const newIds = noteNewApiTicketIds(rows, reset);
  const newRows = rows.filter((t) => {
    const id = normalizeTicketId(t.id);
    return id && newIds.includes(id);
  });
  const newMinePending = getMyPendingTicketsForTitleOnNew(newRows);

  if (newMinePending.length > 0) {
    if (deps.isTtWebviewReloadInFlight?.() || !deps.getWebviewReady?.()) {
      pendingDomSyncRows = newMinePending;
      return;
    }
    let alreadyInList = await pollNewTicketsInHandleList(newMinePending, 6000);
    if (alreadyInList) {
      commitApiTicketIdBaseline(newMinePending);
      clearPendingDomSyncForTickets(newMinePending);
      deps.requestTitleOnNewAfterRefresh();
      return;
    }
    scheduleDeferredTtDomSync("api_new_ticket", newMinePending);
    return;
  }

  if (newRows.length > 0) {
    commitApiTicketIdBaseline(newRows);
    return;
  }

  if (!reset) {
    const domSnap = await collectDomTicketIdsQuick();
    if (!domSnap.hasListWrapper) {
      scheduleDeferredTtDomSync("no_list_wrapper", getMyPendingTicketsForTitleOnNew(rows));
      return;
    }
    const pendingHint = deps.getPendingCount?.();
    const minePending = getMyPendingTicketsForTitleOnNew(rows);
    if (
      Number.isFinite(pendingHint) &&
      pendingHint > 0 &&
      domSnap.ids.length === 0 &&
      minePending.length > 0
    ) {
      scheduleDeferredTtDomSync("dom_lag", minePending);
      return;
    }
  }

  commitApiTicketIdBaseline(rows);
}

function buildTicketExistsInDomScript(ticketId) {
  const safeId = ticketId ? JSON.stringify(String(ticketId)) : "null";
  return `
    (() => {
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ' '); }
      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }
      function parseTicketNoFromRoot(root) {
        const scope = root || document;
        const items = Array.from(scope.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(scope.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
      }
      function guessTicketNo(item) {
        const fromItem = parseTicketNoFromRoot(item);
        if (fromItem) return fromItem;
        const raw = norm(item.textContent || '');
        const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return mid ? mid[1] : '';
      }

      const targetId = ${safeId};
      const wrapper = getListWrapper();
      if (!wrapper) return { found: false, reason: 'no_list_wrapper' };

      const detail =
        document.querySelector('#ticket-detail') ||
        document.querySelector('.ticket-detail-container') ||
        document.querySelector('.detail-with-list-container');
      const activeId = detail ? parseTicketNoFromRoot(detail) : '';
      if (targetId && activeId && String(activeId) === String(targetId)) {
        return { found: true, reason: 'in_detail', activeId };
      }

      const items = Array.from(wrapper.querySelectorAll('.handle-ticket-nav-item'));
      for (const it of items) {
        const id = guessTicketNo(it);
        if (targetId && id && String(id) === String(targetId)) {
          return { found: true, reason: 'in_list', activeId };
        }
      }
      return { found: false, reason: 'not_in_list', listCount: items.length };
    })();
  `;
}

function buildNudgeTtDomListSyncScript(defaultHandleUrl) {
  const safeUrl = JSON.stringify(defaultHandleUrl || C.TT_WEBVIEW_DEFAULT_SRC);
  return `
    (async () => {
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }
      const href = String(location.href || '');
      const onHandle = /\\/ticket\\/handle/i.test(href);
      if (!onHandle) {
        location.href = ${safeUrl};
        return { ok: true, action: 'navigate_handle' };
      }
      if (getListWrapper()) return { ok: true, action: 'list_ready' };

      const tabCandidates = Array.from(
        document.querySelectorAll('.filter-title, .filter-title-ishandle, .mtd-tabs-item, [role="tab"]')
      );
      for (const t of tabCandidates) {
        const txt = (t.textContent || '').trim();
        if (!txt) continue;
        if (txt.includes('待处理') || txt.includes('未处理') || txt.includes('处理中')) {
          t.click();
          await sleep(500);
          break;
        }
      }
      return { ok: true, action: 'tab_click', hasList: !!getListWrapper() };
    })();
  `;
}

async function isTicketVisibleInDom(ticketId) {
  if (!deps.getWebviewReady() || !deps.getTtWebview() || !ticketId) {
    return { found: false, reason: "webview_not_ready" };
  }
  try {
    const res = await ttExecuteJavaScript(buildTicketExistsInDomScript(ticketId));
    return res && typeof res === "object" ? res : { found: false, reason: "bad_response" };
  } catch {
    return { found: false, reason: "script_error" };
  }
}

/**
 * 等待工单出现在 TT 页面 DOM（列表或详情）。API 来单早于页面渲染时使用。
 * @param {string} ticketId
 * @param {{ maxWaitMs?: number, intervalMs?: number, tryNudge?: boolean }} [opts]
 */
async function waitForTicketInDom(ticketId, opts = {}) {
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : 60000;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 500;
  const tryNudge = opts.tryNudge !== false;
  const normId = normalizeTicketId(ticketId);
  if (!normId) return { found: false, reason: "no_id" };

  const end = Date.now() + maxWaitMs;
  let nudged = false;
  let polls = 0;
  while (Date.now() < end) {
    const res = await isTicketVisibleInDom(normId);
    if (res?.found) return { found: true, reason: res.reason || "found" };

    polls += 1;
    if (tryNudge && !nudged && polls >= 3) {
      nudged = true;
      try {
        await ttExecuteJavaScript(buildNudgeTtDomListSyncScript(C.TT_WEBVIEW_DEFAULT_SRC));
        await sleep(1500);
      } catch {
        // ignore
      }
      continue;
    }

    await sleep(intervalMs);
  }

  const last = await isTicketVisibleInDom(normId);
  if (last?.found) return { found: true, reason: last.reason || "found" };
  return { found: false, reason: last?.reason || "timeout" };
}

async function handleTicketClick(item, options = {}) {
  if (!deps.getTtWebview()) return false;

  const skipRefresh = !!options.skipRefresh;
  const requirePending = !!options.requirePending;

  const clickTicketId = normalizeTicketId(item.id);
  const safeId = clickTicketId ? JSON.stringify(clickTicketId) : "null";
  const safeFp = JSON.stringify(item.fingerprint || "");
  const safeTitle = JSON.stringify(String(item.title || "").trim());
  const safeHandler = JSON.stringify(String(item.handler || "").trim());
  const safeListPersonMis = JSON.stringify(listPersonMisForTicketMatch(item));
  const safeRequirePending = requirePending ? "true" : "false";

  const clickScript = `
    (async () => {
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ' '); }
      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function parseTicketNoFromRoot(root) {
        const scope = root || document;
        const items = Array.from(scope.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(scope.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
      }
      function getActiveIdFromDetail() {
        const detail =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        if (!detail) return '';
        return parseTicketNoFromRoot(detail);
      }
      function guessTicketNo(item) {
        const attrKeys = ['data-ticket-id', 'data-id', 'data-ticketid', 'ticket-id', 'ticketid'];
        for (const k of attrKeys) {
          const v = norm(item.getAttribute?.(k) || '');
          const m = v.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const ds = item.dataset || {};
        for (const k of ['ticketId', 'ticketid', 'id']) {
          const v = norm(ds[k] || '');
          const m = v.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const href = norm(
          item.getAttribute?.('href') ||
            item.querySelector?.('a[href]')?.getAttribute?.('href') ||
            ''
        );
        const hm = href.match(/(\\d{6,})/);
        if (hm) return hm[1];
        const fromItem = parseTicketNoFromRoot(item);
        if (fromItem) return fromItem;
        const raw = norm(item.textContent || '');
        const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return mid ? mid[1] : '';
      }

      async function waitForListWrapper(maxWaitMs = 8000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          const w = getListWrapper();
          if (w) return w;
          await sleep(intervalMs);
        }
        return null;
      }

      const targetId = ${safeId};
      const targetFp = ${safeFp};
      const targetTitle = ${safeTitle};
      const targetHandler = ${safeHandler};
      const targetListPersonMis = ${safeListPersonMis};
      const requirePending = ${safeRequirePending};

      function guessListStatus(item) {
        const direct =
          norm(item.querySelector('.ticket-state-text')?.textContent || '') ||
          norm(item.querySelector('.state')?.textContent || '');
        if (direct) return direct;
        const icon = item.querySelector('.ticket-state-icon');
        if (icon?.classList.contains('ticket-state-todo')) return '未处理';
        if (icon?.classList.contains('ticket-state-doing')) return '处理中';
        if (icon?.classList.contains('ticket-state-pending')) return '暂停中';
        return '';
      }

      /** 与自动接单一致：仅未处理/待处理可点；列表文案优先于图标（TT 偶发 pending 图标 + 处理中文案） */
      function isRowPending(it) {
        const stateText = guessListStatus(it);
        const stateIcon = it.querySelector('.ticket-state-icon');
        if (stateText.includes('暂停')) return false;
        if (stateText.includes('处理中')) return false;
        if (stateText.includes('未处理') || stateText.includes('待处理')) return true;
        if (stateIcon?.classList.contains('ticket-state-todo')) return true;
        if (stateIcon?.classList.contains('ticket-state-doing')) return false;
        if (stateIcon?.classList.contains('ticket-state-pending')) return false;
        return false;
      }

      function isRowActive(it) {
        return (
          it.classList.contains('handle-ticket-nav-item-active') ||
          it.classList.contains('active')
        );
      }

      function getDetailScope() {
        return (
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container')
        );
      }

      function listPersonMisMatch(listHandler) {
        if (!targetListPersonMis) return true;
        const h = norm(listHandler).toLowerCase().replace(/\\s+/g, '');
        if (h.includes(targetListPersonMis)) return true;
        const parts = h.split('/');
        const mis = parts.length >= 2 ? parts[parts.length - 1].replace(/[^a-z0-9._-]/g, '') : '';
        return mis === targetListPersonMis;
      }

      function detailMatchesTarget(it) {
        const detail = getDetailScope();
        if (!detail) return false;
        const detailId = getActiveIdFromDetail();
        if (targetId && detailId && String(detailId) === String(targetId)) return true;
        const rowId = guessTicketNo(it);
        if (rowId && detailId && String(rowId) === String(detailId)) return true;
        return false;
      }

      async function waitRowSelected(it, maxWaitMs = 4000) {
        const end = Date.now() + maxWaitMs;
        while (Date.now() < end) {
          if (isRowActive(it) && detailMatchesTarget(it)) return true;
          if (isRowActive(it) && !getDetailScope()) {
            await sleep(150);
            continue;
          }
          await sleep(150);
        }
        return isRowActive(it) && detailMatchesTarget(it);
      }

      function rowPassesPendingGate(it) {
        return !requirePending || isRowPending(it);
      }

      function guessListHandler(item) {
        const direct =
          item.querySelector('.user-name')?.textContent ||
          item.querySelector('.list-user-icon .user-wrapper .user-name')?.textContent ||
          item.querySelector('.nav-user')?.getAttribute('display-name') ||
          item.querySelector('.import-info .img-text')?.textContent ||
          item.querySelector('.import-info-header .img-text')?.textContent ||
          '';
        let t = norm(direct);
        if (t) return t;
        const whole = norm(item.textContent || '');
        const m = whole.match(/发起人\\s*[:：]\\s*([^\\s|，,]+)/);
        return m ? norm(m[1]) : '';
      }

      /** 列表标题与缓存不一致时仍能匹配（如「站冻库…」、改标题后前缀变长等） */
      function titlesLooseMatch(listTitle, fpTitle) {
        if (!listTitle || !fpTitle) return false;
        return listTitle === fpTitle || listTitle.includes(fpTitle) || fpTitle.includes(listTitle);
      }

      function handlersLooseMatch(listH, fpH) {
        if (!fpH) return true;
        if (!listH) return false;
        return listH === fpH || listH.includes(fpH) || fpH.includes(listH);
      }

      function guessListTitle(item) {
        return (
          norm(item.querySelector('.ticket-name-text-display')?.textContent || '') ||
          norm(item.querySelector('.tt-hover-field .ticket-name-text-display')?.textContent || '') ||
          norm(item.querySelector('.content.title')?.textContent || '') ||
          norm(item.querySelector('.title')?.textContent || '') ||
          norm(item.querySelector('.content')?.textContent || '')
        );
      }

      function tryClickRow(it) {
        it.scrollIntoView({ block: 'center', behavior: 'instant' });
        const titleEl =
          it.querySelector('.content.title') ||
          it.querySelector('.ticket-name-text-display') ||
          it.querySelector('.tt-hover-field .ticket-name-text-display') ||
          it;
        titleEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        titleEl.click();
        if (titleEl !== it) {
          it.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          it.click();
        }
      }

      async function clickMatchedRow(it, reason) {
        if (!isRowActive(it) || !detailMatchesTarget(it)) {
          tryClickRow(it);
          let selected = await waitRowSelected(it, requirePending ? 4500 : 2000);
          if (!selected) {
            tryClickRow(it);
            selected = await waitRowSelected(it, 2000);
          }
          if (!selected) {
            return { ok: false, reason: 'click_no_active', activeId: getActiveIdFromDetail() };
          }
        }
        if (!getDetailScope() || !detailMatchesTarget(it)) {
          return { ok: false, reason: 'detail_mismatch', activeId: getActiveIdFromDetail() };
        }
        return { ok: true, reason, activeId: getActiveIdFromDetail() };
      }

      const activeId = getActiveIdFromDetail();
      if (targetId && activeId && String(activeId) === String(targetId)) {
        const earlyWrapper = getListWrapper();
        if (earlyWrapper) {
          const items = Array.from(earlyWrapper.querySelectorAll('.handle-ticket-nav-item'));
          let activeRow = items.find((it) => {
            const id = guessTicketNo(it);
            return id && String(id) === String(targetId) && isRowActive(it);
          });
          if (!activeRow && targetTitle) {
            activeRow = items.find((it) => {
              if (!isRowActive(it)) return false;
              const title = guessListTitle(it);
              return title && titlesLooseMatch(title, targetTitle);
            });
          }
          if (activeRow && getDetailScope()) {
            return { ok: true, reason: 'already_active', activeId };
          }
        }
      }

      const wrapper = await waitForListWrapper(8000, 300);
      if (!wrapper) return { ok: false, reason: 'no_list_wrapper' };

      function parseFp(fp) {
        if (!fp || typeof fp !== 'string') return { fpTitle: '', fpHandler: '' };
        const parts = fp.split('|');
        return { fpTitle: norm(parts[0] || ''), fpHandler: norm(parts[1] || '') };
      }

      const maxScroll = 80;
      for (let i = 0; i < maxScroll; i += 1) {
        const items = Array.from(wrapper.querySelectorAll('.handle-ticket-nav-item'));

        for (const it of items) {
          if (!rowPassesPendingGate(it)) continue;
          const id = guessTicketNo(it);
          if (targetId && id && String(id) === String(targetId)) {
            return clickMatchedRow(it, 'clicked_by_id');
          }
        }

        if (targetId && targetTitle) {
          for (const it of items) {
            if (!rowPassesPendingGate(it)) continue;
            const title = guessListTitle(it);
            if (title && titlesLooseMatch(title, targetTitle)) {
              return clickMatchedRow(it, 'clicked_by_id_title');
            }
          }
        }

        const { fpTitle, fpHandler } = parseFp(targetFp);
        for (const it of items) {
          if (!rowPassesPendingGate(it)) continue;
          const title = guessListTitle(it);
          const listHandler = guessListHandler(it);
          if (!listPersonMisMatch(listHandler)) continue;

          if (
            targetFp &&
            fpTitle &&
            title &&
            titlesLooseMatch(title, fpTitle) &&
            handlersLooseMatch(listHandler, fpHandler)
          ) {
            return clickMatchedRow(it, 'clicked_by_fp');
          }
        }

        if (targetTitle) {
          for (const it of items) {
            if (!rowPassesPendingGate(it)) continue;
            const title = guessListTitle(it);
            const listHandler = guessListHandler(it);
            if (!listPersonMisMatch(listHandler)) continue;
            if (
              title &&
              titlesLooseMatch(title, targetTitle) &&
              handlersLooseMatch(listHandler, targetHandler)
            ) {
              return clickMatchedRow(it, 'clicked_by_title');
            }
          }
        }

        const before = wrapper.scrollTop;
        wrapper.scrollTop = before + Math.max(240, Math.floor(wrapper.clientHeight * 0.85));
        await sleep(120);
        if (wrapper.scrollTop === before) break;
      }

      return { ok: false, reason: 'not_found' };
    })();
  `;

  const res = await ttExecuteJavaScript(clickScript);
  if (!res?.ok) {
    log("无法打开该工单，请稍后重试。", "warning");
    if (!skipRefresh) {
      if (await isApiPrimaryMode()) await syncActiveHighlightFromDom();
      else await refreshTickets({ reset: false });
    }
    return false;
  }

  const activeId = normalizeTicketId(res.activeId);
  if (!activeId || (clickTicketId && activeId !== clickTicketId)) {
    log("无法打开该工单，请稍后重试。", "warning");
    if (!skipRefresh) {
      if (await isApiPrimaryMode()) await syncActiveHighlightFromDom();
      else await refreshTickets({ reset: false });
    }
    return false;
  }
  syncTicketActiveState(activeId);
  return true;
}

function buildScrollTicketListScript({ direction = "down", factor = 0.85 } = {}) {
  const safeDir = JSON.stringify(direction);
  const safeFactor = Number.isFinite(factor) ? factor : 0.85;
  return `
    (() => {
      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }
      const wrapper = getListWrapper();
      if (!wrapper) return { ok: false, reason: 'no_list_wrapper' };
      const before = wrapper.scrollTop;
      const delta = Math.max(240, Math.floor(wrapper.clientHeight * ${safeFactor}));
      const dir = ${safeDir};
      wrapper.scrollTop = dir === 'up' ? Math.max(0, before - delta) : before + delta;
      return { ok: true, before, after: wrapper.scrollTop, atEnd: wrapper.scrollTop === before };
    })();
  `;
}

async function loadMoreTickets() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) return;
  if (ticketRefreshInFlight) return;
  try {
    const res = await ttExecuteJavaScript(buildScrollTicketListScript({ direction: "down" }));
    if (!res?.ok || res?.atEnd) return;
    await sleep(120);
    if (await isApiPrimaryMode()) await syncActiveHighlightFromDom();
    else await refreshTickets({ reset: false });
  } catch {
    // ignore
  }
}
  function getTickets() {
    return tickets;
  }

  function setTicketTitleSearch(v) {
    ticketTitleSearch = String(v || "");
  }

  function setTicketCategoryFilter(v) {
    ticketCategoryFilter = String(v || "all");
  }

  function setTicketOnlyMine(v) {
    ticketOnlyMine = !!v;
  }

  function setTicketHideClosed(v) {
    ticketHideClosed = !!v;
  }

  function getTicketOnlyMine() {
    return ticketOnlyMine;
  }

  function getTicketHideClosed() {
    return ticketHideClosed;
  }

  function togglePrioritySort() {
    if (ticketSortMode === "priority") {
      prioritySortDir = prioritySortDir === -1 ? 1 : -1;
    } else {
      ticketSortMode = "priority";
      prioritySortDir = -1;
    }
    syncSortButtonText();
  }

  function toggleCreatedSort() {
    if (ticketSortMode === "created") {
      createdSortDir = createdSortDir === -1 ? 1 : -1;
    } else {
      ticketSortMode = "created";
      createdSortDir = -1;
    }
    syncSortButtonText();
  }

  function isRefreshInFlight() {
    return ticketRefreshInFlight;
  }

  TD.tickets = {
    bind,
    getTickets,
    setTicketTitleSearch,
    setTicketCategoryFilter,
    setTicketOnlyMine,
    setTicketHideClosed,
    getTicketOnlyMine,
    getTicketHideClosed,
    togglePrioritySort,
    toggleCreatedSort,
    isRefreshInFlight,
    makeStableKey,
    applyTicketFilters,
    sortTickets,
    getMyTodoTicketsForTitleOps,
    getMyPendingTicketsForTitleOnNew,
    getTicketSelectKey,
    parsePriorityRank,
    classifyTicketTitle,
    mergeTickets,
    renderTicketList,
    refreshTickets,
    handleTicketClick,
    syncActiveHighlightFromDom,
    isApiPrimaryMode,
    waitForTicketInDom,
    isTicketVisibleInDom,
    isTicketItemInHandleList,
    startApiTicketPollTimer,
    stopApiTicketPollTimer,
    restartApiTicketPollTimer,
    commitApiTicketIdBaseline,
    commitPendingDomSyncAfterPageLoad,
    clearPendingDomSyncForTickets,
    isTtDomSyncPending,
    scanHandleListForTitleWatch,
    mapDomWatchItemToTicket,
    loadMoreTickets,
    updateTicketMeta,
    syncSortButtonText
  };
})(window.TTDesktop);
