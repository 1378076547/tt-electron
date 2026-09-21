/**
 * 48h SLA 与工单历时展示（阶段 2）
 */
(function initSla(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const { resolveCreatedAtEpoch } = TD.time;

  /** @type {Map<string, number>} */
  const slaAlertCooldown = new Map();
  /** @type {ReturnType<typeof setInterval> | null} */
  let ticketElapsedTimer = null;

  let deps = {
    makeStableKey: (item) => "",
    applyTicketFilters: (list) => list,
    getTickets: () => [],
    getWebviewReady: () => false,
    getTtWebview: () => null,
    ttExecuteJavaScript: async () => null
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  /** @type {ReturnType<typeof setInterval> | null} */
  let ttSlaPaintTimer = null;
  let ttSlaPaintInFlight = false;

  function formatElapsedSinceCreated(epochMs, nowMs = Date.now()) {
    const start = Number(epochMs);
    const now = Number(nowMs);
    if (!Number.isFinite(start) || !Number.isFinite(now)) return "—";
    const ms = Math.max(0, now - start);
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}分钟`;
    const hr = Math.floor(min / 60);
    const minRem = min % 60;
    if (hr < 24) return minRem > 0 ? `${hr}小时${minRem}分` : `${hr}小时`;
    const day = Math.floor(hr / 24);
    const hrRem = hr % 24;
    return hrRem > 0 ? `${day}天${hrRem}小时` : `${day}天`;
  }

  function ticketElapsedLevelClass(epochMs, nowMs = Date.now()) {
    const start = Number(epochMs);
    const now = Number(nowMs);
    if (!Number.isFinite(start) || !Number.isFinite(now)) return "";
    const hr = Math.max(0, now - start) / 3600000;
    if (hr >= 40) return "ticket-elapsed--critical";
    if (hr >= 8) return "ticket-elapsed--warn";
    if (hr >= 4) return "ticket-elapsed--caution";
    return "";
  }

  function getSlaSettings() {
    const overdueHours = C.DEFAULT_SLA_OVERDUE_HOURS;
    const warnHours = C.DEFAULT_SLA_WARN_HOURS;
    return {
      enabled: D.ticketSlaReminderToggle
        ? D.ticketSlaReminderToggle.checked
        : localStorage.getItem(C.STORAGE_KEYS.slaReminderEnabled) !== "0",
      notifyWindows: D.ticketSlaNotifyToggle
        ? D.ticketSlaNotifyToggle.checked
        : localStorage.getItem(C.STORAGE_KEYS.slaNotifyWindows) === "1",
      warnHours,
      overdueHours,
      cooldownMs: C.SLA_ALERT_COOLDOWN_MS
    };
  }

  function isTicketEligibleForSla(item) {
    const st = String(item?.statusText || "").trim();
    if (!st) return true;
    if (/关闭|已解决|已完成|已取消|取消/.test(st)) return false;
    return /未处理|处理中|暂停/.test(st);
  }

  function getTicketElapsedHours(item, nowMs = Date.now()) {
    const epoch = resolveCreatedAtEpoch(item);
    if (!Number.isFinite(epoch)) return null;
    return Math.max(0, nowMs - epoch) / 3600000;
  }

  /** @returns {"warn"|"overdue"|null} */
  function getTicketSlaStage(item, settings, nowMs = Date.now()) {
    if (!settings?.enabled || !isTicketEligibleForSla(item)) return null;
    const hr = getTicketElapsedHours(item, nowMs);
    if (hr == null) return null;
    if (hr >= settings.overdueHours) return "overdue";
    if (hr >= settings.warnHours) return "warn";
    return null;
  }

  function formatRemainingUntilOverdue(hr, overdueHours) {
    const left = overdueHours - hr;
    if (left <= 0) return "已满48小时";
    const h = Math.floor(left);
    const m = Math.floor((left - h) * 60);
    if (h > 0) return `约 ${h} 小时${m > 0 ? `${m} 分` : ""}后满 48h`.replace(/\s+/g, " ").trim();
    return `约 ${Math.max(1, m)} 分钟后满 48h`;
  }

  function getTicketSlaAlertKey(item, stage) {
    const base = String(item?.id || "").trim() || deps.makeStableKey(item);
    return `${base}|${stage}`;
  }

  function maybeEmitSlaAlert(item, stage, hr, settings) {
    const key = getTicketSlaAlertKey(item, stage);
    const last = slaAlertCooldown.get(key) || 0;
    if (Date.now() - last < settings.cooldownMs) return;
    slaAlertCooldown.set(key, Date.now());

    const titleShort = String(item?.title || "（无标题）").trim().slice(0, 60);
    const elapsed = formatElapsedSinceCreated(resolveCreatedAtEpoch(item));

    if (stage === "warn") {
      const remain = formatRemainingUntilOverdue(hr, settings.overdueHours);
      log(`⚠ 工单「${titleShort}」已处理 ${elapsed}，即将满 48 小时。`, "warning");
      if (settings.notifyWindows) {
        void window.ttDesktopApi?.showSlaNotification?.({
          title: "工单即将超时",
          body: `${titleShort}\n已历时 ${elapsed}\n${remain}`
        });
      }
    } else {
      log(`⚠ 工单「${titleShort}」已超时（已处理 ${elapsed}）。`, "error");
      if (settings.notifyWindows) {
        void window.ttDesktopApi?.showSlaNotification?.({
          title: "工单已超时",
          body: `${titleShort}\n已历时 ${elapsed}`
        });
      }
    }
  }

  function updateSlaSummaryUi(warnCount, overdueCount, enabled) {
    if (D.ticketSlaSummaryEl) {
      if (!enabled || (warnCount <= 0 && overdueCount <= 0)) {
        D.ticketSlaSummaryEl.hidden = true;
        D.ticketSlaSummaryEl.textContent = "";
      } else {
        D.ticketSlaSummaryEl.hidden = false;
        const parts = [];
        if (warnCount > 0) parts.push(`${warnCount} 单即将超时`);
        if (overdueCount > 0) parts.push(`${overdueCount} 单已超时`);
        D.ticketSlaSummaryEl.textContent = parts.join(" · ");
      }
    }
    if (D.ticketSlaHeaderBadgeEl) {
      if (!enabled || (warnCount <= 0 && overdueCount <= 0)) {
        D.ticketSlaHeaderBadgeEl.hidden = true;
        D.ticketSlaHeaderBadgeEl.textContent = "";
      } else {
        D.ticketSlaHeaderBadgeEl.hidden = false;
        const parts = [];
        if (warnCount > 0) parts.push(`${warnCount} 预警`);
        if (overdueCount > 0) parts.push(`${overdueCount} 超时`);
        D.ticketSlaHeaderBadgeEl.textContent = parts.join(" · ");
      }
    }
    void window.ttDesktopApi?.updateTraySlaHint?.({ warn: warnCount, overdue: overdueCount });
  }

  function countSlaTickets(list, settings, nowMs = Date.now()) {
    let warn = 0;
    let overdue = 0;
    if (!settings.enabled) return { warn, overdue };
    for (const item of list) {
      const stage = getTicketSlaStage(item, settings, nowMs);
      if (stage === "warn") warn += 1;
      else if (stage === "overdue") overdue += 1;
    }
    return { warn, overdue };
  }

  function collectRiskTicketIds() {
    const ids = new Set();
    try {
      for (const id of TD.hfIssue?.getActiveOpenTicketIds?.() || []) {
        const s = String(id || "").trim();
        if (s) ids.add(s);
      }
    } catch {
      // ignore
    }
    try {
      for (const id of TD.burstOutbreak?.getActiveOpenTicketIds?.() || []) {
        const s = String(id || "").trim();
        if (s) ids.add(s);
      }
    } catch {
      // ignore
    }
    return ids;
  }

  function buildTtSlaPaintPayload(settings, list, nowMs = Date.now()) {
    /** @type {Record<string, "warn"|"overdue">} */
    const byId = {};
    /** @type {Record<string, "warn"|"overdue">} */
    const byTitle = {};
    const riskIds = collectRiskTicketIds();

    if (settings?.enabled) {
      for (const item of list) {
        const stage = getTicketSlaStage(item, settings, nowMs);
        if (!stage) continue;
        const id = String(item?.id || "").trim();
        if (id) {
          if (byId[id] !== "overdue") byId[id] = stage;
        }
        const title = String(item?.title || "")
          .trim()
          .replace(/\s+/g, " ");
        if (title) {
          if (byTitle[title] !== "overdue") byTitle[title] = stage;
        }
      }
    }

    // 高频 / 短时故障：关联工单标题染红（与 48h 超时同色）
    if (riskIds.size) {
      const titleById = new Map();
      for (const item of list) {
        const id = String(item?.id || "").trim();
        const title = String(item?.title || "")
          .trim()
          .replace(/\s+/g, " ");
        if (id && title) titleById.set(id, title);
      }
      for (const id of riskIds) {
        byId[id] = "overdue";
        const title = titleById.get(id);
        if (title) byTitle[title] = "overdue";
      }
    }

    const enabled = !!(settings?.enabled || riskIds.size || Object.keys(byId).length || Object.keys(byTitle).length);
    return { enabled, byId, byTitle };
  }

  async function paintTtSlaTitlesInWebview() {
    if (ttSlaPaintInFlight) return;
    if (!deps.getWebviewReady?.() || !deps.getTtWebview?.()) return;
    if (typeof deps.ttExecuteJavaScript !== "function") return;

    ttSlaPaintInFlight = true;
    try {
      const settings = getSlaSettings();
      const list = deps.applyTicketFilters(deps.getTickets());
      const payload = buildTtSlaPaintPayload(settings, list);
      await deps.ttExecuteJavaScript(buildPaintTtSlaTitlesScript(payload));
    } catch {
      // ignore guest paint errors
    } finally {
      ttSlaPaintInFlight = false;
    }
  }

  function ensureTtSlaPaintTimer() {
    if (ttSlaPaintTimer) return;
    ttSlaPaintTimer = setInterval(() => {
      if (!deps.getWebviewReady?.() || !deps.getTtWebview?.()) return;
      void paintTtSlaTitlesInWebview();
    }, 4000);
  }

  function buildPaintTtSlaTitlesScript(payload) {
    const safe = JSON.stringify(payload || { enabled: false, byId: {}, byTitle: {} });
    return `
      (() => {
        const payload = ${safe};
        const STYLE_ID = 'tt-desktop-sla-title-style';
        const MARK = 'tt-desktop-sla-title';

        function ensureStyle() {
          let el = document.getElementById(STYLE_ID);
          if (el) return;
          el = document.createElement('style');
          el.id = STYLE_ID;
          el.textContent =
            '.' + MARK + '-warn{color:#fb923c !important;}' +
            '.' + MARK + '-overdue{color:#f87171 !important;font-weight:600 !important;}';
          (document.head || document.documentElement).appendChild(el);
        }

        function clearMarks(root) {
          const nodes = (root || document).querySelectorAll('.' + MARK + '-warn, .' + MARK + '-overdue');
          for (const n of nodes) {
            n.classList.remove(MARK + '-warn', MARK + '-overdue');
          }
        }

        function norm(t) {
          return String(t || '').trim().replace(/\\s+/g, ' ');
        }

        function guessId(item) {
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
          const raw = norm(item.textContent || '');
          const mid = raw.match(/编号\\s*[:：]\\s*(\\d{6,})/);
          return mid ? mid[1] : '';
        }

        function guessTitle(item) {
          return (
            norm(item.querySelector('.ticket-name-text-display')?.textContent || '') ||
            norm(item.querySelector('.tt-hover-field .ticket-name-text-display')?.textContent || '') ||
            norm(item.querySelector('.content.title')?.textContent || '') ||
            norm(item.querySelector('.title')?.textContent || '')
          );
        }

        function titleNode(item) {
          return (
            item.querySelector('.ticket-name-text-display') ||
            item.querySelector('.tt-hover-field .ticket-name-text-display') ||
            item.querySelector('.content.title') ||
            item.querySelector('.title')
          );
        }

        function getListItems() {
          const wrapper =
            document.querySelector('.handle-list-wrapper') ||
            document.querySelector('.handle-ticket-list') ||
            document.querySelector('#ticket-detail')?.closest?.('.detail-with-list-container');
          let list = wrapper
            ? Array.from(wrapper.querySelectorAll('.handle-ticket-nav-item'))
            : [];
          if (!list.length) {
            list = Array.from(document.querySelectorAll('.handle-ticket-nav-item'));
          }
          return list;
        }

        ensureStyle();
        const items = getListItems();
        clearMarks(document);

        if (!payload || !payload.enabled) {
          return { ok: true, painted: 0, cleared: true, rows: items.length };
        }

        const byId = payload.byId || {};
        const byTitle = payload.byTitle || {};
        let painted = 0;
        for (const item of items) {
          const id = guessId(item);
          const title = guessTitle(item);
          let stage = '';
          if (id && byId[id]) stage = byId[id];
          else if (title && byTitle[title]) stage = byTitle[title];
          if (!stage) continue;
          const node = titleNode(item);
          if (!node) continue;
          node.classList.add(MARK + '-' + stage);
          painted += 1;
        }
        return { ok: true, painted, rows: items.length };
      })()
    `;
  }

  function runSlaScan({ emitAlerts = false } = {}) {
    const settings = getSlaSettings();
    const filtered = deps.applyTicketFilters(deps.getTickets());
    const now = Date.now();
    const { warn, overdue } = countSlaTickets(filtered, settings, now);
    updateSlaSummaryUi(warn, overdue, settings.enabled);

    void paintTtSlaTitlesInWebview();
    ensureTtSlaPaintTimer();

    if (!settings.enabled || !emitAlerts) return { warn, overdue };

    for (const item of filtered) {
      const hr = getTicketElapsedHours(item, now);
      if (hr == null) continue;
      const stage = getTicketSlaStage(item, settings, now);
      if (stage) maybeEmitSlaAlert(item, stage, hr, settings);
    }
    return { warn, overdue };
  }

  function updateTicketElapsedDisplays() {
    if (!D.ticketListEl) return;
    const now = Date.now();
    const nodes = D.ticketListEl.querySelectorAll(".ticket-elapsed[data-created-epoch]");
    for (const el of nodes) {
      const epoch = Number(el.dataset.createdEpoch);
      if (!Number.isFinite(epoch)) {
        el.textContent = "已历时：—";
        el.className = "ticket-elapsed";
        continue;
      }
      el.textContent = `已历时：${formatElapsedSinceCreated(epoch, now)}`;
      const level = ticketElapsedLevelClass(epoch, now);
      el.className = level ? `ticket-elapsed ${level}` : "ticket-elapsed";
    }
  }

  function ensureTicketElapsedTimer() {
    if (ticketElapsedTimer) return;
    ticketElapsedTimer = setInterval(() => {
      if (D.panelTickets?.classList.contains("left-panel-active")) {
        updateTicketElapsedDisplays();
        runSlaScan({ emitAlerts: false });
      }
    }, 1000);
  }

  TD.sla = {
    bind,
    formatElapsedSinceCreated,
    ticketElapsedLevelClass,
    getSlaSettings,
    isTicketEligibleForSla,
    getTicketElapsedHours,
    getTicketSlaStage,
    runSlaScan,
    paintTtSlaTitlesInWebview,
    updateTicketElapsedDisplays,
    ensureTicketElapsedTimer,
    ensureTtSlaPaintTimer
  };
})(window.TTDesktop);
