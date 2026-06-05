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
    getTickets: () => []
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

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
      log(
        `[48h预警] ${titleShort} · 已历时 ${elapsed}（满 ${settings.warnHours}h 预警线）· ${remain}`,
        "warning"
      );
      if (settings.notifyWindows) {
        void window.ttDesktopApi?.showSlaNotification?.({
          title: "工单即将满 48 小时",
          body: `${titleShort}\n已历时 ${elapsed}\n${remain}`
        });
      }
    } else {
      log(`[48h超时] ${titleShort} · 已历时 ${elapsed} · 已超过 ${settings.overdueHours} 小时`, "error");
      if (settings.notifyWindows) {
        void window.ttDesktopApi?.showSlaNotification?.({
          title: "工单已超过 48 小时",
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
        if (warnCount > 0) parts.push(`即将满 48h：${warnCount} 单`);
        if (overdueCount > 0) parts.push(`已超时：${overdueCount} 单`);
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
        if (warnCount > 0) parts.push(`预警 ${warnCount}`);
        if (overdueCount > 0) parts.push(`超时 ${overdueCount}`);
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

  function runSlaScan({ emitAlerts = false } = {}) {
    const settings = getSlaSettings();
    const filtered = deps.applyTicketFilters(deps.getTickets());
    const now = Date.now();
    const { warn, overdue } = countSlaTickets(filtered, settings, now);
    updateSlaSummaryUi(warn, overdue, settings.enabled);

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
    updateTicketElapsedDisplays,
    ensureTicketElapsedTimer
  };
})(window.TTDesktop);
