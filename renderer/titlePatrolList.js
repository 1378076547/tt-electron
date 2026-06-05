/**
 * 左侧列表「标题巡检」专用：与 titlePrefixEngine.js（标题检测/写入）完全分离，互不复用规则实现。
 *
 * 用途：不打开 TT、仅用程序内同步的列表标题做粗检，定时/手动写日志，便于发现明显不合规标题。
 * 与「标题检测」区别：后者读详情页架构+词典算「建议标题」；本模块只做列表字符串启发式规则。
 *
 * 标题规范（外显顺序，与业务约定一致）：
 * 1）事业部（品牌）：小象 / 快驴 / 快乐猴 / 歪马送酒
 * 2）地区（城市等）
 * 3）站点名称或仓名称（常见以「站」「仓」「店」等结尾）
 * 4）问题简述（监控改名、设备故障等）
 */
(function (global) {
  "use strict";

  /**
   * 允许的业务前缀（列表粗检）；长名优先匹配，避免「快」与更长前缀歧义（当前四者无重叠）
   */
  const ALLOWED_BRAND_PREFIXES = ["歪马送酒", "快乐猴", "小象", "快驴"];

  const BRAND_PREFIX_HINT = "小象、快驴、快乐猴、歪马送酒";

  /**
   * @param {string} t 已 trim 的标题
   * @returns {string|null} 命中的业务前缀，未命中返回 null
   */
  function matchBrandPrefix(t) {
    const sorted = ALLOWED_BRAND_PREFIXES.slice().sort((a, b) => b.length - a.length);
    for (const p of sorted) {
      if (t.startsWith(p)) return p;
    }
    return null;
  }

  /**
   * 单条列表标题是否通过巡检
   * @param {string} rawTitle
   * @returns {{ ok: boolean, reason: string }}
   */
  function evaluateListTitle(rawTitle) {
    const t = String(rawTitle || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!t) return { ok: false, reason: "标题为空" };
    if (t.length < 2) return { ok: false, reason: "标题过短" };
    if (/站站/.test(t)) return { ok: false, reason: "含「站站」" };
    if (!/[\u4e00-\u9fff]/.test(t)) return { ok: false, reason: "标题无汉字" };
    /** 误把详情/架构贴进标题时常见片段（与详情区 HTML 字段一致） */
    if (/公司\//.test(t) || /事业部\//.test(t)) {
      return { ok: false, reason: "含「公司/…」或「事业部/…」路径片段（疑似误贴详情）" };
    }
    if (/处理人|服务目录|问题归档|一级目录|二级目录|三级目录|转入ONES|4000帮助台/.test(t)) {
      return { ok: false, reason: "含详情/目录类关键词（疑似误贴）" };
    }
    const prefix = matchBrandPrefix(t);
    if (!prefix) {
      return { ok: false, reason: `未以业务前缀开头（须为 ${BRAND_PREFIX_HINT} 之一）` };
    }
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixHits = t.match(new RegExp(esc, "g"));
    if (prefixHits && prefixHits.length > 1) {
      return { ok: false, reason: `「${prefix}」前缀重复出现` };
    }
    const afterBrand = t.slice(prefix.length);
    if (afterBrand.length < 3) {
      return { ok: false, reason: `「${prefix}」后内容过短（须含：地区 + 站/仓名 + 问题）` };
    }
    /** 地区 + 站/仓名 的弱信号：规范要求站点或仓名，列表里多带「站」「仓」「店」 */
    if (!/(站|仓|店)/.test(afterBrand)) {
      return {
        ok: false,
        reason: "前缀后缺少「站/仓/店」等位置标识（规范顺序：事业部→地区→站或仓名→问题简述）"
      };
    }
    return { ok: true, reason: "" };
  }

  /**
   * 对工单行批量统计并收集不合格明细（仅使用每项的 title、id）
   * @param {{ title: string, id?: string|null }[]} ticketRows
   * @returns {{
   *   total: number,
   *   okCount: number,
   *   badTotal: number,
   *   badReasons: Record<string, number>,
   *   badItems: { id: string|null, title: string, reason: string }[]
   * }}
   */
  function patrolListTitles(ticketRows) {
    const rows = Array.isArray(ticketRows) ? ticketRows : [];
    let okCount = 0;
    /** @type {Record<string, number>} */
    const badReasons = {};
    /** @type {{ id: string|null, title: string, reason: string }[]} */
    const badItems = [];
    for (const item of rows) {
      const r = evaluateListTitle(item?.title);
      if (r.ok) okCount += 1;
      else {
        const key = r.reason || "不规范";
        badReasons[key] = (badReasons[key] || 0) + 1;
        badItems.push({
          id: item && item.id != null ? String(item.id) : null,
          title: String(item?.title || "").trim(),
          reason: key
        });
      }
    }
    const total = rows.length;
    return {
      total,
      okCount,
      badTotal: total - okCount,
      badReasons,
      badItems
    };
  }

  /**
   * 对工单行批量统计（仅使用每项的 title）
   * @param {{ title: string }[]} ticketRows
   * @returns {{ total: number, okCount: number, badTotal: number, badReasons: Record<string, number> }}
   */
  function summarizeListPatrol(ticketRows) {
    const r = patrolListTitles(ticketRows);
    return {
      total: r.total,
      okCount: r.okCount,
      badTotal: r.badTotal,
      badReasons: r.badReasons
    };
  }

  global.TTTitlePatrolList = {
    /** @deprecated 请用 ALLOWED_BRAND_PREFIXES；保留兼容首项为「小象」的旧引用 */
    get EXPECTED_PREFIX() {
      return "小象";
    },
    ALLOWED_BRAND_PREFIXES,
    matchBrandPrefix,
    evaluateListTitle,
    patrolListTitles,
    summarizeListPatrol
  };
})(typeof window !== "undefined" ? window : globalThis);
