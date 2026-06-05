const { app, BrowserWindow, Tray, Menu, ipcMain, shell, session, dialog, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let trayTooltipBase = "TTDesktop1.0";
let allowQuit = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function restartAppNow() {
  allowQuit = true;
  app.relaunch();
  app.exit(0);
}

function createAppMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "显示窗口",
          click: () => {
            if (!mainWindow) return;
            mainWindow.show();
            mainWindow.focus();
          }
        },
        {
          label: "重启程序",
          accelerator: process.platform === "darwin" ? "CmdOrCtrl+Shift+R" : "Ctrl+Shift+R",
          click: () => {
            restartAppNow();
          }
        },
        {
          label: "打开 API 配置文件",
          click: () => {
            openApiConfigFile().catch(() => {});
          }
        },
        { type: "separator" },
        {
          label: "退出",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",
          click: () => {
            allowQuit = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "打开 TT 系统",
          click: () => {
            shell.openExternal("https://tt.sankuai.com/ticket/handle?filter=todo");
          }
        },
        { type: "separator" },
        {
          label: "开发者工具",
          role: "toggleDevTools"
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  const ver = app.getVersion();
  const titleBase = `TTDesktop1.0 v${ver}`;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#050816",
    title: titleBase,
    icon: path.join(__dirname, "assets", "cat.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (!tray) {
    tray = new Tray(path.join(__dirname, "assets", "cat.png"));
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "显示窗口",
        click: () => {
          if (!mainWindow) return;
          mainWindow.show();
          mainWindow.focus();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          allowQuit = true;
          app.quit();
        }
      }
    ]);
    trayTooltipBase = titleBase;
    tray.setToolTip(titleBase);
    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      if (!mainWindow) return;
      mainWindow.show();
      mainWindow.focus();
    });
  }

  mainWindow.on("minimize", (e) => {
    // 默认最小化到托盘
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("close", (e) => {
    if (allowQuit) return;
    // 点击关闭按钮时隐藏到托盘
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 须与 renderer 中 TT webview 的 partition 一致；独立 session 避免 defaultSession 上 <all_urls> 拦截拖慢主窗口与其它导航
const TT_GUEST_PARTITION = "persist:tt-desktop-tt-guest";
const API_CONFIG_FILENAME = "tt-api.local.json";
const API_CONFIG_EXAMPLE = "tt-api.local.json.example";

function sanitizeUsername(raw) {
  const s = String(raw || "")
    .replace(/[\r\n\t]/g, "")
    .trim();
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned || "";
}

function getApiConfigCandidatePaths() {
  return [
    path.join(__dirname, API_CONFIG_FILENAME),
    path.join(app.getPath("userData"), API_CONFIG_FILENAME)
  ];
}

function getDefaultApiConfigPath() {
  if (!app.isPackaged) {
    return path.join(__dirname, API_CONFIG_FILENAME);
  }
  return path.join(app.getPath("userData"), API_CONFIG_FILENAME);
}

function loadLocalApiConfig() {
  for (const configPath of getApiConfigCandidatePaths()) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") {
        return { ok: false, path: configPath, data: null, error: "JSON 须为对象" };
      }
      return { ok: true, path: configPath, data, error: "" };
    } catch (err) {
      return {
        ok: false,
        path: configPath,
        data: null,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
  return { ok: false, path: getDefaultApiConfigPath(), data: null, error: "" };
}

/** 每次请求前读取，改文件后无需重启（保存后下次拉单即生效） */
function getApiCredentials() {
  const loaded = loadLocalApiConfig();
  const data = loaded.data || {};
  const authorization = String(
    data.authorization || data.TT_API_AUTHORIZATION || process.env.TT_API_AUTHORIZATION || ""
  ).trim();
  const username = sanitizeUsername(
    data.username || data.TT_API_USERNAME || process.env.TT_API_USERNAME || ""
  );
  const envRaw = String(data.env || data.TT_API_ENV || process.env.TT_API_ENV || "prod")
    .trim()
    .toLowerCase();
  const env = envRaw === "test" ? "test" : "prod";
  return {
    authorization,
    username,
    env,
    configPath: loaded.path || getDefaultApiConfigPath(),
    configLoaded: loaded.ok,
    configError: loaded.error || ""
  };
}

function getApiConfigHint() {
  const creds = getApiCredentials();
  if (creds.authorization) return "";
  const p = creds.configPath;
  if (creds.configError) {
    return `API 配置文件 JSON 无效（${p}）：${creds.configError}`;
  }
  if (!creds.configLoaded) {
    return `API 未配置：请编辑 ${p}（可复制 ${API_CONFIG_EXAMPLE} 为 ${API_CONFIG_FILENAME}）`;
  }
  return `API 未配置：请在 ${p} 中填写 authorization`;
}

function ensureApiConfigFile() {
  const target = getDefaultApiConfigPath();
  if (fs.existsSync(target)) return target;
  const examplePath = path.join(__dirname, API_CONFIG_EXAMPLE);
  if (!fs.existsSync(examplePath)) return target;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(examplePath, target);
  } catch {
    // ignore
  }
  return target;
}

async function openApiConfigFile() {
  const configPath = ensureApiConfigFile();
  if (!fs.existsSync(configPath)) {
    const examplePath = path.join(__dirname, API_CONFIG_EXAMPLE);
    if (fs.existsSync(examplePath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.copyFileSync(examplePath, configPath);
    }
  }
  const err = await shell.openPath(configPath);
  if (err) {
    shell.showItemInFolder(configPath);
  }
  return configPath;
}

function ttApiRequest({ path: reqPath, method = "POST", username = "", headers = {}, body = null }) {
  const creds = getApiCredentials();
  const apiEnv = creds.env;
  const hostname = apiEnv === "prod" ? "ticket.vip.sankuai.com" : "ticket.ee.test.sankuai.com";
  const port = apiEnv === "prod" ? 443 : 80;
  const client = apiEnv === "prod" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname,
        port,
        path: reqPath,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: creds.authorization,
          USERNAME: username || creds.username || "",
          ...headers
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += String(chunk || "");
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** 不操作 webview guest（避免 Invalid guestInstanceId），在 TT 专用 partition 的 session 上拦截大象自定义协议 */
function setupElephantProtocolIntercept() {
  const ses = session.fromPartition(TT_GUEST_PARTITION);
  // 仅 mainFrame：TT 内大量 iframe 的 subFrame 导航若也挂 <all_urls>，每个都会同步回调主进程，首屏可拖到十余秒
  ses.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"], types: ["mainFrame"] },
    (details, callback) => {
      const u = details.url || "";
      if (/^(elephant|daxiang|mtdaxiang):\/\//i.test(u)) {
        shell.openExternal(u).catch(() => {});
        callback({ cancel: true });
        return;
      }
      callback({});
    }
  );
}

app.whenReady().then(() => {
  ensureApiConfigFile();
  setupElephantProtocolIntercept();
  createAppMenu();
  createWindow();
});

function getLogFilePath() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const fileName = `${yyyy}-${mm}-${dd}.txt`;
  const dir = path.join(app.getPath("userData"), "logs");
  return { dir, filePath: path.join(dir, fileName) };
}

function appendDailyLog(line) {
  try {
    const { dir, filePath } = getLogFilePath();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, line + "\n", "utf8");
  } catch {
    // ignore file write errors
  }
}

ipcMain.handle("get-app-version", () => ({
  version: app.getVersion(),
  name: app.getName()
}));

ipcMain.handle("load-china-cities", async () => {
  const p = path.join(__dirname, "assets", "china_cities.json");
  const raw = await fs.promises.readFile(p, "utf8");
  return JSON.parse(raw);
});

ipcMain.handle("open-external", async (_event, url) => {
  if (!url) return;
  try {
    await shell.openExternal(url);
  } catch {
    // 忽略外部打开失败
  }
});

ipcMain.on("log-to-file", (_event, payload) => {
  const message = typeof payload === "string" ? payload : payload?.message;
  if (!message) return;
  appendDailyLog(String(message));
});

ipcMain.handle("open-logs-dir", async () => {
  const { dir } = getLogFilePath();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  try {
    // openPath 在 Windows 上会用资源管理器打开目录
    return await shell.openPath(dir);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
});

ipcMain.handle("restart-app", async () => {
  try {
    restartAppNow();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
});

ipcMain.handle("get-tt-api-config-status", async () => {
  const creds = getApiCredentials();
  return {
    ok: !!creds.authorization,
    configPath: creds.configPath,
    env: creds.env,
    hasUsername: !!creds.username,
    message: creds.authorization ? "" : getApiConfigHint()
  };
});

ipcMain.handle("open-tt-api-config", async () => {
  try {
    const configPath = await openApiConfigFile();
    return { ok: true, path: configPath };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("show-sla-notification", async (_event, payload) => {
  try {
    if (!Notification.isSupported()) {
      return { ok: false, message: "系统不支持桌面通知" };
    }
    const title = String(payload?.title || "TTDesktop 工单时效").trim();
    const body = String(payload?.body || "").trim();
    const n = new Notification({ title, body });
    n.show();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("update-tray-sla-hint", async (_event, payload) => {
  try {
    if (!tray) return { ok: false };
    const warn = Number(payload?.warn) || 0;
    const overdue = Number(payload?.overdue) || 0;
    let tip = trayTooltipBase;
    if (warn > 0 || overdue > 0) {
      tip += `\n48h 预警 ${warn} · 超时 ${overdue}`;
    }
    tray.setToolTip(tip);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("tt-api-query-tickets", async (_event, payload) => {
  try {
    const creds = getApiCredentials();
    if (!creds.authorization) {
      return { ok: false, message: getApiConfigHint() };
    }
    const usernameFromPayload = sanitizeUsername(payload?.username || "");
    const username = usernameFromPayload || creds.username || "wb_lidelei";
    if (!username) return { ok: false, message: "用户名缺失（USERNAME）" };

    const params = payload?.params || {};
    const cn = Number.isFinite(Number(params.cn)) ? Number(params.cn) : 1;
    const sn = Number.isFinite(Number(params.sn)) ? Number(params.sn) : 50;
    const orderField = String(params.orderField || "createdAt");
    const orderKind = String(params.orderKind || "DESC");

    const body = { ...params };
    delete body.cn;
    delete body.sn;
    delete body.orderField;
    delete body.orderKind;

    const query = `cn=${cn}&sn=${sn}&orderField=${encodeURIComponent(orderField)}&orderKind=${encodeURIComponent(orderKind)}`;
    const res = await ttApiRequest({
      path: `/api/1.0/ticket/filter/query?${query}`,
      method: "POST",
      username,
      body
    });
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("select-and-read-pm-csv", async () => {
  if (!mainWindow) return { ok: false, message: "窗口未就绪" };
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "选择 PM 配置（CSV）",
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["openFile"]
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const filePath = r.filePaths[0];
    const content = await fs.promises.readFile(filePath, "utf8");
    return { ok: true, path: filePath, content };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("read-text-file", async (_event, filePath) => {
  try {
    const p = String(filePath || "").trim();
    if (!p) return { ok: false, message: "路径为空" };
    const content = await fs.promises.readFile(p, "utf8");
    return { ok: true, path: p, content };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("tt-api-ticket-detail", async (_event, payload) => {
  try {
    const creds = getApiCredentials();
    if (!creds.authorization) {
      return { ok: false, message: getApiConfigHint() };
    }
    const usernameFromPayload = sanitizeUsername(payload?.username || "");
    const username = usernameFromPayload || creds.username || "wb_lidelei";
    const ticketId = String(payload?.ticketId || "").trim();
    if (!ticketId) return { ok: false, message: "ticketId 缺失" };

    const res = await ttApiRequest({
      path: `/api/1.0/ticket/${encodeURIComponent(ticketId)}`,
      method: "GET",
      username
    });
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
