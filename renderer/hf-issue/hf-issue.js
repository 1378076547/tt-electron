/**
 * 高频问题识别：依赖「开始」→ 扫描 API 配置 MIS 的当前/来单 → 历史统计用 RG 全组
 * 刷新时立刻复读活跃告警；历史统计做了加速（站点关键词、30 天推导 7 天、命中后提前结束）
 */
(function initHfIssue(TD) {
  const D = TD.dom;
  const log = TD.log.log;
  const C = TD.constants;

  const MS_DAY = 86400000;
  /** 历史统计翻页上限（站点关键词命中后可提前结束） */
  const MAX_API_PAGES = 12;
  /** 单次统计最多收集的匹配单数（够判定阈值即可，避免无谓翻页） */
  const MATCH_COLLECT_CAP = 20;
  const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

  /** @type {Set<string>} */
  let knownTicketKeys = new Set();
  /** @type {Map<string, object>} */
  let activeAlerts = new Map();
  /** @type {Map<string, number>} */
  let notifyCooldown = new Map();
  let scanInFlight = false;
  /** @type {object|null} */
  let chinaJsonCache = null;
  /** @type {object|null} */
  let lastLoadedCfg = null;
  /** 重统计最短间隔：避免每次工单刷新都打满 API */
  const HF_SCAN_MIN_INTERVAL_MS = 5 * 60 * 1000;
  /** 轻量新单检查最短间隔 */
  const HF_LIGHT_CHECK_MIN_MS = 60 * 1000;
  let lastHfHeavyScanAt = 0;
  let lastHfLightCheckAt = 0;

  let deps = {
    getHandler: () => "",
    getTickets: () => [],
    getRunning: () => false,
    isApiConfigured: async () => false
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  function isFeatureEnabledInUi() {
    return true;
  }

  function normalizeKey(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeTicketId(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/^\d{6,}$/.test(s)) return s;
    const m = s.match(/\d{6,}/);
    return m ? m[0] : null;
  }

  function isClosedStatus(statusText) {
    const st = String(statusText || "").trim();
    return st.includes("已关闭") || st.includes("已完成");
  }

  function ticketKey(item) {
    return normalizeTicketId(item?.id) || "";
  }

  function alertMapKey(siteKey, categoryId) {
    return `${normalizeKey(siteKey)}|${categoryId}`;
  }

  function normalizeMis(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9._-]/g, "");
  }

  /** API 配置 MIS（tt-api.local.json username），无则回退界面处理人 */
  async function getApiUsername() {
    try {
      const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
      const u = String(st?.username || "").trim();
      if (u) return u;
    } catch {
      // ignore
    }
    return String(deps.getHandler() || "").trim();
  }

  function isOwnedByApiUser(item, apiMis) {
    const me = normalizeMis(apiMis);
    if (!me) return true;
    const owner = normalizeMis(item?.ownerMis || item?.assigneeMis || "");
    if (owner) return owner === me;
    return false;
  }

  function mapApiItem(api) {
    function pickAny(obj, keys) {
      for (const k of keys) {
        const v = obj?.[k];
        if (v != null && String(v).trim() !== "") return v;
      }
      return "";
    }
    const id =
      normalizeTicketId(
        pickAny(api, ["id", "ticketId", "ticketID", "ticketNo", "serialId", "number", "sn"]) ||
          pickAny(api?.ticket || {}, ["id", "ticketId"])
      ) || "";
    const title = String(api?.name || api?.title || api?.ticketName || "").trim();
    const statusText = String(api?.state || api?.status || api?.ticketState || "").trim();
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
    const createdRaw = api?.createdAt || api?.createTime || api?.gmtCreate || "";
    let createdAtEpoch = null;
    if (typeof createdRaw === "number" && Number.isFinite(createdRaw)) {
      createdAtEpoch = createdRaw < 1e12 ? createdRaw * 1000 : createdRaw;
    } else if (createdRaw) {
      const p = Date.parse(String(createdRaw));
      if (Number.isFinite(p)) createdAtEpoch = p;
    }
    return { id, title, statusText, ownerMis, assigneeMis: ownerMis, createdAtEpoch };
  }

  async function loadConfig() {
    try {
      const cfg = await window.ttDesktopApi?.getHfIssueConfig?.();
      if (cfg?.ok) return cfg;
    } catch {
      // ignore
    }
    return {
      enabled: true,
      notifyWindows: true,
      thresholds: { days7: 3, days30: 5 },
      categories: []
    };
  }

  async function getRgIds() {
    try {
      const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
      if (Array.isArray(st?.rgIds) && st.rgIds.length) return st.rgIds;
    } catch {
      // ignore
    }
    return Array.isArray(C.TARGET_RG_IDS) ? C.TARGET_RG_IDS.slice() : [];
  }

  async function ensureChinaCitiesLoaded() {
    if (chinaJsonCache) return chinaJsonCache;
    chinaJsonCache = await window.ttDesktopApi?.loadChinaCities?.();
    return chinaJsonCache;
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

  function pickEnglishCustomFromApiPayload(t) {
    const out = { englishCity: "", englishStore: "", englishIdName: "" };
    const lists = [t?.customFields, t?.customFieldList, t?.formFields, t?.fields].filter(Array.isArray);
    for (const list of lists) {
      for (const row of list) {
        const label = String(row?.label || row?.name || row?.fieldName || row?.key || "").trim();
        const val = String(row?.value || row?.fieldValue || row?.content || "").trim();
        if (!label || !val) continue;
        if (/^city$/i.test(label)) out.englishCity = val;
        else if (/^store$/i.test(label)) out.englishStore = val;
        else if (/id\s*&\s*name/i.test(label)) out.englishIdName = val;
      }
    }
    const text = normalizeDescToText(t?.desc || t?.description || "");
    const pick = (re) => {
      const m = text.match(re);
      return m ? String(m[1] || "").trim() : "";
    };
    if (!out.englishCity) out.englishCity = pick(/(?:^|\n)\s*City\s*[:：]\s*([^\n]+)/i);
    if (!out.englishStore) out.englishStore = pick(/(?:^|\n)\s*Store\s*[:：]\s*([^\n]+)/i);
    if (!out.englishIdName) out.englishIdName = pick(/(?:^|\n)\s*ID\s*&\s*Name\s*[:：]\s*([^\n]+)/i);
    return out;
  }

  function buildInspectFromApiTicket(ticketData) {
    const t = ticketData || {};
    const architectureRaw = String(t.org || t.reporterOrg || t.architecture || "").trim();
    const warehouseStore = parseWarehouseFromDesc(t.desc || t.description || "");
    const currentTitle = String(t.name || t.title || t.ticketName || "").trim();
    return { architectureRaw, warehouseStore, currentTitle, ...pickEnglishCustomFromApiPayload(t) };
  }

  async function fetchTicketDetail(ticketId, apiMis) {
    if (!ticketId) return null;
    try {
      const res = await window.ttDesktopApi?.queryTicketDetailByApi?.({
        username: apiMis || (await getApiUsername()),
        ticketId: String(ticketId)
      });
      if (res?.ok && res?.data?.code === 200 && res?.data?.data) {
        return res.data.data;
      }
    } catch {
      // ignore
    }
    return null;
  }

  function collectAllFaultTerms(categories) {
    const out = [];
    for (const c of categories || []) {
      for (const t of c.terms || []) {
        if (t) out.push(String(t));
      }
    }
    return out.sort((a, b) => b.length - a.length);
  }

  function extractEnglishSiteKeyFromTitle(title, faultTerms) {
    const t = String(title || "").trim().replace(/\s+/g, " ");
    if (!t) return "";
    const lower = t.toLowerCase();
    for (const term of faultTerms || []) {
      const idx = lower.indexOf(String(term).toLowerCase());
      if (idx > 0) {
        const prefix = t.slice(0, idx).trim();
        if (prefix.length >= 3) return prefix;
      }
    }
    const m = t.match(/^([A-Za-z]+(?:\s+\d{2,4})?\s+[A-Za-z][A-Za-z0-9\s-]{1,40})/);
    return m ? m[1].trim() : "";
  }

  async function resolveSiteKey(item, categories, apiMis) {
    const title = String(item?.title || "").trim();
    if (!title) return { siteKey: "", reason: "empty_title" };

    const engine = window.TTTitlePrefix;
    const faultTerms = collectAllFaultTerms(categories);

    // 英文标题：优先从标题抠站点，避免先打详情接口拖慢首报
    if (engine?.isEnglishDominantTitle?.(title)) {
      const fromTitle = extractEnglishSiteKeyFromTitle(title, faultTerms);
      if (fromTitle) return { siteKey: fromTitle, source: "title_en_fast" };

      const detail = item.id ? await fetchTicketDetail(item.id, apiMis) : null;
      const inspect = detail
        ? buildInspectFromApiTicket(detail)
        : { architectureRaw: "", warehouseStore: "", currentTitle: title };
      if (!inspect.currentTitle) inspect.currentTitle = title;
      if (engine?.computeExpectedTitle) {
        const en = engine.computeExpectedTitle(inspect, null);
        if (en?.prefix) return { siteKey: String(en.prefix).trim(), source: "engine_en" };
      }
      return { siteKey: "", reason: "en_site_unresolved" };
    }

    const detail = item.id ? await fetchTicketDetail(item.id, apiMis) : null;
    const inspect = detail
      ? buildInspectFromApiTicket(detail)
      : { architectureRaw: "", warehouseStore: "", currentTitle: title };
    if (!inspect.currentTitle) inspect.currentTitle = title;

    try {
      const china = await ensureChinaCitiesLoaded();
      if (engine?.computeExpectedTitle && china) {
        const res = engine.computeExpectedTitle(inspect, china);
        if (res?.prefix) return { siteKey: String(res.prefix).trim(), source: "engine_zh" };
        if (res?.buShort && res?.cityShort && res?.stationNorm) {
          return {
            siteKey: `${res.buShort}${res.cityShort}${res.stationNorm}`,
            source: "engine_zh_parts"
          };
        }
      }
    } catch {
      // ignore
    }

    return { siteKey: "", reason: "zh_site_unresolved" };
  }

  function matchCategories(title, categories) {
    const t = normalizeKey(title);
    const matched = [];
    for (const cat of categories || []) {
      const hit = (cat.terms || []).some((term) => t.includes(normalizeKey(term)));
      if (hit) matched.push(cat);
    }
    return matched;
  }

  /** 英文站点号 015 / 15 等等价；中文仍用包含匹配 */
  function normalizeSiteLooseKey(raw) {
    return normalizeKey(raw).replace(/\b0+(\d+)\b/g, "$1");
  }

  function siteKeyLooseMatch(title, siteKey) {
    const t = normalizeKey(title);
    const sk = normalizeKey(siteKey);
    if (!t || !sk) return false;
    if (t.includes(sk)) return true;
    const tLoose = normalizeSiteLooseKey(title);
    const skLoose = normalizeSiteLooseKey(siteKey);
    if (tLoose.includes(skLoose)) return true;
    const parts = sk.split(/\s+/).filter((p) => p.length >= 2);
    if (parts.length >= 2) {
      const city = parts[0];
      if (!t.includes(city) && !tLoose.includes(normalizeSiteLooseKey(city))) return false;
      return parts.slice(1).some((p) => {
        const pl = normalizeSiteLooseKey(p);
        return tLoose.includes(pl) || t.includes(p);
      });
    }
    return false;
  }

  function titleMatchesSiteAndCategory(title, siteKey, category) {
    if (!siteKeyLooseMatch(title, siteKey)) return false;
    const t = normalizeKey(title);
    return (category.terms || []).some((term) => t.includes(normalizeKey(term)));
  }

  async function fetchTicketsInWindow({
    rgIds,
    startMs,
    endMs,
    keyWord,
    apiMis,
    scopeAssignee = false,
    matchRow = null,
    stopWhenMatched = 0,
    maxPages = MAX_API_PAGES
  }) {
    const merged = new Map();
    const mis = scopeAssignee ? String(apiMis || "").trim() : "";
    let matchedCount = 0;
    for (let cn = 1; cn <= maxPages; cn += 1) {
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();
      const params = {
        rgIds,
        createdAtStart: startMs,
        createdAtEnd: endMs,
        createdAtBegin: startMs,
        createdAtFinish: endMs,
        startTime: startMs,
        endTime: endMs,
        createdAtStartTime: startIso,
        createdAtEndTime: endIso,
        keyWord: String(keyWord || "").trim(),
        keyword: String(keyWord || "").trim(),
        cn,
        sn: 100,
        orderField: "createdAt",
        orderKind: "DESC"
      };
      if (scopeAssignee && mis) {
        params.assigned = mis;
        params.assignee = mis;
        params.assigneeMis = mis;
        params.handlerMis = mis;
        params.processorMis = mis;
        params.dealUserMis = mis;
      } else {
        params.state = ["未处理", "处理中", "暂停中", "已关闭", "已完成"];
      }
      const r = await window.ttDesktopApi?.queryTicketsByApi?.({
        username: apiMis || (await getApiUsername()),
        params
      });
      if (!r?.ok || r?.data?.code !== 200) break;
      const items = Array.isArray(r?.data?.data?.items) ? r.data.data.items : [];
      if (!items.length) break;
      for (const x of items) {
        const row = mapApiItem(x);
        if (!row.id || merged.has(row.id)) continue;
        if (typeof matchRow === "function") {
          if (!matchRow(row)) continue;
          merged.set(row.id, row);
          matchedCount += 1;
          if (stopWhenMatched > 0 && matchedCount >= stopWhenMatched) {
            return Array.from(merged.values());
          }
        } else {
          merged.set(row.id, row);
        }
      }
      if (items.length < 100) break;
    }
    return Array.from(merged.values());
  }

  /** 拉 API 配置 MIS 的当前待处理工单（触发扫描用，不限创建时间） */
  async function fetchCurrentOpenTicketsForApiUser(rgIds, apiMis) {
    const merged = new Map();
    const mis = String(apiMis || "").trim();
    const state = ["未处理", "处理中", "暂停中"];
    for (let cn = 1; cn <= MAX_API_PAGES; cn += 1) {
      const r = await window.ttDesktopApi?.queryTicketsByApi?.({
        username: mis,
        params: {
          rgIds,
          assigned: mis,
          assignee: mis,
          assigneeMis: mis,
          handlerMis: mis,
          processorMis: mis,
          dealUserMis: mis,
          state,
          cn,
          sn: 100,
          orderField: "createdAt",
          orderKind: "DESC"
        }
      });
      if (!r?.ok || r?.data?.code !== 200) break;
      const items = Array.isArray(r?.data?.data?.items) ? r.data.data.items : [];
      if (!items.length) break;
      for (const x of items) {
        const row = mapApiItem(x);
        if (row.id && !merged.has(row.id)) merged.set(row.id, row);
      }
      if (items.length < 100) break;
    }
    return Array.from(merged.values()).filter(
      (row) => !isClosedStatus(row.statusText) && isOwnedByApiUser(row, apiMis)
    );
  }

  function pickKeyWords(siteKey, category, title) {
    const out = [];
    const sk = String(siteKey || "").trim();
    if (sk) out.push(sk);
    // 有明确站点关键词时不再附加故障词（如 Network），避免拉回大量无关单拖慢统计
    if (!sk) {
      const t = normalizeKey(title);
      for (const term of category?.terms || []) {
        if (term && t.includes(normalizeKey(term))) out.push(String(term));
      }
      if (!out.length && category?.terms?.[0]) out.push(category.terms[0]);
    }
    return Array.from(new Set(out.filter(Boolean)));
  }

  function ticketCreatedMs(row) {
    const raw = row?.createdAtEpoch;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw < 1e12 ? raw * 1000 : raw;
    }
    return 0;
  }

  /** 处理中 / 暂停中 / 未处理 均视为仍未关闭 */
  function isStillOpenStatus(statusText) {
    return !isClosedStatus(statusText);
  }

  async function fetchTicketsMergedKeyWords({
    rgIds,
    startMs,
    endMs,
    keyWords,
    apiMis,
    matchRow = null,
    stopWhenMatched = 0
  }) {
    const merged = new Map();
    const kws = Array.from(new Set((keyWords || []).map((k) => String(k || "").trim()).filter(Boolean)));
    const queries = kws.length ? kws : [""];
    // 多关键词并行，缩短等待
    const batches = await Promise.all(
      queries.map((kw) =>
        fetchTicketsInWindow({
          rgIds,
          startMs,
          endMs,
          keyWord: kw,
          apiMis,
          scopeAssignee: false,
          matchRow,
          stopWhenMatched
        })
      )
    );
    for (const rows of batches) {
      for (const row of rows) {
        if (row.id) merged.set(row.id, row);
      }
    }
    return Array.from(merged.values());
  }

  async function countMatchingTickets({ rgIds, siteKey, category, days, keyWords, apiMis, collectCap = MATCH_COLLECT_CAP }) {
    const endMs = Date.now();
    const startMs = endMs - days * MS_DAY;
    const primary = String(siteKey || "").trim();
    const effectiveKws = primary ? [primary] : keyWords;
    const matchRow = (row) => titleMatchesSiteAndCategory(row.title, siteKey, category);
    const raw = await fetchTicketsMergedKeyWords({
      rgIds,
      startMs,
      endMs,
      keyWords: effectiveKws,
      apiMis,
      matchRow,
      stopWhenMatched: Math.max(1, collectCap)
    });
    const allMatched = raw;
    const openMatched = allMatched.filter((row) => isStillOpenStatus(row.statusText));
    return { allMatched, openMatched, rawCount: raw.length };
  }

  function formatIdList(ids, max = 10) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return "（无未关闭单）";
    if (list.length <= max) return list.join("、");
    return `${list.slice(0, max).join("、")} 等 ${list.length} 单`;
  }

  function thresholdFlag(count, threshold) {
    return count >= threshold ? " ⚠" : "";
  }

  function logActiveAlert(alert, cfg, { isNew = false } = {}) {
    const th7 = cfg?.thresholds?.days7 ?? alert.threshold7 ?? 3;
    const th30 = cfg?.thresholds?.days30 ?? alert.threshold30 ?? 5;
    const level = alert.count7 >= th7 || alert.count30 >= th30 ? "error" : "warning";
    const head = isNew ? "⚠ 高频问题预警（单站反复）" : "⚠ 高频问题（单站反复）";
    log(
      `${head}：${alert.siteKey} · ${alert.categoryLabel}\n` +
        `  类型：同一站点在 7/30 天内反复报同类障（非短时多站爆发）\n` +
        `  7 天内 ${alert.count7} 单（预警线 ≥${th7}）${thresholdFlag(alert.count7, th7)}\n` +
        `  30 天内 ${alert.count30} 单（预警线 ≥${th30}）${thresholdFlag(alert.count30, th30)}\n` +
        `  相关工单：${formatIdList(alert.openTicketIds)}`,
      level
    );
  }

  /** 刷新时立刻复读：相关单仍在处理中/暂停中/未处理则继续提示 */
  function relogActiveAlerts() {
    if (!activeAlerts.size) return;
    const cfg = lastLoadedCfg || {
      thresholds: { days7: 3, days30: 5 }
    };
    for (const alert of activeAlerts.values()) {
      if (!(alert.openTicketIds || []).length) continue;
      logActiveAlert(alert, cfg, { isNew: false });
    }
  }

  function updateHfIssueUi() {
    const list = Array.from(activeAlerts.values());
    if (D.hfIssueHeaderBadgeEl) {
      if (!list.length) {
        D.hfIssueHeaderBadgeEl.hidden = true;
        D.hfIssueHeaderBadgeEl.textContent = "";
      } else {
        D.hfIssueHeaderBadgeEl.hidden = false;
        D.hfIssueHeaderBadgeEl.textContent = `高频单站 ${list.length}`;
      }
    }
    if (D.hfIssueSummaryEl) {
      if (!list.length) {
        D.hfIssueSummaryEl.hidden = true;
        D.hfIssueSummaryEl.textContent = "";
      } else {
        D.hfIssueSummaryEl.hidden = false;
        const lines = list.map((a) => {
          return `[高频·单站] ${a.siteKey} · ${a.categoryLabel}：7天 ${a.count7}单 / 30天 ${a.count30}单`;
        });
        D.hfIssueSummaryEl.textContent = lines.join(" ｜ ");
      }
    }
    try {
      void TD.sla?.paintTtSlaTitlesInWebview?.();
    } catch {
      // ignore
    }
  }

  function getActiveOpenTicketIds() {
    const ids = new Set();
    for (const alert of activeAlerts.values()) {
      for (const id of alert.openTicketIds || []) {
        const s = String(id || "").trim();
        if (s) ids.add(s);
      }
    }
    return Array.from(ids);
  }

  function shouldNotifyWindows(cfg) {
    return cfg.notifyWindows !== false;
  }

  function maybeNotifyWindows(alert, cfg) {
    if (!shouldNotifyWindows(cfg) || !isFeatureEnabledInUi()) return;
    const key = alertMapKey(alert.siteKey, alert.categoryId);
    const last = notifyCooldown.get(key) || 0;
    if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
    notifyCooldown.set(key, Date.now());
    void window.ttDesktopApi?.showSlaNotification?.({
      title: `高频问题·单站反复：${alert.categoryLabel}`,
      body: `${alert.siteKey}\n7天 ${alert.count7} 单 / 30天 ${alert.count30} 单\n${formatIdList(alert.openTicketIds, 5)}`
    });
  }

  async function evaluateSiteCategory({ siteKey, category, cfg, rgIds, keyWords, apiMis, isNewTrigger }) {
    const th7 = cfg.thresholds.days7;
    const th30 = cfg.thresholds.days30;
    // 只拉 30 天，7 天从结果推导，历史查询次数减半
    const r30 = await countMatchingTickets({
      rgIds,
      siteKey,
      category,
      days: 30,
      keyWords,
      apiMis,
      collectCap: Math.max(8, th30, th7)
    });
    const start7 = Date.now() - 7 * MS_DAY;
    const all7 = r30.allMatched.filter((t) => ticketCreatedMs(t) >= start7);
    const open7 = all7.filter((t) => isStillOpenStatus(t.statusText));
    const open30 = r30.openMatched;
    const openTicketIds = Array.from(
      new Set([...open7, ...open30].map((t) => t.id).filter(Boolean))
    );
    const count7 = all7.length;
    const count30 = r30.allMatched.length;
    const openCount7 = open7.length;
    const openCount30 = open30.length;
    const hit = count7 >= th7 || count30 >= th30;
    const mapKey = alertMapKey(siteKey, category.id);

    if (!hit) {
      if (activeAlerts.has(mapKey)) {
        activeAlerts.delete(mapKey);
        log(`高频问题已恢复：${siteKey} · ${category.label}。`, "success");
        updateHfIssueUi();
      }
      return null;
    }

    if (!openTicketIds.length) {
      if (activeAlerts.has(mapKey)) {
        activeAlerts.delete(mapKey);
        log(`高频问题已恢复：${siteKey} · ${category.label}（相关工单已关闭）。`, "success");
        updateHfIssueUi();
      }
      return null;
    }

    const prev = activeAlerts.get(mapKey);
    const alert = {
      siteKey,
      categoryId: category.id,
      categoryLabel: category.label,
      apiMis: apiMis || "",
      count7,
      count30,
      openCount7,
      openCount30,
      threshold7: th7,
      threshold30: th30,
      openTicketIds,
      updatedAt: Date.now()
    };
    activeAlerts.set(mapKey, alert);
    const grew =
      !prev || count7 > (prev.count7 || 0) || count30 > (prev.count30 || 0);
    // 周期性复读交给刷新时的 relogActiveAlerts；此处仅新触发/加重时写日志，避免重复刷屏
    if (isNewTrigger || !prev || grew) {
      logActiveAlert(alert, cfg, { isNew: isNewTrigger || !prev });
    }
    if (isNewTrigger || !prev || grew) {
      maybeNotifyWindows(alert, cfg);
    }
    updateHfIssueUi();
    return alert;
  }

  function markTicketsKnown(items) {
    for (const t of items || []) {
      const k = ticketKey(t);
      if (k) knownTicketKeys.add(k);
    }
  }

  function resetScanState() {
    knownTicketKeys = new Set();
    activeAlerts.clear();
    notifyCooldown.clear();
    updateHfIssueUi();
  }

  async function processTicketScan(item, cfg, rgIds, apiMis, { isNewTrigger = false } = {}) {
    const categories = matchCategories(item.title, cfg.categories);
    if (!categories.length) {
      markTicketsKnown([item]);
      return;
    }

    const { siteKey } = await resolveSiteKey(item, cfg.categories, apiMis);
    if (!siteKey) {
      markTicketsKnown([item]);
      return;
    }

    for (const category of categories) {
      const keyWords = pickKeyWords(siteKey, category, item.title);
      await evaluateSiteCategory({
        siteKey,
        category,
        cfg,
        rgIds,
        keyWords,
        apiMis,
        isNewTrigger
      });
    }
    markTicketsKnown([item]);
  }

  function clearOnStop() {
    knownTicketKeys.clear();
    activeAlerts.clear();
    notifyCooldown.clear();
    updateHfIssueUi();
  }

  function clearMemoryCaches() {
    chinaJsonCache = null;
    knownTicketKeys.clear();
    activeAlerts.clear();
    notifyCooldown.clear();
    updateHfIssueUi();
  }

  async function runInitialScanOnStart() {
    if (scanInFlight) return;
    if (!deps.getRunning() || !isFeatureEnabledInUi()) return;
    if (!(await deps.isApiConfigured?.())) return;

    scanInFlight = true;
    try {
      const cfg = await loadConfig();
      lastLoadedCfg = cfg;
      if (!cfg.enabled) return;

      const apiMis = await getApiUsername();
      if (!apiMis) {
        log("高频问题检测未启用：请在设置中配置账号信息。", "warning");
        return;
      }

      const rgIds = await getRgIds();
      if (!rgIds.length) {
        log("高频问题检测未启用：请在设置中配置工单组。", "warning");
        return;
      }

      const current = await fetchCurrentOpenTicketsForApiUser(rgIds, apiMis);
      log("正在检查高频问题…", "info");
      lastHfHeavyScanAt = Date.now();

      for (const item of current) {
        await processTicketScan(item, cfg, rgIds, apiMis, { isNewTrigger: true });
      }

      for (const t of deps.getTickets()) {
        if (isOwnedByApiUser(t, apiMis)) markTicketsKnown([t]);
      }
    } catch (err) {
      log("高频问题检测异常：" + TD.log.errText(err), "warning");
    } finally {
      scanInFlight = false;
    }
  }

  async function refreshActiveAlerts(cfg, rgIds, apiMis) {
    if (!activeAlerts.size) return;
    const snapshot = Array.from(activeAlerts.values());
    for (const prev of snapshot) {
      const category = (cfg.categories || []).find((c) => c.id === prev.categoryId);
      if (!category) {
        activeAlerts.delete(alertMapKey(prev.siteKey, prev.categoryId));
        continue;
      }
      const keyWords = pickKeyWords(prev.siteKey, category, prev.siteKey);
      await evaluateSiteCategory({
        siteKey: prev.siteKey,
        category,
        cfg,
        rgIds,
        keyWords,
        apiMis,
        isNewTrigger: false
      });
    }
  }

  async function runHfIssueScan({ forceHeavy = false } = {}) {
    if (scanInFlight) return;
    if (!deps.getRunning() || !isFeatureEnabledInUi()) return;
    if (!(await deps.isApiConfigured?.())) return;

    const now = Date.now();
    const allowHeavy = forceHeavy || now - lastHfHeavyScanAt >= HF_SCAN_MIN_INTERVAL_MS;

    scanInFlight = true;
    try {
      const cfg = await loadConfig();
      lastLoadedCfg = cfg;
      if (!cfg.enabled) return;

      const apiMis = await getApiUsername();
      if (!apiMis) return;

      const rgIds = await getRgIds();
      if (!rgIds.length) {
        log("高频问题检测未启用：请在设置中配置工单组。", "warning");
        return;
      }

      if (allowHeavy) {
        lastHfHeavyScanAt = now;
        await refreshActiveAlerts(cfg, rgIds, apiMis);
      }

      const apiOpen = await fetchCurrentOpenTicketsForApiUser(rgIds, apiMis);
      const newOnes = apiOpen.filter((t) => {
        const k = ticketKey(t);
        return k && !knownTicketKeys.has(k);
      });
      // 新单仍及时评估；无新单且未到重统计窗口则跳过
      if (!newOnes.length && !allowHeavy) return;
      for (const item of newOnes) {
        await processTicketScan(item, cfg, rgIds, apiMis, { isNewTrigger: true });
      }
    } catch (err) {
      log("高频问题检测异常：" + TD.log.errText(err), "warning");
    } finally {
      scanInFlight = false;
    }
  }

  function requestHfIssueAfterRefresh() {
    if (!deps.getRunning() || !isFeatureEnabledInUi()) return;
    // 跟刷新立刻复读活跃告警；扫描有独立节流
    relogActiveAlerts();
    const now = Date.now();
    const dueHeavy = now - lastHfHeavyScanAt >= HF_SCAN_MIN_INTERVAL_MS;
    const dueLight = now - lastHfLightCheckAt >= HF_LIGHT_CHECK_MIN_MS;
    if (!dueHeavy && !dueLight) return;
    lastHfLightCheckAt = now;
    void runHfIssueScan({ forceHeavy: dueHeavy });
  }

  function onStart() {
    resetScanState();
    void runInitialScanOnStart();
  }

  TD.hfIssue = {
    bind,
    onStart,
    clearOnStop,
    clearMemoryCaches,
    requestHfIssueAfterRefresh,
    runHfIssueScan,
    getActiveOpenTicketIds
  };
})(window.TTDesktop);
