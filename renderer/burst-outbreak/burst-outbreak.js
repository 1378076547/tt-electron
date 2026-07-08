/**
 * 批量故障爆发识别：15 分钟滑动窗口内全国 RG 全组 ≥N 个不同站点同类故障 → 告警
 * 不依赖「开始」；关键词分类可配置 burst-outbreak.local.json
 */
(function initBurstOutbreak(TD) {
  const D = TD.dom;
  const log = TD.log.log;
  const C = TD.constants;

  const MS_MIN = 60000;
  const MAX_API_PAGES = 15;
  const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

  /** @type {Map<string, object>} */
  let activeAlerts = new Map();
  /** @type {Map<string, number>} */
  let notifyCooldown = new Map();
  let scanInFlight = false;
  /** @type {object|null} */
  let chinaJsonCache = null;

  let deps = {
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

  function normalizeSiteLooseKey(raw) {
    return normalizeKey(raw).replace(/\b0+(\d+)\b/g, "$1");
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

  async function getApiUsername() {
    try {
      const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
      const u = String(st?.username || "").trim();
      if (u) return u;
    } catch {
      // ignore
    }
    return "";
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
    const createdRaw = api?.createdAt || api?.createTime || api?.gmtCreate || "";
    let createdAtEpoch = null;
    if (typeof createdRaw === "number" && Number.isFinite(createdRaw)) {
      createdAtEpoch = createdRaw < 1e12 ? createdRaw * 1000 : createdRaw;
    } else if (createdRaw) {
      const p = Date.parse(String(createdRaw));
      if (Number.isFinite(p)) createdAtEpoch = p;
    }
    return { id, title, statusText, createdAtEpoch };
  }

  async function loadConfig() {
    try {
      const cfg = await window.ttDesktopApi?.getBurstOutbreakConfig?.();
      if (cfg?.ok) return cfg;
    } catch {
      // ignore
    }
    return {
      enabled: true,
      notifyWindows: true,
      windowMinutes: 15,
      minDistinctSites: 4,
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

  async function resolveSiteKeyFast(item, categories) {
    const title = String(item?.title || "").trim();
    if (!title) return { siteKey: "", reason: "empty_title" };
    const faultTerms = collectAllFaultTerms(categories);
    const inspect = { architectureRaw: "", warehouseStore: "", currentTitle: title };
    const engine = window.TTTitlePrefix;

    if (engine?.isEnglishDominantTitle?.(title)) {
      if (engine?.computeExpectedTitle) {
        const en = engine.computeExpectedTitle(inspect, null);
        if (en?.prefix) return { siteKey: String(en.prefix).trim(), source: "engine_en" };
      }
      const fromTitle = extractEnglishSiteKeyFromTitle(title, faultTerms);
      if (fromTitle) return { siteKey: fromTitle, source: "title_en" };
      return { siteKey: "", reason: "en_site_unresolved" };
    }

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

    const fromTitle = extractEnglishSiteKeyFromTitle(title, faultTerms);
    if (fromTitle) return { siteKey: fromTitle, source: "title_fallback" };
    return { siteKey: "", reason: "site_unresolved" };
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


  async function fetchTicketsInWindow({ rgIds, startMs, endMs, keyWord, apiMis }) {
    const merged = new Map();
    for (let cn = 1; cn <= MAX_API_PAGES; cn += 1) {
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
        state: ["未处理", "处理中", "暂停中", "已关闭", "已完成"],
        cn,
        sn: 100,
        orderField: "createdAt",
        orderKind: "DESC"
      };
      const r = await window.ttDesktopApi?.queryTicketsByApi?.({
        username: apiMis,
        params
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
    return Array.from(merged.values());
  }

  async function fetchTicketsForWindow({ rgIds, startMs, endMs, categories, apiMis }) {
    const merged = new Map();
    const terms = Array.from(
      new Set(collectAllFaultTerms(categories).map((t) => String(t || "").trim()).filter(Boolean))
    );
    const queries = terms.length ? terms : [""];
    for (const kw of queries) {
      const rows = await fetchTicketsInWindow({ rgIds, startMs, endMs, keyWord: kw, apiMis });
      for (const row of rows) {
        if (row.id) merged.set(row.id, row);
      }
    }
    return Array.from(merged.values());
  }

  function formatIdList(ids, max = 8) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return "（无未关闭单）";
    if (list.length <= max) return list.join("、");
    return `${list.slice(0, max).join("、")} 等 ${list.length} 单`;
  }

  function formatSiteList(sites, max = 6) {
    const list = (sites || []).filter(Boolean);
    if (!list.length) return "—";
    if (list.length <= max) return list.join("；");
    return `${list.slice(0, max).join("；")} 等 ${list.length} 站`;
  }

  function updateBurstOutbreakUi() {
    const list = Array.from(activeAlerts.values());
    if (D.burstOutbreakHeaderBadgeEl) {
      if (!list.length) {
        D.burstOutbreakHeaderBadgeEl.hidden = true;
        D.burstOutbreakHeaderBadgeEl.textContent = "";
      } else {
        D.burstOutbreakHeaderBadgeEl.hidden = false;
        D.burstOutbreakHeaderBadgeEl.textContent = `爆发 ${list.length}`;
      }
    }
    if (D.burstOutbreakSummaryEl) {
      if (!list.length) {
        D.burstOutbreakSummaryEl.hidden = true;
        D.burstOutbreakSummaryEl.textContent = "";
      } else {
        D.burstOutbreakSummaryEl.hidden = false;
        const lines = list.map((a) => {
          return `${a.categoryLabel}：${a.windowMinutes}分钟内 ${a.distinctSites} 站 / ${a.ticketCount} 单`;
        });
        D.burstOutbreakSummaryEl.textContent = lines.join(" ｜ ");
      }
    }
  }

  function shouldNotifyWindows(cfg) {
    return cfg.notifyWindows !== false;
  }

  function maybeNotifyWindows(alert, cfg) {
    if (!shouldNotifyWindows(cfg) || !isFeatureEnabledInUi()) return;
    const key = alert.categoryId;
    const last = notifyCooldown.get(key) || 0;
    if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
    notifyCooldown.set(key, Date.now());
    void window.ttDesktopApi?.showSlaNotification?.({
      title: `批量故障预警：${alert.categoryLabel}`,
      body: `${alert.windowMinutes}分钟内 ${alert.distinctSites} 个不同站点 / ${alert.ticketCount} 单\n${formatSiteList(alert.siteLabels, 4)}\n${formatIdList(alert.openTicketIds, 5)}`
    });
  }

  function logActiveAlert(alert, { isNew = false } = {}) {
    const head = isNew ? "⚠ 批量故障预警" : "⚠ 批量故障";
    log(
      `${head}：${alert.windowMinutes} 分钟内 ${alert.distinctSites} 个站点出现${alert.categoryLabel}\n` +
        `  涉及工单 ${alert.ticketCount} 单\n` +
        `  站点：${formatSiteList(alert.siteLabels, 8)}\n` +
        `  工单：${formatIdList(alert.openTicketIds)}`,
      "error"
    );
  }

  async function runBurstOutbreakScan() {
    if (scanInFlight) return;
    if (!isFeatureEnabledInUi()) return;
    if (!(await deps.isApiConfigured?.())) return;

    scanInFlight = true;
    try {
      const cfg = await loadConfig();
      if (!cfg.enabled) {
        if (activeAlerts.size) {
          activeAlerts.clear();
          updateBurstOutbreakUi();
        }
        return;
      }

      const apiMis = await getApiUsername();
      if (!apiMis) return;

      const rgIds = await getRgIds();
      if (!rgIds.length) {
        log("批量故障检测未启用：请在设置中配置工单组。", "warning");
        return;
      }

      const windowMinutes = Number(cfg.windowMinutes) > 0 ? Number(cfg.windowMinutes) : 15;
      const minDistinctSites = Number(cfg.minDistinctSites) > 0 ? Number(cfg.minDistinctSites) : 4;
      const endMs = Date.now();
      const startMs = endMs - windowMinutes * MS_MIN;

      const rawTickets = await fetchTicketsForWindow({
        rgIds,
        startMs,
        endMs,
        categories: cfg.categories,
        apiMis
      });

      /** @type {Map<string, { category: object, rows: { item: object, siteKey: string, siteNorm: string }[] }>} */
      const buckets = new Map();

      for (const item of rawTickets) {
        const cats = matchCategories(item.title, cfg.categories);
        if (!cats.length) continue;
        const { siteKey } = await resolveSiteKeyFast(item, cfg.categories);
        if (!siteKey) continue;
        const siteNorm = normalizeSiteLooseKey(siteKey);
        if (!siteNorm) continue;
        for (const cat of cats) {
          if (!buckets.has(cat.id)) {
            buckets.set(cat.id, { category: cat, rows: [] });
          }
          buckets.get(cat.id).rows.push({ item, siteKey, siteNorm });
        }
      }

      const nextActive = new Map();

      for (const [catId, bucket] of buckets) {
        const siteMap = new Map();
        for (const row of bucket.rows) {
          if (!siteMap.has(row.siteNorm)) siteMap.set(row.siteNorm, row.siteKey);
        }
        const distinctSites = siteMap.size;
        const openRows = bucket.rows.filter((r) => !isClosedStatus(r.item.statusText));
        const openIds = Array.from(new Set(openRows.map((r) => r.item.id).filter(Boolean)));
        const hit = distinctSites >= minDistinctSites && openIds.length > 0;

        if (!hit) {
          if (activeAlerts.has(catId)) {
            log(`批量故障已恢复：${bucket.category.label}。`, "success");
          }
          continue;
        }

        const alert = {
          categoryId: catId,
          categoryLabel: bucket.category.label,
          windowMinutes,
          minDistinctSites,
          distinctSites,
          ticketCount: bucket.rows.length,
          siteLabels: Array.from(siteMap.values()),
          openTicketIds: openIds,
          updatedAt: Date.now()
        };
        nextActive.set(catId, alert);

        const prev = activeAlerts.get(catId);
        const isNew = !prev;
        const grew =
          !prev ||
          distinctSites > (prev.distinctSites || 0) ||
          openIds.length > (prev.openTicketIds?.length || 0);
        logActiveAlert(alert, { isNew });
        if (isNew || grew) maybeNotifyWindows(alert, cfg);
      }

      for (const catId of activeAlerts.keys()) {
        if (!nextActive.has(catId)) {
          const prev = activeAlerts.get(catId);
          log(`批量故障已恢复：${prev?.categoryLabel || catId}。`, "success");
        }
      }

      activeAlerts = nextActive;
      updateBurstOutbreakUi();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("批量故障检测异常，请稍后重试。", "warning");
    } finally {
      scanInFlight = false;
    }
  }

  function requestBurstOutbreakAfterRefresh() {
    if (!isFeatureEnabledInUi()) return;
    void runBurstOutbreakScan();
  }

  TD.burstOutbreak = {
    bind,
    requestBurstOutbreakAfterRefresh,
    runBurstOutbreakScan
  };
})(window.TTDesktop);
