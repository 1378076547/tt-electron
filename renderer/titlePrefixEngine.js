/**
 * 工单标题前缀：词典解析 + 期望标题计算（规则见 renderer.js 顶部注释）
 *
 * 期望拼接顺序：事业部简称 + 城市（地区）+ 站点或仓名 + 原标题正文（问题简述）。
 */
(function (global) {
  "use strict";

  /** @type {{ full: string, short: string }[] | null} */
  let cityMatchers = null;

  function walkGeo(node, out) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const x of node) walkGeo(x, out);
      return;
    }
    if (typeof node === "object") {
      if (typeof node.name === "string" && node.name.trim()) {
        out.push(node.name.trim());
      }
      if (node.children) walkGeo(node.children, out);
    }
  }

  /** 从 china_cities.json 根对象构建「长名优先」匹配表 */
  function buildCityMatchersFromJson(root) {
    const data = root && root.data;
    const names = [];
    walkGeo(data, names);
    const uniq = Array.from(new Set(names));
    uniq.sort((a, b) => b.length - a.length);
    return uniq.map((full) => ({ full, short: toDisplayCityShort(full) }));
  }

  /** 前缀里用的城市简称：去掉常见行政区划后缀 */
  function toDisplayCityShort(full) {
    let s = String(full || "").trim();
    if (!s) return "";
    if (/壮族自治区|回族自治区|维吾尔自治区|自治区$/.test(s)) {
      s = s.replace(/壮族自治区$|回族自治区$|维吾尔自治区$|自治区$/g, "");
      return s;
    }
    if (/特别行政区$/.test(s)) return s.replace(/特别行政区$/, "");
    if (/省$/.test(s)) return s.replace(/省$/, "");
    if (/市$/.test(s)) return s.replace(/市$/, "");
    if (/地区$/.test(s)) return s.replace(/地区$/, "");
    if (/盟$/.test(s)) return s.replace(/盟$/, "");
    if (/自治州$/.test(s)) return s.replace(/自治州$/, "");
    if (/州$/.test(s)) return s.replace(/州$/, "");
    if (/区$/.test(s) && s.length <= 4) return s.replace(/区$/, "");
    return s;
  }

  /** 在一段路径文本中找第一个命中的城市（已按 full 长度降序） */
  function findCityInSegment(segment, matchers) {
    const seg = String(segment || "");
    if (!seg) return null;
    for (const { full, short } of matchers) {
      if (!full) continue;
      // 先用标准全称（如「重庆市」）匹配；不少架构段里会省略后缀（如「重庆万和站」），再用简称兜底
      if (seg.includes(full)) return short || toDisplayCityShort(full);
      const s = String(short || "").trim();
      if (s && s.length >= 2 && seg.includes(s)) return s;
    }
    return null;
  }

  /** 从右往左扫描路径段，返回第一个能解析出城市的段对应的城市简称 */
  function findCityRightToLeft(segments, matchers) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const c = findCityInSegment(segments[i], matchers);
      if (c) return c;
    }
    return null;
  }

  function splitArchSegments(archRaw) {
    const t = String(archRaw || "")
      .trim()
      .replace(/\s+/g, "");
    if (!t) return [];
    return t
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 取「XX事业部」所在段，得简称（去掉「事业部/事业部门」） */
  function extractBuShort(segments) {
    const seg = segments.find((s) => s.includes("事业部"));
    if (!seg) return "";
    return seg
      .replace(/有限公司$/g, "")
      .replace(/事业部门$/, "")
      .replace(/事业部$/, "")
      .trim();
  }

  /** 路径中带「XX服务站」的段：服务站前为城市名，再转简称 */
  function extractCityFromServiceStationSegment(segments, matchers) {
    const seg = segments.find((s) => /服务站$/.test(s));
    if (!seg) return null;
    const inner = seg.replace(/服务站$/, "").trim();
    if (!inner) return null;
    const hit = findCityInSegment(inner, matchers);
    if (hit) return hit;
    if (/^[\u4e00-\u9fa5]{2,8}$/.test(inner)) return inner;
    return null;
  }

  /** 架构中的职能/组织段（非具体站仓店），如「门店运营」「经营培训」 */
  function isGenericOrgArchSegment(seg) {
    const s = String(seg || "").trim();
    if (!s) return true;
    if (/站$|店$|仓$/.test(s)) return false;
    if (/前置仓|中心仓|配送仓|服务站|网格站|营业部/.test(s)) return false;
    if (/运营|培训|管理|支持|督查|稽查|品控|采购|人力|财务|大区|片区|组$|部$/.test(s) && !/站$|店$|仓$/.test(s)) {
      return true;
    }
    if (/^门店运营$|^经营培训$|^门店管理/.test(s)) return true;
    return false;
  }

  /** 是否像真实网点名（站/仓/店字段或架构里的实体名） */
  function isPhysicalLocationName(name) {
    const s = String(name || "").trim();
    if (!s || s.length < 2) return false;
    if (isGenericOrgArchSegment(s)) return false;
    if (/站$|店$|仓$/.test(s)) return true;
    if (/[\u4e00-\u9fa5]{2,}(站|店|仓)$/.test(s)) return true;
    if (/[路街区园汇广场][\u4e00-\u9fffA-Za-z0-9\-]{0,24}(店|站|仓)$/.test(s)) return true;
    if (/[\u4e00-\u9fa5]{1,12}-[\u4e00-\u9fa5]{1,16}(店|站|仓)$/.test(s)) return true;
    return false;
  }

  /** 架构段是否像可写入标题的站/仓/店（排除职能段；勿用「门店」子串误匹配「门店运营」） */
  function isLocationLikeArchSegment(seg) {
    const s = String(seg || "").trim();
    if (!s || s.length < 2) return false;
    if (isGenericOrgArchSegment(s)) return false;
    if (/事业部$/.test(s) && !/[站店仓]/.test(s)) return false;
    if (/^公司$|^美团$|有限公司$|^集团$|^总部$/.test(s)) return false;
    if (/站$|店$|仓$/.test(s)) return true;
    if (/服务站|网格站|前置仓|中心仓|配送仓|仓储|仓库|营业部/.test(s)) return true;
    return false;
  }

  /** 架构段是否仅为地区名（如路径末级「广东」），不能当作站/仓/店 */
  function isCityOnlyArchSegment(seg, matchers) {
    const s = String(seg || "").trim();
    if (!s || /站$|店$|仓$/.test(s)) return false;
    const hit = findCityInSegment(s, matchers);
    if (!hit) return false;
    const plain = s.replace(/市$|省$|区$/, "");
    const hitPlain = String(hit).replace(/市$|省$/, "");
    if (s === hit || plain === hitPlain) return true;
    if (s.length <= 5 && hit && s.includes(hit)) return true;
    return false;
  }

  /**
   * 从架构路径中选取站/仓/店段：自右向左，跳过职能段与纯地区段，优先带站/店/仓后缀的段。
   * @param {string[]} segments
   * @param {{ full: string, short: string }[]} [matchers]
   */
  function pickLocationSegmentFromArch(segments, matchers) {
    if (!Array.isArray(segments) || !segments.length) return "";
    const m = matchers || [];
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const seg = String(segments[i] || "").trim();
      if (!seg) continue;
      if (seg.includes("事业部") && !/[站店仓]/.test(seg)) continue;
      if (isCityOnlyArchSegment(seg, m)) continue;
      if (isLocationLikeArchSegment(seg)) return seg;
    }
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const seg = String(segments[i] || "").trim();
      if (!seg || seg.includes("事业部")) continue;
      if (/^公司$|有限公司$|美团$/.test(seg)) continue;
      if (isGenericOrgArchSegment(seg) || isCityOnlyArchSegment(seg, m)) continue;
      if (seg.length >= 2 && seg.length <= 28) return seg;
    }
    return "";
  }

  /** 去掉架构段开头嵌入的城市（如「重庆万和站」→「万和站」） */
  function stripEmbeddedCityFromSegment(seg, cityShort, matchers) {
    let s = String(seg || "").trim();
    if (!s) return "";
    const c = String(cityShort || "").trim();
    if (c && s.startsWith(c)) return s.slice(c.length) || s;
    const hit = findCityInSegment(s, matchers);
    if (hit) {
      const idx = s.indexOf(hit);
      if (idx === 0) {
        const rest = s.slice(hit.length);
        if (rest.length >= 2) return rest;
      }
    }
    return s;
  }

  /** 去掉仓库/门店字段里重复的事业部品牌前缀（如 快乐猴-番禺建华汇店 → 番禺建华汇店） */
  function stripBrandPrefixFromStation(name, buShort) {
    let s = String(name || "").trim();
    const bu = String(buShort || "").trim();
    if (!s || !bu) return s;
    if (s.startsWith(`${bu}-`) || s.startsWith(`${bu}—`) || s.startsWith(`${bu}·`)) {
      return s.slice(bu.length + 1).trim();
    }
    if (s.startsWith(bu) && s.length > bu.length && /[-—·]/.test(s[bu.length])) {
      return s.slice(bu.length + 1).trim();
    }
    return s;
  }

  function scorePhysicalLocationName(name) {
    const s = String(name || "").trim();
    if (!s) return -99;
    let score = 0;
    if (/站$|店$|仓$/.test(s)) score += 12;
    if (s.length >= 4 && s.length <= 28) score += 4;
    if (/-/.test(s)) score += 3;
    if (/[路街汇广场园]/.test(s)) score += 2;
    if (isGenericOrgArchSegment(s)) score -= 30;
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(s) && !/站|店|仓/.test(s)) score -= 5;
    return score;
  }

  /**
   * 结合架构 + 仓库/门店字段解析站/仓/店（字段可能不准，架构里也可能是职能段）
   */
  function resolveStationCandidate(ctx) {
    const {
      warehouseClean,
      archLocSeg,
      archLocClean,
      pathLastClean,
      buShort,
      normOpts,
      normalizeStationInput
    } = ctx;

    const archGeneric = isGenericOrgArchSegment(archLocSeg);
    const archPhysical = !!(archLocClean && isPhysicalLocationName(archLocClean) && !archGeneric);
    const warehousePhysical = !!(warehouseClean && isPhysicalLocationName(warehouseClean));

    let rawName = "";
    let stationSource = "";
    let stationCombineNote = "";

    if (warehousePhysical && archGeneric) {
      rawName = stripBrandPrefixFromStation(warehouseClean, buShort) || warehouseClean;
      stationSource = "warehouse+arch";
      stationCombineNote = `职能架构「${archLocSeg}」+字段「${warehouseClean.slice(0, 24)}」`;
    } else if (warehousePhysical && archPhysical) {
      const wScore = scorePhysicalLocationName(warehouseClean);
      const aScore = scorePhysicalLocationName(archLocClean);
      if (wScore >= aScore) {
        rawName = stripBrandPrefixFromStation(warehouseClean, buShort) || warehouseClean;
        stationSource = "warehouse+arch";
        stationCombineNote = `字段优先（${warehouseClean.slice(0, 20)}）`;
      } else {
        rawName = archLocClean;
        stationSource = "arch";
      }
    } else if (warehousePhysical) {
      rawName = stripBrandPrefixFromStation(warehouseClean, buShort) || warehouseClean;
      stationSource = "warehouse";
    } else if (archPhysical) {
      rawName = archLocClean;
      stationSource = "arch";
    } else if (warehouseClean) {
      rawName = stripBrandPrefixFromStation(warehouseClean, buShort) || warehouseClean;
      stationSource = "warehouse";
    } else if (archLocClean && !archGeneric) {
      rawName = archLocClean;
      stationSource = "arch";
    } else if (pathLastClean && !isGenericOrgArchSegment(pathLast)) {
      rawName = pathLastClean;
      stationSource = "path";
    }

    const kindArchSeg = archPhysical ? archLocSeg : warehousePhysical ? "" : archLocSeg;
    const isUserWarehouse = stationSource === "warehouse" || stationSource === "warehouse+arch";
    const stationRaw = rawName
      ? normalizeStationInput(rawName, normOpts({ isUserWarehouse, archSegmentRaw: kindArchSeg }))
      : "";

    return { stationRaw, stationSource, stationCombineNote };
  }

  /** 单条工单只会是「站」或「仓」一类单位；架构段优先用于判断类型 */
  function inferLocationUnitKind(name, warehouseFieldRaw, archSegmentRaw) {
    const n = String(name || "").trim();
    const w = String(warehouseFieldRaw || "").trim();
    const a = String(archSegmentRaw || "").trim();
    if (/仓$/.test(a) || (/前置仓|中心仓|配送仓|仓储|仓库/.test(a) && !/站$|店$/.test(a))) return "warehouse";
    if (/店$/.test(a) || (/营业部/.test(a) && !/运营/.test(a))) return "store";
    if (/站$/.test(a) || /服务站|网格站/.test(a)) return "station";
    if (/仓$/.test(n)) return "warehouse";
    if (/站$/.test(n)) return "station";
    if (/店$/.test(n)) return "store";
    if (/前置仓|中心仓|仓储|配送中心|仓库/.test(n) && !/站$|店$/.test(n)) return "warehouse";
    if (/店$/.test(n) || /门店名称/.test(w)) return "store";
    if (/仓库(?:\/门店)?名称/.test(w) && !/门店名称/.test(w)) return "warehouse";
    if (/服务站|网格站/.test(n)) return "station";
    return "station";
  }

  /**
   * 站点/仓/店展示串：
   * - 架构已带 站/店/仓 → 原样（规范仅 XX站 / XX仓 / XX店，无 XX库）
   * - 缺后缀时按架构/字段推断：仓类不补站，门店补店，站类补站
   */
  function normalizeStationInput(raw, opts) {
    const o = opts && typeof opts === "object" ? opts : { isUserWarehouse: !!opts };
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/站$|店$|部$|所$|中心$|网格$|仓$/.test(s)) return s;
    if (/仓$/.test(s) || (/仓/.test(s) && !/站$|店$/.test(s))) return s;
    const archSeg = String(o.archSegmentRaw || "").trim();
    const kind = inferLocationUnitKind(s, o.warehouseFieldRaw, archSeg || s);
    if (kind === "warehouse") return s;
    if (kind === "store") return `${s}店`;
    if (o.isUserWarehouse || isLocationLikeArchSegment(archSeg)) return `${s}站`;
    return s;
  }

  /**
   * 清洗「仓库/门店」候选值：
   * - 去掉常见字段名前缀（如「仓库/门店名称：」）
   * - 过滤明显脏数据（电话/备注/描述/处理信息等）
   * - 过长或包含组织路径文本时视为无效
   */
  function sanitizeStationCandidate(raw) {
    let s = String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!s) return "";

    s = s.replace(/^\*?\s*(仓库(?:\/门店)?名称|门店名称|仓库名称|门店|仓库)\s*[:：]\s*/i, "").trim();
    if (!s) return "";

    const firstPart = s.split(/[；;，,\n]/)[0].trim();
    if (firstPart) s = firstPart;
    if (!s) return "";

    const noiseKeywords = /(联系电话|手机号|电话|发起人|处理人|问题描述|描述|备注|处理记录|评论|优先级|服务目录|归档|公司\/)/;
    if (noiseKeywords.test(s)) return "";
    if (/\d{11}/.test(s)) return "";
    if (s.length > 30) return "";

    s = s.replace(/[。；;，,、]+$/g, "").trim();
    return s;
  }

  /** 站点与城市段重复时去掉站名前的城市 */
  function dedupeStationWithCity(station, cityShort) {
    let st = String(station || "").trim();
    const c = String(cityShort || "").trim();
    if (!st || !c) return st;
    if (st.startsWith(c)) return st.slice(c.length);
    return st;
  }

  /** 原标题正文：去掉已存在的前缀，避免重复拼接 */
  function extractTitleBody(currentTitle, prefix, buShort, cityShort, stationNorm) {
    const cur = String(currentTitle || "").trim();
    if (!cur) return "";
    if (prefix && cur === prefix) return "";
    if (prefix && cur.startsWith(prefix)) return cur.slice(prefix.length);
    let rest = cur;
    if (buShort && rest.startsWith(buShort)) rest = rest.slice(buShort.length);
    if (cityShort && rest.startsWith(cityShort)) rest = rest.slice(cityShort.length);
    if (stationNorm && rest.startsWith(stationNorm)) rest = rest.slice(stationNorm.length);
    if (rest !== cur) return rest;
    return cur;
  }

  /**
   * @param {object} inspect { architectureRaw, warehouseStore, currentTitle }
   * @param {object} chinaJson china_cities.json 根对象
   */
  function computeExpectedTitle(inspect, chinaJson) {
    const archRaw = String(inspect?.architectureRaw || "").trim();
    const warehouse = String(inspect?.warehouseStore || "").trim();
    const currentTitle = String(inspect?.currentTitle || "").trim();

    if (!archRaw || !archRaw.includes("/")) {
      return { ok: false, skip: true, reason: "无发起人架构路径，跳过" };
    }
    if (!archRaw.includes("事业部")) {
      return { ok: false, skip: true, reason: "路径中无事业部信息，跳过" };
    }

    const matchers = cityMatchers || buildCityMatchersFromJson(chinaJson);
    cityMatchers = matchers;

    const segments = splitArchSegments(archRaw);
    const buShort = extractBuShort(segments);
    if (!buShort) {
      return { ok: false, skip: true, reason: "未能解析事业部简称，跳过" };
    }

    let cityShort = extractCityFromServiceStationSegment(segments, matchers);
    if (!cityShort) {
      cityShort = findCityRightToLeft(segments, matchers);
    }
    if (!cityShort) {
      return { ok: false, skip: true, reason: "无法解析城市（请手动改标题）" };
    }

    const archLocSeg = pickLocationSegmentFromArch(segments, matchers);
    const archLocStripped = stripEmbeddedCityFromSegment(archLocSeg, cityShort, matchers);
    const archLocClean = sanitizeStationCandidate(archLocStripped || archLocSeg);
    const warehouseClean = sanitizeStationCandidate(warehouse);
    const pathLast = segments.length ? segments[segments.length - 1] : "";
    const pathLastClean = sanitizeStationCandidate(pathLast);

    const normOpts = (extra) => ({
      warehouseFieldRaw: warehouse,
      archSegmentRaw: archLocSeg,
      ...extra
    });

    const resolved = resolveStationCandidate({
      warehouseClean,
      archLocSeg,
      archLocClean,
      pathLastClean,
      buShort,
      normOpts,
      normalizeStationInput
    });
    const stationRaw = resolved.stationRaw;
    const stationSource = resolved.stationSource;
    const stationCombineNote = resolved.stationCombineNote;
    if (!stationRaw) {
      return { ok: false, skip: true, reason: "无站点信息（架构/仓库/门店均未解析到站仓店），跳过" };
    }

    let stationNorm = dedupeStationWithCity(stationRaw, cityShort);
    const prefix = `${buShort}${cityShort}${stationNorm}`;
    const body = extractTitleBody(currentTitle, prefix, buShort, cityShort, stationNorm);
    const expected = `${prefix}${body}`;

    if (expected === currentTitle) {
      return {
        ok: true,
        skip: true,
        reason: "标题已是目标格式",
        expected,
        currentTitle,
        prefix,
        buShort,
        cityShort,
        stationNorm,
        stationSource,
        stationCombineNote,
        archLocSeg
      };
    }

    return {
      ok: true,
      skip: false,
      reason: "",
      expected,
      currentTitle,
      prefix,
      body,
      buShort,
      cityShort,
      stationNorm,
      stationSource,
      stationCombineNote,
      archLocSeg,
      segments
    };
  }

  function prepareMatchers(chinaJson) {
    cityMatchers = buildCityMatchersFromJson(chinaJson);
  }

  global.TTTitlePrefix = {
    buildCityMatchersFromJson,
    prepareMatchers,
    computeExpectedTitle
  };
})(typeof window !== "undefined" ? window : globalThis);
