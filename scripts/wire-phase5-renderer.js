/**
 * Phase 5: remove priority + PM blocks from renderer.js
 */
const fs = require("fs");
const path = require("path");

const rendererPath = path.join(__dirname, "../renderer/renderer.js");
let src = fs.readFileSync(rendererPath, "utf8");

function removeBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`start not found: ${startMarker.slice(0, 50)}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`end not found: ${endMarker.slice(0, 50)}`);
  return src.slice(0, start) + src.slice(end);
}

// priority UI + auto boost helpers
src = removeBetween(src, "function updateBatchPrioritySelectionCount() {", "function clampInterval(value) {");

// auto boost request/flush/run (between sleep and PM typedef)
src = removeBetween(src, "function requestAutoPriorityBoostFromRefresh() {", "/** @typedef {{ name: string, mis: string }} PmMember */");

// PM block
src = removeBetween(src, "/** @typedef {{ name: string, mis: string }} PmMember */", "function buildApplyPriorityScript(targetPriorityText) {");

// priority apply block
src = removeBetween(
  src,
  "function buildApplyPriorityScript(targetPriorityText) {",
  "function buildCheckAndHandleScript(handler, autoCreateGroup, elephantMessage, elephantMessageEn, autoSendMessage) {"
);

// remove state vars
src = src.replace("let priorityBatchInProgress = false;\n", "");
src = src.replace("let priorityBatchAbort = false;\n", "");
src = src.replace("/** @type {Set<string>} */\nconst batchPrioritySelected = new Set();\n", "");
src = src.replace("let autoPriorityBoostEnabled = false;\n", "");
src = src.replace("/** @type {Map<string, number>} */\nconst autoPriorityBoostCooldown = new Map();\n", "");
src = src.replace("let autoPriorityBoostQueued = false;\n", "");
src = src.replace("let pmPullInProgress = false;\n", "");

// destructuring
if (!src.includes("TD.priority")) {
  src = src.replace(
    `} = TD.tickets;

`,
    `} = TD.tickets;
const {
  getAutoPriorityBoostEnabled,
  setAutoPriorityBoostEnabled,
  clearAutoBoostQueue,
  isBatchInProgress,
  abortBatch,
  isTicketBatchSelected,
  setTicketBatchSelected,
  clearBatchSelection,
  addAllVisibleToBatch,
  selectVisibleByKeywordBoost,
  getBatchSelectionCount,
  updateBatchPrioritySelectionCount,
  setPriorityBatchUiBusy,
  requestAutoPriorityBoostFromRefresh,
  flushAutoPriorityBoostQueueIfPossible,
  applyPriorityForActiveTicket,
  applyPriorityBatch
} = TD.priority;
const { isPullInProgress, updatePmCsvPathLabel, selectPmCsvFile, runPmPullByRegion } = TD.pm;

`
  );
}

// settings
src = src.replace(
  /localStorage\.setItem\(STORAGE_KEYS\.autoPriorityBoost, autoPriorityBoostEnabled \? "1" : "0"\);/,
  'localStorage.setItem(STORAGE_KEYS.autoPriorityBoost, getAutoPriorityBoostEnabled() ? "1" : "0");'
);
src = src.replace(
  /autoPriorityBoostEnabled = savedAutoBoost === "1";\s*\n\s*if \(ticketAutoPriorityBoostToggle\) ticketAutoPriorityBoostToggle\.checked = autoPriorityBoostEnabled;/,
  'setAutoPriorityBoostEnabled(savedAutoBoost === "1");\n  if (ticketAutoPriorityBoostToggle) ticketAutoPriorityBoostToggle.checked = getAutoPriorityBoostEnabled();'
);

// runtime flags
src = src.replace(/\bpriorityBatchInProgress\b/g, "isBatchInProgress()");
src = src.replace(/\bpmPullInProgress\b/g, "isPullInProgress()");
src = src.replace(/\bautoPriorityBoostQueued = false/g, "clearAutoBoostQueue()");
src = src.replace(/\bautoPriorityBoostEnabled\b/g, "getAutoPriorityBoostEnabled()");

// fix opState in runCheck - might have broken if pm was in opState - grep later

// bindEvents: batch select visible
src = src.replace(
  /if \(priorityBatchInProgress\) return;\s*\n\s*const filtered = applyTicketFilters\(getTickets\(\)\);\s*\n\s*const sorted = sortTickets\(filtered\);\s*\n\s*for \(const it of sorted\) \{\s*\n\s*const k = getTicketSelectKey\(it\);\s*\n\s*if \(k\) batchPrioritySelected\.add\(k\);\s*\n\s*\}/,
  `if (isBatchInProgress()) return;
      const filtered = applyTicketFilters(getTickets());
      const sorted = sortTickets(filtered);
      addAllVisibleToBatch(sorted);`
);

src = src.replace(
  /if \(priorityBatchInProgress\) return;\s*\n\s*batchPrioritySelected\.clear\(\);/,
  "if (isBatchInProgress()) return;\n      clearBatchSelection();"
);

// auto boost toggle handler
src = src.replace(
  /ticketAutoPriorityBoostToggle\.checked = getAutoPriorityBoostEnabled\(\);\s*\n\s*ticketAutoPriorityBoostToggle\.addEventListener\("change", \(\) => \{\s*\n\s*getAutoPriorityBoostEnabled\(\) = !!ticketAutoPriorityBoostToggle\.checked;/,
  `ticketAutoPriorityBoostToggle.checked = getAutoPriorityBoostEnabled();
    ticketAutoPriorityBoostToggle.addEventListener("change", () => {
      setAutoPriorityBoostEnabled(!!ticketAutoPriorityBoostToggle.checked);`
);

// keyword boost button - complex block - replace batchPrioritySelected usage
src = src.replace(
  /if \(isBatchInProgress\(\)\) \{\s*\n\s*log\("正在批量设置优先级，稍后再试。", "warning"\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(isNormalizeInProgress\(\)\) \{\s*\n\s*log\("请等待「标题检测」完成后再执行关键词升高优先级。", "warning"\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(running\) \{\s*\n\s*log\("请先停止「开始」自动处理，再执行关键词升高优先级。", "warning"\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*const filtered = applyTicketFilters\(getTickets\(\)\);\s*\n\s*const sorted = sortTickets\(filtered\);\s*\n\s*batchPrioritySelected\.clear\(\);\s*\n\s*const hits = \[\];\s*\n\s*for \(const it of sorted\) \{\s*\n\s*const k = getTicketSelectKey\(it\);\s*\n\s*if \(!k\) continue;\s*\n\s*const m = matchAutoPriorityBoost\(it\.title \|\| ""\);\s*\n\s*if \(!m\.ok\) continue;\s*\n\s*batchPrioritySelected\.add\(k\);\s*\n\s*hits\.push\(m\.hit\);\s*\n\s*\}/,
  `if (isBatchInProgress()) {
        log("正在批量设置优先级，稍后再试。", "warning");
        return;
      }
      if (isNormalizeInProgress()) {
        log("请等待「标题检测」完成后再执行关键词升高优先级。", "warning");
        return;
      }
      if (running) {
        log("请先停止「开始」自动处理，再执行关键词升高优先级。", "warning");
        return;
      }
      const filtered = applyTicketFilters(getTickets());
      const sorted = sortTickets(filtered);
      const hits = selectVisibleByKeywordBoost(sorted);`
);

src = src.replace(/batchPrioritySelected\.size/g, "getBatchSelectionCount()");
src = src.replace(/const count = getBatchSelectionCount\(\);/g, "const count = getBatchSelectionCount();");

// priority batch stop
src = src.replace(/if \(isBatchInProgress\(\)\) priorityBatchAbort = true;/, "if (isBatchInProgress()) abortBatch();");

// priority batch error handler
src = src.replace(
  /isBatchInProgress\(\) = false;\s*\n\s*setPriorityBatchUiBusy\(false\);/g,
  "setPriorityBatchUiBusy(false);"
);

// pm error handler setPmPullBusy
src = src.replace(/setPmPullBusy\(false\);/g, "// pm module handles busy in finally");

// bindModuleDeps tickets - use TD.priority for batch selection
src = src.replace(
  /isTicketBatchSelected: \(key\) => batchPrioritySelected\.has\(key\),\s*\n\s*setTicketBatchSelected: \(key, on\) => \{\s*\n\s*if \(on\) batchPrioritySelected\.add\(key\);\s*\n\s*else batchPrioritySelected\.delete\(key\);\s*\n\s*\},/,
  "isTicketBatchSelected,\n    setTicketBatchSelected,"
);
src = src.replace(
  /getAutoPriorityBoostEnabled: \(\) => getAutoPriorityBoostEnabled\(\),/,
  "getAutoPriorityBoostEnabled,"
);

src = src.replace(
  /getPriorityBatchInProgress: \(\) => isBatchInProgress\(\),\s*\n\s*getPmPullInProgress: \(\) => isPullInProgress\(\),/,
  "getPriorityBatchInProgress: isBatchInProgress,\n    getPmPullInProgress: isPullInProgress,"
);

fs.writeFileSync(rendererPath, src, "utf8");
console.log("renderer.js phase-5 wiring done");
