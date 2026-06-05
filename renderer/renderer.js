const TD = window.TTDesktop;
const C = TD.constants;
const {
  DEFAULT_HANDLER,
  DEFAULT_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  DEFAULT_BATCH_LIMIT,
  NEXT_TICKET_RELOAD_DELAY_MS,
  TITLE_PATROL_LOG_BAD_MAX,
  AUTO_PRIORITY_BOOST_TARGET,
  AUTO_PRIORITY_BOOST_KEYWORDS,
  AUTO_PRIORITY_BOOST_MAX_PER_ROUND,
  AUTO_PRIORITY_BOOST_COOLDOWN_MS,
  STORAGE_KEYS,
  TICKET_CATEGORY_RULES,
  TARGET_RG_IDS,
  TARGET_FILTER_IDS,
  TT_WEBVIEW_PARTITION,
  TT_WEBVIEW_DEFAULT_SRC
} = C;

const {
  ticketCountEl,
  nextTickEl,
  handlerInput,
  intervalInput,
  autoGroupInput,
  autoSendMessageInput,
  titlePatrolLogInput,
  titleOnNewAutoInput,
  startBtn,
  logList,
  ttWebview,
  webviewLoadingHint,
  templatesSaveBtn,
  templatesAddRuleBtn,
  templatesPreviewBtn,
  defaultMessageTextarea,
  defaultMessageEnTextarea,
  templatesRulesList,
  tabLogsBtn,
  tabTicketsBtn,
  tabTemplatesBtn,
  openLogsDirBtn,
  panelLogs,
  panelTickets,
  panelTemplates,
  prioritySortBtn,
  createdSortBtn,
  ticketTitleSearchInput,
  ticketCategorySelect,
  ticketOnlyMineInput,
  ticketHideClosedInput,
  ticketRefreshBtn,
  ticketTitlePatrolBtn,
  ticketPrioritySelect,
  ticketPriorityApplyBtn,
  ticketBatchSelectVisibleBtn,
  ticketBatchClearSelectionBtn,
  ticketBatchSelectedCountEl,
  ticketAutoPriorityBoostToggle,
  ticketAutoPriorityBoostBtn,
  ticketPriorityBatchBtn,
  ticketPriorityBatchStopBtn,
  ticketTitleNormalizeBtn,
  ticketTitleOnNewBtn,
  pmCsvSelectBtn,
  pmPullByRegionBtn,
  pmCsvPathLabel,
  ticketLastUpdatedEl,
  ticketLoadedCountEl,
  ticketListEl,
  ticketSlaSummaryEl,
  ticketSlaHeaderBadgeEl,
  ticketSlaReminderToggle,
  ticketSlaNotifyToggle
} = TD.dom;

const log = TD.log.log;
const {
  formatDateTime,
  formatEpochToMMDDHHmm,
  parseCreatedAtEpoch,
  resolveCreatedAtEpoch,
  normalizeTicketCreatedFields,
  ticketEpochMs,
  isPlausibleTicketEpoch
} = TD.time;
const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
const setWebviewLoadingHint = TD.ttBridge.setWebviewLoadingHint.bind(TD.ttBridge);
const Guard = TD.guard;
const {
  formatElapsedSinceCreated,
  ticketElapsedLevelClass,
  getSlaSettings,
  getTicketSlaStage,
  runSlaScan,
  updateTicketElapsedDisplays,
  ensureTicketElapsedTimer
} = TD.sla;
const {
  getElephantMessage,
  getElephantMessageEn,
  resolveElephantMessageForTitle,
  loadElephantRules,
  loadTemplatesPanel,
  saveTemplatesModal,
  previewTemplateMatchForActiveTicket,
  addRule
} = TD.templates;

/*
 * 工单标题前缀规范化：已实现「标题检测」按钮（runTicketTitleNormalizeBatch），规则如下：
 * - 无发起人架构 → 不改；词典 assets/china_cities.json。
 * - 外显顺序：事业部（品牌）→ 地区（城市）→ 站点名或仓名 → 原标题/问题简述。
 * - 引擎格式：{事业部简称}{城市}{站点/仓/店名}+原标题正文；站/仓/店优先从架构路径解析，其次仓库/门店字段。
 * - 「来单改标题」须先「开始」；仅处理开始后新出现的待处理单（含转单），确认后写入。
 * - 「标题巡检」逻辑独立在 titlePatrolList.js（TTTitlePatrolList.patrolListTitles）；「标题检测」在 titlePrefixEngine.js（TTTitlePrefix）。
 */

// 勿在此处设置 webview src：须先 bindEvents 注册监听，否则快网环境下会错过 dom-ready，导致 webviewReady 一直为 false

let running = false;
let busy = false;
let webviewReady = false;
let runTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let titlePatrolTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let titlePatrolDebounceTimer = null;
let countdownTimer = null;
let nextRunAt = null;
let pendingRunAfterReload = false;
let batchInProgress = false;
let batchHandledCount = 0;
let batchRemaining = 0;
let sessionHandledCount = 0;
let titleNormalizeInProgress = false;
let priorityBatchInProgress = false;
let priorityBatchAbort = false;
/** @type {Set<string>} */
const batchPrioritySelected = new Set();
let autoPriorityBoostEnabled = false;
/** @type {Map<string, number>} */
const autoPriorityBoostCooldown = new Map();
let autoPriorityBoostQueued = false;
/** @type {object | null} */
let chinaCitiesJsonCache = null;
let pmPullInProgress = false;
let titleOnNewAutoEnabled = false;
/** @type {Set<string>} */
let knownTicketKeysForTitle = new Set();
let titleOnNewQueued = false;

/** @typedef {{ id: string|null, title: string, handler: string, priorityText: string, priorityRank: number, createdAtText: string, createdAtEpoch: number|null, statusText: string, statusRank: number, isActive: boolean, fingerprint: string }} TicketItem */
/** @type {TicketItem[]} */
let tickets = [];
/** @type {Map<string, TicketItem>} */
let ticketIndex = new Map();
let ticketLastUpdatedAt = null;
let ticketRefreshInFlight = false;
let prioritySortDir = -1; // -1 高->低, 1 低->高
let createdSortDir = -1; // -1 新->旧, 1 旧->新
let ticketSortMode = "system"; // system | priority | created
let ticketTitleSearch = "";
let ticketCategoryFilter = "all";
let ticketOnlyMine = true;
let ticketHideClosed = true;

function makeStableKey(item) {
  const title = (item?.title || "").trim();
  const handler = (item?.handler || "").trim();
  const createdAtText = (item?.createdAtText || "").trim();
  // 列表里的时间（right-wrapper）在同一工单内通常稳定，点击/状态变化也不会变
  return `${title}|${handler}|${createdAtText}`;
}

function setActiveLeftTab(tab) {
  const isLogs = tab === "logs";
  const isTickets = tab === "tickets";
  const isTemplates = tab === "templates";
  if (tabLogsBtn) tabLogsBtn.classList.toggle("left-tab-active", isLogs);
  if (tabTicketsBtn) tabTicketsBtn.classList.toggle("left-tab-active", isTickets);
  if (tabTemplatesBtn) tabTemplatesBtn.classList.toggle("left-tab-active", isTemplates);
  if (panelLogs) panelLogs.classList.toggle("left-panel-active", isLogs);
  if (panelTickets) panelTickets.classList.toggle("left-panel-active", isTickets);
  if (panelTemplates) panelTemplates.classList.toggle("left-panel-active", isTemplates);
}

function updateTicketMeta(visibleCount) {
  if (ticketLoadedCountEl) {
    const n = Number.isFinite(Number(visibleCount)) ? Number(visibleCount) : null;
    ticketLoadedCountEl.textContent = String(n == null ? tickets.length : n);
  }
  if (!ticketLastUpdatedEl) return;
  ticketLastUpdatedEl.textContent = ticketLastUpdatedAt ? formatDateTime(ticketLastUpdatedAt) : "—";
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

/** 发起人展示里常见「姓名/mis」：优先用字段 MIS，否则从 handler 取斜杠后账号 */
function resolveMisForDedupe(item) {
  const a = normalizeMis(item?.ownerMis || "");
  const b = normalizeMis(item?.assigneeMis || "");
  if (a) return a;
  if (b) return b;
  return normalizeMis(item?.handler || "");
}

/** API 与 DOM 是否为同一工单（标题 + MIS + 创建时间接近） */
function ticketsLikelySame(a, b) {
  if (!a || !b) return false;
  const idA = String(a.id || "").trim();
  const idB = String(b.id || "").trim();
  if (idA && idB && idA === idB) return true;
  const tA = normalizeTicketTitleForMatch(a.title || "");
  const tB = normalizeTicketTitleForMatch(b.title || "");
  if (!tA || tA !== tB) return false;
  const misA = resolveMisForDedupe(a);
  const misB = resolveMisForDedupe(b);
  if (misA && misB && misA !== misB) return false;
  const eA = ticketEpochMs(a);
  const eB = ticketEpochMs(b);
  if (Number.isFinite(eA) && Number.isFinite(eB)) {
    return Math.abs(eA - eB) <= 48 * 3600000;
  }
  return makeStableKey(a) === makeStableKey(b);
}

function mergeApiDomTicketLists(apiMapped, domMapped) {
  const merged = new Map();
  const rows = [];
  for (const t of apiMapped) {
    normalizeTicketCreatedFields(t);
    const k = t.id ? `id:${t.id}` : `fp:${t.fingerprint}`;
    merged.set(k, t);
    rows.push(t);
  }
  for (const t of domMapped) {
    normalizeTicketCreatedFields(t);
    if (t.id && merged.has(`id:${t.id}`)) continue;
    if (rows.some((a) => ticketsLikelySame(a, t))) continue;
    const k = t.id ? `id:${t.id}` : `fp:${t.fingerprint}`;
    if (!merged.has(k)) {
      merged.set(k, t);
      rows.push(t);
    }
  }
  return rows;
}

/**
 * 去掉「无编号 DOM 行」：若存在同标题、时间接近、MIS 可对齐的「有编号」行，则视为 API+DOM 重复。
 * 典型现象：TT 列表里未解析出编号时，会与 API 各保留一条，计数翻倍。
 * @param {TicketItem[]} list
 */
function dedupeNoIdWhenIdTwinExists(list) {
  if (!Array.isArray(list) || list.length < 2) return list;
  const withId = list.filter((t) => t && String(t.id || "").trim());
  const withoutId = list.filter((t) => t && !String(t.id || "").trim());
  if (!withId.length || !withoutId.length) return list;

  const removeSk = new Set();
  for (const w of withoutId) {
    const wTitle = normalizeTicketTitleForMatch(w.title || "");
    if (!wTitle) continue;
    const wMis = resolveMisForDedupe(w);
    const wE = ticketEpochMs(w);
    for (const x of withId) {
      if (normalizeTicketTitleForMatch(x.title || "") !== wTitle) continue;
      const xMis = resolveMisForDedupe(x);
      if (wMis && xMis && wMis !== xMis) continue;
      const xE = ticketEpochMs(x);
      const timeOk =
        !Number.isFinite(wE) || !Number.isFinite(xE) || Math.abs(wE - xE) <= 48 * 3600000;
      if (!timeOk) continue;
      removeSk.add(makeStableKey(w));
      break;
    }
  }
  if (!removeSk.size) return list;
  return list.filter((t) => !(!String(t.id || "").trim() && removeSk.has(makeStableKey(t))));
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
  if (!ticketCategorySelect) return;
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

  for (const op of Array.from(ticketCategorySelect.options)) {
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

function buildLooseTicketKey(item) {
  const title = normalizeTicketTitleForMatch(item?.title || "");
  const mis = resolveMisForDedupe(item);
  const ts = ticketEpochMs(item);
  return `${title}|${mis}|${ts || ""}`;
}

/**
 * API 与 DOM 合并后、写入缓存前：同一工单常出现「一条有 id、一条无 id」或时间字段格式不同导致 fingerprint 不一致。
 * 先按 id 去重，再按宽松键去掉已无 id 的重复项，避免 mergeTickets 因索引键不一致插入两条。
 * @param {TicketItem[]} items
 * @returns {TicketItem[]}
 */
function dedupeMappedTicketsBeforeMerge(items) {
  if (!Array.isArray(items) || !items.length) return [];
  const withId = items.filter((t) => t && t.id);
  const withoutId = items.filter((t) => t && !t.id);
  const idSeen = new Set();
  const looseUsed = new Set();
  const skUsed = new Set();
  const out = [];

  for (const t of withId) {
    const id = String(t.id).trim();
    if (!id || idSeen.has(id)) continue;
    idSeen.add(id);
    const loose = buildLooseTicketKey(t);
    if (loose) looseUsed.add(loose);
    out.push(t);
  }
  for (const t of withoutId) {
    const loose = buildLooseTicketKey(t);
    if (loose && looseUsed.has(loose)) continue;
    const sk = makeStableKey(t);
    if (skUsed.has(sk)) continue;
    skUsed.add(sk);
    if (loose) looseUsed.add(loose);
    out.push(t);
  }
  return out;
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
  if (prioritySortBtn) {
    prioritySortBtn.textContent = prioritySortDir === -1 ? "优先级：高→低" : "优先级：低→高";
  }
  if (createdSortBtn) {
    createdSortBtn.textContent = createdSortDir === -1 ? "创建时间：新→旧" : "创建时间：旧→新";
  }

  if (prioritySortBtn) prioritySortBtn.classList.toggle("ticket-sort-btn-active", ticketSortMode === "priority");
  if (createdSortBtn) createdSortBtn.classList.toggle("ticket-sort-btn-active", ticketSortMode === "created");
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
  if (!item) return "";
  if (item.id) return `id:${item.id}`;
  const fp = item.fingerprint || "";
  return fp ? `fp:${fp}` : "";
}

function updateBatchPrioritySelectionCount() {
  if (ticketBatchSelectedCountEl) {
    ticketBatchSelectedCountEl.textContent = `已选 ${batchPrioritySelected.size}`;
  }
}

/** @param {boolean} busy 批量任务进行中 */
function setPriorityBatchUiBusy(busy) {
  const b = !!busy;
  if (ticketPriorityBatchBtn) ticketPriorityBatchBtn.disabled = b;
  if (ticketPriorityBatchStopBtn) ticketPriorityBatchStopBtn.disabled = !b;
  if (ticketPriorityApplyBtn) ticketPriorityApplyBtn.disabled = b;
  if (ticketBatchSelectVisibleBtn) ticketBatchSelectVisibleBtn.disabled = b;
  if (ticketBatchClearSelectionBtn) ticketBatchClearSelectionBtn.disabled = b;
  if (ticketAutoPriorityBoostBtn) ticketAutoPriorityBoostBtn.disabled = b;
  if (ticketAutoPriorityBoostToggle) ticketAutoPriorityBoostToggle.disabled = b;
  if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = b;
  if (ticketPrioritySelect) ticketPrioritySelect.disabled = b;
  if (ticketRefreshBtn) ticketRefreshBtn.disabled = b;
  if (pmCsvSelectBtn) pmCsvSelectBtn.disabled = b || pmPullInProgress;
  if (pmPullByRegionBtn) pmPullByRegionBtn.disabled = b || pmPullInProgress;
}

function matchAutoPriorityBoost(title) {
  const t = String(title || "").trim();
  if (!t) return { ok: false, hit: "" };
  for (const kw of AUTO_PRIORITY_BOOST_KEYWORDS) {
    const k = String(kw || "").trim();
    if (!k) continue;
    if (t.includes(k)) return { ok: true, hit: k };
  }
  return { ok: false, hit: "" };
}

function shouldSkipAutoBoostByPriority(item) {
  const r = Number.isFinite(item?.priorityRank) ? item.priorityRank : 9;
  return r <= 2; // 非常紧急/紧急/高 不再升
}

function autoBoostEligibleKey(item) {
  const k = getTicketSelectKey(item);
  if (!k) return "";
  const now = Date.now();
  const last = autoPriorityBoostCooldown.get(k);
  if (last && now - last < AUTO_PRIORITY_BOOST_COOLDOWN_MS) return "";
  return k;
}

/** @param {any} res */
function formatPriorityApplyDebugSuffix(res) {
  const extra =
    res?.reason === "verify_mismatch"
      ? `（界面为「${String(res.actual || "").slice(0, 20)}」，期望「${String(res.expected || "").slice(0, 20)}」）`
      : "";
  const debugParts = [];
  if (res?.debug && Array.isArray(res.debug.tried)) {
    debugParts.push(
      `触发器候选 ${res.debug.triggerCount || res.debug.tried.length} 个，已尝试：${res.debug.tried.slice(0, 5).join(" | ")}`
    );
  }
  if (res?.debug && Array.isArray(res.debug.visibleOptionTexts)) {
    debugParts.push(
      `可见选项 ${res.debug.visibleOptionCount || res.debug.visibleOptionTexts.length} 个：${res.debug.visibleOptionTexts.slice(0, 8).join(" / ")}`
    );
  }
  const debugText = debugParts.length ? `；${debugParts.join("；")}` : "";
  return `${extra}${debugText}`;
}

function mergeTickets(nextItems, { reset = false } = {}) {
  if (reset) {
    tickets = [];
    ticketIndex = new Map();
  }

  for (const item of nextItems) {
    normalizeTicketCreatedFields(item);
    const idKey = item.id ? `id:${item.id}` : null;
    const stableKey = `sk:${makeStableKey(item)}`;
    const fpKey = `fp:${item.fingerprint}`;

    // 先按 id 命中，其次按 fingerprint 命中（用于“点击后才拿到编号”的升级场景）
    let existing =
      (idKey ? ticketIndex.get(idKey) : null) ||
      ticketIndex.get(stableKey) ||
      ticketIndex.get(fpKey);
    if (!existing) {
      existing = tickets.find((t) => ticketsLikelySame(t, item)) || null;
    }
    if (!existing) {
      const keyToUse = idKey || stableKey;
      ticketIndex.set(keyToUse, item);
      tickets.push(item);
      continue;
    }

    // 如果之前是 fingerprint key，后来拿到了 id，则把索引升级到 idKey，避免产生重复项
    if (idKey && !ticketIndex.has(idKey)) {
      ticketIndex.delete(stableKey);
      ticketIndex.delete(fpKey);
      ticketIndex.set(idKey, existing);
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
    existing.id = item.id || existing.id;
    existing.fingerprint = item.fingerprint || existing.fingerprint;
  }
}

function renderTicketList() {
  if (!ticketListEl) return;
  ticketListEl.innerHTML = "";

  updateTicketCategoryOptions(tickets);
  const filtered = applyTicketFilters(tickets);
  const sorted = sortTickets(filtered);
  if (!sorted.length) {
    const empty = document.createElement("div");
    empty.className = "log-item log-item-muted";
    empty.textContent = "未匹配到工单：请调整关键词或分类。";
    ticketListEl.append(empty);
  }
  for (const item of sorted) {
    const row = document.createElement("div");
    row.className = `ticket-item${item.isActive ? " ticket-item-active" : ""}`;
    row.setAttribute("role", "listitem");
    row.dataset.ticketId = item.id || "";
    row.dataset.fingerprint = item.fingerprint;

    const selectKey = getTicketSelectKey(item);
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "ticket-item-select";
    cb.setAttribute("aria-label", "勾选以加入批量设置优先级");
    cb.checked = !!selectKey && batchPrioritySelected.has(selectKey);
    cb.disabled = !selectKey;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (!selectKey) return;
      if (cb.checked) batchPrioritySelected.add(selectKey);
      else batchPrioritySelected.delete(selectKey);
      updateBatchPrioritySelectionCount();
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

    ticketListEl.append(row);
  }

  updateBatchPrioritySelectionCount();
  updateTicketMeta(sorted.length);
  updateTicketElapsedDisplays();
  runSlaScan({ emitAlerts: false });
}

function clampInterval(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return DEFAULT_INTERVAL_SEC;
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.floor(n)));
}

function getIntervalSec() {
  const sec = clampInterval(intervalInput?.value ?? DEFAULT_INTERVAL_SEC);
  if (intervalInput) intervalInput.value = String(sec);
  return sec;
}

function getHandler() {
  const value = (handlerInput?.value || "").trim();
  const handler = value || DEFAULT_HANDLER;
  if (handlerInput) handlerInput.value = handler;
  return handler;
}

function setRunningState(next) {
  running = next;
  if (startBtn) startBtn.checked = !!next;
  const startLabel = document.getElementById("startSwitchLabel");
  if (startLabel) startLabel.textContent = next ? "开" : "关";
}

function updateNextTickDisplay() {
  if (!nextTickEl) return;
  if (!running || !nextRunAt) {
    nextTickEl.textContent = "距下次检查：—";
    return;
  }
  const remaining = Math.max(0, Math.ceil((nextRunAt - Date.now()) / 1000));
  nextTickEl.textContent = `距下次检查：${remaining}s`;
}

function updateTicketCount(count) {
  if (!ticketCountEl) return;
  if (typeof count !== "number" || Number.isNaN(count) || count < 0) {
    ticketCountEl.textContent = "待处理：—";
    return;
  }
  ticketCountEl.textContent = `待处理：${count}`;
}

function scheduleNextRun() {
  nextRunAt = Date.now() + getIntervalSec() * 1000;
  updateNextTickDisplay();
}

function stopTitlePatrolTimer() {
  if (titlePatrolTimer) {
    clearInterval(titlePatrolTimer);
    titlePatrolTimer = null;
  }
}

function clearTitlePatrolDebounce() {
  if (titlePatrolDebounceTimer) {
    clearTimeout(titlePatrolDebounceTimer);
    titlePatrolDebounceTimer = null;
  }
}

/** 工单列表从 TT 同步后延迟触发巡检（仅读程序内标题，不点 TT） */
function scheduleTitlePatrolFromRefresh() {
  if (!getTitlePatrolLogEnabled()) return;
  clearTitlePatrolDebounce();
  titlePatrolDebounceTimer = setTimeout(() => {
    titlePatrolDebounceTimer = null;
    runTicketTitlePatrolScan();
  }, 2800);
}

function getTitlePatrolLogEnabled() {
  return !!(titlePatrolLogInput && titlePatrolLogInput.checked);
}

function restartTitlePatrolTimer() {
  stopTitlePatrolTimer();
  if (!getTitlePatrolLogEnabled()) return;
  const ms = getIntervalSec() * 1000;
  titlePatrolTimer = setInterval(() => {
    runTicketTitlePatrolScan();
  }, ms);
}

function stopTimers() {
  stopTitlePatrolTimer();
  clearTitlePatrolDebounce();
  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  nextRunAt = null;
  pendingRunAfterReload = false;
  batchInProgress = false;
  batchHandledCount = 0;
  batchRemaining = 0;
  sessionHandledCount = 0;
  updateNextTickDisplay();
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.handler, getHandler());
  localStorage.setItem(STORAGE_KEYS.interval, String(getIntervalSec()));
  localStorage.setItem(STORAGE_KEYS.autoGroup, autoGroupInput?.checked ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.autoSendMessage, autoSendMessageInput?.checked === false ? "0" : "1");
  localStorage.setItem(STORAGE_KEYS.titlePatrolLog, titlePatrolLogInput?.checked ? "1" : "0");
  titleOnNewAutoEnabled = !!titleOnNewAutoInput?.checked;
  localStorage.setItem(STORAGE_KEYS.titleOnNewAuto, titleOnNewAutoEnabled ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.autoPriorityBoost, autoPriorityBoostEnabled ? "1" : "0");
  if (ticketSlaReminderToggle) {
    localStorage.setItem(STORAGE_KEYS.slaReminderEnabled, ticketSlaReminderToggle.checked ? "1" : "0");
  }
  if (ticketSlaNotifyToggle) {
    localStorage.setItem(STORAGE_KEYS.slaNotifyWindows, ticketSlaNotifyToggle.checked ? "1" : "0");
  }
}

function loadSettings() {
  const savedHandler = localStorage.getItem(STORAGE_KEYS.handler);
  const savedInterval = localStorage.getItem(STORAGE_KEYS.interval);
  const savedAutoGroup = localStorage.getItem(STORAGE_KEYS.autoGroup);
  const savedAutoSendMessage = localStorage.getItem(STORAGE_KEYS.autoSendMessage);
  const savedTitlePatrol = localStorage.getItem(STORAGE_KEYS.titlePatrolLog);
  const savedTitleOnNewAuto = localStorage.getItem(STORAGE_KEYS.titleOnNewAuto);
  const savedAutoBoost = localStorage.getItem(STORAGE_KEYS.autoPriorityBoost);
  const savedSlaReminder = localStorage.getItem(STORAGE_KEYS.slaReminderEnabled);
  const savedSlaNotify = localStorage.getItem(STORAGE_KEYS.slaNotifyWindows);

  if (handlerInput) handlerInput.value = savedHandler || DEFAULT_HANDLER;
  if (intervalInput) intervalInput.value = String(clampInterval(savedInterval || DEFAULT_INTERVAL_SEC));
  if (autoGroupInput) autoGroupInput.checked = savedAutoGroup === "1";
  if (autoSendMessageInput) autoSendMessageInput.checked = savedAutoSendMessage == null ? true : savedAutoSendMessage === "1";
  if (titlePatrolLogInput) titlePatrolLogInput.checked = savedTitlePatrol === "1";
  titleOnNewAutoEnabled = savedTitleOnNewAuto === "1";
  if (titleOnNewAutoInput) titleOnNewAutoInput.checked = titleOnNewAutoEnabled;
  autoPriorityBoostEnabled = savedAutoBoost === "1";
  if (ticketAutoPriorityBoostToggle) ticketAutoPriorityBoostToggle.checked = autoPriorityBoostEnabled;
  if (ticketSlaReminderToggle) {
    ticketSlaReminderToggle.checked = savedSlaReminder == null ? true : savedSlaReminder === "1";
  }
  if (ticketSlaNotifyToggle) {
    ticketSlaNotifyToggle.checked = savedSlaNotify === "1";
  }
}

function buildPendingCountScript() {
  return `
    (() => {
      const candidates = document.querySelectorAll('.filter-title.filter-title-ishandle, .filter-title-ishandle');
      if (!candidates || candidates.length === 0) return NaN;

      for (const title of candidates) {
        const text = title?.textContent || '';
        const match = text.match(/[（(](\\d+)[)）]/);
        if (!match) continue;
        const value = Number(match[1]);
        if (Number.isFinite(value) && value >= 0) return value;
      }

      return NaN;
    })();
  `;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildExtractTicketsScript() {
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

      function getActiveIdFromDetail() {
        const detail =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        if (!detail) return '';

        const items = Array.from(detail.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(detail.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
      }

      const wrapper = getListWrapper();
      let list = wrapper ? Array.from(wrapper.querySelectorAll(".handle-ticket-nav-item")) : [];
      // 「我的待处理」等视图下列表容器可能不在原选择器内，兜底全局匹配避免左侧缓存一直为空
      if (!list.length) {
        list = Array.from(document.querySelectorAll(".handle-ticket-nav-item"));
      }
      const activeId = getActiveIdFromDetail();

      const result = [];
      for (const item of list) {
        const title = guessTitle(item);
        const handler = guessInitiator(item);
        const statusText = guessStatus(item);
        const priorityFromSla = norm(item.querySelector('.ticket-sla-text')?.textContent || '');
        const priorityText =
          parsePriorityFromText(priorityFromSla) ||
          parsePriorityFromText(item.textContent || '') ||
          norm(item.querySelector('.priority')?.textContent || '');
        const createdAtText = guessTime(item);

        let id = '';
        const raw = norm(item.textContent || '');
        const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/) || raw.match(/\\b(\\d{8,})\\b/);
        if (mid) id = mid[1];

        const isActive = item.classList.contains('handle-ticket-nav-item-active') || item.classList.contains('active');
        const effectiveId = (id || (isActive ? activeId : '')) || '';

        result.push({
          id: effectiveId,
          title,
          handler,
          priorityText,
          createdAtText,
          statusText,
          isActive: !!isActive
        });
      }

      return { items: result, activeId };
    })();
  `;
}

async function refreshTickets({ reset = false } = {}) {
  if (!webviewReady || !ttWebview) return;
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
      const id = (x?.id || "").trim() || null;
      const isActive = (!!id && !!activeId && String(id) === String(activeId)) || !!x?.isActive;
      const pr = parsePriorityRank(priorityText);
      const createdEpoch = parseCreatedAtEpoch(createdAtText);
      const sr = statusRank(statusText);
      const fingerprint = `${title}|${handler}|${priorityText}`;
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
        fingerprint
      };
      normalizeTicketCreatedFields(row);
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
      const id = String(api?.id || api?.ticketId || api?.ticketID || "").trim();
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
    function buildBaseApiParams() {
      const p = {
        cn: 1,
        sn: 100,
        orderField: "createdAt",
        orderKind: "DESC"
      };
      if (ticketOnlyMine) {
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

    // 注意：后端可能把 rgIds 与 filterId 当作“交集”处理，导致 7599 组工单被过滤掉。
    // 因此这里用“并集”：分别查 4个RG 与 filter=7599，再合并去重。
    const baseApiParams = buildBaseApiParams();
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
    const apiRes = results.find((x) => x?.ok && x?.data?.code === 200) || results[0];

    if (results.some((r) => r?.ok && r?.data?.code === 200)) {
      const merged = new Map();
      for (const r of results) {
        if (!r?.ok || r?.data?.code !== 200) continue;
        const apiItems = Array.isArray(r?.data?.data?.items) ? r.data.data.items : [];
        for (const x of apiItems) {
          const it = mapApiItem(x);
          const key = it.id || `${it.title}|${it.handler}|${it.createdAtText}`;
          if (!merged.has(key)) merged.set(key, it);
        }
      }
      const apiList = Array.from(merged.values());
      if (apiList.length > 0 || reset) {
        mapped = apiList.map((x) => mapToTicketItem(x, ""));
        usedApi = true;
      }
    }

    // API + TT 页面 DOM 永远做并集：避免 filterId/RG/权限差异导致漏单
    // 同时修复“仅看我的”硬过滤：DOM 来源的工单来自「我的待处理」视图，可直接补齐 ownerMis=当前MIS。
    let domExtra = [];
    try {
      const payload = await ttExecuteJavaScript(buildExtractTicketsScript());
      const items = Array.isArray(payload?.items) ? payload.items : [];
      activeId = (payload?.activeId || "").trim();
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

    if (!usedApi) {
      mapped = domExtra.map((t) => {
        normalizeTicketCreatedFields(t);
        return t;
      });
    } else if (domExtra.length) {
      mapped = mergeApiDomTicketLists(mapped, domExtra);
    } else {
      mapped.forEach((t) => normalizeTicketCreatedFields(t));
    }

    mapped = dedupeMappedTicketsBeforeMerge(mapped);

    mergeTickets(mapped, { reset });

    // 额外强制去重：对于没有 id 的条目，按 fingerprint（标题+发起人+优先级）保留唯一
    // 必须先处理「有 id」的条目并登记 loose，否则会出现「先写入无 id、后写入同 loose 的有 id」两条并存
    const withIdRows = tickets.filter((t) => t && t.id);
    const withoutIdRows = tickets.filter((t) => t && !t.id);
    const orderedForUniq = [...withIdRows, ...withoutIdRows];

    const uniq = new Map();
    const uniqLoose = new Set();
    for (const t of orderedForUniq) {
      const loose = buildLooseTicketKey(t);
      const key = t.id ? `id:${t.id}` : `sk:${makeStableKey(t)}`;
      if (!t.id && loose && uniqLoose.has(loose)) {
        continue;
      }
      if (!uniq.has(key)) {
        uniq.set(key, t);
        if (loose) uniqLoose.add(loose);
        continue;
      }
      // 若重复，优先保留 isActive 或有更完整时间的那条
      const cur = uniq.get(key);
      if (t.isActive && !cur.isActive) uniq.set(key, t);
      else if (cur.createdAtEpoch == null && t.createdAtEpoch != null) uniq.set(key, t);
    }
    tickets = Array.from(uniq.values());
    tickets = dedupeNoIdWhenIdTwinExists(tickets);

    // 只允许一个高亮：若能拿到 activeId，强制按 id 唯一；否则保留第一个 isActive
    if (activeId) {
      for (const t of tickets) t.isActive = !!t.id && String(t.id) === String(activeId);
    } else {
      let found = false;
      for (const t of tickets) {
        if (t.isActive && !found) found = true;
        else if (t.isActive && found) t.isActive = false;
      }
    }

    // 重建索引，避免 tickets 被去重后 ticketIndex 残留导致“已加载”异常增长
    ticketIndex = new Map();
    for (const t of tickets) {
      if (t.id) ticketIndex.set(`id:${t.id}`, t);
      ticketIndex.set(`sk:${makeStableKey(t)}`, t);
    }

    ticketLastUpdatedAt = new Date();
    renderTicketList();
    runSlaScan({ emitAlerts: true });

    // 自动升高优先级：刷新完成后触发一次（running 时采用“串行插队队列”）
    if (autoPriorityBoostEnabled) {
      requestAutoPriorityBoostFromRefresh();
    }
    requestTitleOnNewAfterRefresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`工单列表刷新失败：${message}`, "warning");
  } finally {
    ticketRefreshInFlight = false;
    if (getTitlePatrolLogEnabled()) {
      scheduleTitlePatrolFromRefresh();
    }
  }
}

function requestAutoPriorityBoostFromRefresh() {
  if (!autoPriorityBoostEnabled) return;
  if (running) {
    if (!autoPriorityBoostQueued) {
      autoPriorityBoostQueued = true;
      log("自动升高已排队：将在本轮自动处理结束后执行。", "muted");
    }
    return;
  }
  queueMicrotask(() => {
    runAutoPriorityBoostFromRefresh({ allowRunning: false, reasonTag: "自动升高" }).catch(() => {});
  });
}

async function flushAutoPriorityBoostQueueIfPossible() {
  if (!autoPriorityBoostQueued) return;
  if (!running) {
    autoPriorityBoostQueued = false;
    return;
  }
  if (batchInProgress || pendingRunAfterReload || busy || priorityBatchInProgress || titleNormalizeInProgress || pmPullInProgress)
    return;
  autoPriorityBoostQueued = false;
  await runAutoPriorityBoostFromRefresh({ allowRunning: true, reasonTag: "自动升高-运行中" });
  await flushTitleOnNewQueueIfPossible();
}

async function runAutoPriorityBoostFromRefresh(options = {}) {
  const allowRunning = !!options.allowRunning;
  const reasonTag = String(options.reasonTag || "自动升高").trim();
  if (!autoPriorityBoostEnabled) return;
  if (priorityBatchInProgress) return;
  if (titleNormalizeInProgress) return;
  if (pmPullInProgress) return;
  if (running && !allowRunning) return;
  if (!webviewReady || !ttWebview) return;

  const filtered = applyTicketFilters(tickets);
  const sorted = sortTickets(filtered);
  batchPrioritySelected.clear();

  let hitCount = 0;
  const hits = [];
  for (const it of sorted) {
    if (hitCount >= AUTO_PRIORITY_BOOST_MAX_PER_ROUND) break;
    if (shouldSkipAutoBoostByPriority(it)) continue;
    const k = autoBoostEligibleKey(it);
    if (!k) continue;
    const m = matchAutoPriorityBoost(it.title || "");
    if (!m.ok) continue;
    batchPrioritySelected.add(k);
    hitCount += 1;
    hits.push(m.hit);
  }

  if (!batchPrioritySelected.size) return;
  updateBatchPrioritySelectionCount();
  renderTicketList();
  if (ticketPrioritySelect) ticketPrioritySelect.value = AUTO_PRIORITY_BOOST_TARGET;

  const uniqHits = Array.from(new Set(hits));
  log(
    `${reasonTag}：命中 ${batchPrioritySelected.size} 条（${uniqHits.slice(0, 6).join(" / ")}），将设置为「${AUTO_PRIORITY_BOOST_TARGET}(S3)」。`,
    "info"
  );
  await applyPriorityBatch({ confirm: false, reasonTag, allowRunning });
}

function buildTitleNormalizeInspectScript() {
  return `
    (() => {
      function norm(t) { return ((t || '').trim()).replace(/\\s+/g, ' '); }

      function getArchitecturePathText() {
        const roots = [
          document.querySelector('#ticket-detail'),
          document.querySelector('.ticket-detail-container'),
          document.querySelector('.detail-with-list-container')
        ].filter(Boolean);

        function cleanPath(t) {
          return String(t || '')
            .trim()
            .replace(/\\s+/g, '');
        }

        /** 仅发起人架构行：必须是「公司/…/事业部/…」短路径，避免把处理人/服务目录等整块拼进 path */
        function looksLikeOrgPathOnly(t) {
          const s = cleanPath(t);
          if (!s || s.length > 160) return false;
          if (!s.includes('公司/') || !s.includes('事业部')) return false;
          if (/处理人|服务目录|一级目录|二级目录|三级目录|问题归档|转入ONES|4000帮助台|零售IT/i.test(s)) return false;
          return true;
        }

        for (const root of roots) {
          const items = root.querySelectorAll('.info-item');
          for (const it of items) {
            const lab = norm(it.querySelector('.info-label')?.textContent || '');
            if (!lab.includes('发起人')) continue;
            const sub = it.querySelectorAll('.info-text, span, div, p');
            for (const el of sub) {
              const t = norm(el.textContent || '');
              if (t.length > 20 && t.includes('/') && (t.includes('事业部') || t.includes('美团'))) {
                const c = cleanPath(t);
                if (looksLikeOrgPathOnly(c)) return c;
              }
            }
            const all = norm(it.textContent || '');
            const m = all.match(/(公司\\/[\\u4e00-\\w\\/\\-]+?事业部\\/[\\u4e00-\\w\\/\\-]+(?:\\/[\\u4e00-\\w\\/\\-]+){2,})/);
            if (m && looksLikeOrgPathOnly(m[1])) return cleanPath(m[1]);
          }
        }

        // TT 新版：h3「发起人」后的第一个 .org-info（仅一行路径）
        for (const root of roots) {
          const h3s = root.querySelectorAll('h3');
          for (const h3 of h3s) {
            if (!norm(h3.textContent || '').includes('发起人')) continue;
            let node = h3.nextElementSibling;
            while (node) {
              if (node.tagName === 'H3') break;
              const org = node.querySelector && node.querySelector('.org-info');
              if (org) {
                const c = cleanPath(org.textContent || '');
                if (looksLikeOrgPathOnly(c)) return c;
              }
              node = node.nextElementSibling;
            }
          }
        }

        // 第一个仅含架构的 .org-info（处理人区块常为「零售IT_4000」无 公司/）
        for (const root of roots) {
          const infos = root.querySelectorAll('.org-info');
          for (const el of infos) {
            const c = cleanPath(el.textContent || '');
            if (looksLikeOrgPathOnly(c)) return c;
          }
        }

        // 最后手段：从正文用正则抠路径，禁止再取「最长 div」以免混入整段详情
        for (const root of roots) {
          const blob = cleanPath(root.innerText || root.textContent || '');
          const m = blob.match(
            /公司\\/[\\u4e00\\w\\/\\-]+?事业部\\/[\\u4e00\\w\\/\\-]+(?:\\/[\\u4e00\\w\\/\\-]+){2,12}/
          );
          if (m && m[0].length <= 160) return m[0];
        }
        return '';
      }

      function getWarehouseStoreValue() {
        const container =
          document.querySelector('.ticket-custom-edit-container') || document.querySelector('.editor-content form.mtd-form');
        if (!container) return '';
        const items = Array.from(container.querySelectorAll('.mtd-form-item'));
        for (const item of items) {
          const label = norm(item.querySelector('.mtd-form-item-label')?.textContent || '');
          if (!label.includes('仓库') || (!label.includes('门店') && !label.includes('名称'))) continue;
          const instr = item.querySelector('.form-item-instruction')?.textContent || '';
          if (!instr.includes('仓库') || !instr.includes('门店')) continue;
          const input = item.querySelector('input.mtd-input');
          return norm(input?.value || '');
        }
        return '';
      }

      function getCurrentTitleFromDetail() {
        const detailRoot =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        const fromDisplay = detailRoot?.querySelector('.ticket-name-text-display');
        if (fromDisplay && norm(fromDisplay.textContent)) return norm(fromDisplay.textContent);
        const ta = document.querySelector('.ticket-edit-title textarea');
        if (ta && ta.value) return norm(ta.value);
        const ipt = document.querySelector('.ticket-edit-title input.mtd-input');
        if (ipt && ipt.value) return norm(ipt.value);
        return '';
      }

      return {
        architectureRaw: getArchitecturePathText(),
        warehouseStore: getWarehouseStoreValue(),
        currentTitle: getCurrentTitleFromDetail()
      };
    })()
  `;
}

/** @typedef {{ name: string, mis: string }} PmMember */
/** @typedef {{ enabled: boolean, region_key: string, members: PmMember[], note: string }} PmCsvRule */

function parsePmCsvContent(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { rules: [], error: "empty" };
  const header = lines[0].split(",").map((c) => c.trim().toLowerCase());
  const idxEn = header.indexOf("enabled");
  const idxRk = header.indexOf("region_key");
  const idxMm = header.indexOf("members_mis");
  const idxNote = header.indexOf("note");
  if (idxRk < 0 || idxMm < 0) return { rules: [], error: "bad_header" };
  const rules = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i];
    const parts = row.split(",").map((c) => c.trim());
    if (parts.length < idxMm + 1) continue;
    const enabledCell = idxEn >= 0 ? String(parts[idxEn] || "").trim() : "1";
    const region_key = String(parts[idxRk] || "").trim();
    if (!region_key) continue;
    let membersCell = "";
    let note = "";
    if (idxNote > idxMm) {
      membersCell = parts.slice(idxMm, idxNote).join(",").trim();
      note = parts.slice(idxNote).join(",").trim();
    } else {
      membersCell = parts.slice(idxMm).join(",").trim();
    }
    const memberMap = new Map();
    for (const part of membersCell.split(";")) {
      const m = parsePmMemberToken(part);
      if (!m.mis) continue;
      if (!memberMap.has(m.mis)) memberMap.set(m.mis, m);
    }
    rules.push({
      enabled: enabledCell === "1" || enabledCell.toLowerCase() === "true" || enabledCell === "是",
      region_key,
      members: Array.from(memberMap.values()),
      note
    });
  }
  return { rules, error: "" };
}

function normalizePmMisToken(tok) {
  const s = String(tok || "").trim();
  if (!s) return "";
  const seg = s.split("/").map((x) => x.trim()).filter(Boolean);
  const last = seg.length ? seg[seg.length - 1] : s;
  return String(last || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

/** 解析 CSV 单元格：须为「姓名/MIS」，拉 PM 时姓名与 MIS 双重校验 */
function parsePmMemberToken(tok) {
  const s = String(tok || "").trim();
  if (!s) return { name: "", mis: "" };
  if (s.includes("/")) {
    const parts = s.split("/").map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const mis = normalizePmMisToken(parts[parts.length - 1]);
      const name = parts
        .slice(0, -1)
        .join("/")
        .replace(/^\/+/, "")
        .trim();
      return { name, mis };
    }
  }
  return { name: "", mis: "" };
}

function formatPmMemberLabel(m) {
  if (!m) return "";
  if (m.name && m.mis) return `${m.name}/${m.mis}`;
  return m.mis || m.name || "";
}

function matchPmRuleForTicket(rules, architectureRaw, title) {
  const list = (Array.isArray(rules) ? rules : []).filter((r) => r && r.enabled && r.region_key);
  const ap = String(architectureRaw || "").replace(/\s+/g, "");
  const tt = String(title || "").replace(/\s+/g, "");
  const sorted = [...list].sort((a, b) => String(b.region_key).length - String(a.region_key).length);
  for (const r of sorted) {
    const k = String(r.region_key || "").replace(/\s+/g, "");
    if (k && ap.includes(k)) return r;
  }
  for (const r of sorted) {
    const k = String(r.region_key || "").replace(/\s+/g, "");
    if (k && tt.includes(k)) return r;
  }
  return null;
}

function setPmPullBusy(busy) {
  const b = !!busy;
  pmPullInProgress = b;
  if (pmCsvSelectBtn) pmCsvSelectBtn.disabled = b;
  if (pmPullByRegionBtn) pmPullByRegionBtn.disabled = b;
  if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = b;
  if (ticketPriorityApplyBtn) ticketPriorityApplyBtn.disabled = b;
  if (ticketPriorityBatchBtn) ticketPriorityBatchBtn.disabled = b;
  if (ticketAutoPriorityBoostBtn) ticketAutoPriorityBoostBtn.disabled = b;
  if (ticketRefreshBtn) ticketRefreshBtn.disabled = b;
}

function updatePmCsvPathLabel() {
  if (!pmCsvPathLabel) return;
  const p = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || "").trim();
  pmCsvPathLabel.textContent = p ? `PM配置：${p}` : "PM配置：未选择";
}

/**
 * 大象会话 → 添加成员 → 按 MIS 搜索 → 搜索结果须同时匹配 CSV 姓名+MIS → 一次确定
 * @param {PmMember[]} targets
 */
function buildPullPmMembersScript(targets) {
  const safe = JSON.stringify(
    (Array.isArray(targets) ? targets : []).filter((t) => t && t.mis && t.name)
  );
  return `
    (async () => {
      const targets = ${safe};
      const logs = [];
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function norm(t) { return String(t || '').trim().replace(/\\s+/g, ' '); }
      function visible(el) {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function clickElephantSessionTab() {
        const spans = Array.from(document.querySelectorAll('span'));
        for (const sp of spans) {
          if (norm(sp.textContent) !== '大象会话') continue;
          const tab =
            sp.closest('[role="tab"]') ||
            sp.closest('.mtd-tabs-item') ||
            sp.closest('li') ||
            sp.closest('button') ||
            sp.parentElement;
          if (!tab) continue;
          try {
            tab.click();
            return true;
          } catch {
            // ignore
          }
        }
        return false;
      }
      async function waitAndClickAddMember(maxMs) {
        const end = Date.now() + maxMs;
        while (Date.now() < end) {
          const spans = Array.from(document.querySelectorAll('span.text, span'));
          for (const sp of spans) {
            if (norm(sp.textContent) !== '添加成员') continue;
            const host =
              sp.closest('button') ||
              sp.closest('[role="button"]') ||
              sp.closest('a') ||
              sp.parentElement;
            if (host && visible(host)) {
              try {
                host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                host.click();
              } catch {
                // ignore
              }
              return true;
            }
          }
          await sleep(120);
        }
        return false;
      }
      function findAddMemberModal() {
        const roots = Array.from(document.querySelectorAll('.mtd-modal-wrap, .mtd-modal, [role="dialog"]'));
        let best = null;
        let bestZ = -1;
        for (const m of roots) {
          if (!visible(m)) continue;
          const txt = m.textContent || '';
          if (!txt.includes('添加成员')) continue;
          let z = 0;
          try {
            z = Number(window.getComputedStyle(m).zIndex) || 0;
          } catch {
            z = 0;
          }
          if (z >= bestZ) {
            bestZ = z;
            best = m;
          }
        }
        return best;
      }
      async function waitModal(maxMs) {
        const end = Date.now() + maxMs;
        while (Date.now() < end) {
          const m = findAddMemberModal();
          if (m) return m;
          await sleep(100);
        }
        return null;
      }
      function findSearchInput(modal) {
        const roots = [modal, document.body].filter(Boolean);
        for (const root of roots) {
          const inputs = root.querySelectorAll('input');
          for (const ip of inputs) {
            const ph = String(ip.getAttribute('placeholder') || '');
            if (ph.includes('MIS') || ph.includes('mis') || ph.includes('姓名')) return ip;
          }
        }
        for (const root of roots) {
          const ip = root.querySelector('input[type="text"], input.mtd-input');
          if (ip) return ip;
        }
        return null;
      }
      function setInputValue(el, val) {
        if (!el || el.tagName !== 'INPUT') return;
        const prev = el.value;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        const tr = el._valueTracker;
        if (tr && typeof tr.setValue === 'function') tr.setValue(prev);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof InputEvent === 'function') {
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: val })
          );
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      function parseResultNameText(raw) {
        const t = String(raw || '').trim();
        const idx = t.lastIndexOf('/');
        if (idx < 0) return { name: '', mis: '', raw: t };
        return {
          name: t.slice(0, idx).replace(/^\\/+/, '').trim(),
          mis: t.slice(idx + 1).trim().toLowerCase(),
          raw: t
        };
      }

      function normalizeMisKey(m) {
        return String(m || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
      }

      function normalizeNameKey(n) {
        return String(n || '').replace(/\\s+/g, '').trim();
      }

      function stripMisPrefix(m) {
        return normalizeMisKey(m).replace(/^wb_/, '');
      }

      /** MIS 一致：完全相同，或去掉 wb_ 前缀后相同（zhangjunjie25 ↔ wb_zhangjunjie25） */
      function misKeysEquivalent(want, got) {
        const a = normalizeMisKey(want);
        const b = normalizeMisKey(got);
        if (!a || !b) return false;
        if (a === b) return true;
        return stripMisPrefix(want) === stripMisPrefix(got);
      }

      /** 姓名一致：完全相同，或双方互相包含（至少 2 字，避免误匹配） */
      function nameKeysEquivalent(want, got) {
        const a = normalizeNameKey(want);
        const b = normalizeNameKey(got);
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
        return false;
      }

      function candidateStrictMatch(cand, target) {
        return misKeysEquivalent(target.mis, cand.mis) && nameKeysEquivalent(target.name, cand.name);
      }

      function collectVisibleCandidates(modal) {
        const root = modal || document.body;
        const lis = Array.from(root.querySelectorAll('li'));
        const out = [];
        for (const li of lis) {
          if (!visible(li)) continue;
          const nm = li.querySelector('span.name');
          if (!nm) continue;
          const raw = String(nm.textContent || '').trim();
          if (!raw) continue;
          const parsed = parseResultNameText(raw);
          out.push({ ...parsed, el: li });
        }
        return out;
      }

      function collectStrictMatches(modal, target) {
        return collectVisibleCandidates(modal).filter((c) => candidateStrictMatch(c, target));
      }

      function collectMisMatches(modal, target) {
        return collectVisibleCandidates(modal).filter((c) => misKeysEquivalent(target.mis, c.mis));
      }

      function clickCandidate(one) {
        try {
          one.el.scrollIntoView({ block: 'center' });
          one.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          one.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          one.el.click();
        } catch {
          // ignore
        }
      }

      async function pickMatchedSuggestionForTarget(modal, target) {
        const wantMis = normalizeMisKey(target.mis);
        const wantName = normalizeNameKey(target.name);
        if (!wantMis) return { ok: false, reason: 'empty_mis' };
        if (!wantName) return { ok: false, reason: 'empty_name' };
        const end = Date.now() + 8000;
        while (Date.now() < end) {
          const strict = collectStrictMatches(modal, target);
          if (strict.length === 1) {
            clickCandidate(strict[0]);
            return { ok: true, picked: strict[0].raw, mode: 'strict' };
          }
          if (strict.length > 1) {
            const names = strict.map((m) => m.raw).slice(0, 5).join(' | ');
            return { ok: false, reason: 'ambiguous', detail: names, count: strict.length };
          }

          const misOnly = collectMisMatches(modal, target);
          if (misOnly.length === 1) {
            clickCandidate(misOnly[0]);
            return {
              ok: true,
              picked: misOnly[0].raw,
              mode: 'mis_only',
              configName: target.name,
              gotName: misOnly[0].name
            };
          }
          if (misOnly.length > 1) {
            const byName = misOnly.filter((c) => nameKeysEquivalent(target.name, c.name));
            if (byName.length === 1) {
              clickCandidate(byName[0]);
              return { ok: true, picked: byName[0].raw, mode: 'strict' };
            }
            const names = misOnly.map((m) => m.raw).slice(0, 5).join(' | ');
            return { ok: false, reason: 'ambiguous', detail: names, count: misOnly.length };
          }

          await sleep(120);
        }
        const hint = collectVisibleCandidates(modal)
          .map((c) => c.raw)
          .slice(0, 6)
          .join(' | ');
        return { ok: false, reason: 'not_found', detail: hint };
      }
      function clickConfirm() {
        const nodes = Array.from(document.querySelectorAll('button, .mtd-btn'));
        for (const b of nodes) {
          if (norm(b.textContent) === '确定' && visible(b)) {
            b.click();
            return true;
          }
        }
        return false;
      }

      if (!targets || !targets.length) return { ok: false, reason: 'empty_targets' };

      if (!clickElephantSessionTab()) {
        return { ok: false, reason: 'no_elephant_tab', logs };
      }
      await sleep(450);

      const clickedAdd = await waitAndClickAddMember(12000);
      if (!clickedAdd) {
        return { ok: false, reason: 'no_add_member', logs };
      }
      await sleep(400);

      const modal = await waitModal(8000);
      if (!modal) {
        return { ok: false, reason: 'no_modal', logs };
      }

      const searchInput = findSearchInput(modal);
      if (!searchInput) {
        return { ok: false, reason: 'no_search_input', logs };
      }

      async function searchAndPick(target) {
        const label = target.name + '/' + target.mis;
        const queries = [
          String(target.mis || ''),
          stripMisPrefix(target.mis),
          String(target.name || ''),
          label
        ].filter((q, i, arr) => q && arr.indexOf(q) === i);

        let lastFail = { ok: false, reason: 'not_found', detail: '' };
        for (const q of queries) {
          setInputValue(searchInput, '');
          await sleep(80);
          setInputValue(searchInput, q);
          await sleep(650);
          const pick = await pickMatchedSuggestionForTarget(modal, target);
          if (pick.ok) return pick;
          if (pick.reason === 'ambiguous') return pick;
          lastFail = pick;
        }
        return lastFail;
      }

      for (const target of targets) {
        if (!target || !target.mis || !target.name) continue;
        const label = target.name + '/' + target.mis;
        const pick = await searchAndPick(target);
        if (!pick.ok) {
          if (pick.reason === 'ambiguous') {
            logs.push('匹配到多条，已跳过：' + label + '（' + (pick.detail || '') + '）');
          } else {
            const hint = pick.detail ? '；搜索列表：' + pick.detail : '';
            logs.push('未找到可匹配成员，已跳过：' + label + hint);
          }
          continue;
        }
        if (pick.mode === 'mis_only') {
          logs.push(
            '已选择：' +
              (pick.picked || label) +
              '（MIS 唯一命中；TT 姓名「' +
              (pick.gotName || '') +
              '」与配置「' +
              (pick.configName || target.name) +
              '」不完全一致）'
          );
        } else {
          logs.push('已选择：' + (pick.picked || label) + '（姓名+MIS 校验通过）');
        }
        await sleep(220);
      }

      if (!clickConfirm()) {
        await sleep(350);
        if (!clickConfirm()) {
          return { ok: false, reason: 'no_confirm', logs };
        }
      }
      await sleep(300);
      return { ok: true, logs };
    })()
  `;
}

async function selectPmCsvFile() {
  try {
    const res = await window.ttDesktopApi?.selectAndReadPmCsv?.();
    if (!res || res.canceled) return;
    if (!res.ok) {
      log(`选择 PM 配置文件失败：${res.message || "unknown"}`, "error");
      return;
    }
    const parsed = parsePmCsvContent(res.content || "");
    if (parsed.error === "bad_header") {
      log("PM 配置 CSV 表头不正确，需要包含 region_key 与 members_mis 列。", "error");
      return;
    }
    localStorage.setItem(STORAGE_KEYS.pmCsvPath, res.path || "");
    updatePmCsvPathLabel();
    log(`已选择 PM 配置：${res.path}（有效规则 ${parsed.rules.filter((r) => r.enabled).length} 条）`, "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`选择 PM 配置异常：${msg}`, "error");
  }
}

async function runPmPullByRegion() {
  if (!webviewReady || !ttWebview) {
    log("请先等待 TT 页面加载完成。", "warning");
    return;
  }
  const opState = { busy, pmPullInProgress, priorityBatchInProgress, titleNormalizeInProgress };
  if (!Guard.canStartPmPull(opState)) {
    if (pmPullInProgress) return;
    if (priorityBatchInProgress) {
      log(Guard.msgPmBlocked(), "warning");
      return;
    }
    if (titleNormalizeInProgress) {
      log(Guard.msgTitleNormalizeBlocked(), "warning");
      return;
    }
    if (busy) {
      log(Guard.msgPmBlockedByBusy(), "warning");
      return;
    }
    return;
  }

  const csvPath = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || "").trim();
  if (!csvPath) {
    log("请先在工单面板点击「选择PM配置」选择 CSV 文件。", "warning");
    return;
  }

  const active = tickets.find((t) => t && t.isActive);
  if (!active) {
    log("请先在左侧工单列表中点击要处理的工单（高亮项），再点「按地区拉PM」。", "warning");
    return;
  }

  setPmPullBusy(true);
  setActiveLeftTab("logs");
  try {
    const opened = await handleTicketClick(active, { skipRefresh: true });
    if (!opened) {
      log("无法打开目标工单，已取消拉 PM。", "error");
      return;
    }
    await sleep(600);

    const detail = await ttExecuteJavaScript(buildTitleNormalizeInspectScript());
    const arch = String(detail?.architectureRaw || "").trim();
    const title = String(detail?.currentTitle || active.title || "").trim();

    const fileRes = await window.ttDesktopApi?.readTextFile?.(csvPath);
    if (!fileRes?.ok) {
      log(`读取 PM 配置失败：${fileRes?.message || "unknown"}`, "error");
      return;
    }
    const parsed = parsePmCsvContent(fileRes.content || "");
    if (!parsed.rules.length) {
      log("PM 配置 CSV 中没有有效数据行。", "error");
      return;
    }

    const rule = matchPmRuleForTicket(parsed.rules, arch, title);
    if (!rule) {
      log(
        `未匹配到地区：发起人路径与标题中均未发现 CSV 里的 region_key（当前路径片段可参考日志）。\n  路径：${(arch || "（空）").slice(0, 120)}\n  标题：${(title || "（空）").slice(0, 80)}`,
        "warning"
      );
      return;
    }
    if (!rule.members.length) {
      log(`地区「${rule.region_key}」未配置 members_mis。`, "warning");
      return;
    }

    const pmTargets = rule.members.filter((m) => m && m.mis && m.name);
    const pmSkipped = rule.members.filter((m) => !m || !m.mis || !m.name);
    if (pmSkipped.length) {
      log(
        `以下成员未按「姓名/MIS」填写完整，已跳过：${pmSkipped.map((m) => formatPmMemberLabel(m) || "（空）").join("、")}`,
        "warning"
      );
    }
    if (!pmTargets.length) {
      log(`地区「${rule.region_key}」没有可用的「姓名/MIS」成员，请检查 CSV。`, "warning");
      return;
    }

    const memberLabels = pmTargets.map((m) => formatPmMemberLabel(m)).join("、");
    log(`按地区拉 PM：匹配「${rule.region_key}」→ 将添加 ${pmTargets.length} 人（姓名+MIS 双重校验）：${memberLabels}`, "info");

    const res = await ttExecuteJavaScript(buildPullPmMembersScript(pmTargets));
    if (!res?.ok) {
      const extra = Array.isArray(res?.logs) && res.logs.length ? `\n  明细：${res.logs.join("；")}` : "";
      log(`拉 PM 未完成：${res?.reason || "unknown"}${extra}`, "error");
    } else {
      const extra = Array.isArray(res?.logs) && res.logs.length ? `\n  明细：${res.logs.join("；")}` : "";
      log(`拉 PM 已完成（已点确定）。${extra}`, "success");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`拉 PM 异常：${msg}`, "error");
  } finally {
    setPmPullBusy(false);
    await refreshTickets({ reset: false });
  }
}

function buildApplyTitleScript(newTitle) {
  const safe = JSON.stringify(newTitle);
  return `
    (async () => {
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function norm(t) { return ((t || '').trim()).replace(/\\s+/g, ' '); }

      function visible(el) {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      /** TT 标题编辑态：.ticket-edit-title .mtd-textarea（Vue/React 需原生 setter + _valueTracker） */
      function setTitleTextareaValue(el, val) {
        if (!el || el.tagName !== 'TEXTAREA') return;
        const prev = el.value;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        const tr = el._valueTracker;
        if (tr && typeof tr.setValue === 'function') tr.setValue(prev);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof InputEvent === 'function') {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: val }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function setTitleInputValue(el, val) {
        if (!el || el.tagName !== 'INPUT') return;
        const prev = el.value;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        const tr = el._valueTracker;
        if (tr && typeof tr.setValue === 'function') tr.setValue(prev);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      /** 只认标题栏内的控件，避免误改页面上其它 input */
      function findTitleEditorStrict(detail) {
        const roots = [document, detail].filter(Boolean);
        const selectors = [
          '.ticket-edit-title textarea.mtd-textarea',
          '.ticket-edit-title .tt-hover-field textarea.mtd-textarea',
          '.ticket-edit-title textarea',
          '.ticket-edit-title .tt-hover-field textarea',
          '.ticket-edit-title input.mtd-input',
          '.ticket-edit-title input[type="text"]'
        ];
        for (const r of roots) {
          for (const sel of selectors) {
            const el = r.querySelector(sel);
            if (el && (visible(el) || el.offsetParent !== null)) return el;
          }
        }
        for (const r of roots) {
          for (const sel of selectors) {
            const el = r.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      }

      function readDisplayedTitle(detail) {
        const d = detail || document;
        const n = d.querySelector('.ticket-name-text-display') || document.querySelector('.ticket-name-text-display');
        return norm(n?.textContent || '');
      }

      const newTitle = ${safe};
      const detail = document.querySelector('#ticket-detail') || document.querySelector('.ticket-detail-container') || document.querySelector('.detail-with-list-container');
      const display = detail?.querySelector('.ticket-name-text-display') || document.querySelector('.ticket-name-text-display');

      if (display && visible(display)) {
        display.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        display.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        display.click();
        await sleep(300);
      } else {
        const field = display?.closest('.tt-hover-field');
        if (field) {
          field.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await sleep(300);
        }
      }

      let editor = null;
      for (let i = 0; i < 28; i += 1) {
        editor = findTitleEditorStrict(detail);
        if (!editor) {
          const ae = document.activeElement;
          if (ae && ae.closest && ae.closest('.ticket-edit-title') && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) editor = ae;
        }
        if (editor) break;
        await sleep(200);
      }

      if (!editor) return { ok: false, reason: 'no_title_editor' };

      editor.focus();
      await sleep(100);
      if (editor.tagName === 'TEXTAREA') setTitleTextareaValue(editor, newTitle);
      else if (editor.tagName === 'INPUT') setTitleInputValue(editor, newTitle);
      await sleep(200);

      editor.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      editor.blur();
      await sleep(200);

      const neutral = detail?.querySelector('.ticket-custom-edit-container') || detail?.querySelector('.mtd-form') || detail;
      if (neutral && neutral !== editor) {
        neutral.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        neutral.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      }
      await sleep(400);

      let after = readDisplayedTitle(detail);
      let ok = after === norm(newTitle);
      if (!ok) {
        await sleep(700);
        after = readDisplayedTitle(detail);
        ok = after === norm(newTitle);
      }
      if (!ok) {
        return { ok: false, reason: 'verify_mismatch', expected: norm(newTitle), actual: after };
      }
      return { ok: true };
    })()
  `;
}

function buildApplyPriorityScript(targetPriorityText) {
  const safe = JSON.stringify(String(targetPriorityText || "").trim());
  return `
    (async () => {
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function norm(t) { return ((t || '').trim()).replace(/\\s+/g, ' '); }

      function visible(el) {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function getDetailRoot() {
        // 同事环境里 TT 详情容器 class 可能不同：找不到时不要直接失败，改为全局操作
        return (
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container') ||
          document.querySelector('.ticket-detail') ||
          document.querySelector('[class*="ticket-detail" i]') ||
          null
        );
      }

      function normalizePriorityLabel(t) {
        const s = norm(t);
        if (!s) return '';
        if (s.includes('非常紧急')) return '非常紧急';
        if (s.includes('紧急')) return '紧急';
        if (s.includes('高')) return '高';
        if (s.includes('中')) return '中';
        if (s.includes('低')) return '低';
        return '';
      }

      function readPriorityFromDetail(detail) {
        const root = detail || document;
        const items = Array.from(root.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('优先级')) continue;
          const txt =
            it.querySelector('.toolcom-state-option-tag')?.textContent ||
            it.querySelector('.info-text')?.textContent ||
            it.querySelector('.info-value')?.textContent ||
            it.textContent ||
            '';
          const p = normalizePriorityLabel(txt);
          if (p) return p;
        }
        const tags = Array.from(root.querySelectorAll('.toolcom-state-option-tag'));
        for (const el of tags) {
          const p = normalizePriorityLabel(el.textContent || '');
          if (p) return p;
        }
        return '';
      }

      // 从优先级控件本身读取当前值（兼容详情字段读取不到的页面结构）
      function readPriorityFromPicker(detail) {
        const root = detail || document;
        const picker =
          root.querySelector('.toolcom-state-picker .mtd-picker-values') ||
          root.querySelector('.toolcom-state-picker .mtd-picker-rendered') ||
          root.querySelector('.toolcom-state-picker') ||
          root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-picker-values') ||
          root.querySelector('[class*=\"toolcom-state-picker\"]');
        if (!picker) return '';
        return normalizePriorityLabel(picker.textContent || '');
      }

      // 某些 TT 页面会先更新左侧列表徽标，再回填详情字段；作为校验兜底来源
      function readPriorityFromActiveListItem() {
        const active =
          document.querySelector('.handle-ticket-nav-item.handle-ticket-nav-item-active') ||
          document.querySelector('.handle-ticket-nav-item.active');
        if (!active) return '';
        const txt =
          active.querySelector('.ticket-sla-text')?.textContent ||
          active.querySelector('.priority')?.textContent ||
          active.textContent ||
          '';
        return normalizePriorityLabel(txt);
      }

      function collectPriorityTriggers(detail) {
        const root = detail || document;
        const out = [];
        const seen = new Set();
        const push = (el) => {
          if (!el || !(el instanceof Element)) return;
          if (seen.has(el)) return;
          seen.add(el);
          out.push(el);
        };

        // 优先命中你截图里的“中 ▼”按钮样式
        const current = readPriorityFromDetail(root);
        const btns = Array.from(root.querySelectorAll('button, .mtd-btn, [role=\"button\"]'));
        for (const b of btns) {
          const t = normalizePriorityLabel(b.textContent || '');
          if (current && t && t === current) push(b);
        }

        // 常见优先级触发器
        push(root.querySelector('.toolcom-state-picker .mtd-picker-selection'));
        push(root.querySelector('.toolcom-state-picker .mtd-picker-icon'));
        push(root.querySelector('.toolcom-state-picker .mtd-btn'));
        push(root.querySelector('.toolcom-state-picker'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-picker-selection'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-picker-icon'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-btn'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"]'));
        push(root.querySelector('[class*=\"state-picker\"] .mtd-picker-selection'));
        push(root.querySelector('[class*=\"state-picker\"] .mtd-picker-icon'));
        push(root.querySelector('[class*=\"state-picker\"] .mtd-btn'));
        push(root.querySelector('[class*=\"state-picker\"]'));

        const items = Array.from(root.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('优先级')) continue;
          push(it.querySelector('.toolcom-state-picker .mtd-picker-selection'));
          push(it.querySelector('.toolcom-state-picker .mtd-picker-icon'));
          push(it.querySelector('.toolcom-state-picker .mtd-btn'));
          push(it.querySelector('.toolcom-state-picker'));
          push(it.querySelector('button,[role=\"button\"],.mtd-select,.mtd-input-wrapper,.info-text'));
          push(it);
        }

        const formItems = Array.from(root.querySelectorAll('.mtd-form-item'));
        for (const it of formItems) {
          const label = norm(it.querySelector('.mtd-form-item-label')?.textContent || '');
          if (!label.includes('优先级')) continue;
          push(it.querySelector('.mtd-select-input'));
          push(it.querySelector('.mtd-input-wrapper'));
          push(it.querySelector('button,[role=\"button\"]'));
          push(it);
        }
        return out;
      }

      function describeEl(el) {
        if (!el || !(el instanceof Element)) return '';
        const tag = (el.tagName || '').toLowerCase();
        const id = el.id ? ('#' + el.id) : '';
        const cls = (el.className && typeof el.className === 'string')
          ? '.' + el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
          : '';
        const txt = norm(el.textContent || '').slice(0, 24);
        return tag + id + cls + (txt ? ('("' + txt + '")') : '');
      }

      async function openPriorityPopper(detail) {
        const triggers = collectPriorityTriggers(detail);
        if (!triggers.length) return { ok: false, reason: 'no_priority_trigger', debug: { triggerCount: 0, tried: [] } };

        function readVisiblePopper() {
          const pops = Array.from(
            document.querySelectorAll(
              '.toolcom-state-picker-popper, .mtd-picker-popper, .mtd-dropdown-popper, .mtd-popper, [class*="picker-popper" i], [class*="dropdown-popper" i]'
            )
          );
          for (const pop of pops) {
            if (pop && (visible(pop) || pop.style.display !== 'none')) return pop;
          }
          return null;
        }

        function readVisiblePriorityOptions(rootEl) {
          const root = rootEl || document;
          const candidates = Array.from(
            root.querySelectorAll(
              'li.toolcom-state-option, li.mtd-dropdown-menu-item, .mtd-dropdown-menu-item, [role="menuitem"], [role="option"]'
            )
          );
          return candidates.filter((el) => {
            if (!el || !(el instanceof Element)) return false;
            const txt = norm(el.textContent || '');
            if (!txt) return false;
            const hasLevel = /非常紧急|紧急|高|中|低/.test(txt);
            if (!hasLevel) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        }

        function isExpandedTrigger(el) {
          if (!el || !(el instanceof Element)) return false;
          const host = el.closest('.toolcom-state-picker, .mtd-picker, .mtd-dropdown') || el;
          if (!(host instanceof Element)) return false;
          const cls = host.className || '';
          return /mtd-dropdown-expended|mtd-dropdown-expanded/.test(String(cls));
        }

        const tried = [];
        for (const trigger of triggers) {
          tried.push(describeEl(trigger));
          try {
            const host = trigger.closest('.toolcom-state-picker, .mtd-picker, .mtd-dropdown') || trigger;
            host.scrollIntoView({ block: 'center' });
            if (typeof host.focus === 'function') host.focus();

            // 更强制：PointerEvent -> MouseEvent -> click，兼容不同组件监听
            if (typeof PointerEvent === 'function') {
              host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse' }));
              host.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse' }));
            }
            host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            if (typeof host.click === 'function') host.click();

            // 再补一轮键盘触发（有些 picker 仅响应 Enter/Space）
            try {
              host.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
              host.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ', code: 'Space' }));
            } catch {
              // ignore
            }

            // 若有下拉图标，额外点一次
            const icon = host.querySelector && (host.querySelector('.mtd-picker-icon') || host.querySelector('.mtdicon-down-thick'));
            if (icon && typeof icon.click === 'function') icon.click();
          } catch {
            // ignore and continue next trigger
          }

          for (let i = 0; i < 10; i += 1) {
            const pop = readVisiblePopper();
            if (pop) return { ok: true, popper: pop };
            if (isExpandedTrigger(trigger)) {
              return { ok: true, popper: null, byExpanded: true };
            }
            const vis = readVisiblePriorityOptions(document);
            if (vis.length > 0) {
              return { ok: true, popper: null, byVisibleOptions: true };
            }
            await sleep(80);
          }
        }
        return { ok: false, reason: 'no_priority_popper', debug: { triggerCount: triggers.length, tried } };
      }

      const target = ${safe};
      if (!target) return { ok: false, reason: 'empty_target' };

      const detail = getDetailRoot() || document.body || document.documentElement || document;

      const before = readPriorityFromDetail(detail);
      const opened = await openPriorityPopper(detail);
      if (!opened.ok) return { ok: false, reason: opened.reason || 'open_failed', debug: opened.debug || null };

      const pop = opened.popper;
      const itemRoot = pop || document;
      let items = Array.from(
        itemRoot.querySelectorAll(
          'li.toolcom-state-option, li.mtd-dropdown-menu-item, .mtd-dropdown-menu-item, [role="menuitem"], [role="option"]'
        )
      );
      items = items.filter((el) => {
        if (!el || !(el instanceof Element)) return false;
        const txt = norm(el.textContent || '');
        if (!txt) return false;
        if (!/非常紧急|紧急|高|中|低/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const pick = items.find((li) => norm(li.textContent || '').includes(target));
      if (!pick) {
        return {
          ok: false,
          reason: 'option_not_found',
          expected: target,
          before,
          debug: { visibleOptionCount: items.length, visibleOptionTexts: items.map((x) => norm(x.textContent || '')).slice(0, 10) }
        };
      }

      pick.scrollIntoView({ block: 'center' });
      pick.click();
      await sleep(180);

      // 某些页面需要失焦才会真正提交优先级变更
      const neutral =
        detail.querySelector('.ticket-custom-edit-container') ||
        detail.querySelector('.main-content') ||
        detail.querySelector('.info-content') ||
        detail;
      if (neutral) {
        neutral.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        neutral.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        if (typeof neutral.click === 'function') neutral.click();
      }
      await sleep(240);

      for (let i = 0; i < 28; i += 1) {
        const actual = readPriorityFromDetail(detail) || readPriorityFromPicker(detail) || readPriorityFromActiveListItem();
        if (actual) {
          if (actual === target) return { ok: true, expected: target, actual, before };
          // 读到旧值时继续等待后端回写，不要立刻误判失败
          await sleep(220);
          const retry = readPriorityFromDetail(detail) || readPriorityFromPicker(detail) || readPriorityFromActiveListItem();
          if (retry === target) return { ok: true, expected: target, actual: retry, before };
        }
        await sleep(140);
      }
      // 末次再尝试一次控件文本，减少因渲染延迟带来的误报
      const finalActual = readPriorityFromPicker(detail) || readPriorityFromDetail(detail) || readPriorityFromActiveListItem();
      if (finalActual) {
        if (finalActual === target) return { ok: true, expected: target, actual: finalActual, before };
        return { ok: false, reason: 'verify_mismatch', expected: target, actual: finalActual, before };
      }
      return { ok: false, reason: 'verify_empty', expected: target, before };
    })()
  `;
}

function applyPriorityInWebview(target) {
  return ttExecuteJavaScript(buildApplyPriorityScript(target));
}

async function applyPriorityForActiveTicket() {
  if (!webviewReady || !ttWebview) {
    log("请先等待 TT 页面加载完成。", "warning");
    return;
  }
  if (titleNormalizeInProgress) {
    log("请等待「标题检测」完成后再修改优先级。", "warning");
    return;
  }
  if (priorityBatchInProgress) {
    log("正在批量设置优先级，请等待完成后再单独设置。", "warning");
    return;
  }
  if (pmPullInProgress) {
    log("正在执行「按地区拉PM」，请稍后再设置优先级。", "warning");
    return;
  }
  if (running) {
    log("请先停止「开始」自动处理，再修改优先级。", "warning");
    return;
  }

  const target = String(ticketPrioritySelect?.value || "").trim();
  if (!target) {
    log("未选择目标优先级。", "warning");
    return;
  }

  setActiveLeftTab("logs");
  log(`开始设置当前工单优先级：${target}…`, "info");

  const res = await applyPriorityInWebview(target);
  if (!res?.ok) {
    log(`设置优先级失败：${res?.reason || "unknown"}${formatPriorityApplyDebugSuffix(res)}`, "error");
  } else {
    log(`优先级已更新：${String(res.actual || target)}`, "success");
  }

  await sleep(260);
  await refreshTickets({ reset: false });
}

async function applyPriorityBatch(options = {}) {
  const confirm = options?.confirm !== false;
  const reasonTag = String(options?.reasonTag || "").trim();
  const allowRunning = !!options?.allowRunning;
  if (!webviewReady || !ttWebview) {
    log("请先等待 TT 页面加载完成。", "warning");
    return;
  }
  if (titleNormalizeInProgress) {
    log("请等待「标题检测」完成后再批量设置优先级。", "warning");
    return;
  }
  if (pmPullInProgress) {
    log("正在执行「按地区拉PM」，请稍后再批量设置优先级。", "warning");
    return;
  }
  if (running && !allowRunning) {
    log("请先停止「开始」自动处理，再批量设置优先级。", "warning");
    return;
  }
  if (priorityBatchInProgress) return;

  const target = String(ticketPrioritySelect?.value || "").trim();
  if (!target) {
    log("未选择目标优先级。", "warning");
    return;
  }

  const filtered = applyTicketFilters(tickets);
  const sorted = sortTickets(filtered);
  const toProcess = sorted.filter((item) => batchPrioritySelected.has(getTicketSelectKey(item)));
  if (!toProcess.length) {
    log("没有可处理的工单：请在列表中勾选工单，并确保它们出现在当前筛选结果中。", "warning");
    return;
  }

  if (confirm) {
    const okConfirm = window.confirm(
      `将对 ${toProcess.length} 条工单顺序设置优先级为「${target}」（仅当前筛选列表内已勾选项）。\n\n确认继续？`
    );
    if (!okConfirm) {
      log("已取消批量设置优先级。", "muted");
      return;
    }
  }

  priorityBatchInProgress = true;
  priorityBatchAbort = false;
  setPriorityBatchUiBusy(true);
  setActiveLeftTab("logs");
  const tag = reasonTag ? `（${reasonTag}）` : "";
  log(`开始批量设置优先级「${target}」${tag}，共 ${toProcess.length} 条（逐条打开 TT 详情并保存）…`, "info");

  let okCount = 0;
  let failCount = 0;

  try {
    for (let i = 0; i < toProcess.length; i += 1) {
      if (priorityBatchAbort) {
        log(`批量设置已中止：已处理 ${i} 条，成功 ${okCount}，失败 ${failCount}。`, "warning");
        break;
      }
      const item = toProcess[i];
      const label = (item.title || item.id || "").slice(0, 55);
      const opened = await handleTicketClick(item, { skipRefresh: true });
      if (!opened) {
        failCount += 1;
        log(`[批量优先级] ${i + 1}/${toProcess.length} 失败（未打开）：${label}`, "error");
        continue;
      }
      await sleep(650);
      const res = await applyPriorityInWebview(target);
      if (!res?.ok) {
        failCount += 1;
        if (!confirm) {
          const k = getTicketSelectKey(item);
          if (k) autoPriorityBoostCooldown.set(k, Date.now());
        }
        log(
          `[批量优先级] ${i + 1}/${toProcess.length} 失败：${label} — ${res?.reason || "unknown"}${formatPriorityApplyDebugSuffix(res)}`,
          "error"
        );
      } else {
        okCount += 1;
        log(`[批量优先级] ${i + 1}/${toProcess.length} 已设为「${String(res.actual || target)}」：${label}`, "success");
      }
      await sleep(280);
    }
    if (!priorityBatchAbort) {
      log(`批量设置优先级结束：成功 ${okCount}，失败 ${failCount}。`, failCount ? "warning" : "success");
    }
  } finally {
    priorityBatchInProgress = false;
    setPriorityBatchUiBusy(false);
    await refreshTickets({ reset: false });
    renderTicketList();
  }
}

async function ensureChinaCitiesLoaded() {
  if (chinaCitiesJsonCache) return chinaCitiesJsonCache;
  const raw = await window.ttDesktopApi?.loadChinaCities?.();
  if (!raw || !raw.data) throw new Error("无法读取 assets/china_cities.json");
  chinaCitiesJsonCache = raw;
  if (window.TTTitlePrefix && typeof window.TTTitlePrefix.prepareMatchers === "function") {
    window.TTTitlePrefix.prepareMatchers(raw);
  }
  return chinaCitiesJsonCache;
}

function formatTitleStationSourceHint(res) {
  if (!res) return "";
  if (res.stationCombineNote) return `\n  站/仓/店：${String(res.stationCombineNote).slice(0, 80)}`;
  if (res.stationSource === "warehouse+arch") {
    return `\n  站/仓/店：字段+架构${res.archLocSeg ? `（架构段「${String(res.archLocSeg).slice(0, 20)}」）` : ""}`;
  }
  if (res.archLocSeg && res.stationSource === "arch") {
    return `\n  站/仓/店：架构「${String(res.archLocSeg).slice(0, 36)}」`;
  }
  if (res.stationSource === "warehouse") return "\n  站/仓/店：仓库/门店字段";
  if (res.stationSource === "path") return "\n  站/仓/店：架构末级";
  return "";
}

function ticketKeyForTitle(item) {
  return String(item?.id || "").trim() || makeStableKey(item);
}

function resetTitleNewTicketBaseline() {
  knownTicketKeysForTitle = new Set();
  for (const t of getMyTodoTicketsForTitleOps(tickets)) {
    const k = ticketKeyForTitle(t);
    if (k) knownTicketKeysForTitle.add(k);
  }
}

/** @param {TicketItem[]} list */
function detectNewTicketsForTitle(list) {
  return getMyTodoTicketsForTitleOps(list).filter((t) => {
    const k = ticketKeyForTitle(t);
    return k && !knownTicketKeysForTitle.has(k);
  });
}

/** @param {TicketItem[]} items */
function markTicketsKnownForTitle(items) {
  for (const t of items) {
    const k = ticketKeyForTitle(t);
    if (k) knownTicketKeysForTitle.add(k);
  }
}

function shouldNotifyTitleSkip(reason) {
  const r = String(reason || "");
  return (
    r.includes("无法解析城市") ||
    r.includes("请手动改标题") ||
    r.includes("无发起人架构") ||
    r.includes("无事业部") ||
    r.includes("未能解析事业部") ||
    r.includes("无站点信息")
  );
}

function notifyTitleNormalizeIssue(item, title, body) {
  void window.ttDesktopApi?.showSlaNotification?.({
    title: String(title || "来单改标题").trim(),
    body: String(body || "").trim()
  });
}

function normalizeDescToText(desc) {
  const s = String(desc || "");
  if (!s) return "";
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}

function parseWarehouseFromDesc(desc) {
  const text = normalizeDescToText(desc);
  if (!text) return "";
  const m =
    text.match(/门店名称\s*[:：]\s*([^\n]+)/) ||
    text.match(/仓库(?:\/门店)?名称\s*[:：]\s*([^\n]+)/) ||
    text.match(/门店\s*[:：]\s*([^\n]+)/);
  return m ? String(m[1] || "").trim() : "";
}

function buildInspectFromApiTicket(ticketData) {
  const t = ticketData || {};
  const architectureRaw = String(t.org || t.reporterOrg || "").trim();
  const warehouseStore = parseWarehouseFromDesc(t.desc || t.description || "");
  const currentTitle = String(t.name || t.title || t.ticketName || "").trim();
  return { architectureRaw, warehouseStore, currentTitle };
}

function mergeInspectPreferApi(domInspect, apiInspect) {
  const d = domInspect || {};
  const a = apiInspect || {};
  return {
    architectureRaw: String(d.architectureRaw || a.architectureRaw || "").trim(),
    warehouseStore: String(a.warehouseStore || d.warehouseStore || "").trim(),
    currentTitle: String(a.currentTitle || d.currentTitle || "").trim()
  };
}

async function inspectTicketItemForTitle(item) {
  const opened = await handleTicketClick(item, { skipRefresh: true });
  if (!opened) {
    return { ok: false, opened: false, reason: "无法打开工单" };
  }
  await sleep(650);
  const domInspect = await ttExecuteJavaScript(buildTitleNormalizeInspectScript());
  let inspect = domInspect;
  if (item.id) {
    try {
      const detailRes = await window.ttDesktopApi?.queryTicketDetailByApi?.({
        username: getHandler(),
        ticketId: item.id
      });
      if (detailRes?.ok && detailRes?.data?.code === 200 && detailRes?.data?.data) {
        const apiInspect = buildInspectFromApiTicket(detailRes.data.data);
        inspect = mergeInspectPreferApi(domInspect, apiInspect);
      }
    } catch {
      // ignore
    }
  }
  const res = window.TTTitlePrefix.computeExpectedTitle(inspect, chinaCitiesJsonCache);
  return { ok: true, opened: true, inspect, res };
}

function canRunTitleNormalizeOp({ allowWhileRunning = false } = {}) {
  if (!webviewReady || !ttWebview) {
    log("请先等待 TT 页面加载完成。", "warning");
    return false;
  }
  if (titleNormalizeInProgress) return false;
  if (priorityBatchInProgress) {
    log("请等待「批量设置优先级」完成后再改标题。", "warning");
    return false;
  }
  if (pmPullInProgress) {
    log("请等待「按地区拉PM」完成后再改标题。", "warning");
    return false;
  }
  if (!allowWhileRunning && running) {
    log("请先停止「开始」自动处理，再执行标题检测。", "warning");
    return false;
  }
  if (allowWhileRunning && !running) {
    log("请先点击顶部「开始」，再使用来单改标题。", "warning");
    return false;
  }
  if (!window.TTTitlePrefix || typeof window.TTTitlePrefix.computeExpectedTitle !== "function") {
    log("标题引擎未加载（缺少 titlePrefixEngine.js）。", "error");
    return false;
  }
  return true;
}

/**
 * 来单改标题：仅「开始」后新出现的待处理单（含转单）；检测后 confirm 写入。
 * @param {{ triggeredBy?: string }} [opts]
 */
async function runNewTicketTitleNormalize(opts = {}) {
  const tag = String(opts.triggeredBy || "来单改标题").trim();
  if (!canRunTitleNormalizeOp({ allowWhileRunning: true })) return;

  titleNormalizeInProgress = true;
  if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = true;
  if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = true;

  try {
    await ensureChinaCitiesLoaded();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[${tag}] 加载城市词典失败：${msg}`, "error");
    notifyTitleNormalizeIssue(null, `${tag}：词典加载失败`, msg);
    titleNormalizeInProgress = false;
    if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = !running;
    if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = running;
    return;
  }

  const newOnes = sortTickets(detectNewTicketsForTitle(tickets));
  if (!newOnes.length) {
    log(`[${tag}] 没有新工单（相对本次「开始」后的基线）。`, "muted");
    titleNormalizeInProgress = false;
    if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = !running;
    if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = running;
    return;
  }

  setActiveLeftTab("logs");
  log(`[${tag}] 发现 ${newOnes.length} 条新工单，开始检测标题…`, "info");

  /** @type {{ item: TicketItem, expected: string, currentTitle: string }[]} */
  const toApply = [];
  const processed = [];

  try {
    for (let i = 0; i < newOnes.length; i += 1) {
      const item = newOnes[i];
      const label = (item.title || item.id || String(i)).slice(0, 60);
      const inspected = await inspectTicketItemForTitle(item);
      processed.push(item);

      if (!inspected.opened) {
        log(`[${tag}] ${label} — 无法打开工单，跳过（继续接单流程）`, "warning");
        notifyTitleNormalizeIssue(item, `${tag}：无法打开`, label);
        continue;
      }

      const res = inspected.res;
      if (res.skip) {
        const skipReason = res.reason || "跳过";
        const skipLevel =
          skipReason.includes("无法解析城市") || skipReason.includes("请手动改标题") ? "error" : "muted";
        log(`[${tag}] ${label} — ${skipReason}（已跳过，可继续接单）`, skipLevel);
        if (shouldNotifyTitleSkip(skipReason)) {
          notifyTitleNormalizeIssue(item, `${tag}：已跳过`, `${label}\n${skipReason}`);
        }
        continue;
      }

      log(
        `[${tag}] ${label}\n  当前：${(res.currentTitle || "").slice(0, 100)}\n  建议：${(res.expected || "").slice(0, 120)}${formatTitleStationSourceHint(res)}`,
        "info"
      );
      toApply.push({ item, expected: res.expected, currentTitle: res.currentTitle || "" });
    }

    markTicketsKnownForTitle(processed.length ? processed : newOnes);

    if (!toApply.length) {
      log(`[${tag}] 结束：无需修改标题。`, "success");
      await refreshTickets({ reset: false });
      return;
    }

    const ok = window.confirm(
      `[${tag}] 共 ${toApply.length} 条新工单建议改标题，是否在 TT 中逐条写入？\n（将自动点开标题、填入、失焦保存）`
    );
    if (!ok) {
      log(`[${tag}] 已取消写入标题。`, "warning");
      await refreshTickets({ reset: false });
      return;
    }

    for (let j = 0; j < toApply.length; j += 1) {
      const row = toApply[j];
      const opened2 = await handleTicketClick(row.item, { skipRefresh: true });
      if (!opened2) {
        log(`[${tag}] 标题写入跳过（未打开）：${(row.item.title || "").slice(0, 40)}`, "warning");
        notifyTitleNormalizeIssue(row.item, `${tag}：写入跳过`, "未能打开工单详情");
        continue;
      }
      await sleep(900);
      const applyRes = await ttExecuteJavaScript(buildApplyTitleScript(row.expected));
      if (!applyRes?.ok) {
        const extra =
          applyRes?.reason === "verify_mismatch"
            ? `（界面仍为「${String(applyRes.actual || "").slice(0, 80)}」）`
            : "";
        log(`[${tag}] 标题写入失败：${(row.item.title || "").slice(0, 40)} — ${applyRes?.reason || "unknown"}${extra}`, "error");
        notifyTitleNormalizeIssue(
          row.item,
          `${tag}：写入失败`,
          `${(row.item.title || "").slice(0, 40)}\n${applyRes?.reason || "unknown"}${extra}`
        );
      } else {
        log(`[${tag}] 标题已写入：${row.expected.slice(0, 100)}`, "success");
      }
      await sleep(400);
    }

    log(`[${tag}] 标题写入完成。`, "success");
    await refreshTickets({ reset: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[${tag}] 中断：${msg}`, "error");
    notifyTitleNormalizeIssue(null, `${tag}：中断`, msg);
    try {
      await refreshTickets({ reset: false });
    } catch {
      // ignore
    }
  } finally {
    titleNormalizeInProgress = false;
    if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = !running;
    if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = running;
    queueMicrotask(() => {
      flushTitleOnNewQueueIfPossible().catch(() => {});
      flushAutoPriorityBoostQueueIfPossible().catch(() => {});
    });
  }
}

function requestTitleOnNewAfterRefresh() {
  if (!running || !titleOnNewAutoEnabled) return;
  if (titleNormalizeInProgress) {
    titleOnNewQueued = true;
    log("[来单改标题] 已排队：将在当前标题任务结束后执行。", "muted");
    return;
  }
  if (busy || batchInProgress || pendingRunAfterReload || priorityBatchInProgress || pmPullInProgress) {
    titleOnNewQueued = true;
    return;
  }
  const newOnes = detectNewTicketsForTitle(tickets);
  if (!newOnes.length) return;
  queueMicrotask(() => {
    runNewTicketTitleNormalize({ triggeredBy: "来单改标题-自动" }).catch(() => {});
  });
}

async function flushTitleOnNewQueueIfPossible() {
  if (!titleOnNewQueued) return;
  if (!running || !titleOnNewAutoEnabled) {
    titleOnNewQueued = false;
    return;
  }
  if (titleNormalizeInProgress || busy || batchInProgress || pendingRunAfterReload || priorityBatchInProgress || pmPullInProgress) {
    return;
  }
  titleOnNewQueued = false;
  const newOnes = detectNewTicketsForTitle(tickets);
  if (!newOnes.length) return;
  await runNewTicketTitleNormalize({ triggeredBy: "来单改标题-自动" });
}

/**
 * 标题巡检：调用 titlePatrolList.js（仅列表标题粗检），与 titlePrefixEngine（标题检测）分离。
 * @param {{ forced?: boolean }} [opts] forced 为 true 时无视顶部「标题巡检」勾选（工单面板按钮手动跑一次）
 */
function runTicketTitlePatrolScan(opts) {
  const forced = !!(opts && opts.forced);
  if (!forced && !getTitlePatrolLogEnabled()) return;

  const patrol = window.TTTitlePatrolList;
  if (!patrol || typeof patrol.patrolListTitles !== "function") {
    log("[标题巡检] 未加载 titlePatrolList.js。", "error");
    return;
  }

  const scoped = getMyTodoTicketsForTitleOps(tickets);
  const list = sortTickets(scoped);
  if (!list.length) {
    log("[标题巡检] 当前处理人待处理工单为空，已跳过。", "muted");
    return;
  }

  const sum = patrol.patrolListTitles(list);
  const tag = forced ? "（手动）" : "";
  const detail =
    sum.badTotal > 0
      ? `；不规范 ${sum.badTotal} 条（${Object.entries(sum.badReasons)
          .map(([k, v]) => `${k} ${v}`)
          .join("，")}）`
      : "";
  const line = `[标题巡检]${tag} 仅列表标题：共 ${sum.total} 条，通过 ${sum.okCount} 条${detail}。`;
  log(line, sum.badTotal > 0 ? "warning" : "info");

  if (sum.badTotal > 0 && Array.isArray(sum.badItems) && sum.badItems.length) {
    const slice = sum.badItems.slice(0, TITLE_PATROL_LOG_BAD_MAX);
    for (const row of slice) {
      const idPart = row.id ? `#${row.id} ` : "";
      const titleShow = (row.title || "").slice(0, 80);
      log(`[标题巡检] 不规范 ${idPart}${titleShow}\n  原因：${row.reason}`, "warning");
    }
    const rest = sum.badItems.length - slice.length;
    if (rest > 0) {
      log(`[标题巡检] … 另有 ${rest} 条未列出（单次最多 ${TITLE_PATROL_LOG_BAD_MAX} 条）。`, "muted");
    }
  }
}

async function runTicketTitleNormalizeBatch() {
  if (!canRunTitleNormalizeOp({ allowWhileRunning: false })) return;

  titleNormalizeInProgress = true;
  if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = true;

  try {
    await ensureChinaCitiesLoaded();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`加载城市词典失败：${msg}`, "error");
    titleNormalizeInProgress = false;
    if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = false;
    return;
  }

  const scoped = getMyTodoTicketsForTitleOps(tickets);
  const list = sortTickets(scoped);
  if (!list.length) {
    log("当前处理人无待处理工单，请先刷新工单列表。", "muted");
    titleNormalizeInProgress = false;
    if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = false;
    return;
  }

  setActiveLeftTab("logs");
  log(`开始检测工单标题（共 ${list.length} 条）…`, "info");

  /** @type {{ item: TicketItem, expected: string, currentTitle: string, reason?: string }[]} */
  const toApply = [];

  try {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const label = (item.title || item.id || String(i)).slice(0, 60);
      const inspected = await inspectTicketItemForTitle(item);
      if (!inspected.opened) {
        log(`[标题] 无法打开工单，跳过：${label}`, "warning");
        continue;
      }
      const res = inspected.res;
      if (res.skip) {
        const skipReason = res.reason || "跳过";
        // 需人工处理：用 error 样式标红警示（与 muted 跳过区分）
        const skipLevel =
          skipReason.includes("无法解析城市") || skipReason.includes("请手动改标题") ? "error" : "muted";
        log(`[标题] ${label} — ${skipReason}`, skipLevel);
      } else {
        log(
          `[标题] ${label}\n  当前：${(res.currentTitle || "").slice(0, 100)}\n  建议：${(res.expected || "").slice(0, 120)}${formatTitleStationSourceHint(res)}`,
          "info"
        );
        toApply.push({ item, expected: res.expected, currentTitle: res.currentTitle || "" });
      }
    }

    if (!toApply.length) {
      log("标题检测结束：没有需要修改的工单。", "success");
      await refreshTickets({ reset: false });
      return;
    }

    const ok = window.confirm(
      `检测完成：共 ${toApply.length} 条建议修改标题，是否在 TT 中逐条写入？\n（将自动点开标题、填入、失焦保存）`
    );
    if (!ok) {
      log("已取消写入标题。", "warning");
      await refreshTickets({ reset: false });
      return;
    }

    for (let j = 0; j < toApply.length; j += 1) {
      const row = toApply[j];
      const opened2 = await handleTicketClick(row.item, { skipRefresh: true });
      if (!opened2) {
        log(`标题写入跳过（未打开工单）：${(row.item.title || "").slice(0, 40)}`, "warning");
        continue;
      }
      await sleep(900);
      const applyRes = await ttExecuteJavaScript(buildApplyTitleScript(row.expected));
      if (!applyRes?.ok) {
        const extra =
          applyRes?.reason === "verify_mismatch"
            ? `（界面仍为「${String(applyRes.actual || "").slice(0, 80)}」，期望「${String(applyRes.expected || "").slice(0, 80)}」）`
            : "";
        log(`标题写入失败：${(row.item.title || "").slice(0, 40)} — ${applyRes?.reason || "unknown"}${extra}`, "error");
      } else {
        log(`标题已写入：${row.expected.slice(0, 100)}`, "success");
      }
      await sleep(400);
    }

    log("标题批量写入完成。", "success");
    await refreshTickets({ reset: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`标题检测中断：${msg}`, "error");
    try {
      await refreshTickets({ reset: false });
    } catch {
      // ignore
    }
  } finally {
    titleNormalizeInProgress = false;
    if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = false;
  }
}

/** @returns {Promise<boolean>} 是否成功在 webview 中打开该工单 */
async function handleTicketClick(item, options = {}) {
  if (!ttWebview) return false;

  const skipRefresh = !!options.skipRefresh;

  const safeId = item.id ? JSON.stringify(item.id) : "null";
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
      function getActiveIdFromDetail() {
        const detail =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        if (!detail) return '';
        const items = Array.from(detail.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('编号')) continue;
          const val = norm(it.querySelector('.info-text')?.textContent || '');
          const m = val.match(/\\d{6,}/);
          if (m) return m[0];
        }
        const m2 = norm(detail.textContent || '').match(/编号\\s*[:：]\\s*(\\d{6,})/);
        return m2 ? m2[1] : '';
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
          const raw = norm(it.textContent || '');
          let id = '';
          const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/) || raw.match(/\\b(\\d{8,})\\b/);
          if (mid) id = mid[1];
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
    if (!skipRefresh) await refreshTickets({ reset: false });
    return false;
  }

  await sleep(250);
  if (!skipRefresh) await refreshTickets({ reset: false });
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
  if (!webviewReady || !ttWebview) return;
  if (ticketRefreshInFlight) return;
  try {
    const res = await ttExecuteJavaScript(buildScrollTicketListScript({ direction: "down" }));
    if (!res?.ok || res?.atEnd) return;
    await sleep(120);
    await refreshTickets({ reset: false });
  } catch {
    // ignore
  }
}

function buildCheckAndHandleScript(handler, autoCreateGroup, elephantMessage, elephantMessageEn, autoSendMessage) {
  const safeHandler = JSON.stringify(handler);
  const safeAuto = autoCreateGroup ? "true" : "false";
  const safeElephantMessage = JSON.stringify(elephantMessage || "");
  const safeElephantMessageEn = JSON.stringify(elephantMessageEn || "");
  const safeAutoSendMessage = autoSendMessage ? "true" : "false";
  const safeElephantRules = JSON.stringify(loadElephantRules());

  return `
    (async () => {
      const handler = ${safeHandler};
      const autoCreateGroup = ${safeAuto};
      const elephantMessage = ${safeElephantMessage};
      const elephantMessageEn = ${safeElephantMessageEn};
      const elephantRules = ${safeElephantRules};
      const autoSendMessage = ${safeAutoSendMessage};
      const HANDLE_TEXTS = ['开始处理', '开启处理'];

      function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ''); }
      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
      }

      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }

      async function waitForListWrapper(maxWaitMs = 8000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          const wrapper = getListWrapper();
          if (wrapper) return wrapper;
          await sleep(intervalMs);
        }
        return null;
      }

      function getDetailScope() {
        return (
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container')
        );
      }

      function isDetailTicketPending(scope) {
        if (!scope) return false;
        const icon = scope.querySelector('.detail-state .ticket-state-icon, .ticket-state .ticket-state-icon');
        if (icon?.classList.contains('ticket-state-todo')) return true;
        if (icon?.classList.contains('ticket-state-doing') || icon?.classList.contains('ticket-state-pending')) return false;

        const text = scope.querySelector('.detail-state .ticket-state-text, .ticket-state .ticket-state-text')?.textContent?.trim() || '';
        if (text.includes('暂停')) return false;
        if (text.includes('未处理')) return true;
        return false;
      }

      function isTargetHandler(scope) {
        if (!scope) return false;
        if ((scope.textContent || '').includes(handler)) return true;

        const filterContainer = document.querySelector('.filter-form, .ticket-filter, .filter-list-container');
        if (filterContainer) {
          const tags = filterContainer.querySelectorAll('.mtd-tag-content');
          for (const tag of tags) {
            if ((tag.textContent || '').trim().includes(handler)) return true;
          }
        }
        return false;
      }

      function clickCreateGroupButton() {
        const scope = getDetailScope();
        if (!scope) return '';
        const groupContainer = scope.querySelector('.ticket-dx-group-container');
        if (!groupContainer) return '';

        const buttons = groupContainer.querySelectorAll('button.mtd-btn');
        let joinBtn = null;
        let hasAlreadyBuilt = false;

        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const text = norm(btn.textContent);
          if (!text) continue;

          if (text.includes('创建大象群')) {
            btn.click();
            return 'create';
          }
          if (text.includes('加入大象群')) {
            joinBtn = btn;
            continue;
          }
          if (text.includes('已建群')) {
            hasAlreadyBuilt = true;
          }
        }

        if (joinBtn) {
          joinBtn.click();
          return 'join';
        }

        if (hasAlreadyBuilt) return 'already';
        return '';
      }

      function clickConfirmInAddMemberModal() {
        const dialogs = Array.from(document.querySelectorAll('.create-chatroom-dialog.form-dialog, .mtd-modal'));
        for (const dialog of dialogs) {
          if (!isVisible(dialog)) continue;

          const titleText = norm(dialog.querySelector('.mtd-modal-title')?.textContent || '');
          const dialogText = norm(dialog.textContent || '');
          const isTargetModal = titleText.includes('添加大象群成员') || dialogText.includes('拉入全部抄送人');
          if (!isTargetModal) continue;

          const buttons = Array.from(dialog.querySelectorAll('.mtd-modal-footer button.mtd-btn-primary, .mtd-modal-footer button'));
          for (const btn of buttons) {
            if (!isVisible(btn)) continue;
            const text = norm(btn.textContent || '');
            if (!text.includes('确定')) continue;
            btn.click();
            return true;
          }
        }
        return false;
      }

      async function waitAndConfirmAddMemberModal(maxWaitMs = 15000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          if (clickConfirmInAddMemberModal()) return true;
          await sleep(intervalMs);
        }
        return false;
      }

      function hasElephantSessionTab() {
        const tabLabels = Array.from(document.querySelectorAll('.content-tabs .mtd-tabs-item-label, .content-tabs .mtd-tabs-item'));
        for (const el of tabLabels) {
          const text = norm(el.textContent || '');
          if (text.includes('大象会话')) return true;
        }
        return false;
      }

      async function waitForElephantSessionTab(maxWaitMs = 12000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          if (hasElephantSessionTab()) return true;
          await sleep(intervalMs);
        }
        return false;
      }

      function getCurrentTicketTitle() {
        const detailRoot =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        const titleFromDetail = detailRoot?.querySelector('.ticket-name-text-display')?.textContent?.trim();
        if (titleFromDetail) return titleFromDetail;

        const titleFromList =
          document.querySelector('.handle-ticket-nav-item-active .ticket-name-text-display')?.textContent?.trim() ||
          document.querySelector('.handle-ticket-nav-item-active .content.title')?.textContent?.trim();
        if (titleFromList) return titleFromList;

        const titleFromEdit = document.querySelector('.ticket-edit-title textarea')?.value?.trim();
        if (titleFromEdit) return titleFromEdit;

        const titleHeader = document.querySelector('.ticket-edit-title')?.textContent?.trim();
        if (titleHeader) return titleHeader;
        return '';
      }

      function normalizeTitleForKeywordMatch(raw) {
        return String(raw || '').toLowerCase().replace(/\\s+/g, '');
      }

      function chooseElephantMessageByTitle() {
        const title = getCurrentTicketTitle() || '';
        const normTitle = normalizeTitleForKeywordMatch(title);

        if (Array.isArray(elephantRules) && elephantRules.length > 0) {
          for (const rule of elephantRules) {
            const keywords = Array.isArray(rule?.keywords) ? rule.keywords : [];
            const msg = (rule?.message || '').trim();
            if (!msg || keywords.length === 0) continue;
            for (const kw of keywords) {
              const k = String(kw || '').trim();
              if (!k) continue;
              const nk = normalizeTitleForKeywordMatch(k);
              if (nk && normTitle.includes(nk)) return msg;
            }
          }
        }

        const userZh = (elephantMessage || '').trim();
        const userEn = (elephantMessageEn || '').trim();
        const hasChinese = /[\\u4e00-\\u9fff]/.test(title);
        const hasEnglish = /[A-Za-z]/.test(title);

        if (hasChinese && userZh) return userZh;
        if (hasEnglish && userEn) return userEn;
        if (userZh) return userZh;
        if (userEn) return userEn;
        return '';
      }

      function findElephantSessionTabElement() {
        const candidates = Array.from(document.querySelectorAll('.content-tabs .mtd-tabs-item, .content-tabs .mtd-tabs-item-label, .content-tabs span'));
        for (const node of candidates) {
          const text = norm(node.textContent || '');
          if (!text.includes('大象会话')) continue;
          const tab = node.closest('.mtd-tabs-item') || node;
          if (isVisible(tab)) return tab;
        }
        return null;
      }

      async function openElephantSessionTab(maxWaitMs = 10000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          const tab = findElephantSessionTabElement();
          if (tab) {
            tab.click();
            await sleep(300);
            return true;
          }
          await sleep(intervalMs);
        }
        return false;
      }

      function findElephantTextarea() {
        const candidates = Array.from(document.querySelectorAll('.low-class textarea.text-area, textarea.text-area[placeholder*="请输入消息"], textarea.text-area'));
        for (const area of candidates) {
          if (isVisible(area)) return area;
        }
        return null;
      }

      function activateElephantTextarea(textarea) {
        if (!textarea) return false;

        const clickTargets = [
          textarea,
          textarea.closest('.low-class'),
          textarea.closest('.comment-edit-input'),
          textarea.parentElement
        ].filter(Boolean);

        for (const target of clickTargets) {
          try {
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch {}
        }

        try { textarea.click(); } catch {}
        try { textarea.focus({ preventScroll: true }); } catch {}
        try {
          const len = (textarea.value || '').length;
          textarea.setSelectionRange(len, len);
        } catch {}

        return document.activeElement === textarea;
      }

      function setTextareaValue(textarea, value) {
        activateElephantTextarea(textarea);
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function findSendButton() {
        const buttons = Array.from(document.querySelectorAll('button.mtd-btn.mtd-btn-primary, button.mtd-btn'));
        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const text = norm(btn.textContent || '');
          if (text.includes('发送')) return btn;
        }
        return null;
      }

      async function sendElephantMessage(maxWaitMs = 10000, intervalMs = 300) {
        const msg = chooseElephantMessageByTitle();
        if (!msg) return 'empty_message';

        const opened = await openElephantSessionTab(maxWaitMs, intervalMs);
        if (!opened) return 'tab_not_found';

        // 建群后系统会先发一条“机器人消息”，固定等 3 秒再发话术更稳
        await sleep(3000);

        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          const textarea = findElephantTextarea();
          const sendBtn = findSendButton();
          if (textarea && sendBtn) {
            activateElephantTextarea(textarea);
            await sleep(100);
            setTextareaValue(textarea, msg);
            await sleep(120);
            if (!((textarea.value || '').trim())) {
              activateElephantTextarea(textarea);
              await sleep(100);
              setTextareaValue(textarea, msg);
              await sleep(120);
            }
            sendBtn.click();
            return 'sent';
          }
          await sleep(intervalMs);
        }
        return 'editor_or_send_not_found';
      }

      function getSystemTodoCount() {
        const title = document.querySelector('.filter-title.filter-title-ishandle, .filter-title-ishandle');
        if (!title) return NaN;
        const text = title.textContent || '';
        const match = text.match(/\\((\\d+)\\)/);
        return match ? Number(match[1]) : NaN;
      }

      const systemTodoCount = getSystemTodoCount();
      const listWrapper = await waitForListWrapper(8000, 300);
      if (!listWrapper) return { status: 'no_list', pendingCount: systemTodoCount };

      const items = Array.from(listWrapper.querySelectorAll('.handle-ticket-nav-item'));
      const pendingItems = items.filter((item) => {
        const stateText = item.querySelector('.ticket-state-text')?.textContent?.trim() || '';
        const stateIcon = item.querySelector('.ticket-state-icon');
        if (stateText.includes('暂停') || !!stateIcon?.classList.contains('ticket-state-pending')) return false;
        return stateText.includes('未处理') || !!stateIcon?.classList.contains('ticket-state-todo');
      });

      if (pendingItems.length === 0) return { status: 'no_pending', pendingCount: systemTodoCount };

      const pendingItem = pendingItems[0];
      pendingItem.click();
      await sleep(1200);

      const scope = getDetailScope();
      if (!scope) return { status: 'no_detail', pendingCount: systemTodoCount };
      if (!isTargetHandler(scope)) return { status: 'handler_not_match', pendingCount: systemTodoCount };
      if (!isDetailTicketPending(scope)) return { status: 'state_not_pending', pendingCount: systemTodoCount };

      const actionRoot =
        document.querySelector('.ticket-handle-container') ||
        document.querySelector('.ticket-handle-buttons') ||
        document.querySelector('.right-button') ||
        document.querySelector('.ticket-detail-header .ticket-handle-container') ||
        document.querySelector('.ticket-content-main-container .right-button') ||
        scope;

      const nodes = actionRoot.querySelectorAll('button, [role="button"], .mtd-btn, .mtd-btn-text');
      for (const el of nodes) {
        const text = (el.textContent || '').trim();
        if (!text) continue;
        if (!HANDLE_TEXTS.some((t) => text.includes(t))) continue;

        el.click();
        if (!autoCreateGroup) return { status: 'clicked_handle', pendingCount: systemTodoCount };

        await sleep(1200);
        const groupAction = clickCreateGroupButton();
        if (!groupAction) return { status: 'clicked_handle|group_btn_not_found', pendingCount: systemTodoCount };

        if (groupAction === 'already') {
          const hasSession = await waitForElephantSessionTab(6000, 300);
          if (!hasSession) return { status: 'clicked_handle|group_already', pendingCount: systemTodoCount };
          if (!autoSendMessage) return { status: 'clicked_handle|group_session_ready_no_send', pendingCount: systemTodoCount };
          const sendResult = await sendElephantMessage(10000, 300);
          if (sendResult === 'sent') return { status: 'clicked_handle|group_session_ready_and_sent', pendingCount: systemTodoCount };
          return { status: 'clicked_handle|group_session_ready_but_send_failed', pendingCount: systemTodoCount };
        }

        if (groupAction === 'join') {
          const confirmed = await waitAndConfirmAddMemberModal(3500, 300);
          const hasSession = await waitForElephantSessionTab(12000, 300);
          if (hasSession) {
            if (!autoSendMessage) return { status: 'clicked_handle|group_session_ready_no_send', pendingCount: systemTodoCount };
            const sendResult = await sendElephantMessage(10000, 300);
            if (sendResult === 'sent') return { status: 'clicked_handle|group_session_ready_and_sent', pendingCount: systemTodoCount };
            return { status: 'clicked_handle|group_session_ready_but_send_failed', pendingCount: systemTodoCount };
          }
          return { status: confirmed ? 'clicked_handle|group_confirmed_no_session' : 'clicked_handle|group_joined', pendingCount: systemTodoCount };
        }

        const confirmed = await waitAndConfirmAddMemberModal();
        if (!confirmed) return { status: 'clicked_handle|group_no_confirm', pendingCount: systemTodoCount };

        const hasSession = await waitForElephantSessionTab(12000, 300);
        if (!hasSession) return { status: 'clicked_handle|group_confirmed_no_session', pendingCount: systemTodoCount };

        if (!autoSendMessage) return { status: 'clicked_handle|group_session_ready_no_send', pendingCount: systemTodoCount };
        const sendResult = await sendElephantMessage(10000, 300);
        if (sendResult === 'sent') return { status: 'clicked_handle|group_session_ready_and_sent', pendingCount: systemTodoCount };
        return { status: 'clicked_handle|group_session_ready_but_send_failed', pendingCount: systemTodoCount };
      }

      return { status: 'no_handle_btn', pendingCount: systemTodoCount };
    })();
  `;
}

function statusToMessage(status) {
  switch (status) {
    case "no_list":
      return "未找到工单列表，可能页面尚未加载完成。";
    case "no_pending":
      return "当前没有可开始处理的“未处理”工单。";
    case "no_detail":
      return "未找到工单详情区域，已跳过本轮。";
    case "handler_not_match":
      return "处理人不匹配，已跳过本轮。";
    case "state_not_pending":
      return "当前工单状态不是“未处理”，已跳过。";
    case "no_handle_btn":
      return "未找到“开始处理/开启处理”按钮。";
    case "clicked_handle":
      return "已自动点击“开始处理”。";
    case "clicked_handle|group_confirmed":
      return "已点击“开始处理”，并完成建群确认。";
    case "clicked_handle|group_session_ready":
      return "已创建/加入群聊，且已出现“大象会话”标签。";
    case "clicked_handle|group_session_ready_no_send":
      return "已创建/加入群聊并出现“大象会话”，当前配置为不自动发送话术。";
    case "clicked_handle|group_session_ready_and_sent":
      return "已创建/加入群聊，已打开“大象会话”并发送话术。";
    case "clicked_handle|group_session_ready_but_send_failed":
      return "已创建/加入群聊并出现“大象会话”，但未成功发送话术。";
    case "clicked_handle|group_confirmed_no_session":
      return "已点“确定”，但暂未检测到“大象会话”标签。";
    case "clicked_handle|group_btn_not_found":
      return "已点击“开始处理”，但未找到“创建大象群”按钮。";
    case "clicked_handle|group_already":
      return "已点击“开始处理”，该工单已存在大象群，无需重复建群。";
    case "clicked_handle|group_joined":
      return "已点击“开始处理”，并执行“加入大象群”。";
    case "clicked_handle|group_no_confirm":
      return "已点击“开始处理”，但建群确认按钮未找到。";
    default:
      return `脚本返回：${status}`;
  }
}

function statusToLevel(status) {
  if (!status) return "info";
  if (status === "unknown") return "error";

  if (
    status === "clicked_handle" ||
    status === "clicked_handle|group_confirmed" ||
    status === "clicked_handle|group_session_ready" ||
    status === "clicked_handle|group_session_ready_and_sent"
  ) return "success";

  if (status === "no_pending" || status === "handler_not_match" || status === "state_not_pending") {
    return "muted";
  }

  if (
    status === "no_list" ||
    status === "no_detail" ||
    status === "no_handle_btn" ||
    status === "clicked_handle|group_session_ready_no_send" ||
    status === "clicked_handle|group_session_ready_but_send_failed" ||
    status === "clicked_handle|group_confirmed_no_session" ||
    status === "clicked_handle|group_btn_not_found" ||
    status === "clicked_handle|group_already" ||
    status === "clicked_handle|group_joined" ||
    status === "clicked_handle|group_no_confirm"
  ) return "warning";

  return "info";
}

async function refreshPendingCount() {
  if (!webviewReady || !ttWebview) return;

  const maxRetries = 5;
  const retryDelayMs = 250;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const count = await ttExecuteJavaScript(buildPendingCountScript());
      const parsed = typeof count === "number" ? count : Number(count);
      if (Number.isFinite(parsed) && parsed >= 0) {
        updateTicketCount(parsed);
        return;
      }
    } catch {
      // ignore and retry
    }

    if (attempt < maxRetries - 1) {
      await sleep(retryDelayMs);
    }
  }

  updateTicketCount(NaN);
}

async function runCheck() {
  if (!running || busy || priorityBatchInProgress || pmPullInProgress || !webviewReady || !ttWebview) return null;
  busy = true;

  try {
    const handler = getHandler();
    const autoCreateGroup = !!(autoGroupInput && autoGroupInput.checked);
    const autoSendMessage = autoSendMessageInput
      ? !!autoSendMessageInput.checked
      : true;
    const elephantMessage = getElephantMessage();
    const elephantMessageEn = getElephantMessageEn();
    const script = buildCheckAndHandleScript(
      handler,
      autoCreateGroup,
      elephantMessage,
      elephantMessageEn,
      autoSendMessage
    );
    const result = await ttExecuteJavaScript(script);

    const status = result?.status || "unknown";
    const pendingCount = Number(result?.pendingCount);

    if (Number.isFinite(pendingCount) && pendingCount >= 0) updateTicketCount(pendingCount);
    log(statusToMessage(status), statusToLevel(status));
    return { status, pendingCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`执行失败：${message}`, "error");
    return { status: "unknown", pendingCount: NaN };
  } finally {
    busy = false;
  }
}

function isHandledStatus(status) {
  return typeof status === "string" && status.startsWith("clicked_handle");
}

function startBatchIfNeeded(reason = "定时触发") {
  if (!running || !ttWebview) return;
  if (batchInProgress || pendingRunAfterReload || busy || priorityBatchInProgress || pmPullInProgress) return;

  batchInProgress = true;
  batchHandledCount = 0;
  batchRemaining = DEFAULT_BATCH_LIMIT;
  log(`开始批量处理（${reason}），单轮上限 ${DEFAULT_BATCH_LIMIT} 单。`, "info");
  refreshPageThenRunCheck();
}

function finishBatch() {
  batchInProgress = false;
  batchRemaining = 0;
  queueMicrotask(() => {
    flushAutoPriorityBoostQueueIfPossible().catch(() => {});
  });
}

function handleBatchResult(result) {
  if (!batchInProgress || !running) return;

  const status = result?.status || "unknown";
  if (status === "no_pending") {
    const level = batchHandledCount > 0 ? "success" : "muted";
    log(`本轮结束：未处理工单已清空，本轮处理 ${batchHandledCount} 单，本次启动累计处理 ${sessionHandledCount} 单。`, level);
    finishBatch();
    return;
  }

  if (!isHandledStatus(status)) {
    log(`本轮结束：${statusToMessage(status)}（已处理 ${batchHandledCount} 单）`, statusToLevel(status));
    finishBatch();
    return;
  }

  batchHandledCount += 1;
  sessionHandledCount += 1;
  batchRemaining -= 1;
  log(`本轮进度：已处理 ${batchHandledCount} 单（本次启动累计 ${sessionHandledCount} 单）。`, "success");
  if (batchRemaining <= 0) {
    log(`达到单轮上限 ${DEFAULT_BATCH_LIMIT} 单，停止本轮批量处理。`, "warning");
    finishBatch();
    return;
  }

  setTimeout(() => {
    if (!running || !batchInProgress) return;
    refreshPageThenRunCheck();
  }, NEXT_TICKET_RELOAD_DELAY_MS);
}

function refreshPageThenRunCheck() {
  if (!running || !ttWebview || busy) return;

  pendingRunAfterReload = true;
  webviewReady = false;
  setWebviewLoadingHint(true);
  log("已执行页面刷新（F5）。", "info");

  try {
    ttWebview.reload();
  } catch {
    pendingRunAfterReload = false;
    webviewReady = true;
    if (running) {
      runCheck().then((result) => {
        handleBatchResult(result);
      });
    }
  }
}

function restartRunningTimers() {
  if (!running) return;

  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }

  const intervalMs = getIntervalSec() * 1000;
  scheduleNextRun();
  runTimer = setInterval(() => {
    scheduleNextRun();
    startBatchIfNeeded("定时触发");
  }, intervalMs);
  restartTitlePatrolTimer();
}

function start() {
  if (running) return;
  if (!ttWebview) {
    log("未找到 webview，无法启动自动处理。", "error");
    return;
  }

  clearTitlePatrolDebounce();
  saveSettings();
  setRunningState(true);
  scheduleNextRun();
  updateNextTickDisplay();

  restartRunningTimers();
  if (!countdownTimer) countdownTimer = setInterval(updateNextTickDisplay, 1000);

  resetTitleNewTicketBaseline();
  titleOnNewQueued = false;
  if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = false;
  log(
    `开始自动处理：间隔 ${getIntervalSec()} 秒，处理人 ${getHandler()}；来单改标题基线已建立（${knownTicketKeysForTitle.size} 条）。`,
    "success"
  );
  startBatchIfNeeded("启动后首轮");
}

function stop() {
  if (!running) return;
  setRunningState(false);
  autoPriorityBoostQueued = false;
  titleOnNewQueued = false;
  if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = true;
  stopTimers();
  restartTitlePatrolTimer();
  log("已停止自动处理。", "info");
}

function toggleStartStop() {
  if (running) stop();
  else start();
  // 与真实 running 同步（start 失败时 checkbox 可能已被用户点开）
  setRunningState(running);
}

function bindEvents() {
  if (startBtn) startBtn.addEventListener("change", toggleStartStop);
  if (templatesSaveBtn) templatesSaveBtn.addEventListener("click", saveTemplatesModal);
  if (templatesAddRuleBtn) templatesAddRuleBtn.addEventListener("click", addRule);
  if (templatesPreviewBtn) {
    templatesPreviewBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      previewTemplateMatchForActiveTicket();
    });
  }
  if (openLogsDirBtn) {
    openLogsDirBtn.addEventListener("click", async () => {
      try {
        const result = await window.ttDesktopApi?.openLogsDir?.();
        if (typeof result === "string" && result.trim()) {
          log(`打开日志文件夹失败：${result}`, "warning");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`打开日志文件夹失败：${message}`, "warning");
      }
    });
  }
  if (tabLogsBtn) tabLogsBtn.addEventListener("click", () => setActiveLeftTab("logs"));
  if (tabTicketsBtn) {
    tabTicketsBtn.addEventListener("click", () => {
      setActiveLeftTab("tickets");
      refreshTickets({ reset: false }).catch(() => {});
    });
  }
  if (tabTemplatesBtn) {
    tabTemplatesBtn.addEventListener("click", () => {
      setActiveLeftTab("templates");
      loadTemplatesPanel();
    });
  }
  if (ticketRefreshBtn) ticketRefreshBtn.addEventListener("click", () => refreshTickets({ reset: true }));
  if (ticketTitlePatrolBtn) {
    ticketTitlePatrolBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runTicketTitlePatrolScan({ forced: true });
    });
  }
  if (ticketPriorityApplyBtn) {
    ticketPriorityApplyBtn.addEventListener("click", () => {
      applyPriorityForActiveTicket().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`设置优先级异常：${msg}`, "error");
      });
    });
  }
  if (ticketBatchSelectVisibleBtn) {
    ticketBatchSelectVisibleBtn.addEventListener("click", () => {
      if (priorityBatchInProgress) return;
      const filtered = applyTicketFilters(tickets);
      const sorted = sortTickets(filtered);
      for (const it of sorted) {
        const k = getTicketSelectKey(it);
        if (k) batchPrioritySelected.add(k);
      }
      updateBatchPrioritySelectionCount();
      renderTicketList();
    });
  }
  if (ticketBatchClearSelectionBtn) {
    ticketBatchClearSelectionBtn.addEventListener("click", () => {
      if (priorityBatchInProgress) return;
      batchPrioritySelected.clear();
      updateBatchPrioritySelectionCount();
      renderTicketList();
    });
  }
  if (ticketAutoPriorityBoostToggle) {
    ticketAutoPriorityBoostToggle.checked = autoPriorityBoostEnabled;
    ticketAutoPriorityBoostToggle.addEventListener("change", () => {
      autoPriorityBoostEnabled = !!ticketAutoPriorityBoostToggle.checked;
      saveSettings();
      log(`自动升高优先级：${autoPriorityBoostEnabled ? "已开启" : "已关闭"}`, autoPriorityBoostEnabled ? "info" : "muted");
      if (autoPriorityBoostEnabled) {
        requestAutoPriorityBoostFromRefresh();
      }
    });
  }
  if (ticketAutoPriorityBoostBtn) {
    ticketAutoPriorityBoostBtn.addEventListener("click", () => {
      if (priorityBatchInProgress) {
        log("正在批量设置优先级，稍后再试。", "warning");
        return;
      }
      if (titleNormalizeInProgress) {
        log("请等待「标题检测」完成后再执行关键词升高优先级。", "warning");
        return;
      }
      if (running) {
        log("请先停止「开始」自动处理，再执行关键词升高优先级。", "warning");
        return;
      }
      const filtered = applyTicketFilters(tickets);
      const sorted = sortTickets(filtered);
      batchPrioritySelected.clear();
      const hits = [];
      for (const it of sorted) {
        const k = getTicketSelectKey(it);
        if (!k) continue;
        const m = matchAutoPriorityBoost(it.title || "");
        if (!m.ok) continue;
        batchPrioritySelected.add(k);
        hits.push(m.hit);
      }
      updateBatchPrioritySelectionCount();
      renderTicketList();
      const uniqHits = Array.from(new Set(hits));
      const count = batchPrioritySelected.size;
      if (!count) {
        log(`未命中关键词（${AUTO_PRIORITY_BOOST_KEYWORDS.join(" / ")}）。`, "muted");
        return;
      }
      if (ticketPrioritySelect) ticketPrioritySelect.value = AUTO_PRIORITY_BOOST_TARGET;
      log(
        `关键词命中 ${count} 条（${uniqHits.slice(0, 6).join(" / ")}），将批量设置为「${AUTO_PRIORITY_BOOST_TARGET}(S3)」。`,
        "info"
      );
      applyPriorityBatch().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`关键词升高优先级异常：${msg}`, "error");
      });
    });
  }
  if (ticketPriorityBatchBtn) {
    ticketPriorityBatchBtn.addEventListener("click", () => {
      applyPriorityBatch().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`批量设置优先级异常：${msg}`, "error");
        priorityBatchInProgress = false;
        setPriorityBatchUiBusy(false);
      });
    });
  }
  if (ticketPriorityBatchStopBtn) {
    ticketPriorityBatchStopBtn.addEventListener("click", () => {
      if (priorityBatchInProgress) priorityBatchAbort = true;
    });
  }
  if (ticketTitleOnNewBtn) {
    ticketTitleOnNewBtn.disabled = !running;
    ticketTitleOnNewBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runNewTicketTitleNormalize({ triggeredBy: "来单改标题" }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`来单改标题异常：${msg}`, "error");
      });
    });
  }
  if (titleOnNewAutoInput) {
    titleOnNewAutoInput.addEventListener("change", () => {
      titleOnNewAutoEnabled = !!titleOnNewAutoInput.checked;
      saveSettings();
      if (!running && titleOnNewAutoEnabled) {
        log("「来单改标题（随开始）」已勾选：请先点「开始」后才会在刷新时发现新单并改标题。", "info");
      } else {
        log(`来单改标题（随开始）：${titleOnNewAutoEnabled ? "已开启" : "已关闭"}`, titleOnNewAutoEnabled ? "info" : "muted");
      }
    });
  }
  if (ticketTitleNormalizeBtn) {
    ticketTitleNormalizeBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runTicketTitleNormalizeBatch().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`标题检测异常：${msg}`, "error");
      });
    });
  }
  if (pmCsvSelectBtn) {
    pmCsvSelectBtn.addEventListener("click", () => {
      selectPmCsvFile().catch(() => {});
    });
  }
  if (pmPullByRegionBtn) {
    pmPullByRegionBtn.addEventListener("click", () => {
      runPmPullByRegion().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`按地区拉PM异常：${msg}`, "error");
        setPmPullBusy(false);
      });
    });
  }
  if (ticketTitleSearchInput) {
    ticketTitleSearchInput.addEventListener("input", () => {
      ticketTitleSearch = String(ticketTitleSearchInput.value || "");
      renderTicketList();
    });
  }
  if (ticketCategorySelect) {
    ticketCategorySelect.addEventListener("change", () => {
      ticketCategoryFilter = String(ticketCategorySelect.value || "all");
      renderTicketList();
    });
  }
  if (ticketOnlyMineInput) {
    ticketOnlyMineInput.checked = ticketOnlyMine;
    ticketOnlyMineInput.addEventListener("change", () => {
      ticketOnlyMine = !!ticketOnlyMineInput.checked;
      renderTicketList();
    });
  }
  if (ticketHideClosedInput) {
    ticketHideClosedInput.checked = ticketHideClosed;
    ticketHideClosedInput.addEventListener("change", () => {
      ticketHideClosed = !!ticketHideClosedInput.checked;
      renderTicketList();
    });
  }

  if (ticketSlaReminderToggle) {
    ticketSlaReminderToggle.addEventListener("change", () => {
      saveSettings();
      const on = !!ticketSlaReminderToggle.checked;
      log(`48h 时效提醒：${on ? "已开启" : "已关闭"}`, on ? "info" : "muted");
      renderTicketList();
      runSlaScan({ emitAlerts: on });
    });
  }
  if (ticketSlaNotifyToggle) {
    ticketSlaNotifyToggle.addEventListener("change", () => {
      saveSettings();
      log(`48h Windows 通知：${ticketSlaNotifyToggle.checked ? "已开启" : "已关闭"}`, "info");
    });
  }
  if (prioritySortBtn) {
    prioritySortBtn.addEventListener("click", () => {
      if (ticketSortMode === "priority") {
        prioritySortDir = prioritySortDir === -1 ? 1 : -1;
      } else {
        ticketSortMode = "priority";
        prioritySortDir = -1;
      }
      syncSortButtonText();
      renderTicketList();
    });
  }
  if (createdSortBtn) {
    createdSortBtn.addEventListener("click", () => {
      if (ticketSortMode === "created") {
        createdSortDir = createdSortDir === -1 ? 1 : -1;
      } else {
        ticketSortMode = "created";
        createdSortDir = -1;
      }
      syncSortButtonText();
      renderTicketList();
    });
  }
  if (ticketListEl) {
    ticketListEl.addEventListener("scroll", () => {
      const threshold = 120;
      const remaining = ticketListEl.scrollHeight - ticketListEl.scrollTop - ticketListEl.clientHeight;
      if (remaining < threshold) {
        loadMoreTickets().catch(() => {});
      }
    });
  }

  if (handlerInput) {
    handlerInput.addEventListener("change", () => {
      handlerInput.value = getHandler();
      saveSettings();
    });
  }

  if (intervalInput) {
    intervalInput.addEventListener("change", () => {
      intervalInput.value = String(getIntervalSec());
      saveSettings();
      restartRunningTimers();
      restartTitlePatrolTimer();
    });
  }

  if (autoGroupInput) autoGroupInput.addEventListener("change", saveSettings);
  if (autoSendMessageInput) autoSendMessageInput.addEventListener("change", saveSettings);
  if (titlePatrolLogInput) {
    titlePatrolLogInput.addEventListener("change", () => {
      saveSettings();
      if (titlePatrolLogInput.checked) {
        log("标题巡检：已开启，将按「间隔」用左侧列表标题做粗检（不打开 TT），与「开始」可同时运行。", "info");
      }
      restartTitlePatrolTimer();
    });
  }

  if (!ttWebview) return;

  // dom-ready 后再跑 executeJavaScript，避免与 guest 首屏绘制争抢
  const scheduleGuestIdleWork = (fn) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => {
        void Promise.resolve(fn()).catch(() => {});
      }, { timeout: 400 });
    } else {
      setTimeout(() => {
        void Promise.resolve(fn()).catch(() => {});
      }, 0);
    }
  };

  ttWebview.addEventListener("dom-ready", async () => {
    webviewReady = true;
    setWebviewLoadingHint(false);
    log("TT 页面已加载完成。", "success");
    scheduleGuestIdleWork(async () => {
      await refreshPendingCount();
      await refreshTickets({ reset: true });
    });
  });

  ttWebview.addEventListener("did-start-loading", () => {
    webviewReady = false;
  });

  ttWebview.addEventListener("did-stop-loading", () => {
    webviewReady = true;
    scheduleGuestIdleWork(async () => {
      await refreshPendingCount();
      await refreshTickets({ reset: false });
      if (running && pendingRunAfterReload) {
        pendingRunAfterReload = false;
        const result = await runCheck();
        handleBatchResult(result);
      }
    });
  });

  ttWebview.addEventListener("did-fail-load", (event) => {
    pendingRunAfterReload = false;
    setWebviewLoadingHint(false);
    if (batchInProgress) {
      log("页面刷新失败，本轮批量处理已中止。", "warning");
      finishBatch();
    }
    log(`页面加载失败：${event.errorDescription || event.errorCode}`, "error");
  });

  // guest preload：仅 x.sankuai.com/bridge 中转（大象自定义协议由主进程 TT 专用 partition 的 webRequest 拦截，不碰 guest）
  ttWebview.addEventListener("ipc-message", (event) => {
    const ch = event.channel;
    const arg0 = event.args && event.args[0];
    if (typeof arg0 !== "string" || !arg0.trim()) return;
    const u = arg0.trim();
    if (ch === "tt-bridge-in-webview") {
      setWebviewLoadingHint(true);
      try {
        if (typeof ttWebview.loadURL === "function") {
          void Promise.resolve(ttWebview.loadURL(u)).catch(() => {});
        } else {
          ttWebview.setAttribute("src", u);
        }
      } catch {
        ttWebview.setAttribute("src", u);
      }
      return;
    }
    if (ch === "tt-open-external" || ch === "tt-open-protocol") {
      void window.ttDesktopApi?.openExternal?.(u);
    }
  });

  setWebviewLoadingHint(true);
  try {
    ttWebview.setAttribute("partition", TT_WEBVIEW_PARTITION);
    ttWebview.setAttribute("preload", new URL("webview-preload.js", document.baseURI).href);
    ttWebview.setAttribute("src", TT_WEBVIEW_DEFAULT_SRC);
  } catch {
    try {
      ttWebview.setAttribute("partition", TT_WEBVIEW_PARTITION);
      ttWebview.setAttribute("src", TT_WEBVIEW_DEFAULT_SRC);
    } catch {
      setWebviewLoadingHint(false);
    }
  }
}

async function applyAppVersionDisplay() {
  try {
    const info = await window.ttDesktopApi?.getAppVersion?.();
    const v = info && typeof info === "object" && info.version ? String(info.version) : "";
    if (!v) return;
    const badge = document.getElementById("appVersionBadge");
    if (badge) badge.textContent = `v${v}`;
    document.title = `TTDesktop1.0 v${v} 桌面版`;
  } catch {
    // ignore
  }
}

async function logTtApiConfigStatus() {
  try {
    const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
    if (!st) return;
    if (st.ok) {
      log(`API 已配置（${st.env || "prod"}）：${st.configPath}`, "success");
    } else {
      log(st.message || `API 未配置：${st.configPath || ""}`, "warning");
    }
  } catch {
    // ignore
  }
}

function bindModuleDeps() {
  TD.sla.bind({
    makeStableKey,
    applyTicketFilters,
    getTickets: () => tickets
  });
  TD.templates.bind({
    getActiveTicketTitle: () => {
      const active = tickets.find((t) => t && t.isActive);
      return active?.title || "";
    }
  });
}

function init() {
  bindModuleDeps();
  loadSettings();
  if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = !running;
  if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = running;
  updatePmCsvPathLabel();
  updateTicketCount(NaN);
  updateNextTickDisplay();
  setRunningState(false);
  setActiveLeftTab("logs");
  updateTicketMeta(0);
  updateBatchPrioritySelectionCount();
  syncSortButtonText();
  bindEvents();
  void applyAppVersionDisplay();
  void logTtApiConfigStatus();
  ensureTicketElapsedTimer();
  restartTitlePatrolTimer();
}

init();
