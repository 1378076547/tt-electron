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

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHandler: () => "",
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

function makeStableKey(item) {
  const title = (item?.title || "").trim();
  const handler = (item?.handler || "").trim();
  const createdAtText = (item?.createdAtText || "").trim();
  // 列表里的时间（right-wrapper）在同一工单内通常稳定，点击/状态变化也不会变
  return `${title}|${handler}|${createdAtText}`;
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
  if (!item) return "";
  if (item.id) return `id:${item.id}`;
  const fp = item.fingerprint || "";
  return fp ? `fp:${fp}` : "";
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
    row.dataset.ticketId = item.id || "";
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
  if (!deps.getWebviewReady() || !deps.getTtWebview()) return;
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
  if (!deps.getWebviewReady() || !deps.getTtWebview()) return;
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
    loadMoreTickets,
    updateTicketMeta,
    syncSortButtonText
  };
})(window.TTDesktop);
