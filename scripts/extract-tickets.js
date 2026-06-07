/**
 * Phase 4: extract ticket list logic into renderer/tickets/tickets.js
 */
const fs = require("fs");
const path = require("path");

const rendererPath = path.join(__dirname, "../renderer/renderer.js");
const outPath = path.join(__dirname, "../renderer/tickets/tickets.js");
const lines = fs.readFileSync(rendererPath, "utf8").split("\n");

function slice(startLine, endLine) {
  return lines.slice(startLine - 1, endLine).join("\n");
}

const chunks = [
  slice(178, 184),
  slice(198, 519),
  slice(590, 732),
  slice(909, 1058),
  slice(1060, 1354),
  slice(2486, 2658)
];

const body = chunks.join("\n\n");

const header = `/**
 * 工单列表：抓取、合并、过滤、渲染（阶段 4）
 */
(function initTickets(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
  const { TICKET_CATEGORY_RULES, TARGET_RG_IDS, TARGET_FILTER_IDS } = C;
  const {
    formatDateTime,
    formatEpochToMMDDHHmm,
    parseCreatedAtEpoch,
    resolveCreatedAtEpoch,
    normalizeTicketCreatedFields,
    ticketEpochMs
  } = TD.time;
  const {
    formatElapsedSinceCreated,
    ticketElapsedLevelClass,
    getSlaSettings,
    getTicketSlaStage,
    runSlaScan,
    updateTicketElapsedDisplays
  } = TD.sla;

  /** @typedef {{ id: string|null, title: string, handler: string, priorityText: string, priorityRank: number, createdAtText: string, createdAtEpoch: number|null, statusText: string, statusRank: number, isActive: boolean, fingerprint: string }} TicketItem */
  /** @type {TicketItem[]} */
  let tickets = [];
  /** @type {Map<string, TicketItem>} */
  let ticketIndex = new Map();
  let ticketLastUpdatedAt = null;
  let ticketRefreshInFlight = false;
  let prioritySortDir = -1;
  let createdSortDir = -1;
  let ticketSortMode = "system";
  let ticketTitleSearch = "";
  let ticketCategoryFilter = "all";
  let ticketOnlyMine = true;
  let ticketHideClosed = true;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHandler: () => "",
    getWebviewReady: () => false,
    getTtWebview: () => null,
    isTicketBatchSelected: () => false,
    setTicketBatchSelected: () => {},
    updateBatchPrioritySelectionCount: () => {},
    getAutoPriorityBoostEnabled: () => false,
    requestAutoPriorityBoostFromRefresh: () => {},
    requestTitleOnNewAfterRefresh: () => {},
    scheduleTitlePatrolFromRefresh: () => {},
    getTitlePatrolLogEnabled: () => false
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

`;

const footer = `
  function getTickets() {
    return tickets;
  }

  function setTicketTitleSearch(v) {
    ticketTitleSearch = String(v || "");
  }

  function setTicketCategoryFilter(v) {
    ticketCategoryFilter = String(v || "all");
  }

  function setTicketOnlyMine(v) {
    ticketOnlyMine = !!v;
  }

  function setTicketHideClosed(v) {
    ticketHideClosed = !!v;
  }

  function getTicketOnlyMine() {
    return ticketOnlyMine;
  }

  function getTicketHideClosed() {
    return ticketHideClosed;
  }

  function togglePrioritySort() {
    if (ticketSortMode === "priority") {
      prioritySortDir = prioritySortDir === -1 ? 1 : -1;
    } else {
      ticketSortMode = "priority";
      prioritySortDir = -1;
    }
    syncSortButtonText();
  }

  function toggleCreatedSort() {
    if (ticketSortMode === "created") {
      createdSortDir = createdSortDir === -1 ? 1 : -1;
    } else {
      ticketSortMode = "created";
      createdSortDir = -1;
    }
    syncSortButtonText();
  }

  function isRefreshInFlight() {
    return ticketRefreshInFlight;
  }

  TD.tickets = {
    bind,
    getTickets,
    setTicketTitleSearch,
    setTicketCategoryFilter,
    setTicketOnlyMine,
    setTicketHideClosed,
    getTicketOnlyMine,
    getTicketHideClosed,
    togglePrioritySort,
    toggleCreatedSort,
    isRefreshInFlight,
    makeStableKey,
    applyTicketFilters,
    sortTickets,
    getMyTodoTicketsForTitleOps,
    getTicketSelectKey,
    parsePriorityRank,
    classifyTicketTitle,
    mergeTickets,
    renderTicketList,
    refreshTickets,
    handleTicketClick,
    loadMoreTickets,
    updateTicketMeta,
    syncSortButtonText
  };
})(window.TTDesktop);
`;

const patchedBody = body
  .replace(/\bticketListEl\b/g, "D.ticketListEl")
  .replace(/\bticketLoadedCountEl\b/g, "D.ticketLoadedCountEl")
  .replace(/\bticketLastUpdatedEl\b/g, "D.ticketLastUpdatedEl")
  .replace(/\bticketCategorySelect\b/g, "D.ticketCategorySelect")
  .replace(/\bprioritySortBtn\b/g, "D.prioritySortBtn")
  .replace(/\bcreatedSortBtn\b/g, "D.createdSortBtn")
  .replace(/\bttWebview\b/g, "deps.getTtWebview()")
  .replace(/\bwebviewReady\b/g, "deps.getWebviewReady()")
  .replace(/batchPrioritySelected\.has\(selectKey\)/g, "deps.isTicketBatchSelected(selectKey)")
  .replace(/batchPrioritySelected\.add\(selectKey\)/g, "deps.setTicketBatchSelected(selectKey, true)")
  .replace(/batchPrioritySelected\.delete\(selectKey\)/g, "deps.setTicketBatchSelected(selectKey, false)")
  .replace(/updateBatchPrioritySelectionCount\(\)/g, "deps.updateBatchPrioritySelectionCount()")
  .replace(/if \(autoPriorityBoostEnabled\)/g, "if (deps.getAutoPriorityBoostEnabled())")
  .replace(/requestAutoPriorityBoostFromRefresh\(\)/g, "deps.requestAutoPriorityBoostFromRefresh()")
  .replace(/requestTitleOnNewAfterRefresh\(\)/g, "deps.requestTitleOnNewAfterRefresh()")
  .replace(/scheduleTitlePatrolFromRefresh\(\)/g, "deps.scheduleTitlePatrolFromRefresh()")
  .replace(/getTitlePatrolLogEnabled\(\)/g, "deps.getTitlePatrolLogEnabled()");

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header + patchedBody + footer, "utf8");
console.log(`wrote ${outPath} (${header.split("\n").length + patchedBody.split("\n").length + footer.split("\n").length} lines approx)`);
