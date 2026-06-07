/**
 * Phase 3: remove duplicated title ops from renderer.js and wire TD.titleOps references.
 */
const fs = require("fs");
const path = require("path");

const rendererPath = path.join(__dirname, "../renderer/renderer.js");
let src = fs.readFileSync(rendererPath, "utf8");

function removeBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker.slice(0, 60)}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`end marker not found after start: ${endMarker.slice(0, 60)}`);
  return src.slice(0, start) + src.slice(end);
}

// 1) buildTitleNormalizeInspectScript block
src = removeBetween(
  src,
  "function buildTitleNormalizeInspectScript() {",
  "/** @typedef {{ name: string, mis: string }} PmMember */"
);

// 2) buildApplyTitleScript block
src = removeBetween(src, "function buildApplyTitleScript(newTitle) {", "function buildApplyPriorityScript(targetPriorityText) {");

// 3) ensureChinaCitiesLoaded … runTicketTitleNormalizeBatch block
src = removeBetween(
  src,
  "async function ensureChinaCitiesLoaded() {",
  "/** @returns {Promise<boolean>} 是否成功在 webview 中打开该工单 */\nasync function handleTicketClick(item, options = {}) {"
);

// 4) title ops destructuring after templates
if (!src.includes("TD.titleOps")) {
  src = src.replace(
    "} = TD.templates;\n",
    `} = TD.templates;
const {
  isNormalizeInProgress,
  getBaselineCount,
  clearQueue: clearTitleOnNewQueue,
  resetTitleNewTicketBaseline,
  buildTitleNormalizeInspectScript,
  requestTitleOnNewAfterRefresh,
  flushTitleOnNewQueueIfPossible,
  runTicketTitlePatrolScan,
  runNewTicketTitleNormalize,
  runTicketTitleNormalizeBatch
} = TD.titleOps;

`
  );
}

// 5) remove moved state vars
src = src.replace("let titleNormalizeInProgress = false;\n", "");
src = src.replace("/** @type {object | null} */\nlet chinaCitiesJsonCache = null;\n", "");
src = src.replace("/** @type {Set<string>} */\nlet knownTicketKeysForTitle = new Set();\n", "");
src = src.replace("let titleOnNewQueued = false;\n", "");

// 6) replace titleNormalizeInProgress reads (opState keeps Guard-compatible key)
src = src.replace(
  /const opState = \{ busy, pmPullInProgress, priorityBatchInProgress, titleNormalizeInProgress \};/,
  "const opState = { busy, pmPullInProgress, priorityBatchInProgress, titleNormalizeInProgress: isNormalizeInProgress() };"
);
src = src.replace(/\btitleNormalizeInProgress\b/g, "isNormalizeInProgress()");

// 7) titleOnNewQueued assignments -> clearTitleOnNewQueue
src = src.replace(/\btitleOnNewQueued\s*=\s*false\s*;/g, "clearTitleOnNewQueue();");

// 8) knownTicketKeysForTitle.size
src = src.replace(/knownTicketKeysForTitle\.size/g, "getBaselineCount()");

fs.writeFileSync(rendererPath, src, "utf8");
console.log("renderer.js phase-3 wiring done");
