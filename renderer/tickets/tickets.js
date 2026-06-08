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

  /** API 已配置时的独立拉单间隔（不依赖 TT 页面 F5） */
  const API_TICKET_POLL_MS = 30000;
  /** @type {ReturnType<typeof setInterval> | null} */
  let apiTicketPollTimer = null;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHandler: () => "",
    getPendingCount: () => NaN,
    isApiConfigured: async () => false,
    getWebviewReady: () => false,
    getTtWebview: () => null,
    isTicketBatchSelected: () => false,
    setTicketBatchSelected: () => {},
    updateBatchPrioritySelectionCount: () => {},
    getAutoPriorityBoostEnabled: () => false,
    requestAutoPriorityBoostFromRefresh: () => {},
    requestTitleOnNewAfterRefresh: () => {},
    scheduleTitlePatrolFromRefresh: () => {},
    getTitlePatrolLogEnabled: () => false
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

function startApiTicketPollTimer() {
  stopApiTicketPollTimer();
  apiTicketPollTimer = setInterval(() => {
    void refreshTickets({ apiOnly: true }).catch(() => {});
  }, API_TICKET_POLL_MS);
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

/** 标题巡检/标题检测专用范围：仅当前处理人（MIS）且待处理状态 */
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
        p.assignee = getHandler();
        p.assigneeMis = getHandler();
        p.handlerMis = getHandler();
        p.processorMis = getHandler();
        p.dealUserMis = getHandler();
      }
      if (ticketHideClosed) {
        // 「我的待处理」包含暂停中，避免与 TT 右侧计数不一致
        p.state = ["未处理", "处理中", "暂停中"];
      }
      return p;
    }

    async function fetchApiListFromParams(baseApiParams) {
      const apiCalls = [];
      apiCalls.push(
        window.ttDesktopApi?.queryTicketsByApi?.({
          username: getHandler(),
          params: { ...baseApiParams, rgIds: TARGET_RG_IDS }
        })
      );
      if (Array.isArray(TARGET_FILTER_IDS) && TARGET_FILTER_IDS.length) {
        apiCalls.push(
          window.ttDesktopApi?.queryTicketsByApi?.({
            username: getHandler(),
            params: {
              ...baseApiParams,
              filterId: TARGET_FILTER_IDS[0],
              filter: TARGET_FILTER_IDS[0],
              filterIds: TARGET_FILTER_IDS
            }
          })
        );
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

    // 注意：后端可能把 rgIds 与 filterId 当作“交集”处理，导致 7599 组工单被过滤掉。
    // 因此这里用“并集”：分别查 4个RG 与 filter=7599，再合并去重。
    const baseApiParams = buildBaseApiParams();
    const { results, apiList } = await fetchApiListFromParams(baseApiParams);

    if (results.some((r) => r?.ok && r?.data?.code === 200)) {
      if (apiList.length > 0 || reset) {
        mapped = apiList.map((x) => mapToTicketItem(x, ""));
        usedApi = true;
      }
    }

    let domExtra = [];

    if (apiPrimary && usedApi) {
      applyMineOwnerFallback(mapped);

      const pendingHint = deps.getPendingCount?.();
      if (ticketOnlyMine && Number.isFinite(pendingHint) && pendingHint > mapped.length) {
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
            log(`待处理 ${pendingHint} 条、首轮 API ${prevLen} 条，放宽 assignee 后 ${mapped.length} 条`, "muted");
          }
        }
      }

      tickets = dedupeTicketsForDisplay(mapped);
      activeId = await fetchActiveIdFromDom();
    } else if (apiPrimary && !usedApi) {
      const failed = results.find((r) => r && r.ok === false && r.message);
      if (failed?.message) log(`API 拉单失败：${failed.message}`, "warning");
      if (apiOnly) return;
      if (!deps.getWebviewReady() || !deps.getTtWebview()) return;
      log("API 拉单失败，临时使用 DOM 兜底列表。", "warning");
    }

    if (!apiPrimary || (apiPrimary && !usedApi)) {
      try {
        const payload = await ttExecuteJavaScript(buildExtractTicketsScript());
        const items = Array.isArray(payload?.items) ? payload.items : [];
        activeId = normalizeTicketId(payload?.activeId) || "";
        domExtra = items.map((x) => {
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
      } catch {
        // ignore DOM failure
      }

      if (!usedApi && results) {
        const failed = results.find((r) => r && r.ok === false && r.message);
        if (failed?.message) {
          log(`API 拉单失败，已使用页面抓取兜底：${failed.message}`, "muted");
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
            log(
              `待处理 ${pendingHint} 条、DOM ${domExtra.length} 条、首轮 ${prevLen} 条，放宽 assignee 后 ${mapped.length} 条`,
              "muted"
            );
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
      const brief = tickets
        .map((t) => normalizeTicketId(t.id) || (t.createdAtText || "").slice(0, 11) || "?")
        .join(", ");
      const sourceLabel = apiPrimary && usedApi ? "API" : `API ${usedApi ? mapped.length : 0} + DOM ${domExtra.length}`;
      log(`工单已同步 ${tickets.length} 条（${sourceLabel}）：${brief}`, "muted");
    }
    renderTicketList();
    runSlaScan({ emitAlerts: true });

    // 自动升高优先级：刷新完成后触发一次（running 时采用“串行插队队列”）
    if (deps.getAutoPriorityBoostEnabled()) {
      deps.requestAutoPriorityBoostFromRefresh();
    }
    deps.requestTitleOnNewAfterRefresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`工单列表刷新失败：${message}`, "warning");
  } finally {
    ticketRefreshInFlight = false;
    if (deps.getTitlePatrolLogEnabled()) {
      deps.scheduleTitlePatrolFromRefresh();
    }
  }
}

async function handleTicketClick(item, options = {}) {
  if (!deps.getTtWebview()) return false;

  const skipRefresh = !!options.skipRefresh;

  const clickTicketId = normalizeTicketId(item.id);
  const safeId = clickTicketId ? JSON.stringify(clickTicketId) : "null";
  const safeFp = JSON.stringify(item.fingerprint || "");

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
        const fromItem = parseTicketNoFromRoot(item);
        if (fromItem) return fromItem;
        const raw = norm(item.textContent || '');
        const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return mid ? mid[1] : '';
      }

      const targetId = ${safeId};
      const targetFp = ${safeFp};
      const wrapper = getListWrapper();
      if (!wrapper) return { ok: false, reason: 'no_list_wrapper' };

      function parseFp(fp) {
        if (!fp || typeof fp !== 'string') return { fpTitle: '', fpHandler: '' };
        const parts = fp.split('|');
        return { fpTitle: norm(parts[0] || ''), fpHandler: norm(parts[1] || '') };
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

      function guessInitiatorRow(item) {
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

      const maxScroll = 80;
      for (let i = 0; i < maxScroll; i += 1) {
        const items = Array.from(wrapper.querySelectorAll('.handle-ticket-nav-item'));

        for (const it of items) {
          const id = guessTicketNo(it);
          if (targetId && id && String(id) === String(targetId)) {
            it.scrollIntoView({ block: 'center' });
            it.click();
            await sleep(200);
            return { ok: true, reason: 'clicked_by_id', activeId: getActiveIdFromDetail() };
          }
        }

        const { fpTitle, fpHandler } = parseFp(targetFp);
        for (const it of items) {
          const title =
            norm(it.querySelector('.ticket-name-text-display')?.textContent || '') ||
            norm(it.querySelector('.tt-hover-field .ticket-name-text-display')?.textContent || '') ||
            norm(it.querySelector('.content.title')?.textContent || '') ||
            norm(it.querySelector('.title')?.textContent || '') ||
            norm(it.querySelector('.content')?.textContent || '');
          const listHandler = guessInitiatorRow(it);

          if (
            targetFp &&
            fpTitle &&
            title &&
            titlesLooseMatch(title, fpTitle) &&
            handlersLooseMatch(listHandler, fpHandler)
          ) {
            it.scrollIntoView({ block: 'center' });
            it.click();
            await sleep(200);
            return { ok: true, reason: 'clicked_by_fp', activeId: getActiveIdFromDetail() };
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
    log(`跳转工单失败：${res?.reason || "unknown"}`, "warning");
    if (!skipRefresh) {
      if (await isApiPrimaryMode()) await syncActiveHighlightFromDom();
      else await refreshTickets({ reset: false });
    }
    return false;
  }

  const activeId = normalizeTicketId(res.activeId) || clickTicketId;
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
    getTicketSelectKey,
    parsePriorityRank,
    classifyTicketTitle,
    mergeTickets,
    renderTicketList,
    refreshTickets,
    handleTicketClick,
    syncActiveHighlightFromDom,
    startApiTicketPollTimer,
    stopApiTicketPollTimer,
    loadMoreTickets,
    updateTicketMeta,
    syncSortButtonText
  };
})(window.TTDesktop);
