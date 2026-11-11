/**
 * 处理人已回复则暂停：API 认 lastReplierMisId，且距 lastReplyTime 超过设定分钟数（北京时间，默认 15），再 DOM 点「暂停TT」
 */
(function initPauseOnReply(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const Guard = TD.guard;

  const REASON = C.PAUSE_ON_REPLY_REASON;
  const DEFAULT_DESC = C.PAUSE_ON_REPLY_DEFAULT_DESC;
  const COOLDOWN_MS = C.PAUSE_ON_REPLY_COOLDOWN_MS;
  const WAIT_MIN_DEFAULT = C.PAUSE_ON_REPLY_WAIT_MINUTES_DEFAULT;
  const WAIT_MIN_MIN = C.PAUSE_ON_REPLY_WAIT_MINUTES_MIN;
  const WAIT_MIN_MAX = C.PAUSE_ON_REPLY_WAIT_MINUTES_MAX;
  const MAX_PER_ROUND = C.PAUSE_ON_REPLY_MAX_PER_ROUND;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHandler: () => "",
    getTickets: () => [],
    applyTicketFilters: (list) => list,
    handleTicketClick: async () => false,
    getWebviewReady: () => false,
    getTtWebview: () => null,
    ttExecuteJavaScript: async () => null,
    getBusy: () => false,
    getBatchInProgress: () => false,
    getPendingRunAfterReload: () => false,
    isNormalizeInProgress: () => false,
    isPriorityBatchInProgress: () => false,
    getPmPullInProgress: () => false,
    isApiConfigured: async () => false,
    setActiveLeftTab: () => {}
  };

  let pauseOnReplyInProgress = false;
  let scanInFlight = false;
  let lastScanAt = 0;
  /** @type {Map<string, number>} */
  const pauseCooldown = new Map();

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  function isInProgress() {
    return pauseOnReplyInProgress;
  }

  function normalizeMis(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9._-]/g, "");
  }

  function isEnabled() {
    return !!D.pauseOnReplyInput?.checked;
  }

  function getPauseDesc() {
    const fromInput = String(D.pauseOnReplyDescInput?.value || "").trim();
    if (fromInput) return fromInput;
    const saved = String(localStorage.getItem(C.STORAGE_KEYS.pauseOnReplyDesc) || "").trim();
    return saved || DEFAULT_DESC;
  }

  function persistDesc() {
    const v = String(D.pauseOnReplyDescInput?.value || "").trim() || DEFAULT_DESC;
    localStorage.setItem(C.STORAGE_KEYS.pauseOnReplyDesc, v);
    if (D.pauseOnReplyDescInput && !String(D.pauseOnReplyDescInput.value || "").trim()) {
      D.pauseOnReplyDescInput.value = v;
    }
  }

  function clampWaitMinutes(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return WAIT_MIN_DEFAULT;
    return Math.max(WAIT_MIN_MIN, Math.min(WAIT_MIN_MAX, Math.floor(n)));
  }

  function getWaitMinutes() {
    const saved = localStorage.getItem(C.STORAGE_KEYS.pauseOnReplyWaitMinutes);
    if (saved != null && String(saved).trim() !== "") return clampWaitMinutes(saved);
    return WAIT_MIN_DEFAULT;
  }

  function persistWaitMinutes() {
    const n = clampWaitMinutes(D.pauseOnReplyWaitInput?.value);
    localStorage.setItem(C.STORAGE_KEYS.pauseOnReplyWaitMinutes, String(n));
    if (D.pauseOnReplyWaitInput) D.pauseOnReplyWaitInput.value = String(n);
    return n;
  }

  function fillWaitInput() {
    if (!D.pauseOnReplyWaitInput) return;
    const saved = localStorage.getItem(C.STORAGE_KEYS.pauseOnReplyWaitMinutes);
    D.pauseOnReplyWaitInput.value = String(clampWaitMinutes(saved == null || saved === "" ? WAIT_MIN_DEFAULT : saved));
  }

  function getWaitMs() {
    return getWaitMinutes() * 60 * 1000;
  }

  function isProcessing(item) {
    const st = String(item?.statusText || "");
    if (st.includes("暂停") || st.includes("已关闭") || st.includes("关闭") || st.includes("已完成")) return false;
    return st.includes("处理中");
  }

  function isMine(item, me) {
    if (!me) return false;
    const owner = normalizeMis(item?.ownerMis || item?.assigneeMis || "");
    return !owner || owner === me;
  }

  function lastReplierIsHandler(item, me) {
    const last = normalizeMis(item?.lastReplierMisId);
    return !!me && !!last && last === me;
  }

  function parseLastReplyEpoch(item) {
    const parse = TD.time?.parseBeijingEpoch;
    if (typeof parse !== "function") return null;
    return parse(String(item?.lastReplyTime || ""));
  }

  function lastReplyOlderThanWait(item) {
    const ts = parseLastReplyEpoch(item);
    const now = TD.time?.nowBeijingEpochMs?.();
    if (ts == null || !Number.isFinite(now)) return false;
    return now - ts > getWaitMs();
  }

  function inCooldown(id) {
    const ts = pauseCooldown.get(id) || 0;
    return Date.now() - ts < COOLDOWN_MS;
  }

  function markPaused(id) {
    if (id) pauseCooldown.set(id, Date.now());
  }

  function isLocked() {
    const s = {
      busy: deps.getBusy(),
      pmPullInProgress: deps.getPmPullInProgress(),
      priorityBatchInProgress: deps.isPriorityBatchInProgress(),
      titleNormalizeInProgress: deps.isNormalizeInProgress(),
      pauseOnReplyInProgress,
      batchInProgress: deps.getBatchInProgress()
    };
    return Guard.isWebviewOpLocked(s) || !!deps.getBatchInProgress() || !!deps.getPendingRunAfterReload();
  }

  function buildPauseTtScript(description) {
    const safeDesc = JSON.stringify(String(description || DEFAULT_DESC));
    const safeReason = JSON.stringify(REASON);
    return `
      (async () => {
        const desc = ${safeDesc};
        const reasonText = ${safeReason};
        function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
        function norm(t) { return ((t || '').trim()).replace(/\\s+/g, ''); }
        function isVisible(el) {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return el.getClientRects().length > 0;
        }

        function getDetailScope() {
          return (
            document.querySelector('#ticket-detail') ||
            document.querySelector('.ticket-detail-container') ||
            document.querySelector('.detail-with-list-container')
          );
        }

        function isAlreadyPaused() {
          const scope = getDetailScope();
          if (!scope) return false;
          const icon = scope.querySelector('.detail-state .ticket-state-icon, .ticket-state .ticket-state-icon');
          if (icon?.classList.contains('ticket-state-pending')) return true;
          const text = scope.querySelector('.detail-state .ticket-state-text, .ticket-state .ticket-state-text')?.textContent || '';
          return text.includes('暂停');
        }

        function findPauseBtn() {
          const nodes = document.querySelectorAll('button.mtd-btn, .mtd-btn, [role="button"]');
          for (const el of nodes) {
            if (!isVisible(el)) continue;
            const t = (el.textContent || '').replace(/\\s+/g, '');
            if (t === '暂停TT' || t.includes('暂停TT')) return el;
          }
          return null;
        }

        function findPauseModal() {
          const nodes = document.querySelectorAll('.mtd-modal, .mtd-dialog, .mtd-modal-content, [class*="modal"]');
          for (const el of nodes) {
            if (!isVisible(el)) continue;
            const t = el.textContent || '';
            if (t.includes('暂停原因') || t.includes('请选择暂停原因')) return el;
          }
          return null;
        }

        function findReasonInput(modal) {
          const labels = Array.from((modal || document).querySelectorAll('label, .mtd-form-item-label, span, div'));
          for (const lab of labels) {
            if (!norm(lab.textContent || '').includes('暂停原因')) continue;
            const item = lab.closest('.mtd-form-item') || lab.parentElement;
            const input =
              item?.querySelector?.('.mtd-select-input input.mtd-input, input.mtd-input') ||
              modal?.querySelector?.('.mtd-select-input input.mtd-input');
            if (input) return input;
          }
          return (modal || document).querySelector('.mtd-select-input input.mtd-input');
        }

        function realClick(el) {
          if (!el) return;
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new MouseEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new MouseEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          if (typeof el.click === 'function') el.click();
        }

        function findReasonOption() {
          const items = document.querySelectorAll('li.mtd-dropdown-menu-item, .mtd-dropdown-menu-item, .mtd-option-label-wrapper');
          const want = reasonText.replace(/\\s+/g, '');
          for (const li of items) {
            const t = (li.textContent || '').replace(/\\s+/g, '');
            if (t.includes(want)) return li.closest('li.mtd-dropdown-menu-item') || li;
          }
          return null;
        }

        function setDesc(modal) {
          const editor = (modal || document).querySelector('.ql-editor[contenteditable="true"]');
          if (!editor) return false;
          editor.focus();
          const safe = String(desc || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          editor.innerHTML = '<p><span>' + safe + '</span></p>';
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }

        function findConfirm(modal) {
          const root = modal || document;
          const btns = root.querySelectorAll('button.mtd-btn-primary, .mtd-btn-primary');
          for (const b of btns) {
            if (!isVisible(b)) continue;
            if ((b.textContent || '').replace(/\\s+/g, '').includes('确定')) return b;
          }
          return null;
        }

        if (isAlreadyPaused()) return { ok: true, reason: 'already_paused' };

        const pauseBtn = findPauseBtn();
        if (!pauseBtn) return { ok: false, reason: 'no_pause_btn' };
        pauseBtn.click();

        let modal = null;
        for (let i = 0; i < 20; i += 1) {
          await sleep(200);
          modal = findPauseModal();
          if (modal) break;
        }
        if (!modal) return { ok: false, reason: 'no_pause_modal' };

        const reasonInput = findReasonInput(modal);
        if (!reasonInput) return { ok: false, reason: 'pause_reason_not_found' };
        const wrap = reasonInput.closest('.mtd-select-input') || reasonInput.closest('.mtd-input-wrapper') || reasonInput;
        const arrow = wrap.querySelector?.('.mtdicon-down-thick, .mtd-input-suffix-inner') || wrap;

        // mtd-select 往往要点两次输入框才会弹出选项
        realClick(arrow);
        realClick(reasonInput);
        await sleep(400);
        realClick(reasonInput);
        await sleep(250);
        realClick(reasonInput);

        let option = findReasonOption();
        for (let i = 0; i < 20 && !option; i += 1) {
          await sleep(150);
          option = findReasonOption();
          if (!option && i === 6) realClick(reasonInput);
        }
        if (!option) return { ok: false, reason: 'pause_reason_not_found' };
        realClick(option);
        await sleep(250);

        if (!setDesc(modal)) return { ok: false, reason: 'pause_desc_not_found' };
        await sleep(200);

        const confirm = findConfirm(modal);
        if (!confirm) return { ok: false, reason: 'no_confirm' };
        confirm.click();

        for (let i = 0; i < 15; i += 1) {
          await sleep(200);
          if (!findPauseModal()) return { ok: true, reason: 'paused' };
        }
        return { ok: true, reason: 'paused' };
      })()
    `;
  }

  function collectTargets() {
    const me = normalizeMis(deps.getHandler());
    const list = deps.applyTicketFilters(deps.getTickets() || []);
    const out = [];
    for (const item of list) {
      const id = String(item?.id || "").trim();
      if (!id) continue;
      if (!isProcessing(item)) continue;
      if (!isMine(item, me)) continue;
      if (!lastReplierIsHandler(item, me)) continue;
      if (!lastReplyOlderThanWait(item)) continue;
      if (inCooldown(id)) continue;
      out.push(item);
    }
    return out;
  }

  async function pauseOne(item) {
    const id = String(item?.id || "").trim();
    const label = String(item?.title || id).slice(0, 40);
    const opened = await deps.handleTicketClick(item, { skipRefresh: true });
    if (!opened) {
      log(`暂停失败：「${label}」— ${TD.log.formatReason("open_failed")}`, "error");
      return false;
    }
    await deps.sleep(900);
    const exec =
      typeof deps.ttExecuteJavaScript === "function"
        ? deps.ttExecuteJavaScript
        : TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
    const res = await exec(buildPauseTtScript(getPauseDesc()));
    const reason = res?.reason || "unknown";
    if (reason === "already_paused" || reason === "paused" || res?.ok) {
      markPaused(id);
      if (item) item.statusText = "暂停中";
      if (reason === "already_paused") {
        log(`工单「${label}」已是暂停状态，跳过。`, "muted");
      } else {
        log(`已暂停工单：「${label}」`, "success");
      }
      return true;
    }
    log(`暂停失败：「${label}」— ${TD.log.formatReason(reason)}`, "error");
    return false;
  }

  async function runPauseOnReplyScan() {
    if (!isEnabled() || scanInFlight || pauseOnReplyInProgress) return;
    if (!deps.getWebviewReady?.() || !deps.getTtWebview?.()) return;
    if (isLocked()) return;
    const now = Date.now();
    if (now - lastScanAt < 8000) return;
    const apiOk = await deps.isApiConfigured();
    if (!apiOk) return;

    const targets = collectTargets().slice(0, MAX_PER_ROUND);
    if (!targets.length) return;

    lastScanAt = now;
    scanInFlight = true;
    pauseOnReplyInProgress = true;
    try {
      TD.browser?.ensureOpsSurface?.();
      for (const item of targets) {
        if (!isEnabled()) break;
        if (isLocked() && !pauseOnReplyInProgress) break;
        if (deps.getBusy() || deps.getBatchInProgress() || deps.isNormalizeInProgress() || deps.getPmPullInProgress() || deps.isPriorityBatchInProgress()) {
          break;
        }
        await pauseOne(item);
        await deps.sleep(400);
      }
    } catch (err) {
      log(`暂停工单异常：${TD.log.errText(err)}`, "error");
    } finally {
      pauseOnReplyInProgress = false;
      scanInFlight = false;
    }
  }

  function requestPauseOnReplyAfterRefresh() {
    if (!isEnabled()) return;
    queueMicrotask(() => {
      void runPauseOnReplyScan();
    });
  }

  TD.pauseOnReply = {
    bind,
    isInProgress,
    getPauseDesc,
    persistDesc,
    getWaitMinutes,
    persistWaitMinutes,
    fillWaitInput,
    requestPauseOnReplyAfterRefresh,
    runPauseOnReplyScan
  };
})(window.TTDesktop);
