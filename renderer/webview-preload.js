const { ipcRenderer } = require("electron");

/** 仅 x.sankuai.com 大象中转页：在应用内 webview 打开（主进程不再碰 guest） */
function isBridgeUrl(url) {
  try {
    const s = String(url).trim();
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === "x.sankuai.com" && u.pathname.startsWith("/bridge/");
  } catch {
    return false;
  }
}

function handOffBridge(url) {
  if (!isBridgeUrl(url)) return false;
  ipcRenderer.sendToHost("tt-bridge-in-webview", String(url).trim());
  return true;
}

const _open = window.open;
window.open = function (url, name, features) {
  if (handOffBridge(url)) return null;
  return _open.apply(window, arguments);
};

const loc = window.location;
const _assign = loc.assign.bind(loc);
const _replace = loc.replace.bind(loc);
loc.assign = function (url) {
  if (handOffBridge(String(url))) return;
  return _assign(url);
};
loc.replace = function (url) {
  if (handOffBridge(String(url))) return;
  return _replace(url);
};

document.addEventListener(
  "click",
  function (e) {
    const el = e.target && e.target.closest && e.target.closest(".dx-link");
    if (!el) return;
    const attrs = ["data-href", "data-url", "data-link", "data-open-url"];
    for (let i = 0; i < attrs.length; i++) {
      const v = el.getAttribute(attrs[i]);
      if (v && handOffBridge(v)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
    }
    const a = el.querySelector("a[href]");
    if (a && a.href && handOffBridge(a.href)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  },
  true
);

/** Ctrl/Cmd + 滚轮 → 主机缩放内置 TT（最小 80%） */
window.addEventListener(
  "wheel",
  function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = Number(e.deltaY) || 0;
    if (!delta) return;
    ipcRenderer.sendToHost("tt-webview-zoom-delta", delta > 0 ? -1 : 1);
  },
  { passive: false, capture: true }
);

/** Ctrl/Cmd + 0 重置；+/- 缩放 */
window.addEventListener(
  "keydown",
  function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = String(e.key || "");
    if (key === "0" || key === "Digit0" || e.code === "Digit0" || e.code === "Numpad0") {
      e.preventDefault();
      ipcRenderer.sendToHost("tt-webview-zoom-reset");
      return;
    }
    if (key === "+" || key === "=" || e.code === "Equal" || e.code === "NumpadAdd") {
      e.preventDefault();
      ipcRenderer.sendToHost("tt-webview-zoom-delta", 1);
      return;
    }
    if (key === "-" || key === "_" || e.code === "Minus" || e.code === "NumpadSubtract") {
      e.preventDefault();
      ipcRenderer.sendToHost("tt-webview-zoom-delta", -1);
    }
  },
  true
);
