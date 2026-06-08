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
  TT_WEBVIEW_DEFAULT_SRC
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
  openLogsDirBtn,
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
  ticketSlaNotifyToggle
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
  resetTitleNewTicketBaseline,
  buildTitleNormalizeInspectScript,
  requestTitleOnNewAfterRefresh,
  flushTitleOnNewQueueIfPossible,
  runTicketTitlePatrolScan,
  runNewTicketTitleNormalize,
  runTicketTitleNormalizeBatch
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
  getTicketSelectKey,
  renderTicketList,
  refreshTickets,
  handleTicketClick,
  syncActiveHighlightFromDom,
  startApiTicketPollTimer,
  stopApiTicketPollTimer,
  loadMoreTickets,
  updateTicketMeta,
  syncSortButtonText
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
const { isPullInProgress, updatePmCsvPathLabel, selectPmCsvFile, runPmPullByRegion } = TD.pm;


/*
 * 工单标题前缀规范化：已实现「标题检测」按钮（runTicketTitleNormalizeBatch），规则如下：
 * - 无发起人架构 → 不改；词典 assets/china_cities.json。
 * - 外显顺序：事业部（品牌）→ 地区（城市）→ 站点名或仓名 → 原标题/问题简述。
 * - 引擎格式：{事业部简称}{城市}{站点/仓/店名}+原标题正文；站/仓/店优先从架构路径解析，其次仓库/门店字段。
 * - 「来单改标题」须先「开始」；仅处理开始后新出现的待处理单（含转单），检测通过后自动写入。
 * - 「标题巡检」逻辑独立在 titlePatrolList.js（TTTitlePatrolList.patrolListTitles）；「标题检测」在 titlePrefixEngine.js（TTTitlePrefix）。
 */

// 勿在此处设置 webview src：须先 bindEvents 注册监听，否则快网环境下会错过 dom-ready，导致 webviewReady 一直为 false

let running = false;
let busy = false;
let webviewReady = false;
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
      return "未找到工单列表，可能页面尚未加载完成。";
    case "no_pending":
      return "当前没有可开始处理的“未处理”工单。";
    case "no_detail":
      return "未找到工单详情区域，已跳过本轮。";
    case "handler_not_match":
      return "处理人不匹配，已跳过本轮。";
    case "state_not_pending":
      return "当前工单状态不是“未处理”，已跳过。";
    case "no_handle_btn":
      return "未找到“开始处理/开启处理”按钮。";
    case "clicked_handle":
      return "已自动点击“开始处理”。";
    case "clicked_handle|group_confirmed":
      return "已点击“开始处理”，并完成建群确认。";
    case "clicked_handle|group_session_ready":
      return "已创建/加入群聊，且已出现“大象会话”标签。";
    case "clicked_handle|group_session_ready_no_send":
      return "已创建/加入群聊并出现“大象会话”，当前配置为不自动发送话术。";
    case "clicked_handle|group_session_ready_and_sent":
      return "已创建/加入群聊，已打开“大象会话”并发送话术。";
    case "clicked_handle|group_session_ready_but_send_failed":
      return "已创建/加入群聊并出现“大象会话”，但未成功发送话术。";
    case "clicked_handle|group_confirmed_no_session":
      return "已点“确定”，但暂未检测到“大象会话”标签。";
    case "clicked_handle|group_btn_not_found":
      return "已点击“开始处理”，但未找到“创建大象群”按钮。";
    case "clicked_handle|group_already":
      return "已点击“开始处理”，该工单已存在大象群，无需重复建群。";
    case "clicked_handle|group_joined":
      return "已点击“开始处理”，并执行“加入大象群”。";
    case "clicked_handle|group_no_confirm":
      return "已点击“开始处理”，但建群确认按钮未找到。";
    default:
      return `脚本返回：${status}`;
  }
}

function statusToLevel(status) {
  if (!status) return "info";
  if (status === "unknown") return "error";

  if (
    status === "clicked_handle" ||
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
  if (!webviewReady || !ttWebview) return;

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
  if (!running || busy || isBatchInProgress() || isPullInProgress() || !webviewReady || !ttWebview) return null;
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
    const message = err instanceof Error ? err.message : String(err);
    log(`执行失败：${message}`, "error");
    return { status: "unknown", pendingCount: NaN };
  } finally {
    busy = false;
  }
}

function isHandledStatus(status) {
  return typeof status === "string" && status.startsWith("clicked_handle");
}

function startBatchIfNeeded(reason = "定时触发") {
  if (!running || !ttWebview) return;
  if (batchInProgress || pendingRunAfterReload || busy || isBatchInProgress() || isPullInProgress()) return;

  batchInProgress = true;
  batchHandledCount = 0;
  batchRemaining = DEFAULT_BATCH_LIMIT;
  log(`开始批量处理（${reason}），单轮上限 ${DEFAULT_BATCH_LIMIT} 单。`, "info");
  refreshPageThenRunCheck();
}

function finishBatch() {
  batchInProgress = false;
  batchRemaining = 0;
  queueMicrotask(() => {
    flushAutoPriorityBoostQueueIfPossible().catch(() => {});
  });
}

function handleBatchResult(result) {
  if (!batchInProgress || !running) return;

  const status = result?.status || "unknown";
  if (status === "no_pending") {
    const level = batchHandledCount > 0 ? "success" : "muted";
    log(`本轮结束：未处理工单已清空，本轮处理 ${batchHandledCount} 单，本次启动累计处理 ${sessionHandledCount} 单。`, level);
    finishBatch();
    return;
  }

  if (!isHandledStatus(status)) {
    log(`本轮结束：${statusToMessage(status)}（已处理 ${batchHandledCount} 单）`, statusToLevel(status));
    finishBatch();
    return;
  }

  batchHandledCount += 1;
  sessionHandledCount += 1;
  batchRemaining -= 1;
  log(`本轮进度：已处理 ${batchHandledCount} 单（本次启动累计 ${sessionHandledCount} 单）。`, "success");
  if (batchRemaining <= 0) {
    log(`达到单轮上限 ${DEFAULT_BATCH_LIMIT} 单，停止本轮批量处理。`, "warning");
    finishBatch();
    return;
  }

  setTimeout(() => {
    if (!running || !batchInProgress) return;
    refreshPageThenRunCheck();
  }, NEXT_TICKET_RELOAD_DELAY_MS);
}

function refreshPageThenRunCheck() {
  if (!running || !ttWebview || busy) return;

  pendingRunAfterReload = true;
  webviewReady = false;
  setWebviewLoadingHint(true);
  log("已执行页面刷新（F5）。", "info");

  try {
    ttWebview.reload();
  } catch {
    pendingRunAfterReload = false;
    webviewReady = true;
    if (running) {
      runCheck().then((result) => {
        handleBatchResult(result);
      });
    }
  }
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
  if (!ttWebview) {
    log("未找到 webview，无法启动自动处理。", "error");
    return;
  }

  clearTitlePatrolDebounce();
  saveSettings();
  setRunningState(true);
  scheduleNextRun();
  updateNextTickDisplay();

  restartRunningTimers();
  if (!countdownTimer) countdownTimer = setInterval(updateNextTickDisplay, 1000);

  resetTitleNewTicketBaseline();
  clearTitleOnNewQueue();
  if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = false;
  log(
    `开始自动处理：间隔 ${getIntervalSec()} 秒，处理人 ${getHandler()}；来单改标题基线已建立（${getBaselineCount()} 条）。`,
    "success"
  );
  startBatchIfNeeded("启动后首轮");
}

function stop() {
  if (!running) return;
  setRunningState(false);
  clearAutoBoostQueue();
  clearTitleOnNewQueue();
  if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = true;
  stopTimers();
  restartTitlePatrolTimer();
  log("已停止自动处理。", "info");
}

function toggleStartStop() {
  if (running) stop();
  else start();
  // 与真实 running 同步（start 失败时 checkbox 可能已被用户点开）
  setRunningState(running);
}

function bindEvents() {
  if (startBtn) startBtn.addEventListener("change", toggleStartStop);
  if (templatesSaveBtn) templatesSaveBtn.addEventListener("click", saveTemplatesModal);
  if (templatesAddRuleBtn) templatesAddRuleBtn.addEventListener("click", addRule);
  if (templatesPreviewBtn) {
    templatesPreviewBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      previewTemplateMatchForActiveTicket();
    });
  }
  if (openLogsDirBtn) {
    openLogsDirBtn.addEventListener("click", async () => {
      try {
        const result = await window.ttDesktopApi?.openLogsDir?.();
        if (typeof result === "string" && result.trim()) {
          log(`打开日志文件夹失败：${result}`, "warning");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`打开日志文件夹失败：${message}`, "warning");
      }
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
        const msg = err instanceof Error ? err.message : String(err);
        log(`设置优先级异常：${msg}`, "error");
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
      log(`自动升高优先级：${getAutoPriorityBoostEnabled() ? "已开启" : "已关闭"}`, getAutoPriorityBoostEnabled() ? "info" : "muted");
      if (getAutoPriorityBoostEnabled()) {
        requestAutoPriorityBoostFromRefresh();
      }
    });
  }
  if (ticketAutoPriorityBoostBtn) {
    ticketAutoPriorityBoostBtn.addEventListener("click", () => {
      if (isBatchInProgress()) {
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
      const hits = selectVisibleByKeywordBoost(sorted);
      updateBatchPrioritySelectionCount();
      renderTicketList();
      const uniqHits = Array.from(new Set(hits));
      const count = getBatchSelectionCount();
      if (!count) {
        log(`未命中关键词（${AUTO_PRIORITY_BOOST_KEYWORDS.join(" / ")}）。`, "muted");
        return;
      }
      if (ticketPrioritySelect) ticketPrioritySelect.value = AUTO_PRIORITY_BOOST_TARGET;
      log(
        `关键词命中 ${count} 条（${uniqHits.slice(0, 6).join(" / ")}），将批量设置为「${AUTO_PRIORITY_BOOST_TARGET}(S3)」。`,
        "info"
      );
      applyPriorityBatch().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`关键词升高优先级异常：${msg}`, "error");
      });
    });
  }
  if (ticketPriorityBatchBtn) {
    ticketPriorityBatchBtn.addEventListener("click", () => {
      applyPriorityBatch().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`批量设置优先级异常：${msg}`, "error");
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
    ticketTitleOnNewBtn.disabled = !running;
    ticketTitleOnNewBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runNewTicketTitleNormalize({ triggeredBy: "来单改标题" }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`来单改标题异常：${msg}`, "error");
      });
    });
  }
  if (titleOnNewAutoInput) {
    titleOnNewAutoInput.addEventListener("change", () => {
      titleOnNewAutoEnabled = !!titleOnNewAutoInput.checked;
      saveSettings();
      if (!running && titleOnNewAutoEnabled) {
        log("「来单改标题（随开始）」已勾选：请先点「开始」后才会在刷新时发现新单并改标题。", "info");
      } else {
        log(`来单改标题（随开始）：${titleOnNewAutoEnabled ? "已开启" : "已关闭"}`, titleOnNewAutoEnabled ? "info" : "muted");
      }
    });
  }
  if (ticketTitleNormalizeBtn) {
    ticketTitleNormalizeBtn.addEventListener("click", () => {
      setActiveLeftTab("logs");
      runTicketTitleNormalizeBatch().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`标题检测异常：${msg}`, "error");
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
        const msg = err instanceof Error ? err.message : String(err);
        log(`按地区拉PM异常：${msg}`, "error");
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
      log(`48h 时效提醒：${on ? "已开启" : "已关闭"}`, on ? "info" : "muted");
      renderTicketList();
      runSlaScan({ emitAlerts: on });
    });
  }
  if (ticketSlaNotifyToggle) {
    ticketSlaNotifyToggle.addEventListener("change", () => {
      saveSettings();
      log(`48h Windows 通知：${ticketSlaNotifyToggle.checked ? "已开启" : "已关闭"}`, "info");
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
        log("标题巡检：已开启，将按「间隔」用左侧列表标题做粗检（不打开 TT），与「开始」可同时运行。", "info");
      }
      restartTitlePatrolTimer();
    });
  }

  if (!ttWebview) return;

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

  ttWebview.addEventListener("dom-ready", async () => {
    webviewReady = true;
    setWebviewLoadingHint(false);
    log("TT 页面已加载完成。", "success");
    scheduleGuestIdleWork(async () => {
      await onTtPageLifecycle({ reset: true });
    });
  });

  ttWebview.addEventListener("did-start-loading", () => {
    webviewReady = false;
  });

  ttWebview.addEventListener("did-stop-loading", () => {
    webviewReady = true;
    scheduleGuestIdleWork(async () => {
      await onTtPageLifecycle({ reset: false });
      if (running && pendingRunAfterReload) {
        pendingRunAfterReload = false;
        const result = await runCheck();
        handleBatchResult(result);
      }
    });
  });

  ttWebview.addEventListener("did-fail-load", (event) => {
    pendingRunAfterReload = false;
    setWebviewLoadingHint(false);
    if (batchInProgress) {
      log("页面刷新失败，本轮批量处理已中止。", "warning");
      finishBatch();
    }
    log(`页面加载失败：${event.errorDescription || event.errorCode}`, "error");
  });

  // guest preload：仅 x.sankuai.com/bridge 中转（大象自定义协议由主进程 TT 专用 partition 的 webRequest 拦截，不碰 guest）
  ttWebview.addEventListener("ipc-message", (event) => {
    const ch = event.channel;
    const arg0 = event.args && event.args[0];
    if (typeof arg0 !== "string" || !arg0.trim()) return;
    const u = arg0.trim();
    if (ch === "tt-bridge-in-webview") {
      setWebviewLoadingHint(true);
      try {
        if (typeof ttWebview.loadURL === "function") {
          void Promise.resolve(ttWebview.loadURL(u)).catch(() => {});
        } else {
          ttWebview.setAttribute("src", u);
        }
      } catch {
        ttWebview.setAttribute("src", u);
      }
      return;
    }
    if (ch === "tt-open-external" || ch === "tt-open-protocol") {
      void window.ttDesktopApi?.openExternal?.(u);
    }
  });

  setWebviewLoadingHint(true);
  try {
    ttWebview.setAttribute("partition", TT_WEBVIEW_PARTITION);
    ttWebview.setAttribute("preload", new URL("webview-preload.js", document.baseURI).href);
    ttWebview.setAttribute("src", TT_WEBVIEW_DEFAULT_SRC);
  } catch {
    try {
      ttWebview.setAttribute("partition", TT_WEBVIEW_PARTITION);
      ttWebview.setAttribute("src", TT_WEBVIEW_DEFAULT_SRC);
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
      if (reset) await refreshTickets({ reset: true });
      else await syncActiveHighlightFromDom();
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
    log("工单列表：API 为主，每 30 秒自动拉单；DOM 仅用于高亮与点击跳转。", "info");
    await refreshTickets({ reset: true, apiOnly: true });
  } catch {
    // ignore
  }
}
async function logTtApiConfigStatus() {
  try {
    const st = await window.ttDesktopApi?.getTtApiConfigStatus?.();
    if (!st) return;
    if (st.ok) {
      log(`API 已配置（${st.env || "prod"}）：${st.configPath}`, "success");
    } else {
      log(st.message || `API 未配置：${st.configPath || ""}`, "warning");
    }
  } catch {
    // ignore
  }
}

function bindModuleDeps() {
  TD.priority.bind({
    sleep,
    getWebviewReady: () => webviewReady,
    getTtWebview: () => ttWebview,
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
    getTtWebview: () => ttWebview,
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
    getTtWebview: () => ttWebview,
    isTicketBatchSelected,
    setTicketBatchSelected,
    updateBatchPrioritySelectionCount,
    getAutoPriorityBoostEnabled,
    requestAutoPriorityBoostFromRefresh,
    requestTitleOnNewAfterRefresh,
    scheduleTitlePatrolFromRefresh,
    getTitlePatrolLogEnabled
  });
  TD.sla.bind({
    makeStableKey,
    applyTicketFilters,
    getTickets
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
    sortTickets,
    handleTicketClick,
    refreshTickets,
    setActiveLeftTab,
    getTickets,
    getRunning: () => running,
    getWebviewReady: () => webviewReady,
    getTtWebview: () => ttWebview,
    getBusy: () => busy,
    getBatchInProgress: () => batchInProgress,
    getPendingRunAfterReload: () => pendingRunAfterReload,
    getPriorityBatchInProgress: isBatchInProgress,
    getPmPullInProgress: isPullInProgress,
    getTitleOnNewAutoEnabled: () => titleOnNewAutoEnabled,
    getTitlePatrolLogEnabled,
    flushAutoPriorityBoostQueueIfPossible
  });
}

function init() {
  bindModuleDeps();
  loadSettings();
  if (ticketTitleOnNewBtn) ticketTitleOnNewBtn.disabled = !running;
  if (ticketTitleNormalizeBtn) ticketTitleNormalizeBtn.disabled = running;
  updatePmCsvPathLabel();
  updateTicketCount(NaN);
  updateNextTickDisplay();
  setRunningState(false);
  setActiveLeftTab("logs");
  updateTicketMeta(0);
  updateBatchPrioritySelectionCount();
  syncSortButtonText();
  bindEvents();
  void applyAppVersionDisplay();
  void logTtApiConfigStatus().then(() => setupApiTicketPolling());
  ensureTicketElapsedTimer();
  restartTitlePatrolTimer();
}

init();
