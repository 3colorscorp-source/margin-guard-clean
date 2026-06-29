(() => {
  "use strict";

  const LS_QUOTES = "mg_ai_closer_lab_quotes_v1";

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMoney(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  }

  function loadLatestQuote() {
    try {
      const raw = localStorage.getItem(LS_QUOTES);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list) || !list.length) return null;
      return list[0];
    } catch (_err) {
      return null;
    }
  }

  function unitLabel(unitType) {
    const map = { sq_ft: "sq ft", fixture: "fixtures", room: "rooms", linear_ft: "linear ft" };
    return map[unitType] || unitType;
  }

  function budgetGapLabel(quote) {
    const min = Number(quote.budgetMin);
    const max = Number(quote.budgetMax);
    const low = Number(quote.rangeLow);
    const high = Number(quote.rangeHigh);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(low)) {
      return "No client budget captured — confirm range on Zoom.";
    }
    if (max >= low && min <= high) return "Budget overlaps starter range — good fit to close.";
    if (max < low) {
      const gap = low - max;
      return `Budget below range by ~${formatMoney(gap)} — discuss scope trim or phased work.`;
    }
    return "Budget above range — room to add upgrades or faster schedule.";
  }

  function recommendation(quote) {
    const style = String(quote.closingStyle || "consultative");
    const gap = budgetGapLabel(quote);
    const zoom = quote.zoomRequested
      ? `Client requested Zoom (${escapeHtml(quote.zoomSlot || "time TBD")}). Open with scope recap.`
      : "No Zoom booked yet — lead with a 15-minute fit call.";
    const sent = quote.quoteSent
      ? "Starter quote already sent (lab mock) — follow up within 24h."
      : "Offer to send starter quote after confirming scope.";

    const styleLine =
      style === "direct"
        ? "Be direct: confirm timeline, deposit path, and next step."
        : style === "educational"
          ? "Educate on prep, access, and material choices before price lock."
          : "Consultative: validate pain, mirror scope, then anchor the range.";

    return `${zoom} ${sent} ${styleLine} ${gap}`;
  }

  function renderBriefing(quote) {
    const empty = $("aclOwnerEmpty");
    const panel = $("aclOwnerBriefing");
    if (!empty || !panel) return;

    if (!quote) {
      empty.hidden = false;
      panel.hidden = true;
      return;
    }

    empty.hidden = true;
    panel.hidden = false;

    $("aclBriefProject").textContent = quote.projectName || "—";
    $("aclBriefClient").textContent =
      [quote.clientName, quote.clientEmail, quote.clientPhone].filter(Boolean).join(" · ") || "—";
    $("aclBriefScope").textContent =
      `${quote.serviceName || "—"} · ${quote.area ?? "—"} ${unitLabel(quote.unitType)}` +
      (quote.scopeNotes ? ` — ${quote.scopeNotes}` : "");
    $("aclBriefBudget").textContent =
      quote.budgetMin != null && quote.budgetMax != null
        ? `${formatMoney(quote.budgetMin)} – ${formatMoney(quote.budgetMax)}`
        : "—";
    $("aclBriefRange").textContent =
      quote.rangeLow != null ? `${formatMoney(quote.rangeLow)} – ${formatMoney(quote.rangeHigh)}` : "—";
    $("aclBriefDays").textContent = quote.estimatedDays != null ? String(quote.estimatedDays) : "—";
    $("aclBriefGap").textContent = budgetGapLabel(quote);
    $("aclBriefZoom").textContent = quote.zoomRequested
      ? `Yes — ${quote.zoomSlot || "slot pending"}`
      : "Not requested";
    $("aclBriefReco").textContent = recommendation(quote);
    $("aclBriefWhen").textContent = quote.createdAt ? String(quote.createdAt).slice(0, 19).replace("T", " ") : "—";
  }

  function bindEvents() {
    $("aclOwnerRefresh")?.addEventListener("click", () => renderBriefing(loadLatestQuote()));
    $("aclOwnerClear")?.addEventListener("click", () => {
      if (!window.confirm("Clear lab quotes from localStorage?")) return;
      localStorage.removeItem(LS_QUOTES);
      renderBriefing(null);
    });
  }

  function boot() {
    if (!$("aclOwnerRoot")) return;
    renderBriefing(loadLatestQuote());
    bindEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
