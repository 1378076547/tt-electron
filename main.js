const { app, BrowserWindow, Tray, Menu, ipcMain, shell, session, dialog, Notification, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { autoUpdater } = require("electron-updater");

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
          label: "API 设置…",
          click: () => {
            if (!mainWindow) return;
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send("open-api-settings");
          }
        },
        {
          label: "书签设置…",
          click: () => {
            if (!mainWindow) return;
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send("open-bookmark-settings");
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
          label: "清理缓存…",
          click: () => {
            clearAppCachesWithConfirm().catch(() => {});
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
          label: "检查更新…",
          click: () => {
            checkForUpdates(true);
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
  // 尽量让系统菜单/控件跟深色外壳一致（Windows 原生菜单仍受系统主题限制）
  try {
    nativeTheme.themeSource = "dark";
  } catch (_) {}
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0b1220",
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
const HF_ISSUE_CONFIG_FILENAME = "hf-issue.local.json";
const HF_ISSUE_CONFIG_EXAMPLE = "hf-issue.local.json.example";
const LEGACY_HF_ISSUE_CONFIG_FILENAME = "fault-burst.local.json";
const DEFAULT_RG_IDS = [13619, 8238, 8200, 4967];

const DEFAULT_HF_ISSUE_CONFIG = {
  enabled: true,
  notifyWindows: true,
  thresholds: { days7: 3, days30: 5 },
  categories: [
    {
      id: "network",
      label: "网络类",
      terms: [
        "断网",
        "网络卡顿",
        "没网",
        "整仓断网",
        "网络故障",
        "Network",
        "network",
        "WIFI",
        "wifi",
        "WiFi",
        "offline",
        "Offline"
      ]
    },
    {
      id: "power",
      label: "电力/UPS",
      terms: ["断电", "UPS", "UPS故障", "停电", "power outage", "Power"]
    }
  ]
};

function parseRgIds(data) {
  const raw = data?.rgIds ?? data?.RG_IDS ?? data?.rg_ids;
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(/[,，\s]+/)
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  return DEFAULT_RG_IDS.slice();
}

function getHfIssueConfigCandidatePaths() {
  return [
    path.join(__dirname, HF_ISSUE_CONFIG_FILENAME),
    path.join(app.getPath("userData"), HF_ISSUE_CONFIG_FILENAME),
    path.join(__dirname, LEGACY_HF_ISSUE_CONFIG_FILENAME),
    path.join(app.getPath("userData"), LEGACY_HF_ISSUE_CONFIG_FILENAME)
  ];
}

function loadLocalHfIssueConfig() {
  for (const configPath of getHfIssueConfigCandidatePaths()) {
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
  const examplePath = path.join(__dirname, HF_ISSUE_CONFIG_EXAMPLE);
  if (fs.existsSync(examplePath)) {
    try {
      const text = fs.readFileSync(examplePath, "utf8").replace(/^\uFEFF/, "");
      const data = JSON.parse(text);
      if (data && typeof data === "object") {
        return { ok: true, path: examplePath, data, error: "" };
      }
    } catch {
      // ignore
    }
  }
  return { ok: true, path: HF_ISSUE_CONFIG_FILENAME, data: DEFAULT_HF_ISSUE_CONFIG, error: "" };
}

function getHfIssueSettings() {
  const loaded = loadLocalHfIssueConfig();
  const data = loaded.data || {};
  const thresholds = data.thresholds && typeof data.thresholds === "object" ? data.thresholds : {};
  return {
    ok: loaded.ok,
    path: loaded.path,
    enabled: data.enabled !== false,
    notifyWindows: data.notifyWindows !== false,
    thresholds: {
      days7: Number(thresholds.days7) > 0 ? Number(thresholds.days7) : 3,
      days30: Number(thresholds.days30) > 0 ? Number(thresholds.days30) : 5
    },
    categories: Array.isArray(data.categories) ? data.categories : DEFAULT_HF_ISSUE_CONFIG.categories
  };
}

const BURST_OUTBREAK_CONFIG_FILENAME = "burst-outbreak.local.json";
const BURST_OUTBREAK_CONFIG_EXAMPLE = "burst-outbreak.local.json.example";

const DEFAULT_BURST_OUTBREAK_CONFIG = {
  enabled: true,
  notifyWindows: true,
  windowMinutes: 15,
  minDistinctSites: 4,
  categories: [
    { id: "receipt_printer", label: "小票机", terms: ["小票机", "热敏", "标签机", "打印机"] },
    { id: "network_cut", label: "断网/没网", terms: ["断网", "没网", "整仓断网", "offline", "Offline"] },
    { id: "network", label: "网络", terms: ["网络", "网络卡顿", "Network", "network", "WIFI", "wifi", "WiFi"] },
    { id: "pda", label: "PDA", terms: ["PDA", "pda", "扫码枪", "手持", "扫码"] }
  ]
};

function getBurstOutbreakConfigCandidatePaths() {
  return [
    path.join(__dirname, BURST_OUTBREAK_CONFIG_FILENAME),
    path.join(app.getPath("userData"), BURST_OUTBREAK_CONFIG_FILENAME)
  ];
}

function loadLocalBurstOutbreakConfig() {
  for (const configPath of getBurstOutbreakConfigCandidatePaths()) {
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
  const examplePath = path.join(__dirname, BURST_OUTBREAK_CONFIG_EXAMPLE);
  if (fs.existsSync(examplePath)) {
    try {
      const text = fs.readFileSync(examplePath, "utf8").replace(/^\uFEFF/, "");
      const data = JSON.parse(text);
      if (data && typeof data === "object") {
        return { ok: true, path: examplePath, data, error: "" };
      }
    } catch {
      // ignore
    }
  }
  return { ok: true, path: BURST_OUTBREAK_CONFIG_FILENAME, data: DEFAULT_BURST_OUTBREAK_CONFIG, error: "" };
}

function getBurstOutbreakSettings() {
  const loaded = loadLocalBurstOutbreakConfig();
  const data = loaded.data || {};
  return {
    ok: loaded.ok,
    path: loaded.path,
    enabled: data.enabled !== false,
    notifyWindows: data.notifyWindows !== false,
    windowMinutes: Number(data.windowMinutes) > 0 ? Number(data.windowMinutes) : 15,
    minDistinctSites: Number(data.minDistinctSites) > 0 ? Number(data.minDistinctSites) : 4,
    categories: Array.isArray(data.categories) ? data.categories : DEFAULT_BURST_OUTBREAK_CONFIG.categories
  };
}

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
  const rgIds = parseRgIds(data);
  return {
    authorization,
    username,
    env,
    rgIds,
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
    return `API 配置文件无效（${p}）：${creds.configError}。请到菜单「文件 → API 设置…」重新填写。`;
  }
  if (!creds.configLoaded) {
    return `API 未配置：请到菜单「文件 → API 设置…」填写令牌与 MIS（配置文件：${p}）`;
  }
  return `API 未配置：请到菜单「文件 → API 设置…」填写 authorization`;
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

/** 解析表单/字符串中的 rgIds */
function parseRgIdsInput(raw) {
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
  }
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/[,，\s]+/)
    .map((n) => Number(String(n).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * 将 API 配置写入默认路径（UTF-8 无 BOM，合法 JSON）
 * @param {{ authorization?: string, username?: string, env?: string, rgIds?: string|number[] }} payload
 */
function saveApiConfigFromForm(payload) {
  const authorization = String(payload?.authorization || "").trim();
  const username = sanitizeUsername(payload?.username || "");
  const envRaw = String(payload?.env || "prod")
    .trim()
    .toLowerCase();
  const env = envRaw === "test" ? "test" : "prod";
  let rgIds = parseRgIdsInput(payload?.rgIds);
  if (!rgIds.length) {
    rgIds = DEFAULT_RG_IDS.slice();
  }

  if (!authorization) {
    return { ok: false, path: getDefaultApiConfigPath(), message: "请填写 authorization 令牌" };
  }
  if (!username) {
    return { ok: false, path: getDefaultApiConfigPath(), message: "请填写 username（MIS）" };
  }

  const configPath = getDefaultApiConfigPath();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const data = { authorization, username, env, rgIds };
    fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return {
      ok: true,
      path: configPath,
      message: "API 配置已保存，下次拉单即生效。",
      data: { authorization, username, env, rgIds }
    };
  } catch (err) {
    return {
      ok: false,
      path: configPath,
      message: err instanceof Error ? err.message : String(err)
    };
  }
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
  checkForUpdates();
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
    username: creds.username || "",
    rgIds: creds.rgIds,
    message: creds.authorization ? "" : getApiConfigHint()
  };
});

ipcMain.handle("get-tt-api-config", async () => {
  const loaded = loadLocalApiConfig();
  const creds = getApiCredentials();
  const data = loaded.data || {};
  const authorization = String(
    data.authorization || data.TT_API_AUTHORIZATION || ""
  ).trim();
  const username = sanitizeUsername(
    data.username || data.TT_API_USERNAME || creds.username || ""
  );
  const envRaw = String(data.env || data.TT_API_ENV || creds.env || "prod")
    .trim()
    .toLowerCase();
  const env = envRaw === "test" ? "test" : "prod";
  const fileRg = parseRgIdsInput(data.rgIds ?? data.RG_IDS ?? data.rg_ids);
  const rgIds = fileRg.length ? fileRg : creds.rgIds || DEFAULT_RG_IDS.slice();
  return {
    ok: loaded.ok && !!authorization,
    path: loaded.path || getDefaultApiConfigPath(),
    configError: loaded.error || "",
    authorization,
    username,
    env,
    rgIds,
    rgIdsText: rgIds.join(", "),
    message: authorization ? "" : getApiConfigHint()
  };
});

ipcMain.handle("save-tt-api-config", async (_event, payload) => {
  try {
    return saveApiConfigFromForm(payload || {});
  } catch (err) {
    return {
      ok: false,
      path: getDefaultApiConfigPath(),
      message: err instanceof Error ? err.message : String(err)
    };
  }
});

ipcMain.handle("get-hf-issue-config", async () => {
  const cfg = getHfIssueSettings();
  return {
    ok: cfg.ok,
    path: cfg.path,
    enabled: cfg.enabled,
    notifyWindows: cfg.notifyWindows,
    thresholds: cfg.thresholds,
    categories: cfg.categories
  };
});

ipcMain.handle("get-burst-outbreak-config", async () => {
  const cfg = getBurstOutbreakSettings();
  return {
    ok: cfg.ok,
    path: cfg.path,
    enabled: cfg.enabled,
    notifyWindows: cfg.notifyWindows,
    windowMinutes: cfg.windowMinutes,
    minDistinctSites: cfg.minDistinctSites,
    categories: cfg.categories
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

const PM_CSV_REMOTE_URL =
  "https://s3plus.sankuai.com/static-bucket/4000%20Agent%20Tools/Synchronize/PM.csv";
const PM_CSV_FILENAME = "PM.csv";

function getPmCsvPreferredPaths() {
  const names = [PM_CSV_FILENAME];
  /** @type {string[]} */
  const dirs = [];
  try {
    if (app.isPackaged) {
      dirs.push(path.dirname(process.execPath));
    } else {
      dirs.push(__dirname);
    }
  } catch (_) {}
  try {
    dirs.push(app.getPath("userData"));
  } catch (_) {}
  const out = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

function looksLikePmCsv(content) {
  const first = String(content || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return false;
  const header = first.toLowerCase();
  if (!header.includes("region_key")) return false;
  // 旧：members_mis；新一人一行：member_mis / mis
  return (
    header.includes("members_mis") ||
    header.includes("member_mis") ||
    /(^|,)\s*mis\s*(,|$)/.test(header)
  );
}

function downloadTextUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === "http:" ? http : https;
    const req = client.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: `${u.pathname}${u.search || ""}`,
        method: "GET",
        headers: {
          Accept: "text/csv,text/plain,*/*",
          "User-Agent": "TTDesktop1.0-PM-Sync"
        },
        timeout: 30000
      },
      (res) => {
        const code = Number(res.statusCode || 0);
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          downloadTextUrl(res.headers.location).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          if (code < 200 || code >= 300) {
            reject(new Error(`HTTP ${code}: ${text.slice(0, 160)}`));
            return;
          }
          resolve(text);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("下载超时"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * 从 S3Plus 拉取 PM.csv，写入程序目录（安装目录旁；写失败则落到 userData）
 */
async function syncPmCsvFromRemote() {
  const content = await downloadTextUrl(PM_CSV_REMOTE_URL);
  if (!looksLikePmCsv(content)) {
    return {
      ok: false,
      message:
        "远程 PM.csv 格式不正确（需含 region_key，以及 members_mis 或 member_mis）"
    };
  }
  const candidates = getPmCsvPreferredPaths();
  let lastErr = "";
  for (const target of candidates) {
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, "utf8");
      return {
        ok: true,
        path: target,
        content,
        url: PM_CSV_REMOTE_URL,
        bytes: Buffer.byteLength(content, "utf8")
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, message: lastErr || "无法写入本地 PM.csv" };
}

ipcMain.handle("sync-pm-csv-from-s3", async () => {
  try {
    return await syncPmCsvFromRemote();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("get-pm-csv-status", async () => {
  const candidates = getPmCsvPreferredPaths();
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const content = await fs.promises.readFile(p, "utf8");
      if (!looksLikePmCsv(content)) continue;
      const st = await fs.promises.stat(p);
      return { ok: true, path: p, mtimeMs: st.mtimeMs, bytes: st.size };
    } catch (_) {}
  }
  return { ok: false, path: "", message: "本地尚无 PM.csv" };
});

function pushCacheItem(items, name, status, detail) {
  items.push({
    name: String(name || ""),
    status: status === "ok" || status === "skip" || status === "fail" ? status : "fail",
    detail: String(detail || "").trim()
  });
}

function isPathBusyError(err) {
  const code = String(err?.code || "").toUpperCase();
  if (code === "EPERM" || code === "EBUSY" || code === "EACCES") return true;
  const msg = String(err instanceof Error ? err.message : err || "").toLowerCase();
  return (
    msg.includes("eperm") ||
    msg.includes("ebusy") ||
    msg.includes("operation not permitted") ||
    msg.includes("resource busy") ||
    msg.includes("being used by another process")
  );
}

function safeRmPath(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) {
      return { ok: false, skipped: true, busy: false, detail: "不存在" };
    }
    const st = fs.statSync(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    return {
      ok: true,
      skipped: false,
      busy: false,
      detail: st.isDirectory() ? `已删除目录 ${targetPath}` : `已删除文件 ${targetPath}`
    };
  } catch (err) {
    if (isPathBusyError(err)) {
      return {
        ok: false,
        skipped: true,
        busy: true,
        detail: `跳过（程序运行中无法删除）：${targetPath}`
      };
    }
    return {
      ok: false,
      skipped: false,
      busy: false,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

function statusFromRmResult(r) {
  if (r?.ok) return "ok";
  if (r?.busy || r?.skipped) return "skip";
  return "fail";
}

function listUpdaterCacheDirs() {
  const out = [];
  const push = (p) => {
    const s = String(p || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  try {
    push(path.join(app.getPath("userData"), "..", "ttdesktop-electron-updater"));
  } catch (_) {}
  try {
    if (process.env.LOCALAPPDATA) {
      push(path.join(process.env.LOCALAPPDATA, "ttdesktop-electron-updater"));
    }
  } catch (_) {}
  try {
    push(path.join(app.getPath("temp"), "ttdesktop-electron-updater"));
  } catch (_) {}
  return out;
}

/**
 * 清理运行缓存（不清 API 配置 / 界面设置 / TT 登录 Cookie）
 * @returns {Promise<{ ok: boolean, items: Array<{name:string,status:string,detail:string}> }>}
 */
async function clearAppCaches() {
  /** @type {Array<{name:string,status:string,detail:string}>} */
  const items = [];

  // 1) 主窗口 HTTP 缓存
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.session.clearCache();
      pushCacheItem(items, "主窗口 HTTP 缓存", "ok", "session.clearCache() 完成");
    } else {
      await session.defaultSession.clearCache();
      pushCacheItem(items, "主窗口 HTTP 缓存", "ok", "defaultSession.clearCache() 完成");
    }
  } catch (err) {
    pushCacheItem(
      items,
      "主窗口 HTTP 缓存",
      "fail",
      err instanceof Error ? err.message : String(err)
    );
  }

  // 2) 内置 TT 浏览器 HTTP 缓存（保留 Cookie/登录）
  try {
    const guest = session.fromPartition(TT_GUEST_PARTITION);
    await guest.clearCache();
    try {
      await guest.clearStorageData({
        storages: ["appcache", "shadercache", "cachestorage", "serviceworkers"]
      });
    } catch (_) {}
    pushCacheItem(
      items,
      "内置 TT 浏览器 HTTP 缓存",
      "ok",
      `partition=${TT_GUEST_PARTITION}（已保留登录 Cookie）`
    );
  } catch (err) {
    pushCacheItem(
      items,
      "内置 TT 浏览器 HTTP 缓存",
      "fail",
      err instanceof Error ? err.message : String(err)
    );
  }

  // 3) PM 表本地文件缓存
  const pmPaths = getPmCsvPreferredPaths();
  let pmHit = false;
  for (const p of pmPaths) {
    const r = safeRmPath(p);
    if (r.skipped && !r.busy) continue;
    pmHit = true;
    pushCacheItem(items, "PM 表本地缓存", statusFromRmResult(r), r.detail);
  }
  if (!pmHit) {
    pushCacheItem(items, "PM 表本地缓存", "skip", "未找到本地 PM.csv");
  }

  // 4) 自动更新下载缓存
  let updaterHit = false;
  for (const dir of listUpdaterCacheDirs()) {
    const r = safeRmPath(dir);
    if (r.skipped && !r.busy) continue;
    updaterHit = true;
    pushCacheItem(items, "自动更新下载缓存", statusFromRmResult(r), r.detail);
  }
  if (!updaterHit) {
    pushCacheItem(items, "自动更新下载缓存", "skip", "未找到 updater 缓存目录");
  }

  // 5) Chromium Code/GPU Cache 目录（userData 下常见缓存）
  const userDataCaches = [];
  try {
    userDataCaches.push(path.join(app.getPath("userData"), "Cache"));
    userDataCaches.push(path.join(app.getPath("userData"), "Code Cache"));
    userDataCaches.push(path.join(app.getPath("userData"), "GPUCache"));
  } catch (_) {}
  let diskCacheHit = false;
  for (const dir of userDataCaches) {
    const r = safeRmPath(dir);
    if (r.skipped && !r.busy) continue;
    diskCacheHit = true;
    pushCacheItem(items, "程序磁盘缓存目录", statusFromRmResult(r), r.detail);
  }
  if (!diskCacheHit) {
    pushCacheItem(items, "程序磁盘缓存目录", "skip", "userData 下无 Cache/Code Cache/GPUCache");
  }

  const failed = items.some((x) => x.status === "fail");
  return { ok: !failed, items };
}

async function clearAppCachesWithConfirm() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "清理缓存",
    message: "确定清理程序运行缓存吗？",
    detail:
      "将清理：\n" +
      "· 主窗口 / 内置 TT 的 HTTP 缓存\n" +
      "· 本地 PM.csv 缓存（随后可重新同步）\n" +
      "· 自动更新下载缓存\n" +
      "· 程序磁盘缓存目录\n" +
      "· 内存中的城市库/扫描状态（由界面侧清理）\n\n" +
      "不会清理：\n" +
      "· API 配置（令牌/MIS/工单组）\n" +
      "· 界面设置与话术模板\n" +
      "· TT 登录 Cookie（一般不用重新登录）",
    buttons: ["清理缓存", "取消"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (response !== 0) return;

  const result = await clearAppCaches();
  try {
    mainWindow.webContents.send("app-cache-cleared", result);
  } catch (_) {}
}

ipcMain.handle("clear-app-caches", async () => {
  try {
    return await clearAppCaches();
  } catch (err) {
    return {
      ok: false,
      items: [
        {
          name: "清理缓存",
          status: "fail",
          detail: err instanceof Error ? err.message : String(err)
        }
      ]
    };
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

// ─── 自动更新（S3Plus generic，与 package.json build.publish 一致）────────────────
const UPDATE_FEED_URL = "https://s3plus.sankuai.com/static-bucket/4000%20Agent%20Tools/";
let updateCheckManual = false;

function logUpdateEvent(message, err) {
  const line = err
    ? `[update] ${message}: ${err instanceof Error ? err.message : String(err)}`
    : `[update] ${message}`;
  console.log(line);
  try {
    const { dir, filePath } = getLogFilePath();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch (_) {}
}

// 不自动下载，让用户自己决定是否更新
autoUpdater.autoDownload = false;
// 退出时自动安装已下载的更新
autoUpdater.autoInstallOnAppQuit = true;
try {
  autoUpdater.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });
} catch (_) {}

// 发现新版本 → 弹窗询问用户
autoUpdater.on("update-available", (info) => {
  updateCheckManual = false;
  if (!mainWindow) return;
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "发现新版本",
    message: `TTDesktop1.0 有新版本 v${info.version} 可用`,
    detail: "是否立即下载并更新？下载完成后重启程序即可生效，不影响当前使用。",
    buttons: ["立即更新", "稍后再说"],
    defaultId: 0,
    cancelId: 1
  }).then(({ response }) => {
    if (response === 0) {
      autoUpdater.downloadUpdate();
    }
  });
});

// 没有新版本 → 手动检查时提示，启动时静默
autoUpdater.on("update-not-available", (info) => {
  if (!updateCheckManual || !mainWindow) return;
  updateCheckManual = false;
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "检查更新",
    message: "当前已是最新版本",
    detail: `TTDesktop1.0 v${info?.version || app.getVersion()}`,
    buttons: ["确定"]
  });
});

// 下载进度 → 发给渲染进程（可选，用于显示进度条）
autoUpdater.on("download-progress", (progress) => {
  mainWindow?.webContents.send("update-download-progress", Math.floor(progress.percent));
});

// 下载完成 → 提示重启
autoUpdater.on("update-downloaded", () => {
  if (!mainWindow) return;
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "更新已就绪",
    message: "新版本已下载完成！",
    detail: "立即重启程序以完成更新，或稍后手动重启。",
    buttons: ["立即重启", "稍后重启"],
    defaultId: 0,
    cancelId: 1
  }).then(({ response }) => {
    if (response === 0) {
      allowQuit = true;
      autoUpdater.quitAndInstall();
    }
  });
});

// 更新出错 → 记录日志；手动检查时弹窗提示
autoUpdater.on("error", (err) => {
  logUpdateEvent("检查或下载失败", err);
  if (!updateCheckManual || !mainWindow) return;
  updateCheckManual = false;
  dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "检查更新失败",
    message: "暂时无法检查更新",
    detail: err instanceof Error ? err.message : String(err || "未知错误"),
    buttons: ["确定"]
  });
});

// 检查更新（仅打包后的正式版本才检查，开发模式跳过）
function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "检查更新",
        message: "开发模式不支持检查更新",
        detail: "请使用打包后的安装版验证自动更新。",
        buttons: ["确定"]
      });
    }
    return;
  }
  updateCheckManual = manual;
  const run = () => {
    logUpdateEvent(manual ? `手动检查更新（${UPDATE_FEED_URL}）` : `启动后自动检查更新（${UPDATE_FEED_URL}）`);
    autoUpdater.checkForUpdates().catch((err) => {
      logUpdateEvent("checkForUpdates 调用失败", err);
      if (manual && mainWindow) {
        updateCheckManual = false;
        dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "检查更新失败",
          message: "暂时无法检查更新",
          detail: err instanceof Error ? err.message : String(err),
          buttons: ["确定"]
        });
      }
    });
  };
  if (manual) {
    run();
    return;
  }
  // 延迟 5 秒再检查，避免与启动时的 TT 页面加载争抢资源
  setTimeout(run, 5000);
}
// ─────────────────────────────────────────────────────────────────────────────

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
