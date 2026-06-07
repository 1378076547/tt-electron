/**
 * Phase 5: extract priority + PM modules from renderer.js
 */
const fs = require("fs");
const path = require("path");

const rendererPath = path.join(__dirname, "../renderer/renderer.js");
const lines = fs.readFileSync(rendererPath, "utf8").split("\n");

function slice(startLine, endLine) {
  return lines.slice(startLine - 1, endLine).join("\n");
}

const priorityBody = [
  slice(197, 264),
  slice(441, 507),
  slice(1106, 1568)
].join("\n\n");

const pmBody = slice(509, 1104);

const priorityHeader = `/**
 * 批量优先级 / 关键词自动升高（阶段 5）
 */
(function initPriority(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
  const {
    AUTO_PRIORITY_BOOST_TARGET,
    AUTO_PRIORITY_BOOST_KEYWORDS,
    AUTO_PRIORITY_BOOST_MAX_PER_ROUND,
    AUTO_PRIORITY_BOOST_COOLDOWN_MS
  } = C;

  let priorityBatchInProgress = false;
  let priorityBatchAbort = false;
  /** @type {Set<string>} */
  const batchPrioritySelected = new Set();
  let autoPriorityBoostEnabled = false;
  /** @type {Map<string, number>} */
  const autoPriorityBoostCooldown = new Map();
  let autoPriorityBoostQueued = false;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getWebviewReady: () => false,
    getTtWebview: () => null,
    getRunning: () => false,
    getBusy: () => false,
    getBatchInProgress: () => false,
    getPendingRunAfterReload: () => false,
    getPmPullInProgress: () => false,
    isNormalizeInProgress: () => false,
    applyTicketFilters: (list) => list,
    sortTickets: (list) => list,
    getTickets: () => [],
    getTicketSelectKey: () => "",
    handleTicketClick: async () => false,
    refreshTickets: async () => {},
    renderTicketList: () => {},
    setActiveLeftTab: () => {},
    flushTitleOnNewQueueIfPossible: async () => {}
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  function sleep(ms) {
    return deps.sleep(ms);
  }

`;

const priorityFooter = `
  function getAutoPriorityBoostEnabled() {
    return autoPriorityBoostEnabled;
  }

  function setAutoPriorityBoostEnabled(on) {
    autoPriorityBoostEnabled = !!on;
  }

  function clearAutoBoostQueue() {
    autoPriorityBoostQueued = false;
  }

  function isBatchInProgress() {
    return priorityBatchInProgress;
  }

  function abortBatch() {
    priorityBatchAbort = true;
  }

  function isTicketBatchSelected(key) {
    return batchPrioritySelected.has(key);
  }

  function setTicketBatchSelected(key, on) {
    if (on) batchPrioritySelected.add(key);
    else batchPrioritySelected.delete(key);
  }

  function clearBatchSelection() {
    batchPrioritySelected.clear();
  }

  function addAllVisibleToBatch(items) {
    for (const it of items) {
      const k = deps.getTicketSelectKey(it);
      if (k) batchPrioritySelected.add(k);
    }
  }

  function getBatchSelectionCount() {
    return batchPrioritySelected.size;
  }

  function selectVisibleByKeywordBoost(items) {
    batchPrioritySelected.clear();
    const hits = [];
    for (const it of items) {
      const k = deps.getTicketSelectKey(it);
      if (!k) continue;
      const m = matchAutoPriorityBoost(it.title || "");
      if (!m.ok) continue;
      batchPrioritySelected.add(k);
      hits.push(m.hit);
    }
    return hits;
  }

  TD.priority = {
    bind,
    getAutoPriorityBoostEnabled,
    setAutoPriorityBoostEnabled,
    clearAutoBoostQueue,
    isBatchInProgress,
    abortBatch,
    isTicketBatchSelected,
    setTicketBatchSelected,
    clearBatchSelection,
    getBatchSelectionCount,
    addAllVisibleToBatch,
    selectVisibleByKeywordBoost,
    updateBatchPrioritySelectionCount,
    setPriorityBatchUiBusy,
    requestAutoPriorityBoostFromRefresh,
    flushAutoPriorityBoostQueueIfPossible,
    applyPriorityForActiveTicket,
    applyPriorityBatch
  };
})(window.TTDesktop);
`;

const pmHeader = `/**
 * 按地区拉 PM（阶段 5）
 */
(function initPm(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
  const Guard = TD.guard;
  const { STORAGE_KEYS } = C;

  let pmPullInProgress = false;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getWebviewReady: () => false,
    getTtWebview: () => null,
    getBusy: () => false,
    isNormalizeInProgress: () => false,
    isPriorityBatchInProgress: () => false,
    getTickets: () => [],
    handleTicketClick: async () => false,
    refreshTickets: async () => {},
    setActiveLeftTab: () => {},
    buildTitleNormalizeInspectScript: () => ""
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  function sleep(ms) {
    return deps.sleep(ms);
  }

`;

const pmFooter = `
  function isPullInProgress() {
    return pmPullInProgress;
  }

  TD.pm = {
    bind,
    isPullInProgress,
    updatePmCsvPathLabel,
    selectPmCsvFile,
    runPmPullByRegion
  };
})(window.TTDesktop);
`;

function patchPriorityBody(src) {
  return src
    .replace(/\bticketBatchSelectedCountEl\b/g, "D.ticketBatchSelectedCountEl")
    .replace(/\bticketPriorityBatchBtn\b/g, "D.ticketPriorityBatchBtn")
    .replace(/\bticketPriorityBatchStopBtn\b/g, "D.ticketPriorityBatchStopBtn")
    .replace(/\bticketPriorityApplyBtn\b/g, "D.ticketPriorityApplyBtn")
    .replace(/\bticketBatchSelectVisibleBtn\b/g, "D.ticketBatchSelectVisibleBtn")
    .replace(/\bticketBatchClearSelectionBtn\b/g, "D.ticketBatchClearSelectionBtn")
    .replace(/\bticketAutoPriorityBoostBtn\b/g, "D.ticketAutoPriorityBoostBtn")
    .replace(/\bticketAutoPriorityBoostToggle\b/g, "D.ticketAutoPriorityBoostToggle")
    .replace(/\bticketTitleNormalizeBtn\b/g, "D.ticketTitleNormalizeBtn")
    .replace(/\bticketPrioritySelect\b/g, "D.ticketPrioritySelect")
    .replace(/\bticketRefreshBtn\b/g, "D.ticketRefreshBtn")
    .replace(/\bpmCsvSelectBtn\b/g, "D.pmCsvSelectBtn")
    .replace(/\bpmPullByRegionBtn\b/g, "D.pmPullByRegionBtn")
    .replace(/\bpmPullInProgress\b/g, "deps.getPmPullInProgress()")
    .replace(/\bwebviewReady\b/g, "deps.getWebviewReady()")
    .replace(/\bttWebview\b/g, "deps.getTtWebview()")
    .replace(/\brunning\b/g, "deps.getRunning()")
    .replace(/\bbusy\b/g, "deps.getBusy()")
    .replace(/\bbatchInProgress\b/g, "deps.getBatchInProgress()")
    .replace(/\bpendingRunAfterReload\b/g, "deps.getPendingRunAfterReload()")
    .replace(/\bisNormalizeInProgress\(\)/g, "deps.isNormalizeInProgress()")
    .replace(/\bapplyTicketFilters\(getTickets\(\)\)/g, "deps.applyTicketFilters(deps.getTickets())")
    .replace(/\bsortTickets\(/g, "deps.sortTickets(")
    .replace(/\bgetTicketSelectKey\(/g, "deps.getTicketSelectKey(")
    .replace(/\bhandleTicketClick\(/g, "deps.handleTicketClick(")
    .replace(/\brefreshTickets\(/g, "deps.refreshTickets(")
    .replace(/\brenderTicketList\(/g, "deps.renderTicketList(")
    .replace(/\bsetActiveLeftTab\(/g, "deps.setActiveLeftTab(")
    .replace(/\bflushTitleOnNewQueueIfPossible\(/g, "deps.flushTitleOnNewQueueIfPossible(")
    .replace(/\/\*\* @typedef \{\{ name: string, mis: string \}\} PmMember \*\/\n/g, "")
    .replace(/function setPriorityBatchUiBusy\(deps\.getBusy\(\)\)/, "function setPriorityBatchUiBusy(busy)")
    .replace(
      /\/\*\* @param \{boolean\} deps\.getBusy\(\) 批量任务进行中 \*\//,
      "/** @param {boolean} busy 批量任务进行中 */"
    )
    .replace(/(function setPriorityBatchUiBusy\(busy\) \{\s*\n\s*const b = )!!deps\.getBusy\(\)/, "$1!!busy");
}

function patchPmBody(src) {
  let out = src
    .replace(/\bpmCsvPathLabel\b/g, "D.pmCsvPathLabel")
    .replace(/\bpmCsvSelectBtn\b/g, "D.pmCsvSelectBtn")
    .replace(/\bpmPullByRegionBtn\b/g, "D.pmPullByRegionBtn")
    .replace(/\bticketTitleNormalizeBtn\b/g, "D.ticketTitleNormalizeBtn")
    .replace(/\bticketPriorityApplyBtn\b/g, "D.ticketPriorityApplyBtn")
    .replace(/\bticketPriorityBatchBtn\b/g, "D.ticketPriorityBatchBtn")
    .replace(/\bticketAutoPriorityBoostBtn\b/g, "D.ticketAutoPriorityBoostBtn")
    .replace(/\bticketRefreshBtn\b/g, "D.ticketRefreshBtn")
    .replace(/\bwebviewReady\b/g, "deps.getWebviewReady()")
    .replace(/\bttWebview\b/g, "deps.getTtWebview()")
    .replace(/\bpriorityBatchInProgress\b/g, "deps.isPriorityBatchInProgress()")
    .replace(/\bisNormalizeInProgress\(\)/g, "deps.isNormalizeInProgress()")
    .replace(/\bgetTickets\(\)/g, "deps.getTickets()")
    .replace(/\bhandleTicketClick\(/g, "deps.handleTicketClick(")
    .replace(/\brefreshTickets\(/g, "deps.refreshTickets(")
    .replace(/\bsetActiveLeftTab\(/g, "deps.setActiveLeftTab(")
    .replace(/\bbuildTitleNormalizeInspectScript\(/g, "deps.buildTitleNormalizeInspectScript(");
  out = out.replace(
    /const opState = \{ busy, pmPullInProgress, deps\.isPriorityBatchInProgress\(\), titleNormalizeInProgress: deps\.isNormalizeInProgress\(\) \};/,
    "const opState = { busy: deps.getBusy(), pmPullInProgress, priorityBatchInProgress: deps.isPriorityBatchInProgress(), titleNormalizeInProgress: deps.isNormalizeInProgress() };"
  );
  out = out.replace(
    /if \(deps\.getBusy\(\)\) \{\s*\n\s*log\(Guard\.msgPmBlockedByBusy\(\), "warning"\);/,
    "if (deps.getBusy()) {\n      log(Guard.msgPmBlockedByBusy(), \"warning\");"
  );
  return out;
}

const priorityPath = path.join(__dirname, "../renderer/priority/priority.js");
const pmPath = path.join(__dirname, "../renderer/pm/pm.js");

fs.mkdirSync(path.dirname(priorityPath), { recursive: true });
fs.mkdirSync(path.dirname(pmPath), { recursive: true });

fs.writeFileSync(priorityPath, priorityHeader + patchPriorityBody(priorityBody) + priorityFooter, "utf8");
fs.writeFileSync(pmPath, pmHeader + patchPmBody(pmBody) + pmFooter, "utf8");

console.log("wrote", priorityPath);
console.log("wrote", pmPath);
