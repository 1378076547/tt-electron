const { contextBridge, ipcRenderer } = require("electron");

// 暴露给渲染进程的安全 API
contextBridge.exposeInMainWorld("ttDesktopApi", {
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  logToFile: (message) => ipcRenderer.send("log-to-file", { message }),
  openLogsDir: () => ipcRenderer.invoke("open-logs-dir"),
  queryTicketsByApi: (payload) => ipcRenderer.invoke("tt-api-query-tickets", payload),
  queryTicketDetailByApi: (payload) => ipcRenderer.invoke("tt-api-ticket-detail", payload),
  getTtApiConfigStatus: () => ipcRenderer.invoke("get-tt-api-config-status"),
  openTtApiConfig: () => ipcRenderer.invoke("open-tt-api-config"),
  loadChinaCities: () => ipcRenderer.invoke("load-china-cities"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  selectAndReadPmCsv: () => ipcRenderer.invoke("select-and-read-pm-csv"),
  readTextFile: (filePath) => ipcRenderer.invoke("read-text-file", filePath),
  showSlaNotification: (payload) => ipcRenderer.invoke("show-sla-notification", payload),
  updateTraySlaHint: (payload) => ipcRenderer.invoke("update-tray-sla-hint", payload)
});
