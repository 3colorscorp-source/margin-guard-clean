/**
 * Client-facing invoice work details — display only.
 * Stored invoices.notes stay technical for billing. This summary is for the public invoice.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MgInvoiceClientWorkDetails = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function stripInternalMarkers(raw) {
    let s = String(raw == null ? "" : raw).replace(/\r\n/g, "\n");
    s = s.replace(/\[source_invoice:[^\]]*\]/gi, "");
    s = s.replace(/\[invoice_type:[^\]]*\]/gi, "");
    s = s.replace(/\[mg_[a-z0-9_]+:[^\]]*\]/gi, "");
    s = s.replace(/[ \t]+\n/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
  }

  function parseNotes(raw) {
    const text = stripInternalMarkers(raw);
    if (!text) return { description: "", billedWork: "", materials: "" };
    let description = "";
    let billedWork = "";
    let materials = "";
    const service = text.match(/^Service details:\n([\s\S]*?)(?=\n\nBilling:|\n\nMaterials:|\n\nLabor subtotal:|\n\nInvoice total:|$)/);
    if (service) description = String(service[1] || "").trim();
    const billing = text.match(/(?:^|\n)Billing:\n([\s\S]*?)(?=\n\nLabor subtotal:|\n\nMaterials:|\n\nInvoice total:|$)/);
    if (billing) billedWork = String(billing[1] || "").trim();
    const mats = text.match(/(?:^|\n)Materials:\n([\s\S]*?)(?=\n\nInvoice total:|$)/);
    if (mats) {
      materials = String(mats[1] || "")
        .split("\n")
        .map((line) => String(line || "").trim())
        .filter((line) => line && !/^Materials subtotal:/i.test(line))
        .join("\n")
        .trim();
    }
    if (!description && !billedWork && !materials) {
      const looksTechnical = /(?:^|\n)(?:Billing:|Labor subtotal:|Invoice total:)/.test(text) || / at \$/.test(text);
      if (!looksTechnical) description = text;
    }
    return { description, billedWork, materials };
  }

  function parseBilledWorkDate(line) {
    const text = String(line || "").trim();
    const m = text.match(/^[A-Za-z]{3}, ([A-Za-z]{3}) (\d{1,2}), (\d{4})$/);
    if (!m) return null;
    const months = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };
    if (!Object.prototype.hasOwnProperty.call(months, m[1])) return null;
    const d = new Date(Number(m[3]), months[m[1]], Number(m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatBilledQty(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return "";
    return String(Math.round(x * 100) / 100);
  }

  function formatBilledDayList(dates) {
    const list = Array.isArray(dates) ? dates : [];
    const uniq = [];
    const seen = new Set();
    list.forEach((d) => {
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) return;
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (seen.has(t)) return;
      seen.add(t);
      uniq.push(new Date(t));
    });
    uniq.sort((a, b) => a.getTime() - b.getTime());
    if (!uniq.length) return "";
    const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const groups = [];
    let start = uniq[0];
    let end = uniq[0];
    for (let i = 1; i < uniq.length; i++) {
      const cur = uniq[i];
      const nextDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
      if (cur.getTime() === nextDay.getTime()) {
        end = cur;
      } else {
        groups.push([start, end]);
        start = cur;
        end = cur;
      }
    }
    groups.push([start, end]);
    const sameYear = uniq.every((d) => d.getFullYear() === uniq[0].getFullYear());
    const fmtOne = (d, withMonth, withYear) => {
      const day = String(d.getDate());
      const mon = monthShort[d.getMonth()];
      if (withYear) return `${mon} ${day}, ${d.getFullYear()}`;
      if (withMonth) return `${mon} ${day}`;
      return day;
    };
    return groups
      .map((pair, idx) => {
        const a = pair[0];
        const b = pair[1];
        const prev = idx > 0 ? groups[idx - 1][1] : null;
        const needMonth = !prev || prev.getMonth() !== a.getMonth() || prev.getFullYear() !== a.getFullYear();
        if (a.getTime() === b.getTime()) return fmtOne(a, needMonth, !sameYear);
        const endNeedMonth = a.getMonth() !== b.getMonth() || a.getFullYear() !== b.getFullYear();
        return `${fmtOne(a, needMonth, false)}–${fmtOne(b, endNeedMonth, !sameYear && endNeedMonth)}`;
      })
      .join(", ");
  }

  function summarizeBilledWork(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    const hours = { Pro: 0, Assistant: 0 };
    const dayQty = { Pro: 0, Assistant: 0 };
    const flats = { Pro: 0, Assistant: 0 };
    const dates = [];
    text.split("\n").forEach((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) return;
      const date = parseBilledWorkDate(trimmed);
      if (date) {
        dates.push(date);
        return;
      }
      const worker = trimmed.match(/^- (Pro|Assistant):\s*([\d.]+)\s+(hours?|days?|flat)\b/i);
      if (worker) {
        const role = String(worker[1]).toLowerCase() === "assistant" ? "Assistant" : "Pro";
        const qty = Number(worker[2]);
        const unit = String(worker[3] || "").toLowerCase();
        if (!Number.isFinite(qty) || qty <= 0) return;
        if (unit.indexOf("hour") === 0) hours[role] += qty;
        else if (unit.indexOf("day") === 0) dayQty[role] += qty;
        else flats[role] += qty;
        return;
      }
      const legacy = trimmed.match(/^(?:Hourly|Daily|Flat) service — ([\d.]+) (hours?|days?|flat)\b/i);
      if (!legacy) return;
      const qty = Number(legacy[1]);
      const unit = String(legacy[2] || "").toLowerCase();
      if (!Number.isFinite(qty) || qty <= 0) return;
      if (unit.indexOf("hour") === 0) hours.Pro += qty;
      else if (unit.indexOf("day") === 0) dayQty.Pro += qty;
      else flats.Pro += qty;
    });
    const lines = [];
    const pushRole = (role) => {
      if (hours[role] > 0) {
        const n = formatBilledQty(hours[role]);
        lines.push(`${role}: ${n} ${Number(n) === 1 ? "hour" : "hours"}`);
      } else if (dayQty[role] > 0) {
        const n = formatBilledQty(dayQty[role]);
        lines.push(`${role}: ${n} ${Number(n) === 1 ? "day" : "days"}`);
      } else if (flats[role] > 0) {
        lines.push(`${role}: flat`);
      }
    };
    pushRole("Pro");
    pushRole("Assistant");
    const dayList = formatBilledDayList(dates);
    if (dayList) lines.push(`Days: ${dayList}`);
    return lines.join("\n");
  }

  function billedLooksTechnical(text) {
    const s = String(text || "");
    return / at \$/i.test(s) || /^(Hourly|Daily|Flat) service\b/im.test(s) || /Labor subtotal:/i.test(s);
  }

  function formatClientFacingWorkDetails(raw) {
    const parsed = parseNotes(raw);
    const billed = summarizeBilledWork(parsed.billedWork);
    const parts = [];
    if (parsed.description) parts.push(parsed.description);
    if (billed && !billedLooksTechnical(billed)) parts.push(billed);
    if (parsed.materials) parts.push("Materials\n" + parsed.materials);
    return parts.join("\n\n");
  }

  return {
    stripInternalMarkers,
    parseNotes,
    summarizeBilledWork,
    formatClientFacingWorkDetails
  };
});
