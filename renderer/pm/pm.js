/**
 * 按地区拉 PM（阶段 5）
 */
(function initPm(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;
  const ttExecuteJavaScript = TD.ttBridge.ttExecuteJavaScript.bind(TD.ttBridge);
  const Guard = TD.guard;
  const { STORAGE_KEYS } = C;

  let pmPullInProgress = false;

  let deps = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getWebviewReady: () => false,
    getTtWebview: () => null,
    getBusy: () => false,
    isNormalizeInProgress: () => false,
    isPriorityBatchInProgress: () => false,
    getTickets: () => [],
    handleTicketClick: async () => false,
    refreshTickets: async () => {},
    setActiveLeftTab: () => {},
    buildTitleNormalizeInspectScript: () => ""
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  function sleep(ms) {
    return deps.sleep(ms);
  }

/** @typedef {{ name: string, mis: string }} PmMember */
/** @typedef {{ enabled: boolean, region_key: string, members: PmMember[], note: string }} PmCsvRule */
/** @typedef {{ line: number, region: string, raw: string, reason: string }} PmParseWarning */

function isTruthyEnabled(cell) {
  const s = String(cell == null ? "1" : cell).trim();
  if (!s) return true;
  return s === "1" || s.toLowerCase() === "true" || s === "是" || s.toLowerCase() === "yes";
}

/** 多人分隔：; ； 以及 : / ::（Excel 常误用冒号） */
function splitPmMembersCell(membersCell) {
  return String(membersCell || "")
    .replace(/::+/g, ";")
    .split(/[;；:|｜、，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizePmMisToken(tok) {
  const s = String(tok || "").trim();
  if (!s) return "";
  const seg = s.split("/").map((x) => x.trim()).filter(Boolean);
  const last = seg.length ? seg[seg.length - 1] : s;
  return String(last || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

function looksLikeMisToken(tok) {
  const s = String(tok || "").trim().toLowerCase();
  if (!s) return false;
  if (/^wb_[a-z0-9._-]{2,}$/i.test(s)) return true;
  // 纯 MIS：字母开头，允许数字下划线点，长度合理，且不含中文
  if (/[\u4e00-\u9fff]/.test(s)) return false;
  return /^[a-z][a-z0-9._-]{1,40}$/i.test(s);
}

/**
 * 智能解析单人 token（方案 A）
 * 支持：姓名/MIS、姓名 MIS、姓名wb_mis 粘连、仅 MIS
 * @returns {{ name: string, mis: string, ok: boolean, reason?: string, mode?: string }}
 */
function parsePmMemberToken(tok) {
  let s = String(tok || "").trim();
  if (!s) return { name: "", mis: "", ok: false, reason: "empty" };
  // 去掉包裹引号
  s = s.replace(/^["']+|["']+$/g, "").trim();
  if (!s) return { name: "", mis: "", ok: false, reason: "empty" };

  // 1) 标准：姓名/MIS（斜杠）
  if (s.includes("/")) {
    const parts = s.split("/").map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const mis = normalizePmMisToken(parts[parts.length - 1]);
      const name = parts
        .slice(0, -1)
        .join("/")
        .replace(/^\/+/, "")
        .trim();
      if (mis) return { name, mis, ok: true, mode: "slash" };
      return { name: "", mis: "", ok: false, reason: "bad_mis_after_slash", raw: s };
    }
  }

  // 2) 空格/全角空格分隔：姓名 MIS
  {
    const parts = s.split(/[\s\u3000]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (looksLikeMisToken(last)) {
        return {
          name: parts.slice(0, -1).join(" ").trim(),
          mis: normalizePmMisToken(last),
          ok: true,
          mode: "space"
        };
      }
    }
  }

  // 3) 粘连：中文/英文名 + wb_xxx 或 名+纯mis（如 胡海wb_huhai）
  {
    const mWb = s.match(/^(.*?)(wb_[a-z0-9._-]{2,})$/i);
    if (mWb) {
      const name = String(mWb[1] || "").trim();
      const mis = normalizePmMisToken(mWb[2]);
      if (mis) return { name, mis, ok: true, mode: name ? "stuck_wb" : "mis_only" };
    }
    // 结尾是像 MIS 的英文段，前面有中文
    const mTail = s.match(/^([\u4e00-\u9fffA-Za-z·•.\s]{1,40}?)([a-z][a-z0-9._-]{2,40})$/i);
    if (mTail && /[\u4e00-\u9fff]/.test(mTail[1] || "") && looksLikeMisToken(mTail[2])) {
      return {
        name: String(mTail[1] || "").trim(),
        mis: normalizePmMisToken(mTail[2]),
        ok: true,
        mode: "stuck_mis"
      };
    }
  }

  // 4) 仅 MIS
  if (looksLikeMisToken(s)) {
    return { name: "", mis: normalizePmMisToken(s), ok: true, mode: "mis_only" };
  }

  return { name: "", mis: "", ok: false, reason: "unrecognized", raw: s };
}

function formatPmMemberLabel(m) {
  if (!m) return "";
  if (m.name && m.mis) return `${m.name}/${m.mis}`;
  return m.mis || m.name || "";
}

function splitCsvLine(line) {
  // 简单 CSV：按逗号切；若有引号字段则保留逗号
  const s = String(line || "");
  if (!s.includes('"')) return s.split(",").map((c) => c.trim());
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') {
      if (inQ && s[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function mergeMemberIntoMap(memberMap, member) {
  if (!member?.mis) return;
  const prev = memberMap.get(member.mis);
  if (!prev) {
    memberMap.set(member.mis, { name: member.name || "", mis: member.mis });
    return;
  }
  // 已有条目缺姓名时，用新解析补上
  if (!prev.name && member.name) prev.name = member.name;
}

/**
 * 解析 PM.csv
 * - 旧格式：enabled,region_key,members_mis,note（一格多人）
 * - 新格式（方案 B）：enabled,region_key,member_name,member_mis,note（一人一行，同地区自动合并）
 * - 智能解析（方案 A）：容错多种写法；返回 warnings 供校验报告（方案 D）
 */
function parsePmCsvContent(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) {
    return { rules: [], error: "empty", format: "", warnings: [], stats: null };
  }

  const header = splitCsvLine(lines[0]).map((c) => c.trim().toLowerCase());
  const idxEn = header.indexOf("enabled");
  const idxRk = header.indexOf("region_key");
  const idxMm = header.indexOf("members_mis");
  const idxName = header.findIndex((h) => h === "member_name" || h === "name" || h === "姓名");
  const idxMis = header.findIndex((h) => h === "member_mis" || h === "mis" || h === "账号");
  const idxNote = header.indexOf("note");

  const rowPerMember = idxRk >= 0 && idxMis >= 0 && idxMm < 0;
  const legacy = idxRk >= 0 && idxMm >= 0;
  if (!rowPerMember && !legacy) {
    return { rules: [], error: "bad_header", format: "", warnings: [], stats: null };
  }

  const format = rowPerMember ? "row_per_member" : "legacy";
  /** @type {Map<string, { enabled: boolean, region_key: string, members: Map<string, PmMember>, note: string, lines: number[] }>} */
  const regionMap = new Map();
  /** @type {PmParseWarning[]} */
  const warnings = [];
  let skippedTokens = 0;
  let misOnlyCount = 0;
  let parsedTokenCount = 0;

  function ensureRegion(region_key, enabled, note, lineNo) {
    const key = String(region_key || "").trim();
    let g = regionMap.get(key);
    if (!g) {
      g = {
        enabled: !!enabled,
        region_key: key,
        members: new Map(),
        note: String(note || "").trim(),
        lines: [lineNo]
      };
      regionMap.set(key, g);
      return g;
    }
    // 任一行为启用则整地区启用；note 取第一条非空
    if (enabled) g.enabled = true;
    if (!g.note && note) g.note = String(note).trim();
    g.lines.push(lineNo);
    return g;
  }

  for (let i = 1; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const parts = splitCsvLine(lines[i]);
    const enabled = isTruthyEnabled(idxEn >= 0 ? parts[idxEn] : "1");
    const region_key = String(parts[idxRk] || "").trim();
    if (!region_key) {
      warnings.push({ line: lineNo, region: "", raw: lines[i], reason: "缺少 region_key" });
      continue;
    }
    const note = idxNote >= 0 ? String(parts[idxNote] || "").trim() : "";

    if (rowPerMember) {
      const name = idxName >= 0 ? String(parts[idxName] || "").trim() : "";
      const misRaw = String(parts[idxMis] || "").trim();
      const mis = normalizePmMisToken(misRaw);
      if (!mis) {
        skippedTokens += 1;
        warnings.push({
          line: lineNo,
          region: region_key,
          raw: misRaw || name || lines[i],
          reason: "一人一行缺少有效 member_mis"
        });
        continue;
      }
      const g = ensureRegion(region_key, enabled, note, lineNo);
      mergeMemberIntoMap(g.members, { name, mis });
      parsedTokenCount += 1;
      if (!name) misOnlyCount += 1;
      continue;
    }

    // legacy：一格多人
    let membersCell = "";
    if (idxNote > idxMm) {
      membersCell = parts.slice(idxMm, idxNote).join(",").trim();
    } else {
      membersCell = parts.slice(idxMm).join(",").trim();
    }
    const g = ensureRegion(region_key, enabled, note, lineNo);
    if (!membersCell) {
      warnings.push({ line: lineNo, region: region_key, raw: "", reason: "members_mis 为空" });
      continue;
    }
    for (const part of splitPmMembersCell(membersCell)) {
      const m = parsePmMemberToken(part);
      if (!m.ok || !m.mis) {
        skippedTokens += 1;
        warnings.push({
          line: lineNo,
          region: region_key,
          raw: part,
          reason: m.reason === "unrecognized" ? "无法识别为「姓名/MIS」或 MIS" : m.reason || "解析失败"
        });
        continue;
      }
      mergeMemberIntoMap(g.members, { name: m.name || "", mis: m.mis });
      parsedTokenCount += 1;
      if (!m.name) misOnlyCount += 1;
    }
  }

  const rules = Array.from(regionMap.values()).map((g) => ({
    enabled: g.enabled,
    region_key: g.region_key,
    members: Array.from(g.members.values()),
    note: g.note
  }));

  const enabledRules = rules.filter((r) => r.enabled);
  const stats = {
    format,
    regions: rules.length,
    enabledRegions: enabledRules.length,
    members: enabledRules.reduce((n, r) => n + (r.members?.length || 0), 0),
    parsedTokens: parsedTokenCount,
    skippedTokens,
    misOnlyCount,
    warningCount: warnings.length
  };

  return { rules, error: "", format, warnings, stats };
}

/** 方案 D：把解析结果写到执行日志 */
function logPmCsvValidationReport(parsed, { silent = false, source = "同步" } = {}) {
  if (!parsed || parsed.error === "empty") {
    if (!silent) log(`PM 表${source}失败：文件为空。`, "error");
    return;
  }
  if (parsed.error === "bad_header") {
    if (!silent) {
      log(
        `PM 表${source}失败：表头不正确。\n` +
          `  支持旧格式：enabled,region_key,members_mis,note\n` +
          `  或一人一行：enabled,region_key,member_name,member_mis,note`,
        "error"
      );
    }
    return;
  }
  const st = parsed.stats || {};
  const fmtLabel = st.format === "row_per_member" ? "一人一行" : "地区多人合格";
  const head =
    `PM 表${source}完成：格式「${fmtLabel}」· 启用 ${st.enabledRegions || 0}/${st.regions || 0} 个地区 · ` +
    `人员 ${st.members || 0} 人` +
    (st.misOnlyCount ? `（其中仅 MIS ${st.misOnlyCount} 人）` : "");
  if (!silent) log(head, "success");

  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  if (!warnings.length) return;

  const maxShow = silent ? 3 : 12;
  const lines = warnings.slice(0, maxShow).map((w) => {
    const loc = w.region ? `第${w.line}行「${w.region}」` : `第${w.line}行`;
    const raw = w.raw ? `「${w.raw}」` : "";
    return `  · ${loc}${raw}：${w.reason}`;
  });
  const more =
    warnings.length > maxShow ? `\n  · …另有 ${warnings.length - maxShow} 条警告未显示` : "";
  log(
    `PM 表校验警告 ${warnings.length} 条（已跳过无效项，不影响已识别人员）：\n${lines.join("\n")}${more}`,
    "warning"
  );
}

function matchPmRuleForTicket(rules, architectureRaw, title) {
  const list = (Array.isArray(rules) ? rules : []).filter((r) => r && r.enabled && r.region_key);
  const ap = String(architectureRaw || "").replace(/\s+/g, "");
  const tt = String(title || "").replace(/\s+/g, "");
  const sorted = [...list].sort((a, b) => String(b.region_key).length - String(a.region_key).length);
  for (const r of sorted) {
    const k = String(r.region_key || "").replace(/\s+/g, "");
    if (k && ap.includes(k)) return r;
  }
  for (const r of sorted) {
    const k = String(r.region_key || "").replace(/\s+/g, "");
    if (k && tt.includes(k)) return r;
  }
  return null;
}

function setPmPullBusy(busy) {
  const b = !!busy;
  pmPullInProgress = b;
  if (D.pmCsvSelectBtn) D.pmCsvSelectBtn.disabled = b;
  if (D.pmPullByRegionBtn) D.pmPullByRegionBtn.disabled = b;
  if (D.ticketTitleNormalizeBtn) D.ticketTitleNormalizeBtn.disabled = b;
  if (D.ticketPriorityApplyBtn) D.ticketPriorityApplyBtn.disabled = b;
  if (D.ticketPriorityBatchBtn) D.ticketPriorityBatchBtn.disabled = b;
  if (D.ticketAutoPriorityBoostBtn) D.ticketAutoPriorityBoostBtn.disabled = b;
  if (D.ticketRefreshBtn) D.ticketRefreshBtn.disabled = b;
}

function updatePmCsvPathLabel(extra) {
  if (!D.pmCsvPathLabel) return;
  const p = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || "").trim();
  const hint = String(extra || "").trim();
  if (!p) {
    D.pmCsvPathLabel.textContent = hint || "PM配置：未同步";
    return;
  }
  D.pmCsvPathLabel.textContent = hint ? `PM配置：${p}（${hint}）` : `PM配置：${p}`;
}

/**
 * 从 S3Plus 拉取 PM.csv → 写入程序目录 → 自动记为当前配置
 * @param {{ silent?: boolean }} [options]
 */
async function syncPmCsvFromS3(options = {}) {
  const silent = !!options.silent;
  try {
    if (!silent) log("正在同步 PM 表…", "info");
    const res = await window.ttDesktopApi?.syncPmCsvFromS3?.();
    if (!res?.ok) {
      const st = await window.ttDesktopApi?.getPmCsvStatus?.();
      if (st?.ok && st.path) {
        localStorage.setItem(STORAGE_KEYS.pmCsvPath, st.path);
        updatePmCsvPathLabel("同步失败，使用本地缓存");
        if (!silent) {
          log(`PM 表同步失败，已改用本地缓存：${st.path}`, "warning");
        }
        return { ok: false, usedCache: true, path: st.path, message: res?.message || "" };
      }
      updatePmCsvPathLabel("同步失败");
      if (!silent) {
        log(`PM 表同步失败：${res?.message || "未知错误"}`, "error");
      }
      return { ok: false, usedCache: false, message: res?.message || "" };
    }

    const parsed = parsePmCsvContent(res.content || "");
    if (parsed.error === "bad_header" || parsed.error === "empty" || !parsed.rules.length) {
      updatePmCsvPathLabel("格式错误");
      logPmCsvValidationReport(parsed, { silent: false, source: "同步" });
      return { ok: false, message: parsed.error || "empty_rules" };
    }

    localStorage.setItem(STORAGE_KEYS.pmCsvPath, res.path || "");
    const enabledCount = parsed.rules.filter((r) => r.enabled).length;
    const memberCount = parsed.stats?.members || 0;
    updatePmCsvPathLabel(`已同步 · ${enabledCount} 地区 / ${memberCount} 人`);
    logPmCsvValidationReport(parsed, { silent, source: "同步" });
    return { ok: true, path: res.path, enabledCount, stats: parsed.stats, warnings: parsed.warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updatePmCsvPathLabel("同步异常");
    if (!silent) log(`PM 表同步异常：${TD.log.errText(err)}`, "error");
    return { ok: false, message: msg };
  }
}

/** 按钮入口：同步远程 PM 表 */
async function selectPmCsvFile() {
  return syncPmCsvFromS3({ silent: false });
}

async function ensurePmCsvReady() {
  try {
    const st = await window.ttDesktopApi?.getPmCsvStatus?.();
    if (st?.ok && st.path) {
      localStorage.setItem(STORAGE_KEYS.pmCsvPath, st.path);
      updatePmCsvPathLabel("本地已就绪");
    }
  } catch (_) {}
  setTimeout(() => {
    void syncPmCsvFromS3({ silent: true }).then((r) => {
      if (r?.ok || r?.usedCache) return;
      const p = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || "").trim();
      if (!p) log("PM 表尚未同步，可点击「同步PM表」手动拉取。", "warning");
    });
  }, 2500);
}

/**
 * 大象会话 → 添加成员 → 按 MIS 搜索 → 搜索结果须同时匹配 CSV 姓名+MIS → 一次确定
 * @param {PmMember[]} targets
 */
function buildPullPmMembersScript(targets) {
  const safe = JSON.stringify(
    (Array.isArray(targets) ? targets : []).filter((t) => t && t.mis)
  );
  return `
    (async () => {
      const targets = ${safe};
      const logs = [];
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      function norm(t) { return String(t || '').trim().replace(/\\s+/g, ' '); }
      function visible(el) {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function clickElephantSessionTab() {
        const spans = Array.from(document.querySelectorAll('span'));
        for (const sp of spans) {
          if (norm(sp.textContent) !== '大象会话') continue;
          const tab =
            sp.closest('[role="tab"]') ||
            sp.closest('.mtd-tabs-item') ||
            sp.closest('li') ||
            sp.closest('button') ||
            sp.parentElement;
          if (!tab) continue;
          try {
            tab.click();
            return true;
          } catch {
            // ignore
          }
        }
        return false;
      }
      async function waitAndClickAddMember(maxMs) {
        const end = Date.now() + maxMs;
        while (Date.now() < end) {
          const spans = Array.from(document.querySelectorAll('span.text, span'));
          for (const sp of spans) {
            if (norm(sp.textContent) !== '添加成员') continue;
            const host =
              sp.closest('button') ||
              sp.closest('[role="button"]') ||
              sp.closest('a') ||
              sp.parentElement;
            if (host && visible(host)) {
              try {
                host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                host.click();
              } catch {
                // ignore
              }
              return true;
            }
          }
          await sleep(120);
        }
        return false;
      }
      function findAddMemberModal() {
        const roots = Array.from(document.querySelectorAll('.mtd-modal-wrap, .mtd-modal, [role="dialog"]'));
        let best = null;
        let bestZ = -1;
        for (const m of roots) {
          if (!visible(m)) continue;
          const txt = m.textContent || '';
          if (!txt.includes('添加成员')) continue;
          let z = 0;
          try {
            z = Number(window.getComputedStyle(m).zIndex) || 0;
          } catch {
            z = 0;
          }
          if (z >= bestZ) {
            bestZ = z;
            best = m;
          }
        }
        return best;
      }
      async function waitModal(maxMs) {
        const end = Date.now() + maxMs;
        while (Date.now() < end) {
          const m = findAddMemberModal();
          if (m) return m;
          await sleep(100);
        }
        return null;
      }
      function findSearchInput(modal) {
        const roots = [modal, document.body].filter(Boolean);
        for (const root of roots) {
          const inputs = root.querySelectorAll('input');
          for (const ip of inputs) {
            const ph = String(ip.getAttribute('placeholder') || '');
            if (ph.includes('MIS') || ph.includes('mis') || ph.includes('姓名')) return ip;
          }
        }
        for (const root of roots) {
          const ip = root.querySelector('input[type="text"], input.mtd-input');
          if (ip) return ip;
        }
        return null;
      }
      function setInputValue(el, val) {
        if (!el || el.tagName !== 'INPUT') return;
        const prev = el.value;
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        const tr = el._valueTracker;
        if (tr && typeof tr.setValue === 'function') tr.setValue(prev);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof InputEvent === 'function') {
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: val })
          );
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      function parseResultNameText(raw) {
        const t = String(raw || '').trim();
        const idx = t.lastIndexOf('/');
        if (idx < 0) return { name: '', mis: '', raw: t };
        return {
          name: t.slice(0, idx).replace(/^\\/+/, '').trim(),
          mis: t.slice(idx + 1).trim().toLowerCase(),
          raw: t
        };
      }

      function normalizeMisKey(m) {
        return String(m || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
      }

      function normalizeNameKey(n) {
        return String(n || '').replace(/\\s+/g, '').trim();
      }

      function stripMisPrefix(m) {
        return normalizeMisKey(m).replace(/^wb_/, '');
      }

      /** MIS 一致：完全相同，或去掉 wb_ 前缀后相同（zhangjunjie25 ↔ wb_zhangjunjie25） */
      function misKeysEquivalent(want, got) {
        const a = normalizeMisKey(want);
        const b = normalizeMisKey(got);
        if (!a || !b) return false;
        if (a === b) return true;
        return stripMisPrefix(want) === stripMisPrefix(got);
      }

      /** 姓名一致：完全相同，或双方互相包含（至少 2 字，避免误匹配） */
      function nameKeysEquivalent(want, got) {
        const a = normalizeNameKey(want);
        const b = normalizeNameKey(got);
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
        return false;
      }

      function candidateStrictMatch(cand, target) {
        return misKeysEquivalent(target.mis, cand.mis) && nameKeysEquivalent(target.name, cand.name);
      }

      function collectVisibleCandidates(modal) {
        const root = modal || document.body;
        const lis = Array.from(root.querySelectorAll('li'));
        const out = [];
        for (const li of lis) {
          if (!visible(li)) continue;
          const nm = li.querySelector('span.name');
          if (!nm) continue;
          const raw = String(nm.textContent || '').trim();
          if (!raw) continue;
          const parsed = parseResultNameText(raw);
          out.push({ ...parsed, el: li });
        }
        return out;
      }

      function collectStrictMatches(modal, target) {
        return collectVisibleCandidates(modal).filter((c) => candidateStrictMatch(c, target));
      }

      function collectMisMatches(modal, target) {
        return collectVisibleCandidates(modal).filter((c) => misKeysEquivalent(target.mis, c.mis));
      }

      function clickCandidate(one) {
        try {
          one.el.scrollIntoView({ block: 'center' });
          one.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          one.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          one.el.click();
        } catch {
          // ignore
        }
      }

      async function pickMatchedSuggestionForTarget(modal, target) {
        const wantMis = normalizeMisKey(target.mis);
        const wantName = normalizeNameKey(target.name);
        if (!wantMis) return { ok: false, reason: 'empty_mis' };
        const end = Date.now() + 8000;
        while (Date.now() < end) {
          if (wantName) {
            const strict = collectStrictMatches(modal, target);
            if (strict.length === 1) {
              clickCandidate(strict[0]);
              return { ok: true, picked: strict[0].raw, mode: 'strict' };
            }
            if (strict.length > 1) {
              const names = strict.map((m) => m.raw).slice(0, 5).join(' | ');
              return { ok: false, reason: 'ambiguous', detail: names, count: strict.length };
            }
          }

          const misOnly = collectMisMatches(modal, target);
          if (misOnly.length === 1) {
            clickCandidate(misOnly[0]);
            return {
              ok: true,
              picked: misOnly[0].raw,
              mode: wantName ? 'mis_only' : 'mis_only_config',
              configName: target.name || '',
              gotName: misOnly[0].name
            };
          }
          if (misOnly.length > 1) {
            if (wantName) {
              const byName = misOnly.filter((c) => nameKeysEquivalent(target.name, c.name));
              if (byName.length === 1) {
                clickCandidate(byName[0]);
                return { ok: true, picked: byName[0].raw, mode: 'strict' };
              }
            }
            const names = misOnly.map((m) => m.raw).slice(0, 5).join(' | ');
            return { ok: false, reason: 'ambiguous', detail: names, count: misOnly.length };
          }

          await sleep(120);
        }
        const hint = collectVisibleCandidates(modal)
          .map((c) => c.raw)
          .slice(0, 6)
          .join(' | ');
        return { ok: false, reason: 'not_found', detail: hint };
      }
      function clickConfirm() {
        const nodes = Array.from(document.querySelectorAll('button, .mtd-btn'));
        for (const b of nodes) {
          if (norm(b.textContent) === '确定' && visible(b)) {
            b.click();
            return true;
          }
        }
        return false;
      }

      if (!targets || !targets.length) return { ok: false, reason: 'empty_targets' };

      if (!clickElephantSessionTab()) {
        return { ok: false, reason: 'no_elephant_tab', logs };
      }
      await sleep(450);

      const clickedAdd = await waitAndClickAddMember(12000);
      if (!clickedAdd) {
        return { ok: false, reason: 'no_add_member', logs };
      }
      await sleep(400);

      const modal = await waitModal(8000);
      if (!modal) {
        return { ok: false, reason: 'no_modal', logs };
      }

      const searchInput = findSearchInput(modal);
      if (!searchInput) {
        return { ok: false, reason: 'no_search_input', logs };
      }

      async function searchAndPick(target) {
        const label = target.name + '/' + target.mis;
        const queries = [
          String(target.mis || ''),
          stripMisPrefix(target.mis),
          String(target.name || ''),
          label
        ].filter((q, i, arr) => q && arr.indexOf(q) === i);

        let lastFail = { ok: false, reason: 'not_found', detail: '' };
        for (const q of queries) {
          setInputValue(searchInput, '');
          await sleep(80);
          setInputValue(searchInput, q);
          await sleep(650);
          const pick = await pickMatchedSuggestionForTarget(modal, target);
          if (pick.ok) return pick;
          if (pick.reason === 'ambiguous') return pick;
          lastFail = pick;
        }
        return lastFail;
      }

      for (const target of targets) {
        if (!target || !target.mis) continue;
        const label = target.name ? target.name + '/' + target.mis : target.mis;
        const pick = await searchAndPick(target);
        if (!pick.ok) {
          if (pick.reason === 'ambiguous') {
            logs.push('匹配到多条，已跳过：' + label + '（' + (pick.detail || '') + '）');
          } else {
            const hint = pick.detail ? '；搜索列表：' + pick.detail : '';
            logs.push('未找到可匹配成员，已跳过：' + label + hint);
          }
          continue;
        }
        if (pick.mode === 'mis_only' || pick.mode === 'mis_only_config') {
          logs.push(
            '已选择：' +
              (pick.picked || label) +
              '（MIS 唯一命中' +
              (pick.configName
                ? '；配置姓名「' + pick.configName + '」与 TT「' + (pick.gotName || '') + '」不完全一致'
                : '；配置未填姓名') +
              '）'
          );
        } else {
          logs.push('已选择：' + (pick.picked || label) + '（姓名+MIS 校验通过）');
        }
        await sleep(220);
      }

      if (!clickConfirm()) {
        await sleep(350);
        if (!clickConfirm()) {
          return { ok: false, reason: 'no_confirm', logs };
        }
      }
      await sleep(300);
      return { ok: true, logs };
    })()
  `;
}

async function runPmPullByRegion() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    log("工单页面加载中，请稍候…", "warning");
    return;
  }
  const opState = { busy: deps.getBusy(), pmPullInProgress, priorityBatchInProgress: deps.isPriorityBatchInProgress(), titleNormalizeInProgress: deps.isNormalizeInProgress() };
  if (!Guard.canStartPmPull(opState)) {
    if (pmPullInProgress) return;
    if (deps.isPriorityBatchInProgress()) {
      log(Guard.msgPmBlocked(), "warning");
      return;
    }
    if (deps.isNormalizeInProgress()) {
      log(Guard.msgTitleNormalizeBlocked(), "warning");
      return;
    }
    if (deps.getBusy()) {
      log(Guard.msgPmBlockedByBusy(), "warning");
      return;
    }
    return;
  }

  let csvPath = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || "").trim();
  if (!csvPath) {
    const synced = await syncPmCsvFromS3({ silent: false });
    csvPath = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || synced?.path || "").trim();
  }
  if (!csvPath) {
    log("请先同步 PM 表。", "warning");
    return;
  }

  const active = deps.getTickets().find((t) => t && t.isActive);
  if (!active) {
    log("请先在列表中选中一条工单。", "warning");
    return;
  }

  setPmPullBusy(true);
  deps.setActiveLeftTab("logs");
  let switchedFromBrowse = false;
  try {
    try {
      const sw = window.TTDesktop?.browser?.ensureOpsSurface?.();
      switchedFromBrowse = !!sw?.switched;
      if (switchedFromBrowse) {
        log("已切换到接单 TT 以拉人（结束后可回到浏览标签）。", "muted");
        await sleep(200);
      }
    } catch {
      // ignore
    }
    const opened = await deps.handleTicketClick(active, { skipRefresh: true });
    if (!opened) {
      log(`无法打开工单，已取消拉人。`, "error");
      return;
    }
    await sleep(600);

    const detail = await ttExecuteJavaScript(deps.buildTitleNormalizeInspectScript());
    const arch = String(detail?.architectureRaw || "").trim();
    const title = String(detail?.currentTitle || active.title || "").trim();

    const fileRes = await window.ttDesktopApi?.readTextFile?.(csvPath);
    if (!fileRes?.ok) {
      log(`配置文件读取失败：${fileRes?.message || fileRes?.error || "请重新选择"}。`, "error");
      return;
    }
    const parsed = parsePmCsvContent(fileRes.content || "");
    if (parsed.error || !parsed.rules.length) {
      logPmCsvValidationReport(parsed, { silent: false, source: "读取" });
      log(`配置文件为空或格式不正确：${parsed.error || "无有效地区规则"}。`, "error");
      return;
    }
    if (parsed.warnings?.length) {
      // 拉人时若本地表有问题，给简要提示（完整报告同步时已打过）
      log(`当前 PM 表有 ${parsed.warnings.length} 条校验警告，异常项已跳过。`, "warning");
    }

    const rule = matchPmRuleForTicket(parsed.rules, arch, title);
    if (!rule) {
      log("未匹配到地区，请检查工单信息或配置文件。", "warning");
      return;
    }
    if (!rule.members.length) {
      log(`地区「${rule.region_key}」未配置人员。`, "warning");
      return;
    }

    const pmTargets = rule.members.filter((m) => m && m.mis);
    const pmSkipped = rule.members.filter((m) => !m || !m.mis);
    if (pmSkipped.length) {
      log(`部分人员缺少 MIS，已跳过。`, "warning");
    }
    if (!pmTargets.length) {
      log(`地区「${rule.region_key}」没有可用人员，请检查配置。`, "warning");
      return;
    }

    const misOnly = pmTargets.filter((m) => !m.name).length;
    log(
      `地区「${rule.region_key}」匹配成功，将添加 ${pmTargets.length} 人` +
        (misOnly ? `（其中 ${misOnly} 人仅有 MIS）` : "") +
        `。`,
      "info"
    );

    const res = await ttExecuteJavaScript(buildPullPmMembersScript(pmTargets));
    if (!res?.ok) {
      const extra = Array.isArray(res?.logs) && res.logs.length ? `\n  明细：${res.logs.join("；")}` : "";
      const reasonHint = TD.log.formatReason(res?.reason);
      const detail = res?.detail ? `「${String(res.detail).slice(0, 60)}」` : "";
      log(`拉人未完成：${reasonHint}${detail}${extra}`, "error");
    } else {
      const extra = Array.isArray(res?.logs) && res.logs.length ? `\n  明细：${res.logs.join("；")}` : "";
      log(`拉人完成。${extra}`, "success");
    }
  } catch (err) {
    log(`拉人异常：${TD.log.errText(err)}`, "error");
  } finally {
    setPmPullBusy(false);
    try {
      if (switchedFromBrowse && window.TTDesktop?.browser?.restoreBrowseSurfaceIfNeeded?.()) {
        log("拉人结束，已回到浏览标签。", "muted");
      } else {
        window.TTDesktop?.browser?.clearOpsSurfaceResume?.();
      }
    } catch {
      // ignore
    }
    await deps.refreshTickets({ reset: false });
  }
}
  function isPullInProgress() {
    return pmPullInProgress;
  }

  TD.pm = {
    bind,
    isPullInProgress,
    updatePmCsvPathLabel,
    selectPmCsvFile,
    syncPmCsvFromS3,
    ensurePmCsvReady,
    runPmPullByRegion,
    parsePmCsvContent,
    parsePmMemberToken
  };
})(window.TTDesktop);
