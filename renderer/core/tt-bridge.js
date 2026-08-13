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

  function getPrimaryWebview() {
    return TD.browser?.getPrimaryWebview?.() || TD.dom.ttWebview || null;
  }

  async function ttExecuteJavaScript(script, timeoutMs = 40000) {
    const ttWebview = getPrimaryWebview();
    if (!ttWebview) throw new Error("webview 不存在");
    const run = Promise.resolve(ttWebview.executeJavaScript(script));
    const timed =
      Number(timeoutMs) > 0
        ? Promise.race([
            run,
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("tt_js_timeout")), timeoutMs);
            })
          ])
        : run;
    try {
      return await timed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "tt_js_timeout") {
        TD.log.log("页面操作超时，将自动重试。", "warning");
        throw err;
      }
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
