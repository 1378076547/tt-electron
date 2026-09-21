const TD = window.TTDesktop;
const C = TD.constants;
const {
  DEFAULT_HANDLER,
  DEFAULT_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  DEFAULT_BATCH_LIMIT,
  NEXT_TICKET_RELOAD_DELAY_MS,
  TITLE_PATROL_LOG_BAD_MAX,
  AUTO_PRIORITY_BOOST_TARGET,
  AUTO_PRIORITY_BOOST_KEYWORDS,
  AUTO_PRIORITY_BOOST_MAX_PER_ROUND,
  AUTO_PRIORITY_BOOST_COOLDOWN_MS,
  STORAGE_KEYS,
  TICKET_CATEGORY_RULES,
  TARGET_RG_IDS,
  TARGET_FILTER_IDS,
  TT_WEBVIEW_PARTITION,
  TT_WEBVIEW_DEFAULT_SRC,
  TT_ZOOM_MIN,
  TT_ZOOM_MAX,
  TT_ZOOM_STEP
} = C;

const {
  ticketCountEl,
  nextTickEl,
  handlerInput,
  intervalInput,
  autoGroupInput,
  autoSendMessageInput,
  titlePatrolLogInput,
  titleOnNewAutoInput,
  startBtn,
  logList,
  ttWebview,
  ttZoomLabel,
  webviewLoadingHint,
  templatesSaveBtn,
  templatesAddRuleBtn,
  templatesPreviewBtn,
  defaultMessageTextarea,
  defaultMessageEnTextarea,
  templatesRulesList,
  tabLogsBtn,
  tabTicketsBtn,
  tabTemplatesBtn,
  panelLogs,
  panelTickets,
  panelTemplates,
  prioritySortBtn,
  createdSortBtn,
  ticketTitleSearchInput,
  ticketCategorySelect,
  ticketOnlyMineInput,
  ticketHideClosedInput,
  ticketRefreshBtn,
  ticketTitlePatrolBtn,
  ticketPrioritySelect,
  ticketPriorityApplyBtn,
  ticketBatchSelectVisibleBtn,
  ticketBatchClearSelectionBtn,
  ticketBatchSelectedCountEl,
  ticketAutoPriorityBoostToggle,
  ticketAutoPriorityBoostBtn,
  ticketPriorityBatchBtn,
  ticketPriorityBatchStopBtn,
  ticketTitleNormalizeBtn,
  ticketTitleOnNewBtn,
  pmCsvSelectBtn,
  pmPullByRegionBtn,
  pmCsvPathLabel,
  ticketLastUpdatedEl,
  ticketLoadedCountEl,
  ticketListEl,
  ticketSlaSummaryEl,
  ticketSlaHeaderBadgeEl,
  ticketSlaReminderToggle,
  ticketSlaNotifyToggle,
  hfIssueHeaderBadgeEl,
  hfIssueSummaryEl,
  burstOutbreakHeaderBadgeEl,
  burstOutbreakSummaryEl,
  apiSettingsModal,
  apiSettingsCloseBtn,
  apiSettingsCancelBtn,
  apiSettingsSaveBtn,
  apiSettingsOpenFileBtn,
  apiAuthInput,
  apiUsernameInput,
  apiEnvSelect,
  apiRgIdsList,
  apiRgIdsAddBtn,
  apiSettingsPath,
  apiSettingsError
} = TD.dom;

const log = TD.log.log;
const {
  formatDateTime,
  formatEpochToMMDDHHmm,
  parseCreatedAtEpoch,
  resolveCreatedAtEpoch,
  normalizeTicketCreatedFields,
  ticketEpochMs,
  isPlausibleTicketEpoch
} = TD.time;
const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
const setWebviewLoadingHint = TD.ttBridge.setWebviewLoadingHint.bind(TD.ttBridge);
const Guard = TD.guard;
const {
  formatElapsedSinceCreated,
  ticketElapsedLevelClass,
  getSlaSettings,
  getTicketSlaStage,
  runSlaScan,
  updateTicketElapsedDisplays,
  ensureTicketElapsedTimer
} = TD.sla;
const {
  getElephantMessage,
  getElephantMessageEn,
  resolveElephantMessageForTitle,
  loadElephantRules,
  loadTemplatesPanel,
  saveTemplatesModal,
  previewTemplateMatchForActiveTicket,
  addRule
} = TD.templates;
const {
  isNormalizeInProgress,
  getBaselineCount,
  clearQueue: clearTitleOnNewQueue,
  clearTitleOnNewBaseline,
  resetTitleNewTicketBaseline,
  ensureTitleBaselineIfNeeded,
  syncTitleOnNewButtonState,
  buildTitleNormalizeInspectScript,
  ensureNewTicketTitlesBeforeAccept,
  requestTitleOnNewAfterRefresh,
  flushTitleOnNewQueueIfPossible,
  runTicketTitlePatrolScan,
  runNewTicketTitleNormalize,
  runTicketTitleNormalizeBatch,
  startHandleListWatch,
  stopHandleListWatch
} = TD.titleOps;
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
  getMyPendingTicketsForTitleOnNew,
  getTicketSelectKey,
  renderTicketList,
  refreshTickets,
  handleTicketClick,
  syncActiveHighlightFromDom,
  startApiTicketPollTimer,
  stopApiTicketPollTimer,
  restartApiTicketPollTimer,
  commitPendingDomSyncAfterPageLoad,
  commitApiTicketIdBaseline,
  clearPendingDomSyncForTickets,
  loadMoreTickets,
  updateTicketMeta,
  syncSortButtonText,
  scanHandleListForTitleWatch,
  mapDomWatchItemToTicket,
  isTtDomSyncPending,
  isTicketItemInHandleList
} = TD.tickets;
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
const { isPullInProgress, updatePmCsvPathLabel, selectPmCsvFile, syncPmCsvFromS3, ensurePmCsvReady, runPmPullByRegion } = TD.pm;
const {
  onStart: onHfIssueStart,
  clearOnStop: clearHfIssueOnStop,
  requestHfIssueAfterRefresh
} = TD.hfIssue;
const { requestBurstOutbreakAfterRefresh } = TD.burstOutbreak;


/*
 * 工单标题前缀规范化：已实现「标题检测」按钮（runTicketTitleNormalizeBatch），规则如下：
 * - 无发起人架构 → 不改；词典 assets/china_cities.json。
 * - 外显顺序：事业部（品牌）→ 地区（城市）→ 站点名或仓名 → 原标题/问题简述。
 * - 英文标题：仅在原标题前加「城市 编号 站点名」；优先自定义字段 City/Store，否则取发起人架构末级（如 Riyadh 002 Ghirnatah）；Store/ID&Name 开头误填的 Station 会剔除。
 * - 引擎格式：{事业部简称}{城市}{站点/仓/店名}+原标题正文；站/仓/店优先从架构路径解析，其次仓库/门店字段。
 * - 「来单改标题」可独立开启（仅改标题），或与「开始」同开（先改标题再接单）；相对基线识别新单。
 * - 「标题巡检」逻辑独立在 titlePatrolList.js（TTTitlePatrolList.patrolListTitles）；「标题检测」在 titlePrefixEngine.js（TTTitlePrefix）。
 */

// 勿在此处设置 webview src：须先 bindEvents 注册监听，否则快网环境下会错过 dom-ready，导致 webviewReady 一直为 false

let running = false;
let busy = false;
let webviewReady = false;
/** 自动化 / 接单 / 改标题等：永远只用主标签 webview */
function getAutomationWebview() {
  return TD.browser?.getPrimaryWebview?.() || ttWebview || null;
}

/** 用户当前看到的标签（缩放等） */
function getVisibleWebview() {
  return TD.browser?.getActiveWebview?.() || getAutomationWebview();
}

/** 内置 TT 缩放比例（最小 80%） */
let ttZoomFactor = 1;

function clampTtZoomFactor(value) {
  const min = Number(TT_ZOOM_MIN) > 0 ? Number(TT_ZOOM_MIN) : 0.8;
  const max = Number(TT_ZOOM_MAX) > min ? Number(TT_ZOOM_MAX) : 2;
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const stepped = Math.round(n * 10) / 10;
  return Math.min(max, Math.max(min, stepped));
}

function updateTtZoomLabel() {
  if (!ttZoomLabel) return;
  ttZoomLabel.textContent = `${Math.round(ttZoomFactor * 100)}%`;
}

function applyTtWebviewZoom(factor, options = {}) {
  const next = clampTtZoomFactor(factor);
  const changed = Math.abs(next - ttZoomFactor) > 0.001;
  ttZoomFactor = next;
  updateTtZoomLabel();
  const target = options.webview || getVisibleWebview();
  try {
    if (target && typeof target.setZoomFactor === "function") {
      target.setZoomFactor(ttZoomFactor);
    }
  } catch (_) {}
  if (options.persist !== false) {
    try {
      localStorage.setItem(STORAGE_KEYS.ttZoomFactor, String(ttZoomFactor));
    } catch (_) {}
  }
  if (changed && options.log) {
    log(`内置 TT 缩放：${Math.round(ttZoomFactor * 100)}%`, "info");
  }
  return ttZoomFactor;
}

function nudgeTtWebviewZoom(direction) {
  const step = Number(TT_ZOOM_STEP) > 0 ? Number(TT_ZOOM_STEP) : 0.1;
  const delta = direction > 0 ? step : -step;
  const before = ttZoomFactor;
  const after = applyTtWebviewZoom(ttZoomFactor + delta);
  if (Math.abs(after - before) < 0.001 && after <= clampTtZoomFactor(TT_ZOOM_MIN) + 0.001 && delta < 0) {
    log("内置 TT 已缩至最小 80%，避免过小影响操作。", "info");
  }
}

let runTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let titlePatrolTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let titlePatrolDebounceTimer = null;
let countdownTimer = null;
let nextRunAt = null;
let pendingRunAfterReload = false;
let batchInProgress = false;
let batchHandledCount = 0;
let batchRemaining = 0;
let batchAutoRetryCount = 0;
const TT_BATCH_RETRY_MAX = 3;
let sessionHandledCount = 0;
let titleOnNewAutoEnabled = false;

function setActiveLeftTab(tab) {
  const isLogs = tab === "logs";
  const isTickets = tab === "tickets";
  const isTemplates = tab === "templates";
  if (tabLogsBtn) tabLogsBtn.classList.toggle("left-tab-active", isLogs);
  if (tabTicketsBtn) tabTicketsBtn.classList.toggle("left-tab-active", isTickets);
  if (tabTemplatesBtn) tabTemplatesBtn.classList.toggle("left-tab-active", isTemplates);
  if (panelLogs) panelLogs.classList.toggle("left-panel-active", isLogs);
  if (panelTickets) panelTickets.classList.toggle("left-panel-active", isTickets);
  if (panelTemplates) panelTemplates.classList.toggle("left-panel-active", isTemplates);
}

function clampInterval(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return DEFAULT_INTERVAL_SEC;
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.floor(n)));
}

function getIntervalSec() {
  const sec = clampInterval(intervalInput?.value ?? DEFAULT_INTERVAL_SEC);
  if (intervalInput) intervalInput.value = String(sec);
  return sec;
}

function getHandler() {
  const value = (handlerInput?.value || "").trim();
  const handler = value || DEFAULT_HANDLER;
  if (handlerInput) handlerInput.value = handler;
  return handler;
}

function setRunningState(next) {
  running = next;
  if (startBtn) startBtn.checked = !!next;
  const startLabel = document.getElementById("startSwitchLabel");
  if (startLabel) startLabel.textContent = next ? "开" : "关";
}

function updateNextTickDisplay() {
  if (!nextTickEl) return;
  if (!running || !nextRunAt) {
    nextTickEl.textContent = "距下次检查：—";
    return;
  }
  const remaining = Math.max(0, Math.ceil((nextRunAt - Date.now()) / 1000));
  nextTickEl.textContent = `距下次检查：${remaining}s`;
}

let lastPendingCount = NaN;

function updateTicketCount(count) {
  if (!ticketCountEl) return;
  if (typeof count !== "number" || Number.isNaN(count) || count < 0) {
    lastPendingCount = NaN;
    ticketCountEl.textContent = "待处理：—";
    return;
  }
  lastPendingCount = count;
  ticketCountEl.textContent = `待处理：${count}`;
}

function scheduleNextRun() {
  nextRunAt = Date.now() + getIntervalSec() * 1000;
  updateNextTickDisplay();
}

function stopTitlePatrolTimer() {
  if (titlePatrolTimer) {
    clearInterval(titlePatrolTimer);
    titlePatrolTimer = null;
  }
}

function clearTitlePatrolDebounce() {
  if (titlePatrolDebounceTimer) {
    clearTimeout(titlePatrolDebounceTimer);
    titlePatrolDebounceTimer = null;
  }
}

/** 工单列表从 TT 同步后延迟触发巡检（仅读程序内标题，不点 TT） */
function scheduleTitlePatrolFromRefresh() {
  if (!getTitlePatrolLogEnabled()) return;
  clearTitlePatrolDebounce();
  titlePatrolDebounceTimer = setTimeout(() => {
    titlePatrolDebounceTimer = null;
    runTicketTitlePatrolScan();
  }, 2800);
}

function getTitlePatrolLogEnabled() {
  return !!(titlePatrolLogInput && titlePatrolLogInput.checked);
}

function restartTitlePatrolTimer() {
  stopTitlePatrolTimer();
  if (!getTitlePatrolLogEnabled()) return;
  const ms = getIntervalSec() * 1000;
  titlePatrolTimer = setInterval(() => {
    runTicketTitlePatrolScan();
  }, ms);
}

function stopTimers() {
  stopTitlePatrolTimer();
  clearTitlePatrolDebounce();
  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  nextRunAt = null;
  pendingRunAfterReload = false;
  batchInProgress = false;
  batchHandledCount = 0;
  batchRemaining = 0;
  sessionHandledCount = 0;
  updateNextTickDisplay();
}

function titleOnNewModeHint() {
  if (!titleOnNewAutoEnabled) return "";
  return running ? "新单将先改标题再接单" : "仅自动改标题，不接单";
}

function logTitleOnNewEnabled() {
  log("来单改标题已开启。", "info");
}

function applyTitleOnNewAutoState(enabled) {
  titleOnNewAutoEnabled = !!enabled;
  if (titleOnNewAutoInput) titleOnNewAutoInput.checked = titleOnNewAutoEnabled;
  localStorage.setItem(STORAGE_KEYS.titleOnNewAuto, titleOnNewAutoEnabled ? "1" : "0");
  if (titleOnNewAutoEnabled) {
    clearTitleOnNewQueue();
    restartApiTicketPollTimer();
    void refreshTickets({ reset: false })
      .then(() => {
        resetTitleNewTicketBaseline();
        startHandleListWatch();
        logTitleOnNewEnabled();
        syncTitleOnNewButtonState();
      })
      .catch(() => {
        resetTitleNewTicketBaseline();
        startHandleListWatch();
        logTitleOnNewEnabled();
        syncTitleOnNewButtonState();
      });
  } else {
    stopHandleListWatch();
    clearTitleOnNewQueue();
    clearTitleOnNewBaseline();
    restartApiTicketPollTimer();
    syncTitleOnNewButtonState();
    log("来单改标题已关闭。", "muted");
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.handler, getHandler());
  localStorage.setItem(STORAGE_KEYS.interval, String(getIntervalSec()));
  localStorage.setItem(STORAGE_KEYS.autoGroup, autoGroupInput?.checked ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.autoSendMessage, autoSendMessageInput?.checked === false ? "0" : "1");
  localStorage.setItem(STORAGE_KEYS.titlePatrolLog, titlePatrolLogInput?.checked ? "1" : "0");
  titleOnNewAutoEnabled = !!titleOnNewAutoInput?.checked;
  localStorage.setItem(STORAGE_KEYS.titleOnNewAuto, titleOnNewAutoEnabled ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.autoPriorityBoost, getAutoPriorityBoostEnabled() ? "1" : "0");
  if (ticketSlaReminderToggle) {
    localStorage.setItem(STORAGE_KEYS.slaReminderEnabled, ticketSlaReminderToggle.checked ? "1" : "0");
  }
  if (ticketSlaNotifyToggle) {
    localStorage.setItem(STORAGE_KEYS.slaNotifyWindows, ticketSlaNotifyToggle.checked ? "1" : "0");
  }
}

function loadSettings() {
  const savedHandler = localStorage.getItem(STORAGE_KEYS.handler);
  const savedInterval = localStorage.getItem(STORAGE_KEYS.interval);
  const savedAutoGroup = localStorage.getItem(STORAGE_KEYS.autoGroup);
  const savedAutoSendMessage = localStorage.getItem(STORAGE_KEYS.autoSendMessage);
  const savedTitlePatrol = localStorage.getItem(STORAGE_KEYS.titlePatrolLog);
  const savedTitleOnNewAuto = localStorage.getItem(STORAGE_KEYS.titleOnNewAuto);
  const savedAutoBoost = localStorage.getItem(STORAGE_KEYS.autoPriorityBoost);
  const savedSlaReminder = localStorage.getItem(STORAGE_KEYS.slaReminderEnabled);
  const savedSlaNotify = localStorage.getItem(STORAGE_KEYS.slaNotifyWindows);
  const savedZoom = localStorage.getItem(STORAGE_KEYS.ttZoomFactor);
  if (savedZoom != null && String(savedZoom).trim() !== "") {
    ttZoomFactor = clampTtZoomFactor(savedZoom);
  }
  updateTtZoomLabel();

  if (handlerInput) handlerInput.value = savedHandler || DEFAULT_HANDLER;
  if (intervalInput) intervalInput.value = String(clampInterval(savedInterval || DEFAULT_INTERVAL_SEC));
  if (autoGroupInput) autoGroupInput.checked = savedAutoGroup === "1";
  if (autoSendMessageInput) autoSendMessageInput.checked = savedAutoSendMessage == null ? true : savedAutoSendMessage === "1";
  if (titlePatrolLogInput) titlePatrolLogInput.checked = savedTitlePatrol === "1";
  titleOnNewAutoEnabled = savedTitleOnNewAuto === "1";
  if (titleOnNewAutoInput) titleOnNewAutoInput.checked = titleOnNewAutoEnabled;
  setAutoPriorityBoostEnabled(savedAutoBoost === "1");
  if (ticketAutoPriorityBoostToggle) ticketAutoPriorityBoostToggle.checked = getAutoPriorityBoostEnabled();
  if (ticketSlaReminderToggle) {
    ticketSlaReminderToggle.checked = savedSlaReminder == null ? true : savedSlaReminder === "1";
  }
  if (ticketSlaNotifyToggle) {
    ticketSlaNotifyToggle.checked = savedSlaNotify === "1";
  }
}

function buildPendingCountScript() {
  return `
    (() => {
      const candidates = document.querySelectorAll('.filter-title.filter-title-ishandle, .filter-title-ishandle');
      if (!candidates || candidates.length === 0) return NaN;

      for (const title of candidates) {
        const text = title?.textContent || '';
        const match = text.match(/[（(](\\d+)[)）]/);
        if (!match) continue;
        const value = Number(match[1]);
        if (Number.isFinite(value) && value >= 0) return value;
      }

      return NaN;
    })();
  `;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCheckAndHandleScript(handler, autoCreateGroup, elephantMessage, elephantMessageEn, autoSendMessage) {
  const safeHandler = JSON.stringify(handler);
  const safeAuto = autoCreateGroup ? "true" : "false";
  const safeElephantMessage = JSON.stringify(elephantMessage || "");
  const safeElephantMessageEn = JSON.stringify(elephantMessageEn || "");
  const safeAutoSendMessage = autoSendMessage ? "true" : "false";
  const safeElephantRules = JSON.stringify(loadElephantRules());

  return `
    (async () => {
      const handler = ${safeHandler};
      const autoCreateGroup = ${safeAuto};
      const elephantMessage = ${safeElephantMessage};
      const elephantMessageEn = ${safeElephantMessageEn};
      const elephantRules = ${safeElephantRules};
      const autoSendMessage = ${safeAutoSendMessage};
      const HANDLE_TEXTS = ['开始处理', '开启处理'];

      function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
      function norm(text) { return ((text || '').trim()).replace(/\\s+/g, ''); }
      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
      }

      function getListWrapper() {
        return (
          document.querySelector('.handle-list-wrapper') ||
          document.querySelector('#handleListNav .handle-list-nav') ||
          document.querySelector('.handle-list-nav')
        );
      }

      async function waitForListWrapper(maxWaitMs = 8000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          const wrapper = getListWrapper();
          if (wrapper) return wrapper;
          await sleep(intervalMs);
        }
        return null;
      }

      function getDetailScope() {
        return (
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container')
        );
      }

      function isDetailTicketPending(scope) {
        if (!scope) return false;
        const icon = scope.querySelector('.detail-state .ticket-state-icon, .ticket-state .ticket-state-icon');
        if (icon?.classList.contains('ticket-state-todo')) return true;
        if (icon?.classList.contains('ticket-state-doing') || icon?.classList.contains('ticket-state-pending')) return false;

        const text = scope.querySelector('.detail-state .ticket-state-text, .ticket-state .ticket-state-text')?.textContent?.trim() || '';
        if (text.includes('暂停')) return false;
        if (text.includes('未处理')) return true;
        return false;
      }

      function isTargetHandler(scope) {
        if (!scope) return false;
        if ((scope.textContent || '').includes(handler)) return true;

        const filterContainer = document.querySelector('.filter-form, .ticket-filter, .filter-list-container');
        if (filterContainer) {
          const tags = filterContainer.querySelectorAll('.mtd-tag-content');
          for (const tag of tags) {
            if ((tag.textContent || '').trim().includes(handler)) return true;
          }
        }
        return false;
      }

      function clickCreateGroupButton() {
        const scope = getDetailScope();
        if (!scope) return '';
        const groupContainer = scope.querySelector('.ticket-dx-group-container');
        if (!groupContainer) return '';

        const buttons = groupContainer.querySelectorAll('button.mtd-btn');
        let joinBtn = null;
        let hasAlreadyBuilt = false;

        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const text = norm(btn.textContent);
          if (!text) continue;

          if (text.includes('创建大象群')) {
            btn.click();
            return 'create';
          }
          if (text.includes('加入大象群')) {
            joinBtn = btn;
            continue;
          }
          if (text.includes('已建群')) {
            hasAlreadyBuilt = true;
          }
        }

        if (joinBtn) {
          joinBtn.click();
          return 'join';
        }

        if (hasAlreadyBuilt) return 'already';
        return '';
      }

      function clickConfirmInAddMemberModal() {
        const dialogs = Array.from(document.querySelectorAll('.create-chatroom-dialog.form-dialog, .mtd-modal'));
        for (const dialog of dialogs) {
          if (!isVisible(dialog)) continue;

          const titleText = norm(dialog.querySelector('.mtd-modal-title')?.textContent || '');
          const dialogText = norm(dialog.textContent || '');
          const isTargetModal = titleText.includes('添加大象群成员') || dialogText.includes('拉入全部抄送人');
          if (!isTargetModal) continue;

          const buttons = Array.from(dialog.querySelectorAll('.mtd-modal-footer button.mtd-btn-primary, .mtd-modal-footer button'));
          for (const btn of buttons) {
            if (!isVisible(btn)) continue;
            const text = norm(btn.textContent || '');
            if (!text.includes('确定')) continue;
            btn.click();
            return true;
          }
        }
        return false;
      }

      async function waitAndConfirmAddMemberModal(maxWaitMs = 15000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          if (clickConfirmInAddMemberModal()) return true;
          await sleep(intervalMs);
        }
        return false;
      }

      function hasElephantSessionTab() {
        const tabLabels = Array.from(document.querySelectorAll('.content-tabs .mtd-tabs-item-label, .content-tabs .mtd-tabs-item'));
        for (const el of tabLabels) {
          const text = norm(el.textContent || '');
          if (text.includes('大象会话')) return true;
        }
        return false;
      }

      async function waitForElephantSessionTab(maxWaitMs = 12000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          if (hasElephantSessionTab()) return true;
          await sleep(intervalMs);
        }
        return false;
      }

      function getCurrentTicketTitle() {
        const detailRoot =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        const titleFromDetail = detailRoot?.querySelector('.ticket-name-text-display')?.textContent?.trim();
        if (titleFromDetail) return titleFromDetail;

        const titleFromList =
          document.querySelector('.handle-ticket-nav-item-active .ticket-name-text-display')?.textContent?.trim() ||
          document.querySelector('.handle-ticket-nav-item-active .content.title')?.textContent?.trim();
        if (titleFromList) return titleFromList;

        const titleFromEdit = document.querySelector('.ticket-edit-title textarea')?.value?.trim();
        if (titleFromEdit) return titleFromEdit;

        const titleHeader = document.querySelector('.ticket-edit-title')?.textContent?.trim();
        if (titleHeader) return titleHeader;
        return '';
      }

      /** 系统电表告警：标题以【电表异常】结尾，且发起人为 Retail/it_retail */
      function getReporterHint(scope) {
        const root = scope || getDetailScope() || document;
        const active = document.querySelector('.handle-ticket-nav-item-active');
        const fromList = (active?.textContent || '').trim();
        const fromDetail = (root.textContent || '').trim();
        return (fromList + '\\n' + fromDetail).replace(/\\s+/g, '');
      }

      function isMeterAlarmTicket(scope) {
        const title = String(getCurrentTicketTitle() || '').replace(/\\s+/g, '');
        if (!title.endsWith('【电表异常】')) return false;
        const hint = getReporterHint(scope).toLowerCase();
        return hint.includes('it_retail') || hint.includes('retail/it_retail');
      }

      function normalizeTitleForKeywordMatch(raw) {
        return String(raw || '').toLowerCase().replace(/\\s+/g, '');
      }

      function chooseElephantMessageByTitle() {
        const title = getCurrentTicketTitle() || '';
        const normTitle = normalizeTitleForKeywordMatch(title);

        if (Array.isArray(elephantRules) && elephantRules.length > 0) {
          for (const rule of elephantRules) {
            const keywords = Array.isArray(rule?.keywords) ? rule.keywords : [];
            const msg = (rule?.message || '').trim();
            if (!msg || keywords.length === 0) continue;
            for (const kw of keywords) {
              const k = String(kw || '').trim();
              if (!k) continue;
              const nk = normalizeTitleForKeywordMatch(k);
              if (nk && normTitle.includes(nk)) return msg;
            }
          }
        }

        const userZh = (elephantMessage || '').trim();
        const userEn = (elephantMessageEn || '').trim();
        const hasChinese = /[\\u4e00-\\u9fff]/.test(title);
        const hasEnglish = /[A-Za-z]/.test(title);

        if (hasChinese && userZh) return userZh;
        if (hasEnglish && userEn) return userEn;
        if (userZh) return userZh;
        if (userEn) return userEn;
        return '';
      }

      function findElephantSessionTabElement() {
        const candidates = Array.from(document.querySelectorAll('.content-tabs .mtd-tabs-item, .content-tabs .mtd-tabs-item-label, .content-tabs span'));
        for (const node of candidates) {
          const text = norm(node.textContent || '');
          if (!text.includes('大象会话')) continue;
          const tab = node.closest('.mtd-tabs-item') || node;
          if (isVisible(tab)) return tab;
        }
        return null;
      }

      async function openElephantSessionTab(maxWaitMs = 10000, intervalMs = 300) {
        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          const tab = findElephantSessionTabElement();
          if (tab) {
            tab.click();
            await sleep(300);
            return true;
          }
          await sleep(intervalMs);
        }
        return false;
      }

      function findElephantTextarea() {
        const candidates = Array.from(document.querySelectorAll('.low-class textarea.text-area, textarea.text-area[placeholder*="请输入消息"], textarea.text-area'));
        for (const area of candidates) {
          if (isVisible(area)) return area;
        }
        return null;
      }

      function activateElephantTextarea(textarea) {
        if (!textarea) return false;

        const clickTargets = [
          textarea,
          textarea.closest('.low-class'),
          textarea.closest('.comment-edit-input'),
          textarea.parentElement
        ].filter(Boolean);

        for (const target of clickTargets) {
          try {
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch {}
        }

        try { textarea.click(); } catch {}
        try { textarea.focus({ preventScroll: true }); } catch {}
        try {
          const len = (textarea.value || '').length;
          textarea.setSelectionRange(len, len);
        } catch {}

        return document.activeElement === textarea;
      }

      function setTextareaValue(textarea, value) {
        activateElephantTextarea(textarea);
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function findSendButton() {
        const buttons = Array.from(document.querySelectorAll('button.mtd-btn.mtd-btn-primary, button.mtd-btn'));
        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const text = norm(btn.textContent || '');
          if (text.includes('发送')) return btn;
        }
        return null;
      }

      async function sendElephantMessage(maxWaitMs = 10000, intervalMs = 300) {
        const msg = chooseElephantMessageByTitle();
        if (!msg) return 'empty_message';

        const opened = await openElephantSessionTab(maxWaitMs, intervalMs);
        if (!opened) return 'tab_not_found';

        // 建群后系统会先发一条“机器人消息”，固定等 3 秒再发话术更稳
        await sleep(3000);

        const endTime = Date.now() + maxWaitMs;
        while (Date.now() < endTime) {
          const textarea = findElephantTextarea();
          const sendBtn = findSendButton();
          if (textarea && sendBtn) {
            activateElephantTextarea(textarea);
            await sleep(100);
            setTextareaValue(textarea, msg);
            await sleep(120);
            if (!((textarea.value || '').trim())) {
              activateElephantTextarea(textarea);
              await sleep(100);
              setTextareaValue(textarea, msg);
              await sleep(120);
            }
            sendBtn.click();
            return 'sent';
          }
          await sleep(intervalMs);
        }
        return 'editor_or_send_not_found';
      }

      function getSystemTodoCount() {
        const title = document.querySelector('.filter-title.filter-title-ishandle, .filter-title-ishandle');
        if (!title) return NaN;
        const text = title.textContent || '';
        const match = text.match(/\\((\\d+)\\)/);
        return match ? Number(match[1]) : NaN;
      }

      const systemTodoCount = getSystemTodoCount();
      const listWrapper = await waitForListWrapper(8000, 300);
      if (!listWrapper) return { status: 'no_list', pendingCount: systemTodoCount };

      const items = Array.from(listWrapper.querySelectorAll('.handle-ticket-nav-item'));
      const pendingItems = items.filter((item) => {
        const stateText = item.querySelector('.ticket-state-text')?.textContent?.trim() || '';
        const stateIcon = item.querySelector('.ticket-state-icon');
        if (stateText.includes('暂停') || !!stateIcon?.classList.contains('ticket-state-pending')) return false;
        return stateText.includes('未处理') || !!stateIcon?.classList.contains('ticket-state-todo');
      });

      if (pendingItems.length === 0) return { status: 'no_pending', pendingCount: systemTodoCount };

      const pendingItem = pendingItems[0];
      pendingItem.click();
      await sleep(1200);

      const scope = getDetailScope();
      if (!scope) return { status: 'no_detail', pendingCount: systemTodoCount };
      if (!isTargetHandler(scope)) return { status: 'handler_not_match', pendingCount: systemTodoCount };
      if (!isDetailTicketPending(scope)) return { status: 'state_not_pending', pendingCount: systemTodoCount };

      const actionRoot =
        document.querySelector('.ticket-handle-container') ||
        document.querySelector('.ticket-handle-buttons') ||
        document.querySelector('.right-button') ||
        document.querySelector('.ticket-detail-header .ticket-handle-container') ||
        document.querySelector('.ticket-content-main-container .right-button') ||
        scope;

      const nodes = actionRoot.querySelectorAll('button, [role="button"], .mtd-btn, .mtd-btn-text');
      for (const el of nodes) {
        const text = (el.textContent || '').trim();
        if (!text) continue;
        if (!HANDLE_TEXTS.some((t) => text.includes(t))) continue;

        el.click();
        // 系统电表告警单：仍接单，但不建群、不发话术
        if (isMeterAlarmTicket(scope)) {
          return { status: 'clicked_handle|meter_alarm_skip_group', pendingCount: systemTodoCount };
        }
        if (!autoCreateGroup) return { status: 'clicked_handle', pendingCount: systemTodoCount };

        await sleep(1200);
        const groupAction = clickCreateGroupButton();
        if (!groupAction) return { status: 'clicked_handle|group_btn_not_found', pendingCount: systemTodoCount };

        if (groupAction === 'already') {
          const hasSession = await waitForElephantSessionTab(6000, 300);
          if (!hasSession) return { status: 'clicked_handle|group_already', pendingCount: systemTodoCount };
          if (!autoSendMessage) return { status: 'clicked_handle|group_session_ready_no_send', pendingCount: systemTodoCount };
          const sendResult = await sendElephantMessage(10000, 300);
          if (sendResult === 'sent') return { status: 'clicked_handle|group_session_ready_and_sent', pendingCount: systemTodoCount };
          return { status: 'clicked_handle|group_session_ready_but_send_failed', pendingCount: systemTodoCount };
        }

        if (groupAction === 'join') {
          const confirmed = await waitAndConfirmAddMemberModal(3500, 300);
          const hasSession = await waitForElephantSessionTab(12000, 300);
          if (hasSession) {
            if (!autoSendMessage) return { status: 'clicked_handle|group_session_ready_no_send', pendingCount: systemTodoCount };
            const sendResult = await sendElephantMessage(10000, 300);
            if (sendResult === 'sent') return { status: 'clicked_handle|group_session_ready_and_sent', pendingCount: systemTodoCount };
            return { status: 'clicked_handle|group_session_ready_but_send_failed', pendingCount: systemTodoCount };
          }
          return { status: confirmed ? 'clicked_handle|group_confirmed_no_session' : 'clicked_handle|group_joined', pendingCount: systemTodoCount };
        }

        const confirmed = await waitAndConfirmAddMemberModal();
        if (!confirmed) return { status: 'clicked_handle|group_no_confirm', pendingCount: systemTodoCount };

        const hasSession = await waitForElephantSessionTab(12000, 300);
        if (!hasSession) return { status: 'clicked_handle|group_confirmed_no_session', pendingCount: systemTodoCount };

        if (!autoSendMessage) return { status: 'clicked_handle|group_session_ready_no_send', pendingCount: systemTodoCount };
        const sendResult = await sendElephantMessage(10000, 300);
        if (sendResult === 'sent') return { status: 'clicked_handle|group_session_ready_and_sent', pendingCount: systemTodoCount };
        return { status: 'clicked_handle|group_session_ready_but_send_failed', pendingCount: systemTodoCount };
      }

      return { status: 'no_handle_btn', pendingCount: systemTodoCount };
    })();
  `;
}

function statusToMessage(status) {
  switch (status) {
    case "no_list":
      return "工单页面加载中，请稍候…";
    case "no_pending":
      return "当前没有待处理工单。";
    case "no_detail":
      return "工单详情加载中，本轮已跳过。";
    case "handler_not_match":
      return "当前工单不归你处理，已跳过。";
    case "state_not_pending":
      return "工单已被处理，已跳过。";
    case "no_handle_btn":
      return "工单操作按钮未就绪，请稍后重试。";
    case "clicked_handle":
      return "已开始处理工单。";
    case "clicked_handle|meter_alarm_skip_group":
      return "系统电表告警单，已接单，已跳过建群与话术。";
    case "clicked_handle|group_confirmed":
      return "已开始处理，大象群已创建。";
    case "clicked_handle|group_session_ready":
      return "已加入大象群，可以发送消息。";
    case "clicked_handle|group_session_ready_no_send":
      return "已加入大象群，未开启自动发送话术。";
    case "clicked_handle|group_session_ready_and_sent":
      return "已加入大象群，话术已发送。";
    case "clicked_handle|group_session_ready_but_send_failed":
      return "已加入大象群，但话术发送失败。";
    case "clicked_handle|group_confirmed_no_session":
      return "大象群创建中，请稍候…";
    case "clicked_handle|group_btn_not_found":
      return "大象群创建按钮未就绪，请稍后重试。";
    case "clicked_handle|group_already":
      return "该工单已有大象群，无需重建。";
    case "clicked_handle|group_joined":
      return "已开始处理，并加入大象群。";
    case "clicked_handle|group_no_confirm":
      return "建群确认未完成，请稍后重试。";
    case "title_pending":
      return "等待改标题完成后再接单…";
    case "unknown":
      return "操作异常，请稍后重试。";
    default:
      return `操作未完成（${String(status).slice(0, 40)}），请稍后重试。`;
  }
}

function statusToLevel(status) {
  if (!status) return "info";
  if (status === "unknown") return "error";

  if (
    status === "clicked_handle" ||
    status === "clicked_handle|meter_alarm_skip_group" ||
    status === "clicked_handle|group_confirmed" ||
    status === "clicked_handle|group_session_ready" ||
    status === "clicked_handle|group_session_ready_and_sent"
  ) return "success";

  if (status === "no_pending" || status === "handler_not_match" || status === "state_not_pending") {
    return "muted";
  }

  if (
    status === "no_list" ||
    status === "no_detail" ||
    status === "no_handle_btn" ||
    status === "clicked_handle|group_session_ready_no_send" ||
    status === "clicked_handle|group_session_ready_but_send_failed" ||
    status === "clicked_handle|group_confirmed_no_session" ||
    status === "clicked_handle|group_btn_not_found" ||
    status === "clicked_handle|group_already" ||
    status === "clicked_handle|group_joined" ||
    status === "clicked_handle|group_no_confirm"
  ) return "warning";

  return "info";
}

async function refreshPendingCount() {
  if (!webviewReady || !getAutomationWebview()) return;

  const maxRetries = 5;
  const retryDelayMs = 250;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const count = await ttExecuteJavaScript(buildPendingCountScript());
      const parsed = typeof count === "number" ? count : Number(count);
      if (Number.isFinite(parsed) && parsed >= 0) {
        updateTicketCount(parsed);
        return;
      }
    } catch {
      // ignore and retry
    }

    if (attempt < maxRetries - 1) {
      await sleep(retryDelayMs);
    }
  }

  updateTicketCount(NaN);
}

async function runCheck() {
  if (!running || busy || isBatchInProgress() || isPullInProgress() || isNormalizeInProgress() || !webviewReady || !getAutomationWebview()) {
    return null;
  }

  // 方案 L：发话术/接单前切到接单面，保证输入框可聚焦
  try {
    const sw = TD.browser?.ensureOpsSurface?.();
    if (sw?.switched) {
      log("已切换到接单 TT 以完成接单/发话术（结束后可回到浏览标签）。", "muted");
      await sleep(200);
    }
  } catch {
    // ignore
  }

  if (titleOnNewAutoEnabled) {
    const titlesReady = await ensureNewTicketTitlesBeforeAccept({
      tryRefresh: !batchInProgress || batchHandledCount === 0
    });
    if (!titlesReady) {
      return { status: "title_pending", pendingCount: NaN };
    }
    if (!running || busy || isNormalizeInProgress() || !getAutomationWebview()) return null;
    const readyWaitEnd = Date.now() + 20000;
    while ((!webviewReady || isTtWebviewReloadInFlight()) && Date.now() < readyWaitEnd) {
      await sleep(200);
    }
    if (!webviewReady || isTtWebviewReloadInFlight()) {
      return { status: "title_pending", pendingCount: NaN };
    }
  }

  busy = true;

  try {
    const handler = getHandler();
    const autoCreateGroup = !!(autoGroupInput && autoGroupInput.checked);
    const autoSendMessage = autoSendMessageInput
      ? !!autoSendMessageInput.checked
      : true;
    const elephantMessage = getElephantMessage();
    const elephantMessageEn = getElephantMessageEn();
    const script = buildCheckAndHandleScript(
      handler,
      autoCreateGroup,
      elephantMessage,
      elephantMessageEn,
      autoSendMessage
    );
    const result = await ttExecuteJavaScript(script);

    const status = result?.status || "unknown";
    const pendingCount = Number(result?.pendingCount);

    if (Number.isFinite(pendingCount) && pendingCount >= 0) updateTicketCount(pendingCount);
    log(statusToMessage(status), statusToLevel(status));
    return { status, pendingCount };
  } catch (err) {
    log(`接单操作失败：${TD.log.errText(err)}`, "error");
    return { status: "unknown", pendingCount: NaN };
  } finally {
    busy = false;
  }
}

function isHandledStatus(status) {
  return typeof status === "string" && status.startsWith("clicked_handle");
}

function startBatchIfNeeded(reason = "定时触发") {
  if (!running || !getAutomationWebview()) return;
  if (batchInProgress || pendingRunAfterReload || busy || isBatchInProgress() || isPullInProgress() || isNormalizeInProgress()) {
    return;
  }

  batchInProgress = true;
  batchHandledCount = 0;
  batchRemaining = DEFAULT_BATCH_LIMIT;
  batchAutoRetryCount = 0;
  log(`开始自动接单，本轮最多处理 ${DEFAULT_BATCH_LIMIT} 单。`, "info");
  refreshPageThenRunCheck();
}

function requestAcceptAfterTitle() {
  if (!running || !getAutomationWebview()) return;
  if (isNormalizeInProgress() || busy) {
    pendingRunAfterReload = true;
    return;
  }
  if (!batchInProgress) {
    startBatchIfNeeded("改标题后接单");
    return;
  }
  refreshPageThenRunCheck();
}

/** API 来新单且已开「开始」：触发一轮批次 F5，无需用户手动刷新 */
function requestBatchPageRefresh(reason = "api_new_ticket") {
  if (!running || !getAutomationWebview()) return false;
  if (pendingRunAfterReload) return true;
  // 改标题进行中不能空返回：否则列表永远不刷、改标题一直等列表
  if (isNormalizeInProgress()) {
    const syncReason =
      reason === "api_new_ticket" || reason === "dom_lag" || reason === "no_list_wrapper"
        ? reason
        : "api_new_ticket";
    return requestTtWebviewReload(syncReason);
  }
  if (batchInProgress || busy) {
    requestTtWebviewReload(
      reason === "api_new_ticket" || reason === "dom_lag" || reason === "no_list_wrapper"
        ? reason
        : "api_new_ticket"
    );
    return true;
  }
  startBatchIfNeeded(reason === "api_new_ticket" ? "API 来新单" : String(reason || "同步"));
  return true;
}

function finishBatch() {
  batchInProgress = false;
  batchRemaining = 0;
  batchAutoRetryCount = 0;
  try {
    if (TD.browser?.restoreBrowseSurfaceIfNeeded?.()) {
      log("接单轮次结束，已回到浏览标签。", "muted");
    }
  } catch {
    // ignore
  }
  queueMicrotask(() => {
    flushAutoPriorityBoostQueueIfPossible().catch(() => {});
  });
}

function handleBatchResult(result) {
  if (!batchInProgress || !running) return;

  if (!result) {
    setTimeout(() => {
      if (!running || !batchInProgress) return;
      void runCheck().then((r) => handleBatchResult(r));
    }, 2500);
    return;
  }

  const status = result?.status || "unknown";
  if (status === "title_pending") {
    batchAutoRetryCount += 1;
    if (batchAutoRetryCount > TT_BATCH_RETRY_MAX) {
      log(`标题等待列表超时（已重试 ${TT_BATCH_RETRY_MAX} 次），本轮接单结束。`, "warning");
      finishBatch();
      return;
    }
    // 只刷一次，就绪后直接复检，避免 api_new_ticket + batch_next 连环 F5
    requestTtWebviewReload("api_new_ticket");
    setTimeout(() => {
      if (!running || !batchInProgress) return;
      void runCheck().then((r) => handleBatchResult(r));
    }, 2800);
    return;
  }

  if (status === "no_pending") {
    const level = batchHandledCount > 0 ? "success" : "muted";
    log(`本轮接单完成：处理了 ${batchHandledCount} 单，累计 ${sessionHandledCount} 单。`, level);
    finishBatch();
    return;
  }

  if (!isHandledStatus(status)) {
    const retryable =
      status === "no_detail" ||
      status === "no_handle_btn" ||
      status === "unknown" ||
      status === "no_list";
    if (retryable) {
      batchAutoRetryCount += 1;
      if (batchAutoRetryCount > TT_BATCH_RETRY_MAX) {
        log(`接单重试已达上限（${TT_BATCH_RETRY_MAX} 次）：${statusToMessage(status)}。`, "warning");
        finishBatch();
        return;
      }
      setTimeout(() => {
        if (!running || !batchInProgress) return;
        refreshPageThenRunCheck();
      }, 2500);
      return;
    }
    log(`本轮接单结束：${statusToMessage(status)}，已处理 ${batchHandledCount} 单。`, statusToLevel(status));
    finishBatch();
    return;
  }

  batchHandledCount += 1;
  sessionHandledCount += 1;
  batchRemaining -= 1;
  batchAutoRetryCount = 0;
  log(`已处理 ${batchHandledCount} 单，累计 ${sessionHandledCount} 单。`, "success");
  if (batchRemaining <= 0) {
    log(`本轮已达上限 ${DEFAULT_BATCH_LIMIT} 单，暂停接单。`, "warning");
    finishBatch();
    return;
  }

  setTimeout(() => {
    if (!running || !batchInProgress) return;
    refreshPageThenRunCheck();
  }, NEXT_TICKET_RELOAD_DELAY_MS);
}

function refreshPageThenRunCheck() {
  if (!running || !getAutomationWebview() || busy || isNormalizeInProgress()) return;

  pendingRunAfterReload = true;
  requestTtWebviewReload("batch_next");
}

/** 两次自动刷新最短间隔（所有原因均生效，避免 F5 风暴） */
const TT_AUTO_RELOAD_COOLDOWN_MS = 12000;
/** 接单下一轮允许稍短间隔 */
const TT_BATCH_RELOAD_COOLDOWN_MS = 1200;
/** 60 秒内最多自动 F5 次数，超限则熔断 */
const TT_RELOAD_CIRCUIT_MAX = 3;
const TT_RELOAD_CIRCUIT_WINDOW_MS = 60000;
const TT_RELOAD_CIRCUIT_COOLDOWN_MS = 180000;
/** 刷新卡住超时后强制恢复 */
const TT_RELOAD_WATCHDOG_MS = 45000;

let lastTtAutoReloadAt = 0;
let ttSyncReloadQueued = false;
let ttSyncReloadQueuedReason = "";
let ttReloadInFlight = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let ttReloadWatchdogTimer = null;
/** @type {number[]} */
let ttReloadRecentAt = [];
let ttReloadCircuitOpenUntil = 0;

function clearTtReloadWatchdog() {
  if (ttReloadWatchdogTimer) {
    clearTimeout(ttReloadWatchdogTimer);
    ttReloadWatchdogTimer = null;
  }
}

function markTtReloadFinished() {
  ttReloadInFlight = false;
  webviewReady = true;
  clearTtReloadWatchdog();
  setWebviewLoadingHint(false);
}

function armTtReloadWatchdog() {
  clearTtReloadWatchdog();
  ttReloadWatchdogTimer = setTimeout(() => {
    ttReloadWatchdogTimer = null;
    if (!ttReloadInFlight) return;
    log("页面刷新超时，已自动恢复。", "warning");
    pendingRunAfterReload = false;
    markTtReloadFinished();
    tryFlushTtSyncReloadQueue();
  }, TT_RELOAD_WATCHDOG_MS);
}

function executeTtWebviewReload() {
  const wv = getAutomationWebview();
  if (!wv) return false;
  try {
    if (typeof wv.reload === "function") {
      wv.reload();
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const u =
      (typeof wv.getURL === "function" && wv.getURL()) ||
      wv.getAttribute?.("src") ||
      C.TT_WEBVIEW_DEFAULT_SRC;
    if (typeof wv.loadURL === "function") {
      void Promise.resolve(wv.loadURL(u)).catch(() => {});
      return true;
    }
    wv.setAttribute("src", u);
    return true;
  } catch {
    return false;
  }
}

function ttReloadReasonLabel(reason) {
  switch (reason) {
    case "api_new_ticket":
      return "API 来新单";
    case "dom_lag":
      return "页面列表滞后";
    case "no_list_wrapper":
      return "列表未加载";
    case "title_on_new":
      return "来单改标题";
    case "batch_next":
      return "接单下一轮";
    default:
      return "同步工单";
  }
}

function isTtWebviewReloadInFlight() {
  return ttReloadInFlight || !webviewReady;
}

function queueTtSyncReload(reason) {
  ttSyncReloadQueued = true;
  ttSyncReloadQueuedReason = reason || "sync";
}

/**
 * 自动刷新 TT webview（等同 F5）。
 * 同一时间只允许一次；全原因冷却；短时过频则熔断。
 * @param {string} [reason]
 * @returns {boolean} 是否已发起 reload
 */
function requestTtWebviewReload(reason = "sync") {
  if (!getAutomationWebview()) return false;

  const isSyncReason =
    reason === "api_new_ticket" || reason === "dom_lag" || reason === "no_list_wrapper";
  const now = Date.now();

  if (ttReloadInFlight) {
    queueTtSyncReload(reason);
    return false;
  }

  if (now < ttReloadCircuitOpenUntil && reason !== "batch_next") {
    return false;
  }

  // 来单同步允许在改标题中打断，避免「等列表 / 禁止 F5」死锁
  if (isNormalizeInProgress() && reason !== "batch_next" && !isSyncReason) {
    queueTtSyncReload(reason);
    return false;
  }

  const cooldownMs = reason === "batch_next" ? TT_BATCH_RELOAD_COOLDOWN_MS : TT_AUTO_RELOAD_COOLDOWN_MS;
  if (now - lastTtAutoReloadAt < cooldownMs) {
    if (reason !== "batch_next") queueTtSyncReload(reason);
    return false;
  }

  if (busy && reason !== "batch_next" && !isSyncReason) {
    queueTtSyncReload(reason);
    return false;
  }

  ttReloadRecentAt = ttReloadRecentAt.filter((t) => now - t < TT_RELOAD_CIRCUIT_WINDOW_MS);
  if (reason !== "batch_next" && ttReloadRecentAt.length >= TT_RELOAD_CIRCUIT_MAX) {
    ttReloadCircuitOpenUntil = now + TT_RELOAD_CIRCUIT_COOLDOWN_MS;
    ttSyncReloadQueued = false;
    ttSyncReloadQueuedReason = "";
    log(
      `页面自动刷新过于频繁，已暂停 ${Math.round(TT_RELOAD_CIRCUIT_COOLDOWN_MS / 60000)} 分钟自动刷新（可手动刷新）。`,
      "warning"
    );
    return false;
  }

  lastTtAutoReloadAt = now;
  ttReloadRecentAt.push(now);
  ttSyncReloadQueued = false;
  ttSyncReloadQueuedReason = "";
  ttReloadInFlight = true;
  webviewReady = false;
  setWebviewLoadingHint(true);
  armTtReloadWatchdog();

  if (reason !== "batch_next") {
    log("正在刷新工单页面…", "info");
  } else {
    log("工单页面已刷新。", "info");
  }

  if (!executeTtWebviewReload()) {
    pendingRunAfterReload = false;
    markTtReloadFinished();
    log(`工单页面刷新失败：未能执行刷新（原因 ${reason || "unknown"}）。`, "error");
    return false;
  }
  return true;
}

function tryFlushTtSyncReloadQueue() {
  if (!ttSyncReloadQueued || ttReloadInFlight) return;
  if (Date.now() < ttReloadCircuitOpenUntil) {
    ttSyncReloadQueued = false;
    ttSyncReloadQueuedReason = "";
    return;
  }
  const reason = ttSyncReloadQueuedReason || "sync";
  ttSyncReloadQueued = false;
  ttSyncReloadQueuedReason = "";
  requestTtWebviewReload(reason);
}

function restartRunningTimers() {
  if (!running) return;

  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }

  const intervalMs = getIntervalSec() * 1000;
  scheduleNextRun();
  runTimer = setInterval(() => {
    scheduleNextRun();
    startBatchIfNeeded("定时触发");
  }, intervalMs);
  restartTitlePatrolTimer();
}

function start() {
  if (running) return;
  if (!getAutomationWebview()) {
    log("程序初始化中，请稍后再试。", "error");
    return;
  }

  clearTitlePatrolDebounce();
  saveSettings();
  setRunningState(true);
  scheduleNextRun();
  updateNextTickDisplay();

  restartRunningTimers();
  restartApiTicketPollTimer();
  if (!countdownTimer) countdownTimer = setInterval(updateNextTickDisplay, 1000);

  resetTitleNewTicketBaseline();
  clearTitleOnNewQueue();
  syncTitleOnNewButtonState();
  onHfIssueStart();
  log(`自动接单已开启：每 ${getIntervalSec()} 秒检查一次，处理人 ${getHandler()}。`, "success");
  startBatchIfNeeded("启动后首轮");
}

function stop() {
  if (!running) return;
  setRunningState(false);
  clearAutoBoostQueue();
  clearTitleOnNewQueue();
  clearHfIssueOnStop();
  restartApiTicketPollTimer();
  syncTitleOnNewButtonState();
  stopTimers();
  restartTitlePatrolTimer();
  try {
    TD.browser?.restoreBrowseSurfaceIfNeeded?.();
    TD.browser?.clearOpsSurfaceResume?.();
  } catch {
    // ignore
  }
  if (titleOnNewAutoEnabled) {
    log("已停止接单。来单改标题仍开启，会继续自动改标题。", "info");
  } else {
    log("已停止自动接单。", "info");
  }
}

function toggleStartStop() {
  if (running) stop();
  else start();
  // 与真实 running 同步（start 失败时 checkbox 可能已被用户点开）
  setRunningState(running);
}

async function handleAppCacheCleared(result) {
  setActiveLeftTab("logs");
  const items = Array.isArray(result?.items) ? result.items : [];
  log("开始清理缓存…", "info");

  if (!items.length) {
    log("清理缓存未返回明细。", "warning");
  } else {
    for (const item of items) {
      const name = String(item?.name || "未命名项");
      const detail = String(item?.detail || "").trim();
      const status = String(item?.status || "");
      if (status === "ok") {
        log(`已清理：${name}${detail ? ` — ${detail}` : ""}`, "success");
      } else if (status === "skip") {
        log(`跳过：${name}${detail ? ` — ${detail}` : ""}`, "info");
      } else {
        log(`失败：${name}${detail ? ` — ${detail}` : ""}`, "error");
      }
    }
  }

  // 渲染进程内存缓存
  try {
    TD.hfIssue?.clearMemoryCaches?.();
    TD.burstOutbreak?.clearMemoryCaches?.();
    TD.titleOps?.clearMemoryCaches?.();
    log("已清理：内存缓存 — 城市库 / 高频扫描状态 / 标题扫描基线", "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`失败：内存缓存 — ${msg}`, "error");
  }

  // PM 路径标记清理后重新同步
  try {
    localStorage.removeItem(STORAGE_KEYS.pmCsvPath);
    updatePmCsvPathLabel("缓存已清理，准备重新同步");
    log("已清理：PM 配置路径标记（localStorage）", "success");
    const synced = await syncPmCsvFromS3?.({ silent: false });
    if (synced?.ok) {
      log("PM 表已从 S3 重新同步。", "success");
    } else if (synced?.usedCache) {
      log("PM 表重新同步失败，若仍有本地文件将继续使用。", "warning");
    } else {
      log("PM 表重新同步失败，可稍后点击「同步PM表」。", "warning");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`PM 表重新同步异常：${msg}`, "warning");
  }

  const failed = items.some((x) => x?.status === "fail") || result?.ok === false;
  log(
    failed ? "缓存清理完成（部分项失败，详见上方日志）。" : "缓存清理完成。",
    failed ? "warning" : "success"
  );
}

function bindEvents() {
  if (startBtn) startBtn.addEventListener("change", toggleStartStop);
  if (apiSettingsCloseBtn) apiSettingsCloseBtn.addEventListener("click", closeApiSettingsModal);
  if (apiSettingsCancelBtn) apiSettingsCancelBtn.addEventListener("click", closeApiSettingsModal);
  if (apiRgIdsAddBtn) apiRgIdsAddBtn.addEventListener("click", () => appendApiRgIdRow(""));
  if (apiSettingsSaveBtn) {
    apiSettingsSaveBtn.addEventListener("click", () => {
      saveApiSettingsFromForm().catch(() => {});
    });
  }
  if (apiSettingsOpenFileBtn) {
    apiSettingsOpenFileBtn.addEventListener("click", async () => {
      try {
        const r = await window.ttDesktopApi?.openTtApiConfig?.();
        if (r?.ok === false) {
          setApiSettingsError(r.message || "无法打开配置文件");
        } else if (r?.path && apiSettingsPath) {
          apiSettingsPath.textContent = `配置文件：${r.path}`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setApiSettingsError(`打开失败：${msg}`);
      }
    });
  }
  if (apiSettingsModal) {
    apiSettingsModal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-api-settings-close") === "1") {
        closeApiSettingsModal();
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && apiSettingsModal && !apiSettingsModal.hidden) {
      closeApiSettingsModal();
    }
  });
  if (typeof window.ttDesktopApi?.onOpenApiSettings === "function") {
    window.ttDesktopApi.onOpenApiSettings(() => {
      openApiSettingsModal().catch(() => {});
    });
  }
  if (typeof window.ttDesktopApi?.onOpenBookmarkSettings === "function") {
    window.ttDesktopApi.onOpenBookmarkSettings(() => {
      TD.browser?.openBookmarkSettingsModal?.();
    });
  }
  if (typeof window.ttDesktopApi?.onAppCacheCleared === "function") {
    window.ttDesktopApi.onAppCacheCleared((result) => {
      handleAppCacheCleared(result).catch(() => {});
    });
  }
  if (templatesSaveBtn) templatesSaveBtn.addEventListener("click", saveTemplatesModal);
  if (templatesAddRuleBtn) templatesAddRuleBtn.addEventListener("click", addRule);
  if (templatesPreviewBtn) {
    templatesPreviewBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      previewTemplateMatchForActiveTicket();
    });
  }
  if (tabLogsBtn) tabLogsBtn.addEventListener("click", () => setActiveLeftTab("logs"));
  if (tabTicketsBtn) {
    tabTicketsBtn.addEventListener("click", () => {
      setActiveLeftTab("tickets");
      refreshTickets({ reset: false }).catch(() => {});
    });
  }
  if (tabTemplatesBtn) {
    tabTemplatesBtn.addEventListener("click", () => {
      setActiveLeftTab("templates");
      loadTemplatesPanel();
    });
  }
  if (ticketRefreshBtn) ticketRefreshBtn.addEventListener("click", () => refreshTickets({ reset: true }));
  if (ticketTitlePatrolBtn) {
    ticketTitlePatrolBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runTicketTitlePatrolScan({ forced: true });
    });
  }
  if (ticketPriorityApplyBtn) {
    ticketPriorityApplyBtn.addEventListener("click", () => {
      applyPriorityForActiveTicket().catch((err) => {
        log(`优先级设置异常：${TD.log.errText(err)}`, "error");
      });
    });
  }
  if (ticketBatchSelectVisibleBtn) {
    ticketBatchSelectVisibleBtn.addEventListener("click", () => {
      if (isBatchInProgress()) return;
      const filtered = applyTicketFilters(getTickets());
      const sorted = sortTickets(filtered);
      addAllVisibleToBatch(sorted);
      updateBatchPrioritySelectionCount();
      renderTicketList();
    });
  }
  if (ticketBatchClearSelectionBtn) {
    ticketBatchClearSelectionBtn.addEventListener("click", () => {
      if (isBatchInProgress()) return;
      clearBatchSelection();
      updateBatchPrioritySelectionCount();
      renderTicketList();
    });
  }
  if (ticketAutoPriorityBoostToggle) {
    ticketAutoPriorityBoostToggle.checked = getAutoPriorityBoostEnabled();
    ticketAutoPriorityBoostToggle.addEventListener("change", () => {
      setAutoPriorityBoostEnabled(!!ticketAutoPriorityBoostToggle.checked);
      saveSettings();
      log(`自动升高优先级${getAutoPriorityBoostEnabled() ? "已开启" : "已关闭"}`, getAutoPriorityBoostEnabled() ? "info" : "muted");
      if (getAutoPriorityBoostEnabled()) {
        requestAutoPriorityBoostFromRefresh();
      }
    });
  }
  if (ticketAutoPriorityBoostBtn) {
    ticketAutoPriorityBoostBtn.addEventListener("click", () => {
      if (isBatchInProgress()) {
        log("正在批量设置优先级，请稍候…", "warning");
        return;
      }
      if (isNormalizeInProgress()) {
        log("请等待标题检测完成后再升高优先级。", "warning");
        return;
      }
      if (running) {
        log("请先停止自动接单，再升高优先级。", "warning");
        return;
      }
      const filtered = applyTicketFilters(getTickets());
      const sorted = sortTickets(filtered);
      const hits = selectVisibleByKeywordBoost(sorted);
      updateBatchPrioritySelectionCount();
      renderTicketList();
      const count = getBatchSelectionCount();
      if (!count) {
        log("当前工单未命中关键词。", "muted");
        return;
      }
      if (ticketPrioritySelect) ticketPrioritySelect.value = AUTO_PRIORITY_BOOST_TARGET;
      log(`命中 ${count} 条工单，将升高至「高」优先级。`, "info");
      applyPriorityBatch().catch((err) => {
        log(`优先级设置异常：${TD.log.errText(err)}`, "error");
      });
    });
  }
  if (ticketPriorityBatchBtn) {
    ticketPriorityBatchBtn.addEventListener("click", () => {
      applyPriorityBatch().catch((err) => {
        log(`优先级设置异常：${TD.log.errText(err)}`, "error");
        setPriorityBatchUiBusy(false);
      });
    });
  }
  if (ticketPriorityBatchStopBtn) {
    ticketPriorityBatchStopBtn.addEventListener("click", () => {
      if (isBatchInProgress()) abortBatch();
    });
  }
  if (ticketTitleOnNewBtn) {
    syncTitleOnNewButtonState();
    ticketTitleOnNewBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runNewTicketTitleNormalize({ triggeredBy: "来单改标题" }).catch((err) => {
        log(`标题修改异常：${TD.log.errText(err)}`, "error");
      });
    });
  }
  if (titleOnNewAutoInput) {
    titleOnNewAutoInput.addEventListener("change", () => {
      applyTitleOnNewAutoState(!!titleOnNewAutoInput.checked);
    });
  }
  if (ticketTitleNormalizeBtn) {
    ticketTitleNormalizeBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runTicketTitleNormalizeBatch().catch((err) => {
        log(`标题检测异常：${TD.log.errText(err)}`, "error");
      });
    });
  }
  if (pmCsvSelectBtn) {
    pmCsvSelectBtn.addEventListener("click", () => {
      selectPmCsvFile().catch(() => {});
    });
  }
  if (pmPullByRegionBtn) {
    pmPullByRegionBtn.addEventListener("click", () => {
      runPmPullByRegion().catch((err) => {
        log(`拉人异常：${TD.log.errText(err)}`, "error");
        // pm module handles busy in finally
      });
    });
  }
  if (ticketTitleSearchInput) {
    ticketTitleSearchInput.addEventListener("input", () => {
      setTicketTitleSearch(ticketTitleSearchInput.value || "");
      renderTicketList();
    });
  }
  if (ticketCategorySelect) {
    ticketCategorySelect.addEventListener("change", () => {
      setTicketCategoryFilter(ticketCategorySelect.value || "all");
      renderTicketList();
    });
  }
  if (ticketOnlyMineInput) {
    ticketOnlyMineInput.checked = getTicketOnlyMine();
    ticketOnlyMineInput.addEventListener("change", () => {
      setTicketOnlyMine(!!ticketOnlyMineInput.checked);
      renderTicketList();
    });
  }
  if (ticketHideClosedInput) {
    ticketHideClosedInput.checked = getTicketHideClosed();
    ticketHideClosedInput.addEventListener("change", () => {
      setTicketHideClosed(!!ticketHideClosedInput.checked);
      renderTicketList();
    });
  }

  if (ticketSlaReminderToggle) {
    ticketSlaReminderToggle.addEventListener("change", () => {
      saveSettings();
      const on = !!ticketSlaReminderToggle.checked;
      log(`工单时效提醒${on ? "已开启" : "已关闭"}`, on ? "info" : "muted");
      renderTicketList();
      runSlaScan({ emitAlerts: on });
    });
  }
  if (ticketSlaNotifyToggle) {
    ticketSlaNotifyToggle.addEventListener("change", () => {
      saveSettings();
      log(`桌面通知${ticketSlaNotifyToggle.checked ? "已开启" : "已关闭"}`, "info");
    });
  }
  if (prioritySortBtn) {
    prioritySortBtn.addEventListener("click", () => {
      togglePrioritySort();
      renderTicketList();
    });
  }
  if (createdSortBtn) {
    createdSortBtn.addEventListener("click", () => {
      toggleCreatedSort();
      renderTicketList();
    });
  }
  if (ticketListEl) {
    ticketListEl.addEventListener("scroll", () => {
      const threshold = 120;
      const remaining = ticketListEl.scrollHeight - ticketListEl.scrollTop - ticketListEl.clientHeight;
      if (remaining < threshold) {
        loadMoreTickets().catch(() => {});
      }
    });
  }

  if (handlerInput) {
    handlerInput.addEventListener("change", () => {
      handlerInput.value = getHandler();
      saveSettings();
    });
  }

  if (intervalInput) {
    intervalInput.addEventListener("change", () => {
      intervalInput.value = String(getIntervalSec());
      saveSettings();
      restartRunningTimers();
      restartTitlePatrolTimer();
    });
  }

  if (autoGroupInput) autoGroupInput.addEventListener("change", saveSettings);
  if (autoSendMessageInput) autoSendMessageInput.addEventListener("change", saveSettings);
  if (titlePatrolLogInput) {
    titlePatrolLogInput.addEventListener("change", () => {
      saveSettings();
      if (titlePatrolLogInput.checked) {
        log("标题巡检已开启：定时检查工单标题是否规范。", "info");
      }
      restartTitlePatrolTimer();
    });
  }

  const primaryWv = getAutomationWebview();
  if (!primaryWv) return;

  // dom-ready 后再跑 executeJavaScript，避免与 guest 首屏绘制争抢
  const scheduleGuestIdleWork = (fn) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => {
        void Promise.resolve(fn()).catch(() => {});
      }, { timeout: 400 });
    } else {
      setTimeout(() => {
        void Promise.resolve(fn()).catch(() => {});
      }, 0);
    }
  };

  primaryWv.addEventListener("dom-ready", async () => {
    markTtReloadFinished();
    applyTtWebviewZoom(ttZoomFactor, { persist: false });
    log("工单页面已就绪。", "success");
    scheduleGuestIdleWork(async () => {
      await onTtPageLifecycle({ reset: true });
      try {
        void TD.sla.paintTtSlaTitlesInWebview?.();
      } catch {
        // ignore
      }
    });
  });

  primaryWv.addEventListener("did-start-loading", () => {
    webviewReady = false;
  });

  primaryWv.addEventListener("did-stop-loading", () => {
    markTtReloadFinished();
    scheduleGuestIdleWork(async () => {
      await onTtPageLifecycle({ reset: false });
      commitPendingDomSyncAfterPageLoad();
      if (running && pendingRunAfterReload) {
        pendingRunAfterReload = false;
        if (titleOnNewAutoEnabled) {
          await sleep(600);
        }
        const result = await runCheck();
        handleBatchResult(result);
      } else if (running && titleOnNewAutoEnabled) {
        flushTitleOnNewQueueIfPossible().catch(() => {});
      } else {
        flushTitleOnNewQueueIfPossible().catch(() => {});
      }
      tryFlushTtSyncReloadQueue();
    });
  });

  primaryWv.addEventListener("did-fail-load", () => {
    pendingRunAfterReload = false;
    markTtReloadFinished();
    if (batchInProgress) {
      log("页面加载失败，本轮接单已中止。", "warning");
      finishBatch();
    }
    log("工单页面加载失败，请检查网络连接。", "error");
    tryFlushTtSyncReloadQueue();
  });

  // guest preload：仅 x.sankuai.com/bridge 中转（大象自定义协议由主进程 TT 专用 partition 的 webRequest 拦截，不碰 guest）
  primaryWv.addEventListener("ipc-message", (event) => {
    const ch = event.channel;
    const arg0 = event.args && event.args[0];
    if (ch === "tt-webview-zoom-delta") {
      const dir = Number(arg0);
      if (Number.isFinite(dir) && dir !== 0) nudgeTtWebviewZoom(dir);
      return;
    }
    if (ch === "tt-webview-zoom-reset") {
      applyTtWebviewZoom(1);
      return;
    }
    if (typeof arg0 !== "string" || !arg0.trim()) return;
    const u = arg0.trim();
    if (ch === "tt-bridge-in-webview") {
      setWebviewLoadingHint(true);
      try {
        if (typeof primaryWv.loadURL === "function") {
          void Promise.resolve(primaryWv.loadURL(u)).catch(() => {});
        } else {
          primaryWv.setAttribute("src", u);
        }
      } catch {
        primaryWv.setAttribute("src", u);
      }
      return;
    }
    if (ch === "tt-open-external" || ch === "tt-open-protocol") {
      void window.ttDesktopApi?.openExternal?.(u);
    }
  });

  document.addEventListener("tt-browser-zoom-ipc", (e) => {
    const d = e.detail || {};
    if (d.channel === "tt-webview-zoom-delta") {
      const dir = Number(d.arg0);
      if (Number.isFinite(dir) && dir !== 0) nudgeTtWebviewZoom(dir);
    } else if (d.channel === "tt-webview-zoom-reset") {
      applyTtWebviewZoom(1);
    }
  });

  if (ttZoomLabel) {
    ttZoomLabel.addEventListener("click", () => {
      applyTtWebviewZoom(1);
      log("内置 TT 缩放已恢复 100%。", "info");
    });
  }

  setWebviewLoadingHint(true);
  try {
    primaryWv.setAttribute("partition", TT_WEBVIEW_PARTITION);
    primaryWv.setAttribute("preload", new URL("webview-preload.js", document.baseURI).href);
    primaryWv.setAttribute("src", TT_WEBVIEW_DEFAULT_SRC);
  } catch {
    try {
      primaryWv.setAttribute("partition", TT_WEBVIEW_PARTITION);
      primaryWv.setAttribute("src", TT_WEBVIEW_DEFAULT_SRC);
    } catch {
      setWebviewLoadingHint(false);
    }
  }
}

async function applyAppVersionDisplay() {
  try {
    const info = await window.ttDesktopApi?.getAppVersion?.();
    const v = info && typeof info === "object" && info.version ? String(info.version) : "";
    if (!v) return;
    const badge = document.getElementById("appVersionBadge");
    if (badge) badge.textContent = `v${v}`;
    document.title = `TTDesktop1.0 v${v} 桌面版`;
  } catch {
    // ignore
  }
}

async function onTtPageLifecycle({ reset = false } = {}) {
  await refreshPendingCount();
  try {
    const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
    if (st?.ok) {
      await refreshTickets({ reset });
      return;
    }
  } catch {
    // ignore
  }
  await refreshTickets({ reset });
}

async function setupApiTicketPolling() {
  try {
    const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
    if (!st?.ok) return;
    startApiTicketPollTimer();
    log("工单列表已就绪，新工单将自动处理。", "info");
    await refreshTickets({ reset: true, apiOnly: true });
    if (titleOnNewAutoEnabled) {
      ensureTitleBaselineIfNeeded();
      startHandleListWatch();
    }
  } catch {
    // ignore
  }
}
async function logTtApiConfigStatus() {
  try {
    const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
    if (!st) return;
    if (st.ok) {
      const mis = st.username ? `（MIS：${st.username}）` : "";
      log(`工单接口已配置${mis}，可以开始使用。`, "success");
    } else {
      const detail = st.message ? `：${st.message}` : "。";
      log(`工单接口未配置${detail}请点击右上角「API 设置」填写。`, "warning");
    }
  } catch {
    // ignore
  }
}

function setApiSettingsError(msg) {
  if (!apiSettingsError) return;
  const text = String(msg || "").trim();
  if (!text) {
    apiSettingsError.hidden = true;
    apiSettingsError.textContent = "";
    return;
  }
  apiSettingsError.hidden = false;
  apiSettingsError.textContent = text;
}

function closeApiSettingsModal() {
  if (!apiSettingsModal) return;
  apiSettingsModal.hidden = true;
  setApiSettingsError("");
}

function appendApiRgIdRow(value = "", { focus = true } = {}) {
  if (!apiRgIdsList) return null;
  const row = document.createElement("div");
  row.className = "api-rgids-row";
  row.setAttribute("role", "listitem");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "api-rgids-row-input";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.placeholder = "例如 13619";
  input.value = String(value || "").trim();

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "api-rgids-row-remove";
  removeBtn.setAttribute("aria-label", "删除此工单组");
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => {
    row.remove();
  });

  row.append(input, removeBtn);
  apiRgIdsList.append(row);
  if (focus) input.focus();
  return input;
}

function renderApiRgIdRows(ids) {
  if (!apiRgIdsList) return;
  apiRgIdsList.innerHTML = "";
  const list = Array.isArray(ids) ? ids : [];
  const uniq = [];
  for (const raw of list) {
    const n = Number(String(raw || "").trim());
    if (!Number.isFinite(n) || n <= 0) continue;
    if (uniq.includes(n)) continue;
    uniq.push(n);
  }
  if (!uniq.length) return;
  for (const id of uniq) {
    appendApiRgIdRow(String(id), { focus: false });
  }
}

function collectApiRgIdsFromForm() {
  if (!apiRgIdsList) return [];
  const inputs = apiRgIdsList.querySelectorAll(".api-rgids-row-input");
  const out = [];
  for (const el of inputs) {
    const n = Number(String(el.value || "").trim());
    if (!Number.isFinite(n) || n <= 0) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function parseRgIdsFromConfig(cfg) {
  if (Array.isArray(cfg?.rgIds) && cfg.rgIds.length) {
    return cfg.rgIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
  }
  const text = String(cfg?.rgIdsText || "").trim();
  if (!text) return [];
  return text
    .split(/[,，\s]+/)
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function openApiSettingsModal() {
  if (!apiSettingsModal) return;
  setApiSettingsError("");
  apiSettingsModal.hidden = false;
  try {
    const cfg = await window.ttDesktopApi?.getTtApiConfig?.();
    if (apiAuthInput) apiAuthInput.value = cfg?.authorization || "";
    if (apiUsernameInput) {
      apiUsernameInput.value = cfg?.username || getHandler() || "";
    }
    if (apiEnvSelect) apiEnvSelect.value = cfg?.env === "test" ? "test" : "prod";
    let rgIds = parseRgIdsFromConfig(cfg);
    if (!rgIds.length && Array.isArray(TARGET_RG_IDS)) {
      rgIds = TARGET_RG_IDS.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    }
    renderApiRgIdRows(rgIds);
    if (apiSettingsPath) {
      const p = cfg?.path || "";
      const err = cfg?.configError ? `（读取异常：${cfg.configError}）` : "";
      apiSettingsPath.textContent = p ? `配置文件：${p}${err}` : "";
    }
    if (cfg?.configError) {
      setApiSettingsError(`当前配置文件无效，请重新填写并保存。${cfg.configError}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setApiSettingsError(`读取配置失败：${msg}`);
  }
  queueMicrotask(() => apiAuthInput?.focus());
}

async function saveApiSettingsFromForm() {
  setApiSettingsError("");
  const authorization = String(apiAuthInput?.value || "").trim();
  const username = String(apiUsernameInput?.value || "").trim();
  const env = apiEnvSelect?.value === "test" ? "test" : "prod";
  const rgIdList = collectApiRgIdsFromForm();
  const rgIds = rgIdList.join(", ");
  if (!authorization) {
    setApiSettingsError("请填写 authorization 令牌");
    return;
  }
  if (!username) {
    setApiSettingsError("请填写 username（MIS）");
    return;
  }
  try {
    const res = await window.ttDesktopApi?.saveTtApiConfig?.({
      authorization,
      username,
      env,
      rgIds
    });
    if (!res?.ok) {
      setApiSettingsError(res?.message || "保存失败");
      return;
    }
    // 同步界面处理人，避免 API username 与处理人不一致
    if (handlerInput && username) {
      handlerInput.value = username;
      localStorage.setItem(STORAGE_KEYS.handler, username);
    }
    closeApiSettingsModal();
    log(res.message || "API 配置已保存。", "success");
    if (res.path) log(`配置已写入：${res.path}`, "muted");
    await setupApiTicketPolling();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setApiSettingsError(`保存失败：${msg}`);
  }
}

function bindModuleDeps() {
  TD.priority.bind({
    sleep,
    getWebviewReady: () => webviewReady,
    getTtWebview: () => getAutomationWebview(),
    getRunning: () => running,
    getBusy: () => busy,
    getBatchInProgress: () => batchInProgress,
    getPendingRunAfterReload: () => pendingRunAfterReload,
    getPmPullInProgress: isPullInProgress,
    isNormalizeInProgress,
    applyTicketFilters,
    sortTickets,
    getTickets,
    getTicketSelectKey,
    handleTicketClick,
    refreshTickets,
    renderTicketList,
    setActiveLeftTab,
    flushTitleOnNewQueueIfPossible
  });
  TD.pm.bind({
    sleep,
    getWebviewReady: () => webviewReady,
    getTtWebview: () => getAutomationWebview(),
    getBusy: () => busy,
    isNormalizeInProgress,
    isPriorityBatchInProgress: isBatchInProgress,
    getTickets,
    handleTicketClick,
    refreshTickets,
    setActiveLeftTab,
    buildTitleNormalizeInspectScript
  });
  TD.tickets.bind({
    sleep,
    getHandler,
    getPendingCount: () => lastPendingCount,
    isApiConfigured: async () => {
      const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
      return !!st?.ok;
    },
    getWebviewReady: () => webviewReady,
    getTtWebview: () => getAutomationWebview(),
    isTicketBatchSelected,
    setTicketBatchSelected,
    updateBatchPrioritySelectionCount,
    getAutoPriorityBoostEnabled,
    requestAutoPriorityBoostFromRefresh,
    requestTitleOnNewAfterRefresh,
    requestHfIssueAfterRefresh,
    requestBurstOutbreakAfterRefresh,
    scheduleTitlePatrolFromRefresh,
    getTitlePatrolLogEnabled,
    getRunning: () => running,
    getTitleOnNewAutoEnabled: () => titleOnNewAutoEnabled,
    requestTtWebviewReload,
    isTtWebviewReloadInFlight,
    requestBatchPageRefresh
  });
  TD.burstOutbreak.bind({
    isApiConfigured: async () => {
      const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
      return !!st?.ok;
    }
  });
  TD.hfIssue.bind({
    getHandler,
    getTickets,
    getRunning: () => running,
    isApiConfigured: async () => {
      const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
      return !!st?.ok;
    }
  });
  TD.sla.bind({
    makeStableKey,
    applyTicketFilters,
    getTickets,
    getWebviewReady: () => webviewReady,
    getTtWebview: () => getAutomationWebview(),
    ttExecuteJavaScript
  });
  TD.templates.bind({
    getActiveTicketTitle: () => {
      const active = getTickets().find((t) => t && t.isActive);
      return active?.title || "";
    }
  });
  TD.titleOps.bind({
    sleep,
    getHandler,
    makeStableKey,
    getMyTodoTicketsForTitleOps,
    getMyPendingTicketsForTitleOnNew,
    sortTickets,
    handleTicketClick,
    refreshTickets,
    setActiveLeftTab,
    getTickets,
    getRunning: () => running,
    getWebviewReady: () => webviewReady,
    getTtWebview: () => getAutomationWebview(),
    getBusy: () => busy,
    getBatchInProgress: () => batchInProgress,
    getPendingRunAfterReload: () => pendingRunAfterReload,
    getPriorityBatchInProgress: isBatchInProgress,
    getPmPullInProgress: isPullInProgress,
    getTitleOnNewAutoEnabled: () => titleOnNewAutoEnabled,
    getTitlePatrolLogEnabled,
    flushAutoPriorityBoostQueueIfPossible,
    isApiPrimaryMode: TD.tickets.isApiPrimaryMode,
    waitForTicketInDom: TD.tickets.waitForTicketInDom,
    isTicketVisibleInDom: TD.tickets.isTicketVisibleInDom,
    requestTtWebviewReload,
    isTtWebviewReloadInFlight,
    scanHandleListForTitleWatch,
    mapDomWatchItemToTicket,
    isTtDomSyncPending,
    isTicketItemInHandleList,
    commitApiTicketIdBaseline,
    clearPendingDomSyncForTickets,
    requestAcceptAfterTitle
  });
}

function init() {
  bindModuleDeps();
  loadSettings();
  syncTitleOnNewButtonState();
  if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = running;
  updatePmCsvPathLabel();
  ensurePmCsvReady?.();
  updateTicketCount(NaN);
  updateNextTickDisplay();
  setRunningState(false);
  setActiveLeftTab("logs");
  updateTicketMeta(0);
  updateBatchPrioritySelectionCount();
  syncSortButtonText();
  if (TD.browser?.init) {
    TD.browser.init({
      onActiveTabChange: () => {
        applyTtWebviewZoom(ttZoomFactor, { persist: false });
        TD.browser?.updateAddressBar?.();
      }
    });
  }
  bindEvents();
  void applyAppVersionDisplay();
  void logTtApiConfigStatus().then(() => setupApiTicketPolling());
  ensureTicketElapsedTimer();
  TD.sla.ensureTtSlaPaintTimer?.();
  restartTitlePatrolTimer();
}

init();
