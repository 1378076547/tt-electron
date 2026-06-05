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
