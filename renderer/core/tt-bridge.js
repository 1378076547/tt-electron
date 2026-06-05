/**
 * TT webview 脚本执行桥（阶段 1）
 */
(function initTtBridge(TD) {
  const C = TD.constants;

  function setWebviewLoadingHint(visible) {
    const el = TD.dom.webviewLoadingHint;
    if (!el) return;
    el.toggleAttribute("hidden", !visible);
  }

  async function ttExecuteJavaScript(script) {
    const ttWebview = TD.dom.ttWebview;
    if (!ttWebview) throw new Error("webview 不存在");
    try {
      return await ttWebview.executeJavaScript(script);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("GUEST_VIEW_MANAGER") || msg.includes("guestInstanceId")) {
        TD.log.log("内置浏览器异常（guest 失效），正在重新加载 TT…", "warning");
        setWebviewLoadingHint(true);
        try {
          if (typeof ttWebview.stop === "function") ttWebview.stop();
        } catch {
          // ignore
        }
        try {
          ttWebview.setAttribute("src", C.TT_WEBVIEW_DEFAULT_SRC);
        } catch {
          // ignore
        }
      }
      throw err;
    }
  }

  TD.ttBridge = { ttExecuteJavaScript, setWebviewLoadingHint };
})(window.TTDesktop);
