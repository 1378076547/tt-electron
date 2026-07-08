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
  let titleBaselineEstablished = false;

  /** 双通道·DOM：轮询 TT handleListNav 发现新单（间隔 ms） */
  const TT_HANDLE_LIST_WATCH_MS = 2000;
  /** @type {ReturnType<typeof setInterval> | null} */
  let handleListWatchTimer = null;
  let handleListWatchInFlight = false;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHandler: () => "",
    makeStableKey: () => "",
    getMyTodoTicketsForTitleOps: (list) => list,
    getMyPendingTicketsForTitleOnNew: (list) => list,
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
    flushAutoPriorityBoostQueueIfPossible: async () => {},
    isApiPrimaryMode: async () => false,
    waitForTicketInDom: async () => ({ found: false }),
    isTicketVisibleInDom: async () => ({ found: false }),
    requestTtWebviewReload: () => false,
    scanHandleListForTitleWatch: async () => ({ hasListWrapper: false, items: [] }),
    mapDomWatchItemToTicket: (row) => row,
    isTtDomSyncPending: () => false,
    isTicketItemInHandleList: async () => ({ found: false }),
    commitApiTicketIdBaseline: () => {},
    clearPendingDomSyncForTickets: () => {},
    requestAcceptAfterTitle: () => {}
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
  function getMyPendingTicketsForTitleOnNew(list) {
    return deps.getMyPendingTicketsForTitleOnNew(list);
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

        /** 发起人架构：中文含「事业部」；海外英文路径如 Keemart/Operation/…/Riyadh 002 Ghirnatah */
        function looksLikeOrgPathOnly(t) {
          const s = cleanPath(t);
          if (!s || s.length > 160) return false;
          if (!s.includes('公司/')) return false;
          if (/处理人|服务目录|一级目录|二级目录|三级目录|问题归档|转入ONES|4000帮助台|零售IT/i.test(s)) return false;
          if (s.includes('事业部')) return true;
          const parts = s.split('/').filter(Boolean);
          if (parts.length >= 5 && /[A-Za-z]/.test(parts[parts.length - 1])) return true;
          return false;
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
          let m = blob.match(
            /公司\\/[\\u4e00\\w\\/\\-]+?事业部\\/[\\u4e00\\w\\/\\-]+(?:\\/[\\u4e00\\w\\/\\-]+){2,12}/
          );
          if (m && m[0].length <= 160 && looksLikeOrgPathOnly(m[0])) return m[0];
          m = blob.match(/公司\\/[\\u4e00\\wA-Za-z\\/\\-]+(?:\\/[\\u4e00\\wA-Za-z\\/\\-]+){4,14}/);
          if (m && m[0].length <= 160 && looksLikeOrgPathOnly(m[0])) return m[0];
        }
        return '';
      }

      function readCustomFieldInput(item) {
        const input = item.querySelector('input.mtd-input, textarea.mtd-input');
        if (input && norm(input.value)) return norm(input.value);
        const text = item.querySelector('.mtd-form-item-content, .form-item-instruction');
        return norm(text?.textContent || '');
      }

      function isPlaceholderCustomValue(val) {
        const v = norm(val).toLowerCase();
        if (!v) return true;
        return /e\.g\.|example|store no\.|id\s*&\s*name|请填写|请输入/.test(v);
      }

      /** 英文工单自定义字段：City、Store、ID&Name（用户填写优先于架构） */
      function getEnglishCustomFields() {
        const container =
          document.querySelector('.ticket-custom-edit-container') || document.querySelector('.editor-content form.mtd-form');
        if (!container) return { englishCity: '', englishStore: '', englishIdName: '' };
        let englishCity = '';
        let englishStore = '';
        let englishIdName = '';
        const items = Array.from(container.querySelectorAll('.mtd-form-item'));
        for (const item of items) {
          const label = norm(item.querySelector('.mtd-form-item-label')?.textContent || '');
          const val = readCustomFieldInput(item);
          if (!val || isPlaceholderCustomValue(val)) continue;
          if (/^city$/i.test(label) || label === '城市') englishCity = val;
          else if (/^store$/i.test(label) || label === '门店' || label === '站点') englishStore = val;
          else if (/id\s*&\s*name/i.test(label) || /编号.*名称|门店编号/.test(label)) englishIdName = val;
        }
        return { englishCity, englishStore, englishIdName };
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

      const englishCustom = getEnglishCustomFields();
      return {
        architectureRaw: getArchitecturePathText(),
        warehouseStore: getWarehouseStoreValue(),
        currentTitle: getCurrentTitleFromDetail(),
        englishCity: englishCustom.englishCity,
        englishStore: englishCustom.englishStore,
        englishIdName: englishCustom.englishIdName
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
        const selectors = [
          '.ticket-edit-title .ticket-name-text-display',
          '.ticket-detail-header .ticket-name-text-display',
          '.ticket-name-text-display'
        ];
        for (const sel of selectors) {
          const n = d.querySelector(sel);
          if (n && norm(n.textContent)) return norm(n.textContent);
        }
        const editor = findTitleEditorStrict(detail);
        if (editor && editor.value) return norm(editor.value);
        return '';
      }

      async function commitTitleEdit(editor, detail) {
        try {
          editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
          editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
        } catch {
          // ignore
        }
        await sleep(120);

        editor.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        editor.blur();
        await sleep(200);

        const titleRoot = detail?.querySelector('.ticket-edit-title') || document.querySelector('.ticket-edit-title');
        if (titleRoot) {
          const confirmBtn = titleRoot.querySelector(
            '.mtdicon-check, .mtdicon-success-o, [class*="confirm"], button.mtd-btn-primary, button.mtd-btn'
          );
          if (confirmBtn && visible(confirmBtn) && norm(confirmBtn.textContent || '').length <= 4) {
            confirmBtn.click();
            await sleep(200);
          }
        }

        const neutral =
          detail?.querySelector('.ticket-custom-edit-container') ||
          detail?.querySelector('.main-content') ||
          detail?.querySelector('.mtd-form') ||
          detail;
        if (neutral && neutral !== editor) {
          neutral.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          neutral.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          if (typeof neutral.click === 'function') neutral.click();
        }
        await sleep(300);
      }

      const newTitle = ${safe};
      const detail = document.querySelector('#ticket-detail') || document.querySelector('.ticket-detail-container') || document.querySelector('.detail-with-list-container');
      if (!detail) return { ok: false, reason: 'no_detail' };

      const beforeTitle = readDisplayedTitle(detail);
      if (beforeTitle === norm(newTitle)) return { ok: true, reason: 'already_set' };

      const display =
        detail.querySelector('.ticket-edit-title .ticket-name-text-display') ||
        detail.querySelector('.ticket-name-text-display');

      let editor = findTitleEditorStrict(detail);
      if (!editor && display && visible(display)) {
        display.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        display.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        display.click();
        await sleep(300);
      } else if (!editor && display) {
        const field = display.closest('.tt-hover-field');
        if (field) {
          field.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await sleep(300);
        }
      }

      for (let i = 0; i < 28 && !editor; i += 1) {
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

      await commitTitleEdit(editor, detail);

      for (let i = 0; i < 24; i += 1) {
        const after = readDisplayedTitle(detail);
        if (after === norm(newTitle)) return { ok: true };
        await sleep(220);
      }

      const finalActual = readDisplayedTitle(detail);
      return { ok: false, reason: 'verify_mismatch', expected: norm(newTitle), actual: finalActual };
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
  const langHint = res.titleLang === "en" ? "\n  类型：英文标题（城市+编号+站点前缀）" : "";
  if (res.locationSource === "custom") return `${langHint}\n  前缀来源：自定义字段 City/Store`;
  if (res.locationSource === "arch") return `${langHint}\n  前缀来源：发起人架构末级`;
  if (res.stationCombineNote) return `${langHint}\n  站/仓/店：${String(res.stationCombineNote).slice(0, 80)}`;
  if (res.stationSource === "warehouse+arch") {
    return `${langHint}\n  站/仓/店：字段+架构${res.archLocSeg ? `（架构段「${String(res.archLocSeg).slice(0, 20)}」）` : ""}`;
  }
  if (res.archLocSeg && res.stationSource === "arch") {
    return `${langHint}\n  站/仓/店：架构「${String(res.archLocSeg).slice(0, 36)}」`;
  }
  if (res.stationSource === "warehouse") return `${langHint}\n  站/仓/店：仓库/门店字段`;
  if (res.stationSource === "path") return `${langHint}\n  站/仓/店：架构末级`;
  return langHint;
}

function ticketKeyForTitle(item) {
  return String(item?.id || "").trim() || makeStableKey(item);
}

function resetTitleNewTicketBaseline() {
  knownTicketKeysForTitle = new Set();
  for (const t of getMyPendingTicketsForTitleOnNew(getTickets())) {
    const k = ticketKeyForTitle(t);
    if (k) knownTicketKeysForTitle.add(k);
  }
  titleBaselineEstablished = true;
}

/** 应用启动后首次检测前建立基线，避免把已有工单当成新单 */
function ensureTitleBaselineIfNeeded() {
  if (!deps.getTitleOnNewAutoEnabled() || titleBaselineEstablished) return;
  resetTitleNewTicketBaseline();
}

function clearTitleOnNewBaseline() {
  knownTicketKeysForTitle = new Set();
  titleBaselineEstablished = false;
}

/** @param {TicketItem[]} list */
function detectNewTicketsForTitle(list, opts = {}) {
  const scoped = opts.fromDomList
    ? (Array.isArray(list) ? list : []).filter((t) => isPendingTicketStatus(t?.statusText))
    : getMyPendingTicketsForTitleOnNew(list);
  return scoped.filter((t) => {
    const k = ticketKeyForTitle(t);
    return k && !knownTicketKeysForTitle.has(k);
  });
}

function isPendingTicketStatus(statusText) {
  const st = String(statusText || "").trim();
  if (!st) return true;
  const up = st.toUpperCase();
  if (st.includes("未处理") || st.includes("待处理")) return true;
  if (st.includes("暂停") || st.includes("处理中") || st.includes("已关闭") || st.includes("关闭")) return false;
  if (up === "TODO" || up === "PENDING" || up === "OPEN" || up === "NEW") return true;
  return false;
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

function parseEnglishCustomFromDesc(desc) {
  const text = normalizeDescToText(desc);
  if (!text) return { englishCity: "", englishStore: "", englishIdName: "" };
  function pick(re) {
    const m = text.match(re);
    return m ? String(m[1] || "").trim() : "";
  }
  return {
    englishCity: pick(/(?:^|\n)\s*City\s*[:：]\s*([^\n]+)/i),
    englishStore: pick(/(?:^|\n)\s*Store\s*[:：]\s*([^\n]+)/i),
    englishIdName: pick(/(?:^|\n)\s*ID\s*&\s*Name\s*[:：]\s*([^\n]+)/i)
  };
}

function pickEnglishCustomFromApiPayload(t) {
  const out = { englishCity: "", englishStore: "", englishIdName: "" };
  const lists = [t?.customFields, t?.customFieldList, t?.formFields, t?.fields].filter(Array.isArray);
  for (const list of lists) {
    for (const row of list) {
      const label = String(row?.label || row?.name || row?.fieldName || row?.key || "").trim();
      const val = String(row?.value || row?.fieldValue || row?.content || "").trim();
      if (!label || !val) continue;
      if (/^city$/i.test(label)) out.englishCity = val;
      else if (/^store$/i.test(label)) out.englishStore = val;
      else if (/id\s*&\s*name/i.test(label)) out.englishIdName = val;
    }
  }
  const fromDesc = parseEnglishCustomFromDesc(t?.desc || t?.description || "");
  if (!out.englishCity && fromDesc.englishCity) out.englishCity = fromDesc.englishCity;
  if (!out.englishStore && fromDesc.englishStore) out.englishStore = fromDesc.englishStore;
  if (!out.englishIdName && fromDesc.englishIdName) out.englishIdName = fromDesc.englishIdName;
  return out;
}

function buildInspectFromApiTicket(ticketData) {
  const t = ticketData || {};
  const architectureRaw = String(t.org || t.reporterOrg || "").trim();
  const warehouseStore = parseWarehouseFromDesc(t.desc || t.description || "");
  const currentTitle = String(t.name || t.title || t.ticketName || "").trim();
  const englishCustom = pickEnglishCustomFromApiPayload(t);
  return { architectureRaw, warehouseStore, currentTitle, ...englishCustom };
}

function mergeInspectPreferApi(domInspect, apiInspect) {
  const d = domInspect || {};
  const a = apiInspect || {};
  const pickCustom = (key) => String(d[key] || a[key] || "").trim();
  return {
    architectureRaw: String(d.architectureRaw || a.architectureRaw || "").trim(),
    warehouseStore: String(a.warehouseStore || d.warehouseStore || "").trim(),
    currentTitle: String(a.currentTitle || d.currentTitle || "").trim(),
    englishCity: pickCustom("englishCity"),
    englishStore: pickCustom("englishStore"),
    englishIdName: pickCustom("englishIdName")
  };
}

async function openHandleListTicketForTitle(item, opts = {}) {
  const attempts = Number.isFinite(opts.attempts) ? opts.attempts : 3;
  const clickOpts = { skipRefresh: true, requirePending: true };
  for (let i = 0; i < attempts; i += 1) {
    if (await handleTicketClick(item, clickOpts)) return true;
    const inList = await deps.isTicketItemInHandleList?.(item);
    if (inList?.found && inList.row) {
      const rowTicket = deps.mapDomWatchItemToTicket(inList.row);
      if (await handleTicketClick(rowTicket, clickOpts)) return true;
    }
    if (i < attempts - 1) await sleep(400);
  }
  return false;
}

function titlesLooseMatchItem(a, b) {
  const titleA = String(a?.title || "").trim().replace(/\s+/g, "");
  const titleB = String(b?.title || "").trim().replace(/\s+/g, "");
  if (!titleA || !titleB) return false;
  return titleA === titleB || titleA.includes(titleB) || titleB.includes(titleA);
}

function mergeTicketForDomOpen(apiItem, domItem) {
  const api = apiItem || {};
  const dom = domItem || {};
  const id = String(api.id || dom.id || "").trim() || null;
  return {
    ...dom,
    ...api,
    id,
    title: String(api.title || dom.title || "").trim(),
    handler: String(api.handler || dom.handler || "").trim(),
    statusText: String(api.statusText || dom.statusText || "").trim(),
    fingerprint: api.fingerprint || dom.fingerprint
  };
}

/** 轮询 handleListNav，等列表渲染并匹配到目标行 */
async function waitForHandleListRowForTitle(item, maxWaitMs = 8000) {
  const end = Date.now() + maxWaitMs;
  while (Date.now() < end) {
    if (!deps.getWebviewReady() || !deps.getTtWebview()) {
      await sleep(250);
      continue;
    }
    const inList = await deps.isTicketItemInHandleList?.(item);
    if (inList?.found) {
      const rowTicket = inList.row ? deps.mapDomWatchItemToTicket(inList.row) : item;
      return { found: true, ticket: mergeTicketForDomOpen(item, rowTicket) };
    }
    const snap = await deps.scanHandleListForTitleWatch?.();
    if (snap?.hasListWrapper && (snap.items || []).length > 0) {
      const domRows = (snap.items || []).map((row) => deps.mapDomWatchItemToTicket(row));
      const matched = domRows.find((d) => {
        const idA = String(item?.id || "").trim();
        const idB = String(d?.id || "").trim();
        if (idA && idB && idA === idB) return true;
        return titlesLooseMatchItem(item, d);
      });
      if (matched) {
        return { found: true, ticket: mergeTicketForDomOpen(item, matched) };
      }
    }
    await sleep(300);
  }
  return { found: false, ticket: null };
}

async function inspectTicketItemForTitle(item) {
  const opened = await openHandleListTicketForTitle(item);
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

/**
 * 工单是否已在 TT 列表中；已在列表则可直接点击，无需长时间等待同步。
 * @returns {Promise<{ ready: boolean, reason?: string }>}
 */
async function ensureTicketDomReadyForTitle(item, tag, opts = {}) {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    return { ready: false, reason: "webview_not_ready" };
  }

  const label = (item?.title || item?.id || "工单").slice(0, 50);
  const waitMs = opts.alreadyInList ? 5000 : 10000;
  const rowHit = await waitForHandleListRowForTitle(item, waitMs);
  if (!rowHit.found) {
    log(`工单「${label}」未在列表中找到，将自动重试。`, "warning");
    return { ready: false, reason: "not_in_list" };
  }

  const opened = await openHandleListTicketForTitle(rowHit.ticket || item, { attempts: 5 });
  if (opened) return { ready: true };

  log(`工单「${label}」在列表中但未能选中，将自动重试。`, "warning");
  return { ready: false, reason: "open_failed" };
}

async function applyExpectedTitleOnOpenTicket(tag, item, expected) {
  await sleep(400);
  const applyRes = await ttExecuteJavaScript(buildApplyTitleScript(expected));
  const label = (item.title || item.id || "").slice(0, 40);
  if (!applyRes?.ok) {
    const extra =
      applyRes?.reason === "verify_mismatch"
        ? `（界面仍为「${String(applyRes.actual || "").slice(0, 80)}」）`
        : "";
    log(`标题修改失败：「${label}」。`, "error");
    notifyTitleNormalizeIssue(
      item,
      `${tag}：修改失败`,
      label
    );
    return applyRes;
  }
  if (applyRes?.reason === "already_set") {
    log("标题已规范，无需修改。", "muted");
  } else {
    log(`标题已修改为：${expected.slice(0, 100)}`, "success");
  }
  await sleep(400);
  return applyRes;
}

function canRunTitleNormalizeOp({ allowWhileRunning = false } = {}) {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    log("工单页面加载中，请稍候…", "warning");
    return false;
  }
  if (titleNormalizeInProgress) return false;
  if (deps.getPriorityBatchInProgress()) {
    log("请等待优先级设置完成后再改标题。", "warning");
    return false;
  }
  if (deps.getPmPullInProgress()) {
    log("请等待拉人完成后再改标题。", "warning");
    return false;
  }
  if (!allowWhileRunning && deps.getRunning()) {
    log("请先停止自动接单，再执行标题检测。", "warning");
    return false;
  }
  if (!window.TTTitlePrefix || typeof window.TTTitlePrefix.computeExpectedTitle !== "function") {
    log("标题检测功能异常，请重启程序。", "error");
    return false;
  }
  return true;
}

function canRunNewTicketTitleNormalize() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    log("工单页面加载中，请稍候…", "warning");
    return false;
  }
  if (!deps.getTitleOnNewAutoEnabled()) {
    log("请先开启「来单改标题」。", "warning");
    return false;
  }
  if (titleNormalizeInProgress) return false;
  if (deps.getPriorityBatchInProgress()) {
    log("请等待优先级设置完成后再改标题。", "warning");
    return false;
  }
  if (deps.getPmPullInProgress()) {
    log("请等待拉人完成后再改标题。", "warning");
    return false;
  }
  if (deps.getRunning() && deps.getBusy()) return false;
  if (!window.TTTitlePrefix || typeof window.TTTitlePrefix.computeExpectedTitle !== "function") {
    log("标题检测功能异常，请重启程序。", "error");
    return false;
  }
  return true;
}

function syncTitleOnNewButtonState() {
  if (!D.ticketTitleOnNewBtn) return;
  D.ticketTitleOnNewBtn.disabled = !deps.getTitleOnNewAutoEnabled() || titleNormalizeInProgress;
}

/**
 * 来单改标题：相对基线的新未处理单（含转单）；检测通过后自动写入。可不与「开始」同开。
 * @param {{ triggeredBy?: string }} [opts]
 */
async function runNewTicketTitleNormalize(opts = {}) {
  const tag = String(opts.triggeredBy || "来单改标题").trim();
  const emptyResult = { applied: 0, deferred: 0, pendingNew: 0 };
  if (!canRunNewTicketTitleNormalize()) return emptyResult;

  titleNormalizeInProgress = true;
  syncTitleOnNewButtonState();
  if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = true;

  try {
    await ensureChinaCitiesLoaded();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("地址数据加载失败，标题检测可能不准确。", "error");
    notifyTitleNormalizeIssue(null, `${tag}：词典加载失败`, msg);
    titleNormalizeInProgress = false;
    syncTitleOnNewButtonState();
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = deps.getRunning();
    return emptyResult;
  }

  ensureTitleBaselineIfNeeded();
  const presetNewOnes = Array.isArray(opts.newOnes) ? opts.newOnes.filter(Boolean) : null;
  const newOnes = presetNewOnes
    ? sortTickets(presetNewOnes)
    : sortTickets(detectNewTicketsForTitle(getTickets()));
  if (!newOnes.length) {
    log("没有新工单。", "muted");
    titleNormalizeInProgress = false;
    syncTitleOnNewButtonState();
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = deps.getRunning();
    return emptyResult;
  }

  setActiveLeftTab("logs");
  log(`发现 ${newOnes.length} 条新工单，正在检测标题…`, "info");

  const processed = [];
  let appliedCount = 0;
  let deferredDomCount = 0;
  let result = { applied: 0, deferred: 0, pendingNew: newOnes.length };

  try {
    for (let i = 0; i < newOnes.length; i += 1) {
      const item = newOnes[i];
      const label = (item.title || item.id || String(i)).slice(0, 60);

      const domReady = await ensureTicketDomReadyForTitle(item, tag, {
        alreadyInList: !!opts.fromListWatch
      });
      if (!domReady.ready) {
        deferredDomCount += 1;
        continue;
      }

      const inspected = await inspectTicketItemForTitle(item);
      processed.push(item);

      if (!inspected.opened) {
        log(`无法打开「${label}」，已跳过。`, "warning");
        notifyTitleNormalizeIssue(item, `${tag}：无法打开`, label);
        continue;
      }

      const res = inspected.res;
      if (res.skip) {
        const skipReason = res.reason || "跳过";
        const skipLevel =
          skipReason.includes("无法解析城市") || skipReason.includes("请手动改标题") ? "error" : "muted";
        log(`「${label}」${skipReason}，已跳过。`, skipLevel);
        if (shouldNotifyTitleSkip(skipReason)) {
          notifyTitleNormalizeIssue(item, `${tag}：已跳过`, `${label}\n${skipReason}`);
        }
        continue;
      }

      // title change preview — no per-ticket user log

      const applyRes = await applyExpectedTitleOnOpenTicket(tag, item, res.expected);
      if (applyRes?.ok) appliedCount += 1;
    }

    markTicketsKnownForTitle(processed);
    if (processed.length) {
      deps.commitApiTicketIdBaseline?.(processed);
      deps.clearPendingDomSyncForTickets?.(processed);
    }

    if (deferredDomCount > 0) {
      titleOnNewQueued = true;
    }

    if (!appliedCount && !processed.length) {
      if (deferredDomCount > 0) {
        log(`${deferredDomCount} 条新工单等待列表就绪，将自动重试。`, "info");
      } else {
        log("标题检测完成，无需修改。", "success");
      }
      await refreshTickets({ reset: false });
      result = { applied: appliedCount, deferred: deferredDomCount, pendingNew: deferredDomCount };
      return result;
    }

    if (!appliedCount) {
      log("标题检测完成，无需修改。", "success");
      await refreshTickets({ reset: false });
      result = { applied: 0, deferred: deferredDomCount, pendingNew: deferredDomCount };
      return result;
    }

    log(`已修改 ${appliedCount} 条工单标题。`, "success");
    await refreshTickets({ reset: false });
    result = { applied: appliedCount, deferred: deferredDomCount, pendingNew: 0 };
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("标题修改中断，请稍后重试。", "error");
    notifyTitleNormalizeIssue(null, `${tag}：中断`, msg);
    try {
      await refreshTickets({ reset: false });
    } catch {
      // ignore
    }
    result = { applied: appliedCount, deferred: deferredDomCount, pendingNew: deferredDomCount || newOnes.length };
  } finally {
    titleNormalizeInProgress = false;
    syncTitleOnNewButtonState();
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = deps.getRunning();
    if (result.applied > 0 && deps.getRunning?.()) {
      queueMicrotask(() => {
        deps.requestAcceptAfterTitle?.();
      });
    }
    queueMicrotask(() => {
      flushTitleOnNewQueueIfPossible().catch(() => {});
      deps.flushAutoPriorityBoostQueueIfPossible().catch(() => {});
    });
  }
  return result;
}

/**
 * 与「开始」同开时：接单前先处理相对基线的新工单标题。
 * @param {{ tryRefresh?: boolean }} [opts] 本地无新单时是否先刷新列表（批量首单建议 true）
 */
async function ensureNewTicketTitlesBeforeAccept(opts = {}) {
  if (!deps.getRunning() || !deps.getTitleOnNewAutoEnabled()) return true;
  if (titleNormalizeInProgress) return false;

  ensureTitleBaselineIfNeeded();
  let newOnes = detectNewTicketsForTitle(getTickets());
  const tryRefresh = opts.tryRefresh !== false;
  if (!newOnes.length && tryRefresh) {
    await refreshTickets({ reset: false });
    newOnes = detectNewTicketsForTitle(getTickets());
  }
  if (!newOnes.length) return true;
  const res = await runNewTicketTitleNormalize({ triggeredBy: "来单改标题-接单前" });
  if (res.deferred > 0 || (res.pendingNew > 0 && res.applied === 0)) {
    titleOnNewQueued = true;
    return false;
  }
  return true;
}

/** 列表刷新后发现新单时自动改标题（仅开改标题，或与接单并行时的提前路径） */
function requestTitleOnNewAfterRefresh() {
  if (!deps.getTitleOnNewAutoEnabled()) return;
  if (titleNormalizeInProgress) {
    titleOnNewQueued = true;
    return;
  }
  if (deps.getRunning() && (deps.getBusy() || deps.getPendingRunAfterReload())) {
    return;
  }
  if (deps.getPriorityBatchInProgress() || deps.getPmPullInProgress()) {
    return;
  }
  ensureTitleBaselineIfNeeded();
  const newOnes = detectNewTicketsForTitle(getTickets());
  if (!newOnes.length) return;
  queueMicrotask(() => {
    runNewTicketTitleNormalize({ triggeredBy: "来单改标题-自动" }).catch(() => {});
  });
}

/** 双通道·DOM：扫描 handleListNav，发现本人未处理新单即改标题（无需等接口刷新） */
async function tickHandleListWatch() {
  if (!deps.getTitleOnNewAutoEnabled()) return;
  if (!deps.getWebviewReady() || !deps.getTtWebview()) return;
  if (titleNormalizeInProgress) return;
  if (deps.getPriorityBatchInProgress() || deps.getPmPullInProgress()) return;
  if (deps.isTtDomSyncPending()) return;
  if (handleListWatchInFlight) return;

  handleListWatchInFlight = true;
  try {
    const snap = await deps.scanHandleListForTitleWatch();
    if (!snap?.hasListWrapper) return;

    ensureTitleBaselineIfNeeded();
    const rows = (snap.items || []).map((row) => deps.mapDomWatchItemToTicket(row));
    const newOnes = sortTickets(detectNewTicketsForTitle(rows, { fromDomList: true }));
    if (!newOnes.length) return;

    if (deps.getRunning() && (deps.getBusy() || deps.getPendingRunAfterReload())) return;

    setActiveLeftTab("logs");
    log("列表中发现新工单，正在改标题…", "info");
    for (const row of newOnes) {
      if (!row?.isActive) {
        await openHandleListTicketForTitle(row);
      }
    }
    await runNewTicketTitleNormalize({ triggeredBy: "来单改标题-列表", newOnes, fromListWatch: true });
  } finally {
    handleListWatchInFlight = false;
  }
}

function startHandleListWatch() {
  stopHandleListWatch();
  if (!deps.getTitleOnNewAutoEnabled()) return;
  void tickHandleListWatch();
  handleListWatchTimer = setInterval(() => {
    void tickHandleListWatch();
  }, TT_HANDLE_LIST_WATCH_MS);
}

function stopHandleListWatch() {
  if (handleListWatchTimer) {
    clearInterval(handleListWatchTimer);
    handleListWatchTimer = null;
  }
  handleListWatchInFlight = false;
}

async function flushTitleOnNewQueueIfPossible() {
  if (!titleOnNewQueued) return;
  if (!deps.getTitleOnNewAutoEnabled()) {
    titleOnNewQueued = false;
    return;
  }
  if (titleNormalizeInProgress || deps.getBusy() || deps.getPendingRunAfterReload() || deps.getPriorityBatchInProgress() || deps.getPmPullInProgress()) {
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
    log("标题巡检功能异常，请重启程序。", "error");
    return;
  }

  const scoped = getMyTodoTicketsForTitleOps(getTickets());
  const list = sortTickets(scoped);
  if (!list.length) {
    log("没有待处理工单，巡检已跳过。", "muted");
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
  const line = `标题巡检${tag}：共 ${sum.total} 条，规范 ${sum.okCount} 条${detail}。`;
  log(line, sum.badTotal > 0 ? "warning" : "info");

  if (sum.badTotal > 0 && Array.isArray(sum.badItems) && sum.badItems.length) {
    const slice = sum.badItems.slice(0, C.TITLE_PATROL_LOG_BAD_MAX);
    for (const row of slice) {
      const idPart = row.id ? `#${row.id} ` : "";
      const titleShow = (row.title || "").slice(0, 80);
      log(`「${titleShow}」标题不规范：${row.reason}`, "warning");
    }
    const rest = sum.badItems.length - slice.length;
    if (rest > 0) {
      log(`… 另有 ${rest} 条未列出。`, "muted");
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
    log("地址数据加载失败，请稍后重试。", "error");
    titleNormalizeInProgress = false;
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = false;
    return;
  }

  const scoped = getMyTodoTicketsForTitleOps(getTickets());
  const list = sortTickets(scoped);
  if (!list.length) {
    log("当前没有待处理工单。", "muted");
    titleNormalizeInProgress = false;
    if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = false;
    return;
  }

  setActiveLeftTab("logs");
  log(`正在检测 ${list.length} 条工单标题…`, "info");

  /** @type {{ item: TicketItem, expected: string, currentTitle: string, reason?: string }[]} */
  const toApply = [];

  try {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const label = (item.title || item.id || String(i)).slice(0, 60);
      const inspected = await inspectTicketItemForTitle(item);
      if (!inspected.opened) {
        log(`无法打开「${label}」，已跳过。`, "warning");
        continue;
      }
      const res = inspected.res;
      if (res.skip) {
        const skipReason = res.reason || "跳过";
        // 需人工处理：用 error 样式标红警示（与 muted 跳过区分）
        const skipLevel =
          skipReason.includes("无法解析城市") || skipReason.includes("请手动改标题") ? "error" : "muted";
        log(`「${label}」${skipReason}`, skipLevel);
      } else {
        toApply.push({ item, expected: res.expected, currentTitle: res.currentTitle || "" });
      }
    }

    if (!toApply.length) {
      log("标题检测完成，全部规范。", "success");
      await refreshTickets({ reset: false });
      return;
    }

    const ok = window.confirm(
      `检测完成：共 ${toApply.length} 条工单标题建议修改，是否立即修改？`
    );
    if (!ok) {
      log("已取消标题修改。", "warning");
      await refreshTickets({ reset: false });
      return;
    }

    for (let j = 0; j < toApply.length; j += 1) {
      const row = toApply[j];
      const opened2 = await openHandleListTicketForTitle(row.item);
      if (!opened2) {
        log(`无法打开工单，已跳过：${(row.item.title || "").slice(0, 40)}`, "warning");
        continue;
      }
      await applyExpectedTitleOnOpenTicket("标题", row.item, row.expected);
    }

    log("标题修改完成。", "success");
    await refreshTickets({ reset: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("标题检测中断，请稍后重试。", "error");
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
    clearTitleOnNewBaseline,
    resetTitleNewTicketBaseline,
    ensureTitleBaselineIfNeeded,
    syncTitleOnNewButtonState,
    buildTitleNormalizeInspectScript,
    buildApplyTitleScript,
    ensureNewTicketTitlesBeforeAccept,
    requestTitleOnNewAfterRefresh,
    flushTitleOnNewQueueIfPossible,
    runTicketTitlePatrolScan,
    runNewTicketTitleNormalize,
    runTicketTitleNormalizeBatch,
    startHandleListWatch,
    stopHandleListWatch
  };
})(window.TTDesktop);
