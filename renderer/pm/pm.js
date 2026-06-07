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

function parsePmCsvContent(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { rules: [], error: "empty" };
  const header = lines[0].split(",").map((c) => c.trim().toLowerCase());
  const idxEn = header.indexOf("enabled");
  const idxRk = header.indexOf("region_key");
  const idxMm = header.indexOf("members_mis");
  const idxNote = header.indexOf("note");
  if (idxRk < 0 || idxMm < 0) return { rules: [], error: "bad_header" };
  const rules = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i];
    const parts = row.split(",").map((c) => c.trim());
    if (parts.length < idxMm + 1) continue;
    const enabledCell = idxEn >= 0 ? String(parts[idxEn] || "").trim() : "1";
    const region_key = String(parts[idxRk] || "").trim();
    if (!region_key) continue;
    let membersCell = "";
    let note = "";
    if (idxNote > idxMm) {
      membersCell = parts.slice(idxMm, idxNote).join(",").trim();
      note = parts.slice(idxNote).join(",").trim();
    } else {
      membersCell = parts.slice(idxMm).join(",").trim();
    }
    const memberMap = new Map();
    for (const part of membersCell.split(";")) {
      const m = parsePmMemberToken(part);
      if (!m.mis) continue;
      if (!memberMap.has(m.mis)) memberMap.set(m.mis, m);
    }
    rules.push({
      enabled: enabledCell === "1" || enabledCell.toLowerCase() === "true" || enabledCell === "是",
      region_key,
      members: Array.from(memberMap.values()),
      note
    });
  }
  return { rules, error: "" };
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

/** 解析 CSV 单元格：须为「姓名/MIS」，拉 PM 时姓名与 MIS 双重校验 */
function parsePmMemberToken(tok) {
  const s = String(tok || "").trim();
  if (!s) return { name: "", mis: "" };
  if (s.includes("/")) {
    const parts = s.split("/").map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const mis = normalizePmMisToken(parts[parts.length - 1]);
      const name = parts
        .slice(0, -1)
        .join("/")
        .replace(/^\/+/, "")
        .trim();
      return { name, mis };
    }
  }
  return { name: "", mis: "" };
}

function formatPmMemberLabel(m) {
  if (!m) return "";
  if (m.name && m.mis) return `${m.name}/${m.mis}`;
  return m.mis || m.name || "";
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

function updatePmCsvPathLabel() {
  if (!D.pmCsvPathLabel) return;
  const p = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || "").trim();
  D.pmCsvPathLabel.textContent = p ? `PM配置：${p}` : "PM配置：未选择";
}

/**
 * 大象会话 → 添加成员 → 按 MIS 搜索 → 搜索结果须同时匹配 CSV 姓名+MIS → 一次确定
 * @param {PmMember[]} targets
 */
function buildPullPmMembersScript(targets) {
  const safe = JSON.stringify(
    (Array.isArray(targets) ? targets : []).filter((t) => t && t.mis && t.name)
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
        if (!wantName) return { ok: false, reason: 'empty_name' };
        const end = Date.now() + 8000;
        while (Date.now() < end) {
          const strict = collectStrictMatches(modal, target);
          if (strict.length === 1) {
            clickCandidate(strict[0]);
            return { ok: true, picked: strict[0].raw, mode: 'strict' };
          }
          if (strict.length > 1) {
            const names = strict.map((m) => m.raw).slice(0, 5).join(' | ');
            return { ok: false, reason: 'ambiguous', detail: names, count: strict.length };
          }

          const misOnly = collectMisMatches(modal, target);
          if (misOnly.length === 1) {
            clickCandidate(misOnly[0]);
            return {
              ok: true,
              picked: misOnly[0].raw,
              mode: 'mis_only',
              configName: target.name,
              gotName: misOnly[0].name
            };
          }
          if (misOnly.length > 1) {
            const byName = misOnly.filter((c) => nameKeysEquivalent(target.name, c.name));
            if (byName.length === 1) {
              clickCandidate(byName[0]);
              return { ok: true, picked: byName[0].raw, mode: 'strict' };
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
        if (!target || !target.mis || !target.name) continue;
        const label = target.name + '/' + target.mis;
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
        if (pick.mode === 'mis_only') {
          logs.push(
            '已选择：' +
              (pick.picked || label) +
              '（MIS 唯一命中；TT 姓名「' +
              (pick.gotName || '') +
              '」与配置「' +
              (pick.configName || target.name) +
              '」不完全一致）'
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

async function selectPmCsvFile() {
  try {
    const res = await window.ttDesktopApi?.selectAndReadPmCsv?.();
    if (!res || res.canceled) return;
    if (!res.ok) {
      log(`选择 PM 配置文件失败：${res.message || "unknown"}`, "error");
      return;
    }
    const parsed = parsePmCsvContent(res.content || "");
    if (parsed.error === "bad_header") {
      log("PM 配置 CSV 表头不正确，需要包含 region_key 与 members_mis 列。", "error");
      return;
    }
    localStorage.setItem(STORAGE_KEYS.pmCsvPath, res.path || "");
    updatePmCsvPathLabel();
    log(`已选择 PM 配置：${res.path}（有效规则 ${parsed.rules.filter((r) => r.enabled).length} 条）`, "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`选择 PM 配置异常：${msg}`, "error");
  }
}

async function runPmPullByRegion() {
  if (!deps.getWebviewReady() || !deps.getTtWebview()) {
    log("请先等待 TT 页面加载完成。", "warning");
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

  const csvPath = (localStorage.getItem(STORAGE_KEYS.pmCsvPath) || "").trim();
  if (!csvPath) {
    log("请先在工单面板点击「选择PM配置」选择 CSV 文件。", "warning");
    return;
  }

  const active = deps.getTickets().find((t) => t && t.isActive);
  if (!active) {
    log("请先在左侧工单列表中点击要处理的工单（高亮项），再点「按地区拉PM」。", "warning");
    return;
  }

  setPmPullBusy(true);
  deps.setActiveLeftTab("logs");
  try {
    const opened = await deps.handleTicketClick(active, { skipRefresh: true });
    if (!opened) {
      log("无法打开目标工单，已取消拉 PM。", "error");
      return;
    }
    await sleep(600);

    const detail = await ttExecuteJavaScript(deps.buildTitleNormalizeInspectScript());
    const arch = String(detail?.architectureRaw || "").trim();
    const title = String(detail?.currentTitle || active.title || "").trim();

    const fileRes = await window.ttDesktopApi?.readTextFile?.(csvPath);
    if (!fileRes?.ok) {
      log(`读取 PM 配置失败：${fileRes?.message || "unknown"}`, "error");
      return;
    }
    const parsed = parsePmCsvContent(fileRes.content || "");
    if (!parsed.rules.length) {
      log("PM 配置 CSV 中没有有效数据行。", "error");
      return;
    }

    const rule = matchPmRuleForTicket(parsed.rules, arch, title);
    if (!rule) {
      log(
        `未匹配到地区：发起人路径与标题中均未发现 CSV 里的 region_key（当前路径片段可参考日志）。\n  路径：${(arch || "（空）").slice(0, 120)}\n  标题：${(title || "（空）").slice(0, 80)}`,
        "warning"
      );
      return;
    }
    if (!rule.members.length) {
      log(`地区「${rule.region_key}」未配置 members_mis。`, "warning");
      return;
    }

    const pmTargets = rule.members.filter((m) => m && m.mis && m.name);
    const pmSkipped = rule.members.filter((m) => !m || !m.mis || !m.name);
    if (pmSkipped.length) {
      log(
        `以下成员未按「姓名/MIS」填写完整，已跳过：${pmSkipped.map((m) => formatPmMemberLabel(m) || "（空）").join("、")}`,
        "warning"
      );
    }
    if (!pmTargets.length) {
      log(`地区「${rule.region_key}」没有可用的「姓名/MIS」成员，请检查 CSV。`, "warning");
      return;
    }

    const memberLabels = pmTargets.map((m) => formatPmMemberLabel(m)).join("、");
    log(`按地区拉 PM：匹配「${rule.region_key}」→ 将添加 ${pmTargets.length} 人（姓名+MIS 双重校验）：${memberLabels}`, "info");

    const res = await ttExecuteJavaScript(buildPullPmMembersScript(pmTargets));
    if (!res?.ok) {
      const extra = Array.isArray(res?.logs) && res.logs.length ? `\n  明细：${res.logs.join("；")}` : "";
      log(`拉 PM 未完成：${res?.reason || "unknown"}${extra}`, "error");
    } else {
      const extra = Array.isArray(res?.logs) && res.logs.length ? `\n  明细：${res.logs.join("；")}` : "";
      log(`拉 PM 已完成（已点确定）。${extra}`, "success");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`拉 PM 异常：${msg}`, "error");
  } finally {
    setPmPullBusy(false);
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
    runPmPullByRegion
  };
})(window.TTDesktop);
