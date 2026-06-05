/**
 * 执行日志（阶段 1）
 */
(function initLog(TD) {
  const C = TD.constants;

  function nowTime() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function log(message, level = "info") {
    const logList = TD.dom.logList;
    if (!logList) return;

    const valid = ["success", "info", "warning", "error", "muted"];
    const normalized = valid.includes(level) ? level : "info";

    const item = document.createElement("div");
    item.className = `log-item log-item-${normalized}`;
    const line = `[${nowTime()}] ${message}`;
    item.textContent = line;
    logList.prepend(item);

    try {
      window.ttDesktopApi?.logToFile?.(line);
    } catch {
      // ignore
    }

    while (logList.childElementCount > C.MAX_LOG_ITEMS) {
      const last = logList.lastElementChild;
      if (!last) break;
      logList.removeChild(last);
    }
  }

  TD.log = { log, nowTime };
})(window.TTDesktop);
