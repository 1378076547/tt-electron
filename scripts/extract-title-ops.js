const fs = require("fs");
const path = require("path");

const rendererPath = path.join(__dirname, "../renderer/renderer.js");
const lines = fs.readFileSync(rendererPath, "utf8").split("\n");

const inspectStart = lines.findIndex((l) => l.startsWith("function buildTitleNormalizeInspectScript()"));
const inspectEnd = lines.findIndex((l, i) => i > inspectStart && l.startsWith("/** @typedef {{ name: string, mis: string }} PmMember */"));
const opsStart = lines.findIndex((l) => l.startsWith("async function ensureChinaCitiesLoaded()"));
const opsEnd = lines.findIndex((l) => l.startsWith("/** @returns {Promise<boolean>} 是否成功在 webview 中打开该工单 */"));
if (inspectStart < 0 || inspectEnd < 0 || opsStart < 0 || opsEnd < 0) {
  throw new Error(`markers not found ${inspectStart} ${inspectEnd} ${opsStart} ${opsEnd}`);
}

const body = [...lines.slice(inspectStart, inspectEnd), "", ...lines.slice(opsStart, opsEnd)].join("\n");
const lineCount = inspectEnd - inspectStart + (opsEnd - opsStart);

const header = `/**
 * 标题检测 / 来单改标题 / 标题巡检（阶段 3）
 */
(function initTitleOps(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);

  let chinaCitiesJsonCache = null;
  let titleNormalizeInProgress = false;
  /** @type {Set<string>} */
  let knownTicketKeysForTitle = new Set();
  let titleOnNewQueued = false;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHandler: () => "",
    makeStableKey: () => "",
    getMyTodoTicketsForTitleOps: (list) => list,
    sortTickets: (list) => list,
    handleTicketClick: async () => false,
    refreshTickets: async () => {},
    setActiveLeftTab: () => {},
    getTickets: () => [],
    getRunning: () => false,
    getWebviewReady: () => false,
    getTtWebview: () => null,
    getBusy: () => false,
    getBatchInProgress: () => false,
    getPendingRunAfterReload: () => false,
    getPriorityBatchInProgress: () => false,
    getPmPullInProgress: () => false,
    getTitleOnNewAutoEnabled: () => false,
    getTitlePatrolLogEnabled: () => false,
    flushAutoPriorityBoostQueueIfPossible: async () => {}
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
    return deps.makeStableKey(item);
  }
  function getMyTodoTicketsForTitleOps(list) {
    return deps.getMyTodoTicketsForTitleOps(list);
  }
  function sortTickets(list) {
    return deps.sortTickets(list);
  }
  async function handleTicketClick(item, options) {
    return deps.handleTicketClick(item, options);
  }
  async function refreshTickets(opts) {
    return deps.refreshTickets(opts);
  }
  function setActiveLeftTab(tab) {
    return deps.setActiveLeftTab(tab);
  }
  function getTickets() {
    return deps.getTickets();
  }

`;

const footer = `
  TD.titleOps = {
    bind,
    isNormalizeInProgress: () => titleNormalizeInProgress,
    getBaselineCount: () => knownTicketKeysForTitle.size,
    clearQueue: () => {
      titleOnNewQueued = false;
    },
    resetTitleNewTicketBaseline,
    buildTitleNormalizeInspectScript,
    buildApplyTitleScript,
    requestTitleOnNewAfterRefresh,
    flushTitleOnNewQueueIfPossible,
    runTicketTitlePatrolScan,
    runNewTicketTitleNormalize,
    runTicketTitleNormalizeBatch
  };
})(window.TTDesktop);
`;

// Order matters: longer tokens first to avoid partial replacements
let transformed = body;
const replacements = [
  ["getTitlePatrolLogEnabled()", "deps.getTitlePatrolLogEnabled()"],
  ["TITLE_PATROL_LOG_BAD_MAX", "C.TITLE_PATROL_LOG_BAD_MAX"],
  ["ticketTitleOnNewBtn", "D.ticketTitleOnNewBtn"],
  ["ticketTitleNormalizeBtn", "D.ticketTitleNormalizeBtn"],
  ["titleOnNewAutoEnabled", "deps.getTitleOnNewAutoEnabled()"],
  ["pendingRunAfterReload", "deps.getPendingRunAfterReload()"],
  ["priorityBatchInProgress", "deps.getPriorityBatchInProgress()"],
  ["pmPullInProgress", "deps.getPmPullInProgress()"],
  ["batchInProgress", "deps.getBatchInProgress()"],
  ["webviewReady", "deps.getWebviewReady()"],
  ["ttWebview", "deps.getTtWebview()"],
  ["flushAutoPriorityBoostQueueIfPossible", "deps.flushAutoPriorityBoostQueueIfPossible"],
  ["getTickets()", "getTickets()"],
  ["tickets", "getTickets()"],
  ["running", "deps.getRunning()"],
  ["busy", "deps.getBusy()"]
];

for (const [from, to] of replacements) {
  transformed = transformed.split(from).join(to);
}

const outPath = path.join(__dirname, "../renderer/title/title-ops.js");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header + transformed + footer, "utf8");
console.log("written", outPath, "lines", lineCount);
