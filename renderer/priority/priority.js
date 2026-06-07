/**
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

function updateBatchPrioritySelectionCount() {
  if (D.ticketBatchSelectedCountEl) {
    D.ticketBatchSelectedCountEl.textContent = `已选 ${batchPrioritySelected.size}`;
  }
}

/** @param {boolean} busy 批量任务进行中 */
function setPriorityBatchUiBusy(busy) {
  const b = !!busy;
  if (D.ticketPriorityBatchBtn) D.ticketPriorityBatchBtn.disabled = b;
  if (D.ticketPriorityBatchStopBtn) D.ticketPriorityBatchStopBtn.disabled = !b;
  if (D.ticketPriorityApplyBtn) D.ticketPriorityApplyBtn.disabled = b;
  if (D.ticketBatchSelectVisibleBtn) D.ticketBatchSelectVisibleBtn.disabled = b;
  if (D.ticketBatchClearSelectionBtn) D.ticketBatchClearSelectionBtn.disabled = b;
  if (D.ticketAutoPriorityBoostBtn) D.ticketAutoPriorityBoostBtn.disabled = b;
  if (D.ticketAutoPriorityBoostToggle) D.ticketAutoPriorityBoostToggle.disabled = b;
  if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = b;
  if (D.ticketPrioritySelect) D.ticketPrioritySelect.disabled = b;
  if (D.ticketRefreshBtn) D.ticketRefreshBtn.disabled = b;
  if (D.pmCsvSelectBtn) D.pmCsvSelectBtn.disabled = b || deps.getPmPullInProgress();
  if (D.pmPullByRegionBtn) D.pmPullByRegionBtn.disabled = b || deps.getPmPullInProgress();
}

function matchAutoPriorityBoost(title) {
  const t = String(title || "").trim();
  if (!t) return { ok: false, hit: "" };
  for (const kw of AUTO_PRIORITY_BOOST_KEYWORDS) {
    const k = String(kw || "").trim();
    if (!k) continue;
    if (t.includes(k)) return { ok: true, hit: k };
  }
  return { ok: false, hit: "" };
}

function shouldSkipAutoBoostByPriority(item) {
  const r = Number.isFinite(item?.priorityRank) ? item.priorityRank : 9;
  return r <= 2; // 非常紧急/紧急/高 不再升
}

function autoBoostEligibleKey(item) {
  const k = deps.getTicketSelectKey(item);
  if (!k) return "";
  const now = Date.now();
  const last = autoPriorityBoostCooldown.get(k);
  if (last && now - last < AUTO_PRIORITY_BOOST_COOLDOWN_MS) return "";
  return k;
}

/** @param {any} res */
function formatPriorityApplyDebugSuffix(res) {
  const extra =
    res?.reason === "verify_mismatch"
      ? `（界面为「${String(res.actual || "").slice(0, 20)}」，期望「${String(res.expected || "").slice(0, 20)}」）`
      : "";
  const debugParts = [];
  if (res?.debug && Array.isArray(res.debug.tried)) {
    debugParts.push(
      `触发器候选 ${res.debug.triggerCount || res.debug.tried.length} 个，已尝试：${res.debug.tried.slice(0, 5).join(" | ")}`
    );
  }
  if (res?.debug && Array.isArray(res.debug.visibleOptionTexts)) {
    debugParts.push(
      `可见选项 ${res.debug.visibleOptionCount || res.debug.visibleOptionTexts.length} 个：${res.debug.visibleOptionTexts.slice(0, 8).join(" / ")}`
    );
  }
  const debugText = debugParts.length ? `；${debugParts.join("；")}` : "";
  return `${extra}${debugText}`;
}

function requestAutoPriorityBoostFromRefresh() {
  if (!autoPriorityBoostEnabled) return;
  if (deps.getRunning()) {
    if (!autoPriorityBoostQueued) {
      autoPriorityBoostQueued = true;
      log("自动升高已排队：将在本轮自动处理结束后执行。", "muted");
    }
    return;
  }
  queueMicrotask(() => {
    runAutoPriorityBoostFromRefresh({ allowRunning: false, reasonTag: "自动升高" }).catch(() => {});
  });
}

async function flushAutoPriorityBoostQueueIfPossible() {
  if (!autoPriorityBoostQueued) return;
  if (!deps.getRunning()) {
    autoPriorityBoostQueued = false;
    return;
  }
  if (deps.getBatchInProgress() || deps.getPendingRunAfterReload() || deps.getBusy() || priorityBatchInProgress || deps.isNormalizeInProgress() || deps.getPmPullInProgress())
    return;
  autoPriorityBoostQueued = false;
  await runAutoPriorityBoostFromRefresh({ allowRunning: true, reasonTag: "自动升高-运行中" });
  await deps.flushTitleOnNewQueueIfPossible();
}

async function runAutoPriorityBoostFromRefresh(options = {}) {
  const allowRunning = !!options.allowRunning;
  const reasonTag = String(options.reasonTag || "自动升高").trim();
  if (!autoPriorityBoostEnabled) return;
  if (priorityBatchInProgress) return;
  if (deps.isNormalizeInProgress()) return;
  if (deps.getPmPullInProgress()) return;
  if (deps.getRunning() && !allowRunning) return;
  if (!deps.getWebviewReady() || !deps.getTtWebview()) return;

  const filtered = deps.applyTicketFilters(deps.getTickets());
  const sorted = deps.sortTickets(filtered);
  batchPrioritySelected.clear();

  let hitCount = 0;
  const hits = [];
  for (const it of sorted) {
    if (hitCount >= AUTO_PRIORITY_BOOST_MAX_PER_ROUND) break;
    if (shouldSkipAutoBoostByPriority(it)) continue;
    const k = autoBoostEligibleKey(it);
    if (!k) continue;
    const m = matchAutoPriorityBoost(it.title || "");
    if (!m.ok) continue;
    batchPrioritySelected.add(k);
    hitCount += 1;
    hits.push(m.hit);
  }

  if (!batchPrioritySelected.size) return;
  updateBatchPrioritySelectionCount();
  deps.renderTicketList();
  if (D.ticketPrioritySelect) D.ticketPrioritySelect.value = AUTO_PRIORITY_BOOST_TARGET;

  const uniqHits = Array.from(new Set(hits));
  log(
    `${reasonTag}：命中 ${batchPrioritySelected.size} 条（${uniqHits.slice(0, 6).join(" / ")}），将设置为「${AUTO_PRIORITY_BOOST_TARGET}(S3)」。`,
    "info"
  );
  await applyPriorityBatch({ confirm: false, reasonTag, allowRunning });
}

function buildApplyPriorityScript(targetPriorityText) {
  const safe = JSON.stringify(String(targetPriorityText || "").trim());
  return `
    (async () => {
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function norm(t) { return ((t || '').trim()).replace(/\\s+/g, ' '); }

      function visible(el) {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function getDetailRoot() {
        // 同事环境里 TT 详情容器 class 可能不同：找不到时不要直接失败，改为全局操作
        return (
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container') ||
          document.querySelector('.ticket-detail') ||
          document.querySelector('[class*="ticket-detail" i]') ||
          null
        );
      }

      function normalizePriorityLabel(t) {
        const s = norm(t);
        if (!s) return '';
        if (s.includes('非常紧急')) return '非常紧急';
        if (s.includes('紧急')) return '紧急';
        if (s.includes('高')) return '高';
        if (s.includes('中')) return '中';
        if (s.includes('低')) return '低';
        return '';
      }

      function readPriorityFromDetail(detail) {
        const root = detail || document;
        const items = Array.from(root.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('优先级')) continue;
          const txt =
            it.querySelector('.toolcom-state-option-tag')?.textContent ||
            it.querySelector('.info-text')?.textContent ||
            it.querySelector('.info-value')?.textContent ||
            it.textContent ||
            '';
          const p = normalizePriorityLabel(txt);
          if (p) return p;
        }
        const tags = Array.from(root.querySelectorAll('.toolcom-state-option-tag'));
        for (const el of tags) {
          const p = normalizePriorityLabel(el.textContent || '');
          if (p) return p;
        }
        return '';
      }

      // 从优先级控件本身读取当前值（兼容详情字段读取不到的页面结构）
      function readPriorityFromPicker(detail) {
        const root = detail || document;
        const picker =
          root.querySelector('.toolcom-state-picker .mtd-picker-values') ||
          root.querySelector('.toolcom-state-picker .mtd-picker-rendered') ||
          root.querySelector('.toolcom-state-picker') ||
          root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-picker-values') ||
          root.querySelector('[class*=\"toolcom-state-picker\"]');
        if (!picker) return '';
        return normalizePriorityLabel(picker.textContent || '');
      }

      // 某些 TT 页面会先更新左侧列表徽标，再回填详情字段；作为校验兜底来源
      function readPriorityFromActiveListItem() {
        const active =
          document.querySelector('.handle-ticket-nav-item.handle-ticket-nav-item-active') ||
          document.querySelector('.handle-ticket-nav-item.active');
        if (!active) return '';
        const txt =
          active.querySelector('.ticket-sla-text')?.textContent ||
          active.querySelector('.priority')?.textContent ||
          active.textContent ||
          '';
        return normalizePriorityLabel(txt);
      }

      function collectPriorityTriggers(detail) {
        const root = detail || document;
        const out = [];
        const seen = new Set();
        const push = (el) => {
          if (!el || !(el instanceof Element)) return;
          if (seen.has(el)) return;
          seen.add(el);
          out.push(el);
        };

        // 优先命中你截图里的“中 ▼”按钮样式
        const current = readPriorityFromDetail(root);
        const btns = Array.from(root.querySelectorAll('button, .mtd-btn, [role=\"button\"]'));
        for (const b of btns) {
          const t = normalizePriorityLabel(b.textContent || '');
          if (current && t && t === current) push(b);
        }

        // 常见优先级触发器
        push(root.querySelector('.toolcom-state-picker .mtd-picker-selection'));
        push(root.querySelector('.toolcom-state-picker .mtd-picker-icon'));
        push(root.querySelector('.toolcom-state-picker .mtd-btn'));
        push(root.querySelector('.toolcom-state-picker'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-picker-selection'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-picker-icon'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"] .mtd-btn'));
        push(root.querySelector('[class*=\"toolcom-state-picker\"]'));
        push(root.querySelector('[class*=\"state-picker\"] .mtd-picker-selection'));
        push(root.querySelector('[class*=\"state-picker\"] .mtd-picker-icon'));
        push(root.querySelector('[class*=\"state-picker\"] .mtd-btn'));
        push(root.querySelector('[class*=\"state-picker\"]'));

        const items = Array.from(root.querySelectorAll('.info-item'));
        for (const it of items) {
          const label = norm(it.querySelector('.info-label')?.textContent || '');
          if (!label.includes('优先级')) continue;
          push(it.querySelector('.toolcom-state-picker .mtd-picker-selection'));
          push(it.querySelector('.toolcom-state-picker .mtd-picker-icon'));
          push(it.querySelector('.toolcom-state-picker .mtd-btn'));
          push(it.querySelector('.toolcom-state-picker'));
          push(it.querySelector('button,[role=\"button\"],.mtd-select,.mtd-input-wrapper,.info-text'));
          push(it);
        }

        const formItems = Array.from(root.querySelectorAll('.mtd-form-item'));
        for (const it of formItems) {
          const label = norm(it.querySelector('.mtd-form-item-label')?.textContent || '');
          if (!label.includes('优先级')) continue;
          push(it.querySelector('.mtd-select-input'));
          push(it.querySelector('.mtd-input-wrapper'));
          push(it.querySelector('button,[role=\"button\"]'));
          push(it);
        }
        return out;
      }

      function describeEl(el) {
        if (!el || !(el instanceof Element)) return '';
        const tag = (el.tagName || '').toLowerCase();
        const id = el.id ? ('#' + el.id) : '';
        const cls = (el.className && typeof el.className === 'string')
          ? '.' + el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
          : '';
        const txt = norm(el.textContent || '').slice(0, 24);
        return tag + id + cls + (txt ? ('("' + txt + '")') : '');
      }

      async function openPriorityPopper(detail) {
        const triggers = collectPriorityTriggers(detail);
        if (!triggers.length) return { ok: false, reason: 'no_priority_trigger', debug: { triggerCount: 0, tried: [] } };

        function readVisiblePopper() {
          const pops = Array.from(
            document.querySelectorAll(
              '.toolcom-state-picker-popper, .mtd-picker-popper, .mtd-dropdown-popper, .mtd-popper, [class*="picker-popper" i], [class*="dropdown-popper" i]'
            )
          );
          for (const pop of pops) {
            if (pop && (visible(pop) || pop.style.display !== 'none')) return pop;
          }
          return null;
        }

        function readVisiblePriorityOptions(rootEl) {
          const root = rootEl || document;
          const candidates = Array.from(
            root.querySelectorAll(
              'li.toolcom-state-option, li.mtd-dropdown-menu-item, .mtd-dropdown-menu-item, [role="menuitem"], [role="option"]'
            )
          );
          return candidates.filter((el) => {
            if (!el || !(el instanceof Element)) return false;
            const txt = norm(el.textContent || '');
            if (!txt) return false;
            const hasLevel = /非常紧急|紧急|高|中|低/.test(txt);
            if (!hasLevel) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        }

        function isExpandedTrigger(el) {
          if (!el || !(el instanceof Element)) return false;
          const host = el.closest('.toolcom-state-picker, .mtd-picker, .mtd-dropdown') || el;
          if (!(host instanceof Element)) return false;
          const cls = host.className || '';
          return /mtd-dropdown-expended|mtd-dropdown-expanded/.test(String(cls));
        }

        const tried = [];
        for (const trigger of triggers) {
          tried.push(describeEl(trigger));
          try {
            const host = trigger.closest('.toolcom-state-picker, .mtd-picker, .mtd-dropdown') || trigger;
            host.scrollIntoView({ block: 'center' });
            if (typeof host.focus === 'function') host.focus();

            // 更强制：PointerEvent -> MouseEvent -> click，兼容不同组件监听
            if (typeof PointerEvent === 'function') {
              host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse' }));
              host.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse' }));
            }
            host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            if (typeof host.click === 'function') host.click();

            // 再补一轮键盘触发（有些 picker 仅响应 Enter/Space）
            try {
              host.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
              host.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ', code: 'Space' }));
            } catch {
              // ignore
            }

            // 若有下拉图标，额外点一次
            const icon = host.querySelector && (host.querySelector('.mtd-picker-icon') || host.querySelector('.mtdicon-down-thick'));
            if (icon && typeof icon.click === 'function') icon.click();
          } catch {
            // ignore and continue next trigger
          }

          for (let i = 0; i < 10; i += 1) {
            const pop = readVisiblePopper();
            if (pop) return { ok: true, popper: pop };
            if (isExpandedTrigger(trigger)) {
              return { ok: true, popper: null, byExpanded: true };
            }
            const vis = readVisiblePriorityOptions(document);
            if (vis.length > 0) {
              return { ok: true, popper: null, byVisibleOptions: true };
            }
            await sleep(80);
          }
        }
        return { ok: false, reason: 'no_priority_popper', debug: { triggerCount: triggers.length, tried } };
      }

      const target = ${safe};
      if (!target) return { ok: false, reason: 'empty_target' };

      const detail = getDetailRoot() || document.body || document.documentElement || document;

      const before = readPriorityFromDetail(detail);
      const opened = await openPriorityPopper(detail);
      if (!opened.ok) return { ok: false, reason: opened.reason || 'open_failed', debug: opened.debug || null };

      const pop = opened.popper;
      const itemRoot = pop || document;
      let items = Array.from(
        itemRoot.querySelectorAll(
          'li.toolcom-state-option, li.mtd-dropdown-menu-item, .mtd-dropdown-menu-item, [role="menuitem"], [role="option"]'
        )
      );
      items = items.filter((el) => {
        if (!el || !(el instanceof Element)) return false;
        const txt = norm(el.textContent || '');
        if (!txt) return false;
        if (!/非常紧急|紧急|高|中|低/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const pick = items.find((li) => norm(li.textContent || '').includes(target));
      if (!pick) {
        return {
          ok: false,
          reason: 'option_not_found',
          expected: target,
          before,
          debug: { visibleOptionCount: items.length, visibleOptionTexts: items.map((x) => norm(x.textContent || '')).slice(0, 10) }
        };
      }

      pick.scrollIntoView({ block: 'center' });
      pick.click();
      await sleep(180);

      // 某些页面需要失焦才会真正提交优先级变更
      const neutral =
        detail.querySelector('.ticket-custom-edit-container') ||
        detail.querySelector('.main-content') ||
        detail.querySelector('.info-content') ||
        detail;
      if (neutral) {
        neutral.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        neutral.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        if (typeof neutral.click === 'function') neutral.click();
      }
      await sleep(240);

      for (let i = 0; i < 28; i += 1) {
        const actual = readPriorityFromDetail(detail) || readPriorityFromPicker(detail) || readPriorityFromActiveListItem();
        if (actual) {
          if (actual === target) return { ok: true, expected: target, actual, before };
          // 读到旧值时继续等待后端回写，不要立刻误判失败
          await sleep(220);
          const retry = readPriorityFromDetail(detail) || readPriorityFromPicker(detail) || readPriorityFromActiveListItem();
          if (retry === target) return { ok: true, expected: target, actual: retry, before };
        }
        await sleep(140);
      }
      // 末次再尝试一次控件文本，减少因渲染延迟带来的误报
      const finalActual = readPriorityFromPicker(detail) || readPriorityFromDetail(detail) || readPriorityFromActiveListItem();
      if (finalActual) {
        if (finalActual === target) return { ok: true, expected: target, actual: finalActual, before };
        return { ok: false, reason: 'verify_mismatch', expected: target, actual: finalActual, before };
      }
      return { ok: false, reason: 'verify_empty', expected: target, before };
    })()
  `;
}

function applyPriorityInWebview(target) {
  return ttExecuteJavaScript(buildApplyPriorityScript(target));
}

async function applyPriorityForActiveTicket() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    log("请先等待 TT 页面加载完成。", "warning");
    return;
  }
  if (deps.isNormalizeInProgress()) {
    log("请等待「标题检测」完成后再修改优先级。", "warning");
    return;
  }
  if (priorityBatchInProgress) {
    log("正在批量设置优先级，请等待完成后再单独设置。", "warning");
    return;
  }
  if (deps.getPmPullInProgress()) {
    log("正在执行「按地区拉PM」，请稍后再设置优先级。", "warning");
    return;
  }
  if (deps.getRunning()) {
    log("请先停止「开始」自动处理，再修改优先级。", "warning");
    return;
  }

  const target = String(D.ticketPrioritySelect?.value || "").trim();
  if (!target) {
    log("未选择目标优先级。", "warning");
    return;
  }

  deps.setActiveLeftTab("logs");
  log(`开始设置当前工单优先级：${target}…`, "info");

  const res = await applyPriorityInWebview(target);
  if (!res?.ok) {
    log(`设置优先级失败：${res?.reason || "unknown"}${formatPriorityApplyDebugSuffix(res)}`, "error");
  } else {
    log(`优先级已更新：${String(res.actual || target)}`, "success");
  }

  await sleep(260);
  await deps.refreshTickets({ reset: false });
}

async function applyPriorityBatch(options = {}) {
  const confirm = options?.confirm !== false;
  const reasonTag = String(options?.reasonTag || "").trim();
  const allowRunning = !!options?.allowRunning;
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    log("请先等待 TT 页面加载完成。", "warning");
    return;
  }
  if (deps.isNormalizeInProgress()) {
    log("请等待「标题检测」完成后再批量设置优先级。", "warning");
    return;
  }
  if (deps.getPmPullInProgress()) {
    log("正在执行「按地区拉PM」，请稍后再批量设置优先级。", "warning");
    return;
  }
  if (deps.getRunning() && !allowRunning) {
    log("请先停止「开始」自动处理，再批量设置优先级。", "warning");
    return;
  }
  if (priorityBatchInProgress) return;

  const target = String(D.ticketPrioritySelect?.value || "").trim();
  if (!target) {
    log("未选择目标优先级。", "warning");
    return;
  }

  const filtered = deps.applyTicketFilters(deps.getTickets());
  const sorted = deps.sortTickets(filtered);
  const toProcess = sorted.filter((item) => batchPrioritySelected.has(deps.getTicketSelectKey(item)));
  if (!toProcess.length) {
    log("没有可处理的工单：请在列表中勾选工单，并确保它们出现在当前筛选结果中。", "warning");
    return;
  }

  if (confirm) {
    const okConfirm = window.confirm(
      `将对 ${toProcess.length} 条工单顺序设置优先级为「${target}」（仅当前筛选列表内已勾选项）。\n\n确认继续？`
    );
    if (!okConfirm) {
      log("已取消批量设置优先级。", "muted");
      return;
    }
  }

  priorityBatchInProgress = true;
  priorityBatchAbort = false;
  setPriorityBatchUiBusy(true);
  deps.setActiveLeftTab("logs");
  const tag = reasonTag ? `（${reasonTag}）` : "";
  log(`开始批量设置优先级「${target}」${tag}，共 ${toProcess.length} 条（逐条打开 TT 详情并保存）…`, "info");

  let okCount = 0;
  let failCount = 0;

  try {
    for (let i = 0; i < toProcess.length; i += 1) {
      if (priorityBatchAbort) {
        log(`批量设置已中止：已处理 ${i} 条，成功 ${okCount}，失败 ${failCount}。`, "warning");
        break;
      }
      const item = toProcess[i];
      const label = (item.title || item.id || "").slice(0, 55);
      const opened = await deps.handleTicketClick(item, { skipRefresh: true });
      if (!opened) {
        failCount += 1;
        log(`[批量优先级] ${i + 1}/${toProcess.length} 失败（未打开）：${label}`, "error");
        continue;
      }
      await sleep(650);
      const res = await applyPriorityInWebview(target);
      if (!res?.ok) {
        failCount += 1;
        if (!confirm) {
          const k = deps.getTicketSelectKey(item);
          if (k) autoPriorityBoostCooldown.set(k, Date.now());
        }
        log(
          `[批量优先级] ${i + 1}/${toProcess.length} 失败：${label} — ${res?.reason || "unknown"}${formatPriorityApplyDebugSuffix(res)}`,
          "error"
        );
      } else {
        okCount += 1;
        log(`[批量优先级] ${i + 1}/${toProcess.length} 已设为「${String(res.actual || target)}」：${label}`, "success");
      }
      await sleep(280);
    }
    if (!priorityBatchAbort) {
      log(`批量设置优先级结束：成功 ${okCount}，失败 ${failCount}。`, failCount ? "warning" : "success");
    }
  } finally {
    priorityBatchInProgress = false;
    setPriorityBatchUiBusy(false);
    await deps.refreshTickets({ reset: false });
    deps.renderTicketList();
  }
}
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
