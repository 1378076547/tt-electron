/**
 * 内置浏览器增强：左侧收起、多标签、收藏夹书签、自定义网址、紧凑地址栏
 * 主标签锁死接单；自动化只绑主标签
 */
(function initBrowserShell(TD) {
  const C = TD.constants;
  const log = (...args) => {
    try {
      TD.log?.log?.(...args);
    } catch {
      // ignore
    }
  };

  const PRIMARY_ID = "primary";
  const MAX_TABS = Number(C.TT_TAB_MAX) > 0 ? Number(C.TT_TAB_MAX) : 20;
  const DEFAULT_SRC = C.TT_WEBVIEW_DEFAULT_SRC;
  const PARTITION = C.TT_WEBVIEW_PARTITION;
  const STORAGE_BM = C.STORAGE_KEYS.ttBookmarksV2 || "tt_browser_bookmarks_v2";
  const STORAGE_BM_LEGACY = C.STORAGE_KEYS.ttBookmarks || "tt_browser_bookmarks_v1";

  /** @type {{ id: string, title: string, url: string, primary: boolean, webview: HTMLElement|null }[]} */
  let tabs = [];
  let activeTabId = PRIMARY_ID;
  let tabSeq = 1;
  let leftCollapsed = false;
  /** @type {"new_tab"|"current_tab"} */
  let bookmarkOpenMode = C.TT_BOOKMARK_OPEN_NEW_TAB;
  /** @type {{ id: string, name: string, order: number }[]} */
  let folders = [];
  /** @type {{ id: string, folderId: string, title: string, url: string }[]} */
  let bookmarks = [];
  let activeFolderId = "f_biz";

  /** @type {null | ((wv: HTMLElement, opts: { primary: boolean }) => void)} */
  let onWebviewCreated = null;
  /** @type {null | (() => void)} */
  let onActiveTabChange = null;

  function $(id) {
    return document.getElementById(id);
  }

  function getPrimaryWebview() {
    const t = tabs.find((x) => x.primary);
    return t?.webview || TD.dom.ttWebview || null;
  }

  function getActiveWebview() {
    const t = tabs.find((x) => x.id === activeTabId);
    return t?.webview || getPrimaryWebview();
  }

  function getActiveTab() {
    return tabs.find((x) => x.id === activeTabId) || tabs.find((x) => x.primary) || null;
  }

  function syncDomPrimaryRef() {
    const primary = getPrimaryWebview();
    if (primary && TD.dom) TD.dom.ttWebview = primary;
  }

  function isAllowedNavigateUrl(raw) {
    let u;
    try {
      u = new URL(String(raw || "").trim());
    } catch {
      return { ok: false, message: "网址格式无效" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, message: "仅支持 http/https 网址" };
    }
    return { ok: true, url: u.toString() };
  }

  /** 方案 L：自动化前切到接单面；浏览标签 id 暂存以便结束后恢复 */
  let browseTabBeforeOps = null;

  function isOpsTabActive() {
    const t = tabs.find((x) => x.id === activeTabId);
    return !!(t && t.primary);
  }

  /**
   * 接单 / 发话术 / 拉 PM 等操作前确保接单 TT 在前台（可聚焦）。
   * @returns {{ switched: boolean, previousId: string|null }}
   */
  function ensureOpsSurface() {
    const primary = tabs.find((x) => x.primary);
    if (!primary?.webview) return { switched: false, previousId: null };
    if (primary.id === activeTabId) {
      return { switched: false, previousId: browseTabBeforeOps };
    }
    if (!browseTabBeforeOps) browseTabBeforeOps = activeTabId;
    activateTab(primary.id);
    try {
      primary.webview.focus?.();
    } catch {
      // ignore
    }
    return { switched: true, previousId: browseTabBeforeOps };
  }

  /** 自动化结束后若曾从浏览标签切走，则恢复 */
  function restoreBrowseSurfaceIfNeeded() {
    const prev = browseTabBeforeOps;
    browseTabBeforeOps = null;
    if (!prev) return false;
    if (!tabs.some((t) => t.id === prev)) return false;
    activateTab(prev);
    return true;
  }

  function clearOpsSurfaceResume() {
    browseTabBeforeOps = null;
  }

  function normalizeInputUrl(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    return s;
  }

  function loadLeftCollapsed() {
    try {
      leftCollapsed = localStorage.getItem(C.STORAGE_KEYS.leftPanelCollapsed) === "1";
    } catch {
      leftCollapsed = false;
    }
  }

  function saveLeftCollapsed() {
    try {
      localStorage.setItem(C.STORAGE_KEYS.leftPanelCollapsed, leftCollapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }

  function applyLeftCollapsed() {
    const layout = $("mainLayout") || document.querySelector(".main-layout");
    const rail = $("leftPanelRail");
    if (!layout) return;
    layout.classList.toggle("left-collapsed", leftCollapsed);
    if (rail) rail.hidden = !leftCollapsed;
  }

  function setLeftCollapsed(next) {
    leftCollapsed = !!next;
    saveLeftCollapsed();
    applyLeftCollapsed();
  }

  function toggleLeftCollapsed() {
    setLeftCollapsed(!leftCollapsed);
  }

  function loadBookmarkOpenMode() {
    try {
      const v = localStorage.getItem(C.STORAGE_KEYS.ttBookmarkOpenMode);
      bookmarkOpenMode =
        v === C.TT_BOOKMARK_OPEN_CURRENT ? C.TT_BOOKMARK_OPEN_CURRENT : C.TT_BOOKMARK_OPEN_NEW_TAB;
    } catch {
      bookmarkOpenMode = C.TT_BOOKMARK_OPEN_NEW_TAB;
    }
  }

  function saveBookmarkOpenMode() {
    try {
      localStorage.setItem(C.STORAGE_KEYS.ttBookmarkOpenMode, bookmarkOpenMode);
    } catch {
      // ignore
    }
  }

  function getDefaultFolders() {
    return [
      { id: "f_biz", name: "业务", order: 1 },
      { id: "f_device", name: "设备", order: 2 },
      { id: "f_sop", name: "SOP", order: 3 },
      { id: "f_doc", name: "文档", order: 4 }
    ];
  }

  function getDefaultBookmarksV2() {
    return [
      { id: "bm_handle", folderId: "f_biz", title: "处理 TT", url: DEFAULT_SRC },
      { id: "bm_query", folderId: "f_biz", title: "查询 TT", url: "https://tt.sankuai.com/ticket/list" },
      {
        id: "bm_beidou",
        folderId: "f_biz",
        title: "北斗看板",
        url: "https://beidou.sankuai.com/#/yxmonitor/graphQuery"
      },
      {
        id: "bm_maiot",
        folderId: "f_device",
        title: "设备状态日志",
        url: "https://maiot.meituan.com/sysManage/biz/detail?deviceId=08a1891384d4&tab=statusLog"
      },
      {
        id: "bm_km_iot",
        folderId: "f_sop",
        title: "IoT 技术支持人员表",
        url: "https://km.sankuai.com/collabpage/1276386991#id-3.IoT%E6%8A%80%E6%9C%AF%E6%94%AF%E6%8C%81%E4%BA%BA%E5%91%98%E8%A1%A8"
      }
    ];
  }

  function persistBookmarksStore() {
    try {
      localStorage.setItem(
        STORAGE_BM,
        JSON.stringify({
          version: 2,
          defaultsMerged: true,
          folders,
          bookmarks
        })
      );
    } catch {
      // ignore
    }
  }

  function loadBookmarksStore() {
    folders = getDefaultFolders();
    bookmarks = [];
    try {
      const rawV2 = localStorage.getItem(STORAGE_BM);
      if (rawV2) {
        const parsed = JSON.parse(rawV2);
        if (Array.isArray(parsed?.folders) && parsed.folders.length) {
          folders = parsed.folders
            .map((f, i) => ({
              id: String(f?.id || `f_${i}`),
              name: String(f?.name || "收藏夹").trim() || "收藏夹",
              order: Number(f?.order) || i + 1
            }))
            .sort((a, b) => a.order - b.order);
        }
        if (Array.isArray(parsed?.bookmarks)) {
          bookmarks = parsed.bookmarks
            .map((b, i) => ({
              id: String(b?.id || `bm_${i}`),
              folderId: String(b?.folderId || folders[0]?.id || "f_biz"),
              title: String(b?.title || "书签").trim() || "书签",
              url: String(b?.url || "").trim()
            }))
            .filter((b) => /^https?:\/\//i.test(b.url));
        }
        if (!bookmarks.length) bookmarks = getDefaultBookmarksV2();
        // 旧 v2 数据常缺设备/SOP 预置项：仅在尚未合并过时补齐一次
        if (!parsed?.defaultsMerged) {
          mergeMissingDefaultBookmarks();
          persistBookmarksStore();
        }
        return;
      }

      const rawV1 = localStorage.getItem(STORAGE_BM_LEGACY);
      if (rawV1) {
        const parsed = JSON.parse(rawV1);
        const list = Array.isArray(parsed) ? parsed : [];
        const fallbackFolder = folders[0]?.id || "f_biz";
        bookmarks = list
          .map((b, i) => ({
            id: String(b?.id || `bm_legacy_${i}`),
            folderId: fallbackFolder,
            title: String(b?.title || "书签").trim() || "书签",
            url: String(b?.url || "").trim()
          }))
          .filter((b) => /^https?:\/\//i.test(b.url));
        if (!bookmarks.length) bookmarks = getDefaultBookmarksV2();
        mergeMissingDefaultBookmarks();
        persistBookmarksStore();
        return;
      }
    } catch {
      // fall through
    }
    bookmarks = getDefaultBookmarksV2();
    persistBookmarksStore();
  }

  /** 补齐缺失的预置书签（用于旧数据未写入设备/SOP 等默认项；仅调用方控制调用时机） */
  function mergeMissingDefaultBookmarks() {
    const existingIds = new Set(bookmarks.map((b) => b.id));
    for (const def of getDefaultBookmarksV2()) {
      if (!existingIds.has(def.id)) bookmarks.push({ ...def });
    }
  }

  function ensureActiveFolder() {
    if (!folders.some((f) => f.id === activeFolderId)) {
      activeFolderId = folders[0]?.id || "f_biz";
    }
  }

  function renderBookmarks() {
    ensureActiveFolder();
    const folderList = $("ttFolderList");
    const chipList = $("ttBookmarkChips");
    if (!folderList || !chipList) return;
    folderList.innerHTML = "";
    const sortedFolders = folders.slice().sort((a, b) => a.order - b.order);
    for (const folder of sortedFolders) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tt-folder-btn" + (folder.id === activeFolderId ? " tt-folder-btn-active" : "");
      btn.dataset.folderId = folder.id;
      const count = bookmarks.filter((b) => b.folderId === folder.id).length;
      btn.textContent = `${folder.name} (${count})`;
      btn.title = `显示「${folder.name}」里的书签`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        activeFolderId = folder.id;
        renderBookmarks();
      });
      folderList.appendChild(btn);
    }

    chipList.innerHTML = "";
    const items = bookmarks.filter((b) => b.folderId === activeFolderId);
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "tt-bookmark-empty";
      empty.textContent = "此收藏夹暂无书签，点 ★ 添加";
      chipList.appendChild(empty);
      return;
    }
    for (const bm of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tt-bookmark-item";
      row.title = `${bm.url}\n右键可删除`;
      row.textContent = bm.title;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        openBookmark(bm);
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.confirm(`删除书签「${bm.title}」？`)) {
          bookmarks = bookmarks.filter((x) => x.id !== bm.id);
          persistBookmarksStore();
          renderBookmarks();
        }
      });
      chipList.appendChild(row);
    }
  }

  function fillFolderSelect(selectEl, selectedId) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    for (const f of folders.slice().sort((a, b) => a.order - b.order)) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      if (f.id === (selectedId || activeFolderId)) opt.selected = true;
      selectEl.appendChild(opt);
    }
  }

  function openAddBookmarkModal() {
    const modal = $("addBookmarkModal");
    if (!modal) return;
    const tab = getActiveTab();
    const wv = getActiveWebview();
    let url = tab?.url || DEFAULT_SRC;
    let title = tab?.title || "书签";
    try {
      if (wv && typeof wv.getURL === "function") {
        const u = wv.getURL();
        if (u) url = u;
      }
    } catch {
      // ignore
    }
    try {
      if (wv && typeof wv.getTitle === "function") {
        const t = wv.getTitle();
        if (t) title = t;
      }
    } catch {
      // ignore
    }
    const titleInput = $("addBookmarkTitle");
    const urlInput = $("addBookmarkUrl");
    const folderSelect = $("addBookmarkFolder");
    if (titleInput) titleInput.value = title;
    if (urlInput) urlInput.value = url;
    fillFolderSelect(folderSelect, activeFolderId || folders[0]?.id);
    const err = $("addBookmarkError");
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    modal.hidden = false;
    titleInput?.focus();
  }

  function closeAddBookmarkModal() {
    const modal = $("addBookmarkModal");
    if (modal) modal.hidden = true;
  }

  function saveAddBookmarkFromForm() {
    const title = String($("addBookmarkTitle")?.value || "").trim() || "书签";
    const rawUrl = String($("addBookmarkUrl")?.value || "").trim();
    const folderId = String($("addBookmarkFolder")?.value || folders[0]?.id || "");
    const err = $("addBookmarkError");
    const check = isAllowedNavigateUrl(normalizeInputUrl(rawUrl));
    if (!check.ok) {
      if (err) {
        err.hidden = false;
        err.textContent = check.message;
      }
      return;
    }
    if (!folders.some((f) => f.id === folderId)) {
      if (err) {
        err.hidden = false;
        err.textContent = "请选择收藏夹";
      }
      return;
    }
    bookmarks.push({
      id: `bm_${Date.now()}`,
      folderId,
      title,
      url: check.url
    });
    activeFolderId = folderId;
    persistBookmarksStore();
    renderBookmarks();
    closeAddBookmarkModal();
    log(`已添加书签到「${folders.find((f) => f.id === folderId)?.name || "收藏夹"}」：${title}`, "success");
  }

  function navigateWebview(wv, url) {
    if (!wv || !url) return;
    try {
      if (typeof wv.loadURL === "function") {
        void Promise.resolve(wv.loadURL(url)).catch(() => {
          wv.setAttribute("src", url);
        });
      } else {
        wv.setAttribute("src", url);
      }
    } catch {
      try {
        wv.setAttribute("src", url);
      } catch {
        // ignore
      }
    }
  }

  function updateAddressBar() {
    const input = $("ttAddressInput");
    if (!input) return;
    const tab = getActiveTab();
    const wv = getActiveWebview();
    let url = tab?.url || "";
    try {
      if (wv && typeof wv.getURL === "function") {
        const u = wv.getURL();
        if (u) url = u;
      }
    } catch {
      // ignore
    }
    if (document.activeElement !== input) input.value = url || "";
    const locked = !!tab?.primary;
    input.readOnly = locked;
    input.title = locked
      ? "接单 TT 为操作专用（接单/话术/拉 PM），请用副标签打开其他网址"
      : "输入网址后回车或点前往";
    input.classList.toggle("tt-address-locked", locked);
  }

  function goToAddressBarUrl() {
    const input = $("ttAddressInput");
    const raw = normalizeInputUrl(input?.value || "");
    const check = isAllowedNavigateUrl(raw);
    if (!check.ok) {
      window.alert(check.message);
      return;
    }
    const active = getActiveTab();
    if (active?.primary) {
      const created = createTab(check.url, "新标签");
      if (created) log("接单 TT 为操作专用，已在新标签打开网址。", "info");
      return;
    }
    if (!active || !active.webview) {
      createTab(check.url, "新标签");
      return;
    }
    active.url = check.url;
    navigateWebview(active.webview, check.url);
    renderTabs();
    updateAddressBar();
  }

  function openBookmark(bm) {
    if (!bm?.url) return;
    const check = isAllowedNavigateUrl(bm.url);
    if (!check.ok) {
      window.alert(check.message || "该书签网址不允许打开");
      return;
    }
    const mode = bookmarkOpenMode;
    const active = getActiveTab();
    if (mode === C.TT_BOOKMARK_OPEN_CURRENT && active?.primary) {
      const created = createTab(check.url, bm.title);
      if (created) log("接单 TT 为操作专用，已在新标签打开书签。", "info");
      return;
    }
    if (mode === C.TT_BOOKMARK_OPEN_CURRENT && active && !active.primary) {
      active.url = check.url;
      active.title = bm.title || active.title;
      navigateWebview(active.webview, check.url);
      renderTabs();
      updateAddressBar();
      return;
    }
    createTab(check.url, bm.title);
  }

  function createWebviewEl({ primary, src }) {
    const wv = document.createElement("webview");
    wv.className = "web-frame tt-webview-pane";
    if (primary) {
      wv.id = "ttWebview";
      wv.dataset.tabPrimary = "1";
    }
    wv.setAttribute("allowpopups", "");
    try {
      wv.setAttribute("partition", PARTITION);
      wv.setAttribute("preload", new URL("webview-preload.js", document.baseURI).href);
      wv.setAttribute("src", src || DEFAULT_SRC);
    } catch {
      try {
        wv.setAttribute("partition", PARTITION);
        wv.setAttribute("src", src || DEFAULT_SRC);
      } catch {
        // ignore
      }
    }
    return wv;
  }

  function syncTabUrlFromWebview(tab) {
    const wv = tab?.webview;
    if (!wv) return;
    try {
      if (typeof wv.getURL === "function") {
        const u = wv.getURL();
        if (u) tab.url = u;
      }
    } catch {
      // ignore
    }
    if (tab.id === activeTabId) updateAddressBar();
  }

  function attachSecondaryListeners(tab) {
    const wv = tab.webview;
    if (!wv) return;
    wv.addEventListener("page-title-updated", (e) => {
      if (tab.primary) return;
      const t = String(e?.title || "").trim();
      if (t) {
        tab.title = t.slice(0, 40);
        renderTabs();
      }
    });
    wv.addEventListener("did-navigate", () => {
      syncTabUrlFromWebview(tab);
    });
    wv.addEventListener("did-navigate-in-page", () => {
      syncTabUrlFromWebview(tab);
    });
    wv.addEventListener("did-finish-load", () => {
      syncTabUrlFromWebview(tab);
    });
    wv.addEventListener("ipc-message", (event) => {
      const ch = event.channel;
      const arg0 = event.args && event.args[0];
      if (ch === "tt-webview-zoom-delta" || ch === "tt-webview-zoom-reset") {
        document.dispatchEvent(
          new CustomEvent("tt-browser-zoom-ipc", { detail: { channel: ch, arg0, webview: wv } })
        );
        return;
      }
      if (typeof arg0 !== "string" || !arg0.trim()) return;
      const u = arg0.trim();
      if (ch === "tt-bridge-in-webview") {
        const check = isAllowedNavigateUrl(u);
        if (check.ok) navigateWebview(wv, check.url);
        return;
      }
      if (ch === "tt-open-external" || ch === "tt-open-protocol") {
        void window.ttDesktopApi?.openExternal?.(u);
      }
    });
  }

  function attachPrimaryNavListeners(primaryWv) {
    if (!primaryWv || primaryWv.dataset.navBound === "1") return;
    primaryWv.dataset.navBound = "1";
    const sync = () => {
      const tab = tabs.find((t) => t.primary);
      if (tab) syncTabUrlFromWebview(tab);
    };
    primaryWv.addEventListener("did-navigate", sync);
    primaryWv.addEventListener("did-navigate-in-page", sync);
    primaryWv.addEventListener("did-finish-load", sync);
  }

  function renderTabs() {
    const list = $("ttTabList");
    const countEl = $("ttTabCount");
    if (countEl) countEl.textContent = `${tabs.length}/${MAX_TABS}`;
    if (!list) return;
    list.innerHTML = "";
    for (const tab of tabs) {
      const el = document.createElement("button");
      el.type = "button";
      el.className =
        "tt-tab" + (tab.id === activeTabId ? " tt-tab-active" : "") + (tab.primary ? " tt-tab-primary" : "");
      el.title = tab.primary
        ? "操作专用：接单 / 改标题 / 发话术 / 拉 PM（浏览请用副标签）"
        : tab.url || "";
      const label = document.createElement("span");
      label.className = "tt-tab-label";
      label.textContent = tab.primary ? `🔒 接单 TT` : tab.title;
      el.appendChild(label);
      if (!tab.primary) {
        const close = document.createElement("span");
        close.className = "tt-tab-close";
        close.textContent = "×";
        close.title = "关闭";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          closeTab(tab.id);
        });
        el.appendChild(close);
      }
      el.addEventListener("click", () => activateTab(tab.id));
      list.appendChild(el);
    }
  }

  function showOnlyActiveWebview() {
    const host = $("ttWebviewHost");
    const active = tabs.find((t) => t.id === activeTabId);
    const browsing = !!(active && !active.primary);
    if (host) host.classList.toggle("tt-host-browsing", browsing);

    for (const tab of tabs) {
      if (!tab.webview) continue;
      const on = tab.id === activeTabId;
      tab.webview.classList.toggle("tt-webview-active", on);

      if (tab.primary) {
        // 方案 L：接单面永不 display:none，浏览时叠在底层保持尺寸（话术/拉 PM 可见性判定可用）
        tab.webview.style.display = "";
        tab.webview.classList.toggle("tt-webview-ops-under", !on);
        tab.webview.classList.toggle("tt-webview-ops-front", on);
      } else {
        tab.webview.style.display = on ? "" : "none";
        tab.webview.classList.toggle("tt-webview-ops-under", false);
        tab.webview.classList.toggle("tt-webview-ops-front", false);
        tab.webview.classList.toggle("tt-webview-browse-front", on);
      }
    }
  }

  function activateTab(id) {
    if (!tabs.some((t) => t.id === id)) return;
    activeTabId = id;
    showOnlyActiveWebview();
    renderTabs();
    updateAddressBar();
    try {
      onActiveTabChange?.();
    } catch {
      // ignore
    }
  }

  function createTab(url, title) {
    if (tabs.length >= MAX_TABS) {
      log(`最多只能打开 ${MAX_TABS} 个标签页。`, "warning");
      window.alert(`最多只能打开 ${MAX_TABS} 个标签页。`);
      return null;
    }
    const host = $("ttWebviewHost");
    if (!host) return null;
    let src = url || DEFAULT_SRC;
    const check = isAllowedNavigateUrl(src);
    if (!check.ok) {
      window.alert(check.message);
      return null;
    }
    src = check.url;
    const id = `tab_${++tabSeq}`;
    const wv = createWebviewEl({ primary: false, src });
    host.appendChild(wv);
    const tab = {
      id,
      title: String(title || "新标签").slice(0, 40),
      url: src,
      primary: false,
      webview: wv
    };
    tabs.push(tab);
    attachSecondaryListeners(tab);
    try {
      onWebviewCreated?.(wv, { primary: false });
    } catch {
      // ignore
    }
    activateTab(id);
    return tab;
  }

  function promptNewTab() {
    // Electron 下 window.prompt 常被禁用（直接返回 null），导致点 + 无反应
    const tab = createTab(DEFAULT_SRC, "新标签");
    if (!tab) return;
    updateAddressBar();
    const input = $("ttAddressInput");
    if (input && !input.readOnly) {
      input.focus();
      input.select();
    }
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = tabs[idx];
    if (tab.primary) return;
    if (browseTabBeforeOps === id) browseTabBeforeOps = null;
    try {
      tab.webview?.remove?.();
    } catch {
      // ignore
    }
    tabs.splice(idx, 1);
    if (activeTabId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)] || tabs[0];
      activateTab(next.id);
    } else {
      renderTabs();
      showOnlyActiveWebview();
    }
  }

  function ensurePrimaryTab() {
    const host = $("ttWebviewHost");
    let primaryWv = document.getElementById("ttWebview");
    if (!primaryWv && host) {
      primaryWv = createWebviewEl({ primary: true, src: DEFAULT_SRC });
      host.insertBefore(primaryWv, host.firstChild);
    }
    if (!tabs.some((t) => t.primary)) {
      tabs.unshift({
        id: PRIMARY_ID,
        title: "接单 TT",
        url: DEFAULT_SRC,
        primary: true,
        webview: primaryWv
      });
    } else {
      const p = tabs.find((t) => t.primary);
      if (p) p.webview = primaryWv;
    }
    syncDomPrimaryRef();
    attachPrimaryNavListeners(primaryWv);
    activeTabId = PRIMARY_ID;
    showOnlyActiveWebview();
    renderTabs();
    updateAddressBar();
    return primaryWv;
  }

  function navBack() {
    const wv = getActiveWebview();
    try {
      if (wv && typeof wv.canGoBack === "function" && wv.canGoBack() && typeof wv.goBack === "function") {
        wv.goBack();
      }
    } catch {
      // ignore
    }
  }

  function navForward() {
    const wv = getActiveWebview();
    try {
      if (wv && typeof wv.canGoForward === "function" && wv.canGoForward() && typeof wv.goForward === "function") {
        wv.goForward();
      }
    } catch {
      // ignore
    }
  }

  function navReload() {
    const wv = getActiveWebview();
    try {
      if (wv && typeof wv.reload === "function") wv.reload();
    } catch {
      // ignore
    }
  }

  function openBookmarkSettingsModal() {
    const modal = $("bookmarkSettingsModal");
    if (!modal) return;
    const newRadio = $("bookmarkOpenNewTab");
    const curRadio = $("bookmarkOpenCurrentTab");
    if (newRadio) newRadio.checked = bookmarkOpenMode !== C.TT_BOOKMARK_OPEN_CURRENT;
    if (curRadio) curRadio.checked = bookmarkOpenMode === C.TT_BOOKMARK_OPEN_CURRENT;
    modal.hidden = false;
  }

  function closeBookmarkSettingsModal() {
    const modal = $("bookmarkSettingsModal");
    if (modal) modal.hidden = true;
  }

  function saveBookmarkSettingsFromForm() {
    const curRadio = $("bookmarkOpenCurrentTab");
    bookmarkOpenMode = curRadio?.checked ? C.TT_BOOKMARK_OPEN_CURRENT : C.TT_BOOKMARK_OPEN_NEW_TAB;
    saveBookmarkOpenMode();
    closeBookmarkSettingsModal();
    log(
      bookmarkOpenMode === C.TT_BOOKMARK_OPEN_CURRENT
        ? "书签打开方式：当前标签跳转（主标签除外）"
        : "书签打开方式：总是开新标签",
      "success"
    );
  }

  function bindUi() {
    $("leftPanelCollapseBtn")?.addEventListener("click", () => setLeftCollapsed(true));
    $("leftPanelRail")?.addEventListener("click", () => setLeftCollapsed(false));
    $("ttTabAddBtn")?.addEventListener("click", () => promptNewTab());
    $("ttBookmarkAddBtn")?.addEventListener("click", () => openAddBookmarkModal());
    $("ttNavBackBtn")?.addEventListener("click", () => navBack());
    $("ttNavForwardBtn")?.addEventListener("click", () => navForward());
    $("ttNavReloadBtn")?.addEventListener("click", () => navReload());
    $("ttAddressGoBtn")?.addEventListener("click", () => goToAddressBarUrl());
    $("ttAddressInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        goToAddressBarUrl();
      }
    });
    $("bookmarkSettingsCloseBtn")?.addEventListener("click", closeBookmarkSettingsModal);
    $("bookmarkSettingsCancelBtn")?.addEventListener("click", closeBookmarkSettingsModal);
    $("bookmarkSettingsSaveBtn")?.addEventListener("click", saveBookmarkSettingsFromForm);
    $("bookmarkSettingsModal")?.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-bookmark-settings-close") === "1") {
        closeBookmarkSettingsModal();
      }
    });
    $("addBookmarkCloseBtn")?.addEventListener("click", closeAddBookmarkModal);
    $("addBookmarkCancelBtn")?.addEventListener("click", closeAddBookmarkModal);
    $("addBookmarkSaveBtn")?.addEventListener("click", saveAddBookmarkFromForm);
    $("addBookmarkModal")?.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-add-bookmark-close") === "1") {
        closeAddBookmarkModal();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "\\" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleLeftCollapsed();
      }
      if (e.key === "Escape") {
        const bm = $("bookmarkSettingsModal");
        if (bm && !bm.hidden) closeBookmarkSettingsModal();
        const add = $("addBookmarkModal");
        if (add && !add.hidden) closeAddBookmarkModal();
      }
      if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
        const input = $("ttAddressInput");
        if (input && !input.readOnly) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    });
  }

  function init(opts = {}) {
    onWebviewCreated = typeof opts.onWebviewCreated === "function" ? opts.onWebviewCreated : null;
    onActiveTabChange = typeof opts.onActiveTabChange === "function" ? opts.onActiveTabChange : null;
    loadLeftCollapsed();
    loadBookmarkOpenMode();
    loadBookmarksStore();
    bindUi();
    applyLeftCollapsed();
    renderBookmarks();
    const primary = ensurePrimaryTab();
    try {
      onWebviewCreated?.(primary, { primary: true });
    } catch {
      // ignore
    }
    return { primaryWebview: primary };
  }

  TD.browser = {
    init,
    getPrimaryWebview,
    getActiveWebview,
    getActiveTab,
    createTab,
    activateTab,
    closeTab,
    openBookmarkSettingsModal,
    updateAddressBar,
    isLeftCollapsed: () => leftCollapsed,
    getBookmarkOpenMode: () => bookmarkOpenMode,
    getTabs: () => tabs.slice(),
    isAllowedNavigateUrl,
    isOpsTabActive,
    ensureOpsSurface,
    restoreBrowseSurfaceIfNeeded,
    clearOpsSurfaceResume
  };
})(window.TTDesktop = window.TTDesktop || {});
