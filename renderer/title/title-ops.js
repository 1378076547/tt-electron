/**
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

function buildTitleNormalizeInspectScript() {
  return `
    (() => {
      function norm(t) { return ((t || '').trim()).replace(/\\s+/g, ' '); }

      function getArchitecturePathText() {
        const roots = [
          document.querySelector('#ticket-detail'),
          document.querySelector('.ticket-detail-container'),
          document.querySelector('.detail-with-list-container')
        ].filter(Boolean);

        function cleanPath(t) {
          return String(t || '')
            .trim()
            .replace(/\\s+/g, '');
        }

        /** 仅发起人架构行：必须是「公司/…/事业部/…」短路径，避免把处理人/服务目录等整块拼进 path */
        function looksLikeOrgPathOnly(t) {
          const s = cleanPath(t);
          if (!s || s.length > 160) return false;
          if (!s.includes('公司/') || !s.includes('事业部')) return false;
          if (/处理人|服务目录|一级目录|二级目录|三级目录|问题归档|转入ONES|4000帮助台|零售IT/i.test(s)) return false;
          return true;
        }

        for (const root of roots) {
          const items = root.querySelectorAll('.info-item');
          for (const it of items) {
            const lab = norm(it.querySelector('.info-label')?.textContent || '');
            if (!lab.includes('发起人')) continue;
            const sub = it.querySelectorAll('.info-text, span, div, p');
            for (const el of sub) {
              const t = norm(el.textContent || '');
              if (t.length > 20 && t.includes('/') && (t.includes('事业部') || t.includes('美团'))) {
                const c = cleanPath(t);
                if (looksLikeOrgPathOnly(c)) return c;
              }
            }
            const all = norm(it.textContent || '');
            const m = all.match(/(公司\\/[\\u4e00-\\w\\/\\-]+?事业部\\/[\\u4e00-\\w\\/\\-]+(?:\\/[\\u4e00-\\w\\/\\-]+){2,})/);
            if (m && looksLikeOrgPathOnly(m[1])) return cleanPath(m[1]);
          }
        }

        // TT 新版：h3「发起人」后的第一个 .org-info（仅一行路径）
        for (const root of roots) {
          const h3s = root.querySelectorAll('h3');
          for (const h3 of h3s) {
            if (!norm(h3.textContent || '').includes('发起人')) continue;
            let node = h3.nextElementSibling;
            while (node) {
              if (node.tagName === 'H3') break;
              const org = node.querySelector && node.querySelector('.org-info');
              if (org) {
                const c = cleanPath(org.textContent || '');
                if (looksLikeOrgPathOnly(c)) return c;
              }
              node = node.nextElementSibling;
            }
          }
        }

        // 第一个仅含架构的 .org-info（处理人区块常为「零售IT_4000」无 公司/）
        for (const root of roots) {
          const infos = root.querySelectorAll('.org-info');
          for (const el of infos) {
            const c = cleanPath(el.textContent || '');
            if (looksLikeOrgPathOnly(c)) return c;
          }
        }

        // 最后手段：从正文用正则抠路径，禁止再取「最长 div」以免混入整段详情
        for (const root of roots) {
          const blob = cleanPath(root.innerText || root.textContent || '');
          const m = blob.match(
            /公司\\/[\\u4e00\\w\\/\\-]+?事业部\\/[\\u4e00\\w\\/\\-]+(?:\\/[\\u4e00\\w\\/\\-]+){2,12}/
          );
          if (m && m[0].length <= 160) return m[0];
        }
        return '';
      }

      function getWarehouseStoreValue() {
        const container =
          document.querySelector('.ticket-custom-edit-container') || document.querySelector('.editor-content form.mtd-form');
        if (!container) return '';
        const items = Array.from(container.querySelectorAll('.mtd-form-item'));
        for (const item of items) {
          const label = norm(item.querySelector('.mtd-form-item-label')?.textContent || '');
          if (!label.includes('仓库') || (!label.includes('门店') && !label.includes('名称'))) continue;
          const instr = item.querySelector('.form-item-instruction')?.textContent || '';
          if (!instr.includes('仓库') || !instr.includes('门店')) continue;
          const input = item.querySelector('input.mtd-input');
          return norm(input?.value || '');
        }
        return '';
      }

      function getCurrentTitleFromDetail() {
        const detailRoot =
          document.querySelector('#ticket-detail') ||
          document.querySelector('.ticket-detail-container') ||
          document.querySelector('.detail-with-list-container');
        const fromDisplay = detailRoot?.querySelector('.ticket-name-text-display');
        if (fromDisplay && norm(fromDisplay.textContent)) return norm(fromDisplay.textContent);
        const ta = document.querySelector('.ticket-edit-title textarea');
        if (ta && ta.value) return norm(ta.value);
        const ipt = document.querySelector('.ticket-edit-title input.mtd-input');
        if (ipt && ipt.value) return norm(ipt.value);
        return '';
      }

      return {
        architectureRaw: getArchitecturePathText(),
        warehouseStore: getWarehouseStoreValue(),
        currentTitle: getCurrentTitleFromDetail()
      };
    })()
  `;
}

function buildApplyTitleScript(newTitle) {
  const safe = JSON.stringify(newTitle);
  return `
    (async () => {
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function norm(t) { return ((t || '').trim()).replace(/\\s+/g, ' '); }

      function visible(el) {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      /** TT 标题编辑态：.ticket-edit-title .mtd-textarea（Vue/React 需原生 setter + _valueTracker） */
      function setTitleTextareaValue(el, val) {
        if (!el || el.tagName !== 'TEXTAREA') return;
        const prev = el.value;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        const tr = el._valueTracker;
        if (tr && typeof tr.setValue === 'function') tr.setValue(prev);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof InputEvent === 'function') {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: val }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function setTitleInputValue(el, val) {
        if (!el || el.tagName !== 'INPUT') return;
        const prev = el.value;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        const tr = el._valueTracker;
        if (tr && typeof tr.setValue === 'function') tr.setValue(prev);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      /** 只认标题栏内的控件，避免误改页面上其它 input */
      function findTitleEditorStrict(detail) {
        const roots = [document, detail].filter(Boolean);
        const selectors = [
          '.ticket-edit-title textarea.mtd-textarea',
          '.ticket-edit-title .tt-hover-field textarea.mtd-textarea',
          '.ticket-edit-title textarea',
          '.ticket-edit-title .tt-hover-field textarea',
          '.ticket-edit-title input.mtd-input',
          '.ticket-edit-title input[type="text"]'
        ];
        for (const r of roots) {
          for (const sel of selectors) {
            const el = r.querySelector(sel);
            if (el && (visible(el) || el.offsetParent !== null)) return el;
          }
        }
        for (const r of roots) {
          for (const sel of selectors) {
            const el = r.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      }

      function readDisplayedTitle(detail) {
        const d = detail || document;
        const n = d.querySelector('.ticket-name-text-display') || document.querySelector('.ticket-name-text-display');
        return norm(n?.textContent || '');
      }

      const newTitle = ${safe};
      const detail = document.querySelector('#ticket-detail') || document.querySelector('.ticket-detail-container') || document.querySelector('.detail-with-list-container');
      const display = detail?.querySelector('.ticket-name-text-display') || document.querySelector('.ticket-name-text-display');

      if (display && visible(display)) {
        display.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        display.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        display.click();
        await sleep(300);
      } else {
        const field = display?.closest('.tt-hover-field');
        if (field) {
          field.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await sleep(300);
        }
      }

      let editor = null;
      for (let i = 0; i < 28; i += 1) {
        editor = findTitleEditorStrict(detail);
        if (!editor) {
          const ae = document.activeElement;
          if (ae && ae.closest && ae.closest('.ticket-edit-title') && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) editor = ae;
        }
        if (editor) break;
        await sleep(200);
      }

      if (!editor) return { ok: false, reason: 'no_title_editor' };

      editor.focus();
      await sleep(100);
      if (editor.tagName === 'TEXTAREA') setTitleTextareaValue(editor, newTitle);
      else if (editor.tagName === 'INPUT') setTitleInputValue(editor, newTitle);
      await sleep(200);

      editor.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      editor.blur();
      await sleep(200);

      const neutral = detail?.querySelector('.ticket-custom-edit-container') || detail?.querySelector('.mtd-form') || detail;
      if (neutral && neutral !== editor) {
        neutral.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        neutral.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      }
      await sleep(400);

      let after = readDisplayedTitle(detail);
      let ok = after === norm(newTitle);
      if (!ok) {
        await sleep(700);
        after = readDisplayedTitle(detail);
        ok = after === norm(newTitle);
      }
      if (!ok) {
        return { ok: false, reason: 'verify_mismatch', expected: norm(newTitle), actual: after };
      }
      return { ok: true };
    })()
  `;
}

async function ensureChinaCitiesLoaded() {
  if (chinaCitiesJsonCache) return chinaCitiesJsonCache;
  const raw = await window.ttDesktopApi?.loadChinaCities?.();
  if (!raw || !raw.data) throw new Error("无法读取 assets/china_cities.json");
  chinaCitiesJsonCache = raw;
  if (window.TTTitlePrefix && typeof window.TTTitlePrefix.prepareMatchers === "function") {
    window.TTTitlePrefix.prepareMatchers(raw);
  }
  return chinaCitiesJsonCache;
}

function formatTitleStationSourceHint(res) {
  if (!res) return "";
  if (res.stationCombineNote) return `\n  站/仓/店：${String(res.stationCombineNote).slice(0, 80)}`;
  if (res.stationSource === "warehouse+arch") {
    return `\n  站/仓/店：字段+架构${res.archLocSeg ? `（架构段「${String(res.archLocSeg).slice(0, 20)}」）` : ""}`;
  }
  if (res.archLocSeg && res.stationSource === "arch") {
    return `\n  站/仓/店：架构「${String(res.archLocSeg).slice(0, 36)}」`;
  }
  if (res.stationSource === "warehouse") return "\n  站/仓/店：仓库/门店字段";
  if (res.stationSource === "path") return "\n  站/仓/店：架构末级";
  return "";
}

function ticketKeyForTitle(item) {
  return String(item?.id || "").trim() || makeStableKey(item);
}

function resetTitleNewTicketBaseline() {
  knownTicketKeysForTitle = new Set();
  for (const t of getMyTodoTicketsForTitleOps(getTickets())) {
    const k = ticketKeyForTitle(t);
    if (k) knownTicketKeysForTitle.add(k);
  }
}

/** @param {TicketItem[]} list */
function detectNewTicketsForTitle(list) {
  return getMyTodoTicketsForTitleOps(list).filter((t) => {
    const k = ticketKeyForTitle(t);
    return k && !knownTicketKeysForTitle.has(k);
  });
}

/** @param {TicketItem[]} items */
function markTicketsKnownForTitle(items) {
  for (const t of items) {
    const k = ticketKeyForTitle(t);
    if (k) knownTicketKeysForTitle.add(k);
  }
}

function shouldNotifyTitleSkip(reason) {
  const r = String(reason || "");
  return (
    r.includes("无法解析城市") ||
    r.includes("请手动改标题") ||
    r.includes("无发起人架构") ||
    r.includes("无事业部") ||
    r.includes("未能解析事业部") ||
    r.includes("无站点信息")
  );
}

function notifyTitleNormalizeIssue(item, title, body) {
  void window.ttDesktopApi?.showSlaNotification?.({
    title: String(title || "来单改标题").trim(),
    body: String(body || "").trim()
  });
}

function normalizeDescToText(desc) {
  const s = String(desc || "");
  if (!s) return "";
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}

function parseWarehouseFromDesc(desc) {
  const text = normalizeDescToText(desc);
  if (!text) return "";
  const m =
    text.match(/门店名称\s*[:：]\s*([^\n]+)/) ||
    text.match(/仓库(?:\/门店)?名称\s*[:：]\s*([^\n]+)/) ||
    text.match(/门店\s*[:：]\s*([^\n]+)/);
  return m ? String(m[1] || "").trim() : "";
}

function buildInspectFromApiTicket(ticketData) {
  const t = ticketData || {};
  const architectureRaw = String(t.org || t.reporterOrg || "").trim();
  const warehouseStore = parseWarehouseFromDesc(t.desc || t.description || "");
  const currentTitle = String(t.name || t.title || t.ticketName || "").trim();
  return { architectureRaw, warehouseStore, currentTitle };
}

function mergeInspectPreferApi(domInspect, apiInspect) {
  const d = domInspect || {};
  const a = apiInspect || {};
  return {
    architectureRaw: String(d.architectureRaw || a.architectureRaw || "").trim(),
    warehouseStore: String(a.warehouseStore || d.warehouseStore || "").trim(),
    currentTitle: String(a.currentTitle || d.currentTitle || "").trim()
  };
}

async function inspectTicketItemForTitle(item) {
  const opened = await handleTicketClick(item, { skipRefresh: true });
  if (!opened) {
    return { ok: false, opened: false, reason: "无法打开工单" };
  }
  await sleep(650);
  const domInspect = await ttExecuteJavaScript(buildTitleNormalizeInspectScript());
  let inspect = domInspect;
  if (item.id) {
    try {
      const detailRes = await window.ttDesktopApi?.queryTicketDetailByApi?.({
        username: getHandler(),
        ticketId: item.id
      });
      if (detailRes?.ok && detailRes?.data?.code === 200 && detailRes?.data?.data) {
        const apiInspect = buildInspectFromApiTicket(detailRes.data.data);
        inspect = mergeInspectPreferApi(domInspect, apiInspect);
      }
    } catch {
      // ignore
    }
  }
  const res = window.TTTitlePrefix.computeExpectedTitle(inspect, chinaCitiesJsonCache);
  return { ok: true, opened: true, inspect, res };
}

function canRunTitleNormalizeOp({ allowWhileRunning = false } = {}) {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    log("请先等待 TT 页面加载完成。", "warning");
    return false;
  }
  if (titleNormalizeInProgress) return false;
  if (deps.getPriorityBatchInProgress()) {
    log("请等待「批量设置优先级」完成后再改标题。", "warning");
    return false;
  }
  if (deps.getPmPullInProgress()) {
    log("请等待「按地区拉PM」完成后再改标题。", "warning");
    return false;
  }
  if (!allowWhileRunning && deps.getRunning()) {
    log("请先停止「开始」自动处理，再执行标题检测。", "warning");
    return false;
  }
  if (allowWhileRunning && !deps.getRunning()) {
    log("请先点击顶部「开始」，再使用来单改标题。", "warning");
    return false;
  }
  if (!window.TTTitlePrefix || typeof window.TTTitlePrefix.computeExpectedTitle !== "function") {
    log("标题引擎未加载（缺少 titlePrefixEngine.js）。", "error");
    return false;
  }
  return true;
}

/**
 * 来单改标题：仅「开始」后新出现的待处理单（含转单）；检测后 confirm 写入。
 * @param {{ triggeredBy?: string }} [opts]
 */
async function runNewTicketTitleNormalize(opts = {}) {
  const tag = String(opts.triggeredBy || "来单改标题").trim();
  if (!canRunTitleNormalizeOp({ allowWhileRunning: true })) return;

  titleNormalizeInProgress = true;
  if (D.ticketTitleOnNewBtn) D.ticketTitleOnNewBtn.disabled = true;
  if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = true;

  try {
    await ensureChinaCitiesLoaded();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[${tag}] 加载城市词典失败：${msg}`, "error");
    notifyTitleNormalizeIssue(null, `${tag}：词典加载失败`, msg);
    titleNormalizeInProgress = false;
    if (D.ticketTitleOnNewBtn) D.ticketTitleOnNewBtn.disabled = !deps.getRunning();
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = deps.getRunning();
    return;
  }

  const newOnes = sortTickets(detectNewTicketsForTitle(getTickets()));
  if (!newOnes.length) {
    log(`[${tag}] 没有新工单（相对本次「开始」后的基线）。`, "muted");
    titleNormalizeInProgress = false;
    if (D.ticketTitleOnNewBtn) D.ticketTitleOnNewBtn.disabled = !deps.getRunning();
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = deps.getRunning();
    return;
  }

  setActiveLeftTab("logs");
  log(`[${tag}] 发现 ${newOnes.length} 条新工单，开始检测标题…`, "info");

  /** @type {{ item: TicketItem, expected: string, currentTitle: string }[]} */
  const toApply = [];
  const processed = [];

  try {
    for (let i = 0; i < newOnes.length; i += 1) {
      const item = newOnes[i];
      const label = (item.title || item.id || String(i)).slice(0, 60);
      const inspected = await inspectTicketItemForTitle(item);
      processed.push(item);

      if (!inspected.opened) {
        log(`[${tag}] ${label} — 无法打开工单，跳过（继续接单流程）`, "warning");
        notifyTitleNormalizeIssue(item, `${tag}：无法打开`, label);
        continue;
      }

      const res = inspected.res;
      if (res.skip) {
        const skipReason = res.reason || "跳过";
        const skipLevel =
          skipReason.includes("无法解析城市") || skipReason.includes("请手动改标题") ? "error" : "muted";
        log(`[${tag}] ${label} — ${skipReason}（已跳过，可继续接单）`, skipLevel);
        if (shouldNotifyTitleSkip(skipReason)) {
          notifyTitleNormalizeIssue(item, `${tag}：已跳过`, `${label}\n${skipReason}`);
        }
        continue;
      }

      log(
        `[${tag}] ${label}\n  当前：${(res.currentTitle || "").slice(0, 100)}\n  建议：${(res.expected || "").slice(0, 120)}${formatTitleStationSourceHint(res)}`,
        "info"
      );
      toApply.push({ item, expected: res.expected, currentTitle: res.currentTitle || "" });
    }

    markTicketsKnownForTitle(processed.length ? processed : newOnes);

    if (!toApply.length) {
      log(`[${tag}] 结束：无需修改标题。`, "success");
      await refreshTickets({ reset: false });
      return;
    }

    const ok = window.confirm(
      `[${tag}] 共 ${toApply.length} 条新工单建议改标题，是否在 TT 中逐条写入？\n（将自动点开标题、填入、失焦保存）`
    );
    if (!ok) {
      log(`[${tag}] 已取消写入标题。`, "warning");
      await refreshTickets({ reset: false });
      return;
    }

    for (let j = 0; j < toApply.length; j += 1) {
      const row = toApply[j];
      const opened2 = await handleTicketClick(row.item, { skipRefresh: true });
      if (!opened2) {
        log(`[${tag}] 标题写入跳过（未打开）：${(row.item.title || "").slice(0, 40)}`, "warning");
        notifyTitleNormalizeIssue(row.item, `${tag}：写入跳过`, "未能打开工单详情");
        continue;
      }
      await sleep(900);
      const applyRes = await ttExecuteJavaScript(buildApplyTitleScript(row.expected));
      if (!applyRes?.ok) {
        const extra =
          applyRes?.reason === "verify_mismatch"
            ? `（界面仍为「${String(applyRes.actual || "").slice(0, 80)}」）`
            : "";
        log(`[${tag}] 标题写入失败：${(row.item.title || "").slice(0, 40)} — ${applyRes?.reason || "unknown"}${extra}`, "error");
        notifyTitleNormalizeIssue(
          row.item,
          `${tag}：写入失败`,
          `${(row.item.title || "").slice(0, 40)}\n${applyRes?.reason || "unknown"}${extra}`
        );
      } else {
        log(`[${tag}] 标题已写入：${row.expected.slice(0, 100)}`, "success");
      }
      await sleep(400);
    }

    log(`[${tag}] 标题写入完成。`, "success");
    await refreshTickets({ reset: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[${tag}] 中断：${msg}`, "error");
    notifyTitleNormalizeIssue(null, `${tag}：中断`, msg);
    try {
      await refreshTickets({ reset: false });
    } catch {
      // ignore
    }
  } finally {
    titleNormalizeInProgress = false;
    if (D.ticketTitleOnNewBtn) D.ticketTitleOnNewBtn.disabled = !deps.getRunning();
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = deps.getRunning();
    queueMicrotask(() => {
      flushTitleOnNewQueueIfPossible().catch(() => {});
      deps.flushAutoPriorityBoostQueueIfPossible().catch(() => {});
    });
  }
}

function requestTitleOnNewAfterRefresh() {
  if (!deps.getRunning() || !deps.getTitleOnNewAutoEnabled()) return;
  if (titleNormalizeInProgress) {
    titleOnNewQueued = true;
    log("[来单改标题] 已排队：将在当前标题任务结束后执行。", "muted");
    return;
  }
  if (deps.getBusy() || deps.getBatchInProgress() || deps.getPendingRunAfterReload() || deps.getPriorityBatchInProgress() || deps.getPmPullInProgress()) {
    titleOnNewQueued = true;
    return;
  }
  const newOnes = detectNewTicketsForTitle(getTickets());
  if (!newOnes.length) return;
  queueMicrotask(() => {
    runNewTicketTitleNormalize({ triggeredBy: "来单改标题-自动" }).catch(() => {});
  });
}

async function flushTitleOnNewQueueIfPossible() {
  if (!titleOnNewQueued) return;
  if (!deps.getRunning() || !deps.getTitleOnNewAutoEnabled()) {
    titleOnNewQueued = false;
    return;
  }
  if (titleNormalizeInProgress || deps.getBusy() || deps.getBatchInProgress() || deps.getPendingRunAfterReload() || deps.getPriorityBatchInProgress() || deps.getPmPullInProgress()) {
    return;
  }
  titleOnNewQueued = false;
  const newOnes = detectNewTicketsForTitle(getTickets());
  if (!newOnes.length) return;
  await runNewTicketTitleNormalize({ triggeredBy: "来单改标题-自动" });
}

/**
 * 标题巡检：调用 titlePatrolList.js（仅列表标题粗检），与 titlePrefixEngine（标题检测）分离。
 * @param {{ forced?: boolean }} [opts] forced 为 true 时无视顶部「标题巡检」勾选（工单面板按钮手动跑一次）
 */
function runTicketTitlePatrolScan(opts) {
  const forced = !!(opts && opts.forced);
  if (!forced && !deps.getTitlePatrolLogEnabled()) return;

  const patrol = window.TTTitlePatrolList;
  if (!patrol || typeof patrol.patrolListTitles !== "function") {
    log("[标题巡检] 未加载 titlePatrolList.js。", "error");
    return;
  }

  const scoped = getMyTodoTicketsForTitleOps(getTickets());
  const list = sortTickets(scoped);
  if (!list.length) {
    log("[标题巡检] 当前处理人待处理工单为空，已跳过。", "muted");
    return;
  }

  const sum = patrol.patrolListTitles(list);
  const tag = forced ? "（手动）" : "";
  const detail =
    sum.badTotal > 0
      ? `；不规范 ${sum.badTotal} 条（${Object.entries(sum.badReasons)
          .map(([k, v]) => `${k} ${v}`)
          .join("，")}）`
      : "";
  const line = `[标题巡检]${tag} 仅列表标题：共 ${sum.total} 条，通过 ${sum.okCount} 条${detail}。`;
  log(line, sum.badTotal > 0 ? "warning" : "info");

  if (sum.badTotal > 0 && Array.isArray(sum.badItems) && sum.badItems.length) {
    const slice = sum.badItems.slice(0, C.TITLE_PATROL_LOG_BAD_MAX);
    for (const row of slice) {
      const idPart = row.id ? `#${row.id} ` : "";
      const titleShow = (row.title || "").slice(0, 80);
      log(`[标题巡检] 不规范 ${idPart}${titleShow}\n  原因：${row.reason}`, "warning");
    }
    const rest = sum.badItems.length - slice.length;
    if (rest > 0) {
      log(`[标题巡检] … 另有 ${rest} 条未列出（单次最多 ${C.TITLE_PATROL_LOG_BAD_MAX} 条）。`, "muted");
    }
  }
}

async function runTicketTitleNormalizeBatch() {
  if (!canRunTitleNormalizeOp({ allowWhileRunning: false })) return;

  titleNormalizeInProgress = true;
  if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = true;

  try {
    await ensureChinaCitiesLoaded();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`加载城市词典失败：${msg}`, "error");
    titleNormalizeInProgress = false;
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = false;
    return;
  }

  const scoped = getMyTodoTicketsForTitleOps(getTickets());
  const list = sortTickets(scoped);
  if (!list.length) {
    log("当前处理人无待处理工单，请先刷新工单列表。", "muted");
    titleNormalizeInProgress = false;
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = false;
    return;
  }

  setActiveLeftTab("logs");
  log(`开始检测工单标题（共 ${list.length} 条）…`, "info");

  /** @type {{ item: TicketItem, expected: string, currentTitle: string, reason?: string }[]} */
  const toApply = [];

  try {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const label = (item.title || item.id || String(i)).slice(0, 60);
      const inspected = await inspectTicketItemForTitle(item);
      if (!inspected.opened) {
        log(`[标题] 无法打开工单，跳过：${label}`, "warning");
        continue;
      }
      const res = inspected.res;
      if (res.skip) {
        const skipReason = res.reason || "跳过";
        // 需人工处理：用 error 样式标红警示（与 muted 跳过区分）
        const skipLevel =
          skipReason.includes("无法解析城市") || skipReason.includes("请手动改标题") ? "error" : "muted";
        log(`[标题] ${label} — ${skipReason}`, skipLevel);
      } else {
        log(
          `[标题] ${label}\n  当前：${(res.currentTitle || "").slice(0, 100)}\n  建议：${(res.expected || "").slice(0, 120)}${formatTitleStationSourceHint(res)}`,
          "info"
        );
        toApply.push({ item, expected: res.expected, currentTitle: res.currentTitle || "" });
      }
    }

    if (!toApply.length) {
      log("标题检测结束：没有需要修改的工单。", "success");
      await refreshTickets({ reset: false });
      return;
    }

    const ok = window.confirm(
      `检测完成：共 ${toApply.length} 条建议修改标题，是否在 TT 中逐条写入？\n（将自动点开标题、填入、失焦保存）`
    );
    if (!ok) {
      log("已取消写入标题。", "warning");
      await refreshTickets({ reset: false });
      return;
    }

    for (let j = 0; j < toApply.length; j += 1) {
      const row = toApply[j];
      const opened2 = await handleTicketClick(row.item, { skipRefresh: true });
      if (!opened2) {
        log(`标题写入跳过（未打开工单）：${(row.item.title || "").slice(0, 40)}`, "warning");
        continue;
      }
      await sleep(900);
      const applyRes = await ttExecuteJavaScript(buildApplyTitleScript(row.expected));
      if (!applyRes?.ok) {
        const extra =
          applyRes?.reason === "verify_mismatch"
            ? `（界面仍为「${String(applyRes.actual || "").slice(0, 80)}」，期望「${String(applyRes.expected || "").slice(0, 80)}」）`
            : "";
        log(`标题写入失败：${(row.item.title || "").slice(0, 40)} — ${applyRes?.reason || "unknown"}${extra}`, "error");
      } else {
        log(`标题已写入：${row.expected.slice(0, 100)}`, "success");
      }
      await sleep(400);
    }

    log("标题批量写入完成。", "success");
    await refreshTickets({ reset: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`标题检测中断：${msg}`, "error");
    try {
      await refreshTickets({ reset: false });
    } catch {
      // ignore
    }
  } finally {
    titleNormalizeInProgress = false;
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = false;
  }
}

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
