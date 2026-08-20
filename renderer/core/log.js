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

  const REASON_ZH = {
    no_detail: "未找到工单详情页",
    no_title_editor: "未能进入标题编辑框",
    verify_mismatch: "写入后界面未变成目标内容",
    verify_empty: "写入后读不到界面结果",
    already_set: "已是目标值",
    no_priority_trigger: "未找到优先级控件",
    no_priority_popper: "优先级下拉未弹出",
    empty_target: "未指定目标值",
    option_not_found: "下拉中没有目标选项",
    empty_mis: "人员缺少 MIS",
    ambiguous: "搜索结果不唯一",
    not_found: "未找到目标",
    empty_targets: "没有可操作对象",
    no_elephant_tab: "未找到大象会话标签",
    no_add_member: "未找到添加成员按钮",
    no_modal: "拉人弹窗未出现",
    no_search_input: "未找到搜索框",
    no_confirm: "未找到确认按钮",
    unknown: "未知原因",
    webview_not_ready: "工单页面未就绪",
    not_in_list: "工单未出现在列表",
    open_failed: "未能选中工单"
  };

  function errText(err) {
    if (err == null || err === "") return "未知错误";
    if (typeof err === "string") {
      const t = err.replace(/\s+/g, " ").trim();
      return t.slice(0, 180) || "未知错误";
    }
    if (err instanceof Error) {
      const t = String(err.message || err.name || "").replace(/\s+/g, " ").trim();
      return t.slice(0, 180) || "未知错误";
    }
    try {
      const t = String(err).replace(/\s+/g, " ").trim();
      return t.slice(0, 180) || "未知错误";
    } catch {
      return "未知错误";
    }
  }

  function formatReason(reason) {
    const raw = String(reason || "").trim() || "unknown";
    const zh = REASON_ZH[raw];
    return zh ? `${zh}（${raw}）` : raw;
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

  TD.log = { log, nowTime, errText, formatReason };
})(window.TTDesktop);
