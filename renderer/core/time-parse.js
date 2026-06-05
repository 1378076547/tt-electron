/**
 * 工单创建时间解析与展示（阶段 1）
 */
(function initTimeParse(TD) {
  function formatEpochToMMDDHHmm(epochMs) {
    const n = Number(epochMs);
    if (!Number.isFinite(n)) return "";
    const d = new Date(n);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function formatDateTime(d) {
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  function isPlausibleTicketEpoch(epochMs) {
    const n = Number(epochMs);
    if (!Number.isFinite(n)) return false;
    const y = new Date(n).getFullYear();
    return y >= 2015 && y <= 2035;
  }

  function parseCreatedAtEpoch(text) {
    const t = (text || "").trim();
    if (!t) return null;

    if (/^\d{10,13}$/.test(t)) {
      let n = Number(t);
      if (!Number.isFinite(n)) return null;
      if (t.length === 10) n *= 1000;
      return isPlausibleTicketEpoch(n) ? n : null;
    }

    const m =
      t.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/) ||
      t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (m) {
      const yyyy = Number(m[1]);
      const mm = Number(m[2]);
      const dd = Number(m[3]);
      const hh = Number(m[4]);
      const mi = Number(m[5]);
      const ss = m[6] ? Number(m[6]) : 0;
      const ts = new Date(yyyy, mm - 1, dd, hh, mi, ss).getTime();
      return isPlausibleTicketEpoch(ts) ? ts : null;
    }

    const m2 = t.match(/^(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m2) {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = Number(m2[1]);
      const dd = Number(m2[2]);
      const hh = Number(m2[3]);
      const mi = Number(m2[4]);
      const ss = m2[5] ? Number(m2[5]) : 0;
      const ts = new Date(yyyy, mm - 1, dd, hh, mi, ss).getTime();
      return isPlausibleTicketEpoch(ts) ? ts : null;
    }

    if (/^\d{4}[-/]/.test(t) || /T\d{1,2}:/.test(t)) {
      const isoTs = Date.parse(t);
      if (isPlausibleTicketEpoch(isoTs)) return isoTs;
    }

    return null;
  }

  function resolveCreatedAtEpoch(item) {
    if (!item) return null;
    const fromField = item.createdAtEpoch;
    if (isPlausibleTicketEpoch(fromField)) return fromField;
    const parsed = parseCreatedAtEpoch(item.createdAtText || "");
    if (parsed != null) item.createdAtEpoch = parsed;
    return parsed;
  }

  function normalizeTicketCreatedFields(item) {
    if (!item) return;
    const epoch = resolveCreatedAtEpoch(item);
    if (epoch != null && isPlausibleTicketEpoch(epoch)) {
      item.createdAtEpoch = epoch;
      if (!String(item.createdAtText || "").trim()) {
        item.createdAtText = formatEpochToMMDDHHmm(epoch);
      }
    }
  }

  function ticketEpochMs(item) {
    const n = resolveCreatedAtEpoch(item);
    if (Number.isFinite(n)) return n;
    return parseCreatedAtEpoch(item?.createdAtText || "");
  }

  TD.time = {
    formatEpochToMMDDHHmm,
    formatDateTime,
    isPlausibleTicketEpoch,
    parseCreatedAtEpoch,
    resolveCreatedAtEpoch,
    normalizeTicketCreatedFields,
    ticketEpochMs
  };
})(window.TTDesktop);
