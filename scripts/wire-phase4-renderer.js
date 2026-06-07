/**
 * Phase 4: remove duplicated ticket logic from renderer.js
 */
const fs = require("fs");
const path = require("path");

const rendererPath = path.join(__dirname, "../renderer/renderer.js");
let src = fs.readFileSync(rendererPath, "utf8");

function removeBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker.slice(0, 60)}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`end marker not found: ${endMarker.slice(0, 60)}`);
  return src.slice(0, start) + src.slice(end);
}

// makeStableKey only
src = removeBetween(src, "function makeStableKey(item) {", "function setActiveLeftTab(tab) {");

// updateTicketMeta … getTicketSelectKey (stop before updateBatchPrioritySelectionCount)
src = removeBetween(
  src,
  "function updateTicketMeta(visibleCount) {",
  "function updateBatchPrioritySelectionCount() {"
);

// mergeTickets + renderTicketList
src = removeBetween(src, "function mergeTickets(nextItems, { reset = false } = {}) {", "function clampInterval(value) {");

// buildExtractTicketsScript + refreshTickets
src = removeBetween(src, "function buildExtractTicketsScript() {", "function requestAutoPriorityBoostFromRefresh() {");

// handleTicketClick … loadMoreTickets
src = removeBetween(
  src,
  "/** @returns {Promise<boolean>} 是否成功在 webview 中打开该工单 */\nasync function handleTicketClick(item, options = {}) {",
  "function buildCheckAndHandleScript(handler, autoCreateGroup, elephantMessage, elephantMessageEn, autoSendMessage) {"
);

// remove ticket state (keep typedef comment optional - remove state vars)
src = src.replace(
  `/** @typedef {{ id: string|null, title: string, handler: string, priorityText: string, priorityRank: number, createdAtText: string, createdAtEpoch: number|null, statusText: string, statusRank: number, isActive: boolean, fingerprint: string }} TicketItem */
/** @type {TicketItem[]} */
let tickets = [];
/** @type {Map<string, TicketItem>} */
let ticketIndex = new Map();
let ticketLastUpdatedAt = null;
let ticketRefreshInFlight = false;
let prioritySortDir = -1; // -1 高->低, 1 低->高
let createdSortDir = -1; // -1 新->旧, 1 旧->新
let ticketSortMode = "system"; // system | priority | created
let ticketTitleSearch = "";
let ticketCategoryFilter = "all";
let ticketOnlyMine = true;
let ticketHideClosed = true;

`,
  ""
);

// tickets destructuring after titleOps
if (!src.includes("TD.tickets")) {
  src = src.replace(
    `} = TD.titleOps;

`,
    `} = TD.titleOps;
const {
  getTickets,
  setTicketTitleSearch,
  setTicketCategoryFilter,
  setTicketOnlyMine,
  setTicketHideClosed,
  getTicketOnlyMine,
  getTicketHideClosed,
  togglePrioritySort,
  toggleCreatedSort,
  makeStableKey,
  applyTicketFilters,
  sortTickets,
  getMyTodoTicketsForTitleOps,
  getTicketSelectKey,
  renderTicketList,
  refreshTickets,
  handleTicketClick,
  loadMoreTickets,
  updateTicketMeta,
  syncSortButtonText
} = TD.tickets;

`
  );
}

// replace tickets references in remaining renderer code
src = src.replace(/applyTicketFilters\(tickets\)/g, "applyTicketFilters(getTickets())");
src = src.replace(/tickets\.find\(/g, "getTickets().find(");
src = src.replace(/ticketRefreshInFlight/g, "isRefreshInFlight()");

// bindEvents filter handlers
src = src.replace(
  /ticketTitleSearch = String\(ticketTitleSearchInput\.value \|\| ""\);\s*\n\s*renderTicketList\(\);/,
  "setTicketTitleSearch(ticketTitleSearchInput.value || \"\");\n      renderTicketList();"
);
src = src.replace(
  /ticketCategoryFilter = String\(ticketCategorySelect\.value \|\| "all"\);\s*\n\s*renderTicketList\(\);/,
  "setTicketCategoryFilter(ticketCategorySelect.value || \"all\");\n      renderTicketList();"
);
src = src.replace(/ticketOnlyMineInput\.checked = ticketOnlyMine;/, "ticketOnlyMineInput.checked = getTicketOnlyMine();");
src = src.replace(
  /ticketOnlyMine = !!ticketOnlyMineInput\.checked;\s*\n\s*renderTicketList\(\);/,
  "setTicketOnlyMine(!!ticketOnlyMineInput.checked);\n      renderTicketList();"
);
src = src.replace(/ticketHideClosedInput\.checked = ticketHideClosed;/, "ticketHideClosedInput.checked = getTicketHideClosed();");
src = src.replace(
  /ticketHideClosed = !!ticketHideClosedInput\.checked;\s*\n\s*renderTicketList\(\);/,
  "setTicketHideClosed(!!ticketHideClosedInput.checked);\n      renderTicketList();"
);

// sort button handlers
src = src.replace(
  /if \(prioritySortBtn\) \{\s*prioritySortBtn\.addEventListener\("click", \(\) => \{[\s\S]*?syncSortButtonText\(\);\s*renderTicketList\(\);\s*\}\);\s*\}/,
  `if (prioritySortBtn) {
    prioritySortBtn.addEventListener("click", () => {
      togglePrioritySort();
      renderTicketList();
    });
  }`
);
src = src.replace(
  /if \(createdSortBtn\) \{\s*createdSortBtn\.addEventListener\("click", \(\) => \{[\s\S]*?syncSortButtonText\(\);\s*renderTicketList\(\);\s*\}\);\s*\}/,
  `if (createdSortBtn) {
    createdSortBtn.addEventListener("click", () => {
      toggleCreatedSort();
      renderTicketList();
    });
  }`
);

fs.writeFileSync(rendererPath, src, "utf8");
console.log("renderer.js phase-4 wiring done");
