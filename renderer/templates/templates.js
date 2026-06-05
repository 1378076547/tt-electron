/**
 * 话术模板（阶段 2）
 */
(function initTemplates(TD) {
  const C = TD.constants;
  const D = TD.dom;
  const log = TD.log.log;

  let deps = {
    getActiveTicketTitle: () => "",
    getTickets: () => []
  };

  function bind(extra) {
    deps = { ...deps, ...extra };
  }

  function getElephantMessage() {
    return (localStorage.getItem(C.STORAGE_KEYS.elephantMessage) || "").trim();
  }

  function getElephantMessageEn() {
    return (localStorage.getItem(C.STORAGE_KEYS.elephantMessageEn) || "").trim();
  }

  function normalizeTitleForKeywordMatch(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function normalizeKeywords(text) {
    return String(text || "")
      .split(/[,，;；]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function resolveElephantMessageForTitle(title, rules, defaultZh, defaultEn) {
    const rawTitle = String(title || "");
    const normTitle = normalizeTitleForKeywordMatch(rawTitle);
    const list = Array.isArray(rules) ? rules : [];

    for (let i = 0; i < list.length; i += 1) {
      const rule = list[i];
      const msg = String(rule?.message || "").trim();
      const keywords = Array.isArray(rule?.keywords) ? rule.keywords : [];
      if (!msg || !keywords.length) continue;
      for (const kw of keywords) {
        const k = String(kw || "").trim();
        if (!k) continue;
        const nk = normalizeTitleForKeywordMatch(k);
        if (nk && normTitle.includes(nk)) {
          return { message: msg, source: `规则#${i + 1}`, keyword: k };
        }
      }
    }

    const userZh = String(defaultZh || "").trim();
    const userEn = String(defaultEn || "").trim();
    const hasChinese = /[\u4e00-\u9fff]/.test(rawTitle);
    const hasEnglish = /[A-Za-z]/.test(rawTitle);

    if (hasChinese && userZh) return { message: userZh, source: "中文默认话术" };
    if (hasEnglish && userEn) return { message: userEn, source: "英文默认话术" };
    if (userZh) return { message: userZh, source: "中文默认话术" };
    if (userEn) return { message: userEn, source: "英文默认话术" };
    return { message: "", source: "未配置兜底话术" };
  }

  function getElephantRulesText() {
    return (localStorage.getItem(C.STORAGE_KEYS.elephantRules) || "").trim();
  }

  function setElephantRulesText(value) {
    localStorage.setItem(C.STORAGE_KEYS.elephantRules, String(value || ""));
  }

  function parseElephantRulesFromLegacyText(rulesText) {
    const text = String(rulesText || "");
    const lines = text.split(/\r?\n/);
    const rules = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#") || line.startsWith("//")) continue;
      const idx = line.indexOf("=>");
      if (idx <= 0) continue;
      const left = line.slice(0, idx).trim();
      const message = line.slice(idx + 2).trim();
      if (!left || !message) continue;
      const keywords = normalizeKeywords(left);
      if (keywords.length === 0) continue;
      rules.push({ keywords, message });
    }
    return rules;
  }

  function loadElephantRules() {
    const raw = getElephantRulesText();
    if (!raw) return [];

    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((r) => ({
            keywords: Array.isArray(r?.keywords) ? r.keywords.map((k) => String(k || "").trim()).filter(Boolean) : [],
            message: String(r?.message || "").trim()
          }))
          .filter((r) => r.keywords.length > 0 && r.message);
      } catch {
        return [];
      }
    }

    return parseElephantRulesFromLegacyText(raw);
  }

  function saveElephantRules(rules) {
    const cleaned = Array.isArray(rules)
      ? rules
          .map((r) => ({
            keywords: Array.isArray(r?.keywords) ? r.keywords.map((k) => String(k || "").trim()).filter(Boolean) : [],
            message: String(r?.message || "").trim()
          }))
          .filter((r) => r.keywords.length > 0 && r.message)
      : [];
    setElephantRulesText(JSON.stringify(cleaned));
  }

  function createRuleCard(rule, index, total) {
    const card = document.createElement("div");
    card.className = "rule-card";
    card.setAttribute("role", "listitem");

    const row = document.createElement("div");
    row.className = "rule-row";

    const keywords = document.createElement("input");
    keywords.className = "rule-keywords";
    keywords.type = "text";
    keywords.placeholder = "关键词（逗号分隔，例如：设备离线,ping不可达,AP持续）";
    keywords.value = Array.isArray(rule?.keywords) ? rule.keywords.join(",") : "";

    const actions = document.createElement("div");
    actions.className = "rule-actions";

    const upBtn = document.createElement("button");
    upBtn.className = "icon-btn";
    upBtn.type = "button";
    upBtn.textContent = "↑";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => moveRule(index, -1));

    const downBtn = document.createElement("button");
    downBtn.className = "icon-btn";
    downBtn.type = "button";
    downBtn.textContent = "↓";
    downBtn.disabled = index === total - 1;
    downBtn.addEventListener("click", () => moveRule(index, 1));

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn icon-btn-danger";
    delBtn.type = "button";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => deleteRule(index));

    actions.append(upBtn, downBtn, delBtn);
    row.append(keywords, actions);

    const message = document.createElement("textarea");
    message.className = "rule-message";
    message.rows = 3;
    message.placeholder = "命中该关键词时发送的话术";
    message.value = String(rule?.message || "");

    card.append(row, message);
    return card;
  }

  function renderRulesList(rules) {
    if (!D.templatesRulesList) return;
    D.templatesRulesList.innerHTML = "";
    const list = Array.isArray(rules) ? rules : [];
    list.forEach((r, idx) => {
      D.templatesRulesList.append(createRuleCard(r, idx, list.length));
    });
  }

  function collectRulesFromUI() {
    if (!D.templatesRulesList) return [];
    const cards = Array.from(D.templatesRulesList.querySelectorAll(".rule-card"));
    const rules = [];
    for (const card of cards) {
      const kw = card.querySelector(".rule-keywords")?.value || "";
      const msg = card.querySelector(".rule-message")?.value || "";
      const keywords = normalizeKeywords(kw);
      const message = String(msg || "").trim();
      if (keywords.length === 0 || !message) continue;
      rules.push({ keywords, message });
    }
    return rules;
  }

  function addRule() {
    const rules = collectRulesFromUI();
    rules.push({ keywords: [], message: "" });
    renderRulesList(rules);
  }

  function deleteRule(index) {
    const rules = collectRulesFromUI();
    rules.splice(index, 1);
    renderRulesList(rules);
  }

  function moveRule(index, delta) {
    const rules = collectRulesFromUI();
    const next = index + delta;
    if (next < 0 || next >= rules.length) return;
    const tmp = rules[index];
    rules[index] = rules[next];
    rules[next] = tmp;
    renderRulesList(rules);
  }

  function loadTemplatesPanel() {
    if (D.defaultMessageTextarea) D.defaultMessageTextarea.value = getElephantMessage();
    if (D.defaultMessageEnTextarea) D.defaultMessageEnTextarea.value = getElephantMessageEn();
    renderRulesList(loadElephantRules());
  }

  function saveTemplatesModal() {
    const nextDefaultZh = (D.defaultMessageTextarea?.value || "").trim();
    const nextDefaultEn = (D.defaultMessageEnTextarea?.value || "").trim();
    localStorage.setItem(C.STORAGE_KEYS.elephantMessage, nextDefaultZh);
    localStorage.setItem(C.STORAGE_KEYS.elephantMessageEn, nextDefaultEn);
    const rules = collectRulesFromUI();
    saveElephantRules(rules);
    log(
      `话术模板已保存：${rules.length} 条规则；中文默认 ${nextDefaultZh ? "已设置" : "为空"}，英文默认 ${nextDefaultEn ? "已设置" : "为空"}。`,
      "success"
    );
  }

  function previewTemplateMatchForActiveTicket() {
    const title = deps.getActiveTicketTitle();
    if (!String(title || "").trim()) {
      log("请先在工单列表中选中一条工单，再试匹配。", "warning");
      return;
    }
    const rules = collectRulesFromUI();
    const picked = resolveElephantMessageForTitle(
      title,
      rules.length ? rules : loadElephantRules(),
      (D.defaultMessageTextarea?.value || "").trim() || getElephantMessage(),
      (D.defaultMessageEnTextarea?.value || "").trim() || getElephantMessageEn()
    );
    const preview = picked.message.length > 80 ? `${picked.message.slice(0, 80)}…` : picked.message;
    log(
      `话术试匹配「${title.slice(0, 40)}」→ ${picked.source}${picked.keyword ? `（关键词：${picked.keyword}）` : ""}：${preview}`,
      "info"
    );
  }

  TD.templates = {
    bind,
    getElephantMessage,
    getElephantMessageEn,
    resolveElephantMessageForTitle,
    loadElephantRules,
    saveElephantRules,
    loadTemplatesPanel,
    saveTemplatesModal,
    previewTemplateMatchForActiveTicket,
    addRule,
    collectRulesFromUI
  };
})(window.TTDesktop);
