const { contextBridge, ipcRenderer } = require("electron");

// 暴露给渲染进程的安全 API
contextBridge.exposeInMainWorld("ttDesktopApi", {
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  logToFile: (message) => ipcRenderer.send("log-to-file", { message }),
  queryTicketsByApi: (payload) => ipcRenderer.invoke("tt-api-query-tickets", payload),
  queryTicketDetailByApi: (payload) => ipcRenderer.invoke("tt-api-ticket-detail", payload),
  getTtApiConfigStatus: () => ipcRenderer.invoke("get-tt-api-config-status"),
  getTtApiConfig: () => ipcRenderer.invoke("get-tt-api-config"),
  saveTtApiConfig: (payload) => ipcRenderer.invoke("save-tt-api-config", payload),
  getHfIssueConfig: () => ipcRenderer.invoke("get-hf-issue-config"),
  getBurstOutbreakConfig: () => ipcRenderer.invoke("get-burst-outbreak-config"),
  openTtApiConfig: () => ipcRenderer.invoke("open-tt-api-config"),
  onOpenApiSettings: (callback) => {
    const listener = () => {
      try {
        callback();
      } catch {
        // ignore
      }
    };
    ipcRenderer.on("open-api-settings", listener);
    return () => ipcRenderer.removeListener("open-api-settings", listener);
  },
  onOpenBookmarkSettings: (callback) => {
    const listener = () => {
      try {
        callback();
      } catch {
        // ignore
      }
    };
    ipcRenderer.on("open-bookmark-settings", listener);
    return () => ipcRenderer.removeListener("open-bookmark-settings", listener);
  },
  onAppCacheCleared: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on("app-cache-cleared", listener);
    return () => ipcRenderer.removeListener("app-cache-cleared", listener);
  },
  clearAppCaches: () => ipcRenderer.invoke("clear-app-caches"),
  loadChinaCities: () => ipcRenderer.invoke("load-china-cities"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  selectAndReadPmCsv: () => ipcRenderer.invoke("select-and-read-pm-csv"),
  syncPmCsvFromS3: () => ipcRenderer.invoke("sync-pm-csv-from-s3"),
  getPmCsvStatus: () => ipcRenderer.invoke("get-pm-csv-status"),
  readTextFile: (filePath) => ipcRenderer.invoke("read-text-file", filePath),
  showSlaNotification: (payload) => ipcRenderer.invoke("show-sla-notification", payload),
  updateTraySlaHint: (payload) => ipcRenderer.invoke("update-tray-sla-hint", payload)
});
