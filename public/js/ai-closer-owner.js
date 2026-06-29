(() => {
  "use strict";

  const LS_QUOTES = "mg_ai_closer_lab_quotes_v1";
  const LIST_API = "/.netlify/functions/ai-closer-list-prequotes";

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
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(Number(n));
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (_err) {
      return String(iso).slice(0, 16).replace("T", " ");
    }
  }

  function unitLabel(unitType) {
    const map = { sq_ft: "sq ft", fixture: "fixtures", room: "rooms", linear_ft: "linear ft" };
    return map[unitType] || unitType || "—";
  }

  function budgetSignalLabel(signal) {
    const key = String(signal || "").trim().toLowerCase();
    if (key === "overlaps_range") return "Overlaps starter range";
    if (key === "below_range") return "Below starter range";
    if (key === "above_range") return "Above starter range";
    return signal ? String(signal) : "—";
  }

  function loadLatestLocalQuote() {
    try {
      const raw = localStorage.getItem(LS_QUOTES);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list) || !list.length) return null;
      return list[0];
    } catch (_err) {
      return null;
    }
  }

  function renderLocalFallback(quote) {
    const wrap = $("aclLabFallback");
    const body = $("aclLabFallbackBody");
    if (!wrap || !body) return;
    if (!quote) {
      wrap.hidden = true;
      body.innerHTML = "";
      return;
    }
    wrap.hidden = false;
    body.innerHTML = `
      <div class="acl-inbox-card">
        <div class="acl-inbox-card__head">
          <h3 class="acl-inbox-card__title">${escapeHtml(quote.projectName || "Project")}</h3>
          <div class="acl-inbox-card__range">${escapeHtml(
            quote.rangeLow != null
              ? `${formatMoney(quote.rangeLow)} – ${formatMoney(quote.rangeHigh)}`
              : "—"
          )}</div>
        </div>
        <p class="sub" style="margin:0;">
          ${escapeHtml(quote.clientName || "—")} · ${escapeHtml(quote.clientEmail || "—")}
        </p>
      </div>`;
  }

  function renderPrequoteCard(row) {
    const range =
      row.range_low != null && row.range_high != null
        ? `${formatMoney(row.range_low)} – ${formatMoney(row.range_high)}`
        : "—";
    const scope =
      row.scope_size != null
        ? `${row.scope_size} ${unitLabel(row.unit_type)}`
        : "—";
    const clientLine = [row.client_name, row.client_email, row.client_phone]
      .filter(Boolean)
      .map((v) => escapeHtml(v))
      .join(" · ");

    return `
      <article class="acl-inbox-card" data-prequote-id="${escapeHtml(row.id)}">
        <div class="acl-inbox-card__head">
          <h3 class="acl-inbox-card__title">${escapeHtml(row.project_name || "Untitled project")}</h3>
          <div class="acl-inbox-card__range">${escapeHtml(range)}</div>
        </div>
        <dl class="acl-inbox-meta">
          <div><dt>Client</dt><dd>${clientLine || "—"}</dd></div>
          <div><dt>Work type</dt><dd>${escapeHtml(row.work_type || "—")}</dd></div>
          <div><dt>Scope</dt><dd>${escapeHtml(scope)}</dd></div>
          <div><dt>Crew days</dt><dd>${escapeHtml(
            row.estimated_crew_days != null ? String(row.estimated_crew_days) : "—"
          )}</dd></div>
          <div><dt>Client budget</dt><dd>${escapeHtml(row.client_budget || "—")}</dd></div>
          <div><dt>Budget signal</dt><dd>${escapeHtml(budgetSignalLabel(row.budget_signal))}</dd></div>
          <div><dt>Zoom slot</dt><dd>${escapeHtml(row.zoom_slot || "—")}</dd></div>
          <div><dt>Submitted</dt><dd>${escapeHtml(formatDate(row.created_at))}</dd></div>
        </dl>
        ${
          row.scope_notes
            ? `<p class="sub" style="margin:8px 0 0;">${escapeHtml(row.scope_notes)}</p>`
            : ""
        }
        <p class="acl-inbox-card__action">Review manually before creating an official quote.</p>
      </article>`;
  }

  function setStatus(message, isError) {
    const el = $("aclInboxStatus");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("acl-status--error");
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("acl-status--error", Boolean(isError));
  }

  function renderInbox(prequotes) {
    const list = $("aclInboxList");
    const empty = $("aclInboxEmpty");
    if (!list || !empty) return;

    const rows = Array.isArray(prequotes) ? prequotes : [];
    if (!rows.length) {
      list.hidden = true;
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    list.hidden = false;
    list.innerHTML = rows.map(renderPrequoteCard).join("");
  }

  async function loadInbox() {
    setStatus("Loading pre-quotes…", false);
    renderInbox([]);
    $("aclInboxEmpty").hidden = true;

    try {
      const response = await fetch(`${LIST_API}?limit=25`, {
        method: "GET",
        credentials: "include",
      });
      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        data = {};
      }

      if (response.status === 401 || response.status === 403) {
        setStatus("Owner sign-in required to view AI Closer pre-quotes.", true);
        renderInbox([]);
        renderLocalFallback(loadLatestLocalQuote());
        return;
      }

      if (!response.ok || data.ok !== true) {
        setStatus("Could not load pre-quotes right now. Try again shortly.", true);
        renderInbox([]);
        renderLocalFallback(loadLatestLocalQuote());
        return;
      }

      setStatus(data.count ? `${data.count} pre-quote(s) loaded.` : "", false);
      renderInbox(data.prequotes);
      renderLocalFallback(null);

      if (!data.count) {
        const local = loadLatestLocalQuote();
        if (local) renderLocalFallback(local);
      }
    } catch (_err) {
      setStatus("Could not reach the server. Check your connection and try again.", true);
      renderInbox([]);
      renderLocalFallback(loadLatestLocalQuote());
    }
  }

  function bindEvents() {
    $("aclOwnerRefresh")?.addEventListener("click", () => {
      void loadInbox();
    });
  }

  function boot() {
    if (!$("aclOwnerRoot")) return;
    bindEvents();
    void loadInbox();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
