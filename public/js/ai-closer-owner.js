(() => {
  "use strict";

  const LS_QUOTES = "mg_ai_closer_lab_quotes_v1";
  const LIST_API = "/.netlify/functions/ai-closer-list-prequotes";
  const UPDATE_API = "/.netlify/functions/ai-closer-update-prequote-status";

  const STATUS_ACTIONS = [
    { status: "reviewed", label: "Mark Reviewed" },
    { status: "good_lead", label: "Good Lead" },
    { status: "needs_site_visit", label: "Needs Site Visit" },
    { status: "bad_budget", label: "Bad Budget" },
    { status: "archived", label: "Archive" },
  ];

  let inboxRows = [];
  let activeFilter = "all";

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

  function statusKey(raw) {
    return String(raw || "new")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
  }

  function statusLabel(raw) {
    const key = statusKey(raw);
    const map = {
      new: "New",
      reviewed: "Reviewed",
      good_lead: "Good Lead",
      needs_site_visit: "Needs Site Visit",
      bad_budget: "Bad Budget",
      archived: "Archived",
    };
    return map[key] || "New";
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
          <div class="acl-inbox-card__range-wrap">
            <span class="acl-status-badge acl-status-badge--new">New</span>
            <div class="acl-inbox-card__range">${escapeHtml(
              quote.rangeLow != null
                ? `${formatMoney(quote.rangeLow)} – ${formatMoney(quote.rangeHigh)}`
                : "—"
            )}</div>
          </div>
        </div>
        <p class="sub" style="margin:0;">
          ${escapeHtml(quote.clientName || "—")} · ${escapeHtml(quote.clientEmail || "—")}
        </p>
      </div>`;
  }

  function filteredRows() {
    if (activeFilter === "all") return inboxRows;
    return inboxRows.filter((row) => statusKey(row.status) === activeFilter);
  }

  function updateFilterTabs() {
    const tabs = $("aclFilterTabs");
    if (!tabs) return;
    tabs.hidden = !inboxRows.length;
    tabs.querySelectorAll("[data-filter]").forEach((btn) => {
      const key = btn.getAttribute("data-filter");
      const count =
        key === "all"
          ? inboxRows.length
          : inboxRows.filter((row) => statusKey(row.status) === key).length;
      const base = btn.textContent.split(" (")[0];
      btn.textContent = count ? `${base} (${count})` : base;
      btn.classList.toggle("acl-filter-tab--active", key === activeFilter);
    });
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
    const st = statusKey(row.status);
    const actionButtons = STATUS_ACTIONS.map(
      (action) =>
        `<button type="button" class="btn ghost" data-prequote-action="${escapeHtml(action.status)}" data-prequote-id="${escapeHtml(row.id)}"${st === action.status ? " disabled" : ""}>${escapeHtml(action.label)}</button>`
    ).join("");

    return `
      <article class="acl-inbox-card" data-prequote-id="${escapeHtml(row.id)}">
        <div class="acl-inbox-card__head">
          <h3 class="acl-inbox-card__title">${escapeHtml(row.project_name || "Untitled project")}</h3>
          <div class="acl-inbox-card__range-wrap">
            <span class="acl-status-badge acl-status-badge--${escapeHtml(st)}">${escapeHtml(statusLabel(row.status))}</span>
            <div class="acl-inbox-card__range">${escapeHtml(range)}</div>
          </div>
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
        <div class="acl-card-actions">${actionButtons}</div>
        <p class="acl-inbox-card__action">Official quote conversion will come in a later step after owner review.</p>
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

  function renderInbox() {
    const list = $("aclInboxList");
    const empty = $("aclInboxEmpty");
    if (!list || !empty) return;

    updateFilterTabs();
    const rows = filteredRows();

    if (!inboxRows.length) {
      list.hidden = true;
      list.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = "<p>No AI Closer pre-quotes yet.</p>";
      return;
    }

    if (!rows.length) {
      list.hidden = true;
      list.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = `<p>No pre-quotes in <strong>${escapeHtml(statusLabel(activeFilter))}</strong>.</p>`;
      return;
    }

    empty.hidden = true;
    list.hidden = false;
    list.innerHTML = rows.map(renderPrequoteCard).join("");
  }

  async function updatePrequoteStatus(prequoteId, status) {
    const response = await fetch(UPDATE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ prequoteId, status }),
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      data = {};
    }
    if (!response.ok || data.ok !== true) {
      const msg =
        response.status === 401 || response.status === 403
          ? "Owner sign-in required to update status."
          : "Could not update status. Try again.";
      return { ok: false, error: msg };
    }
    const row = inboxRows.find((r) => r.id === prequoteId);
    if (row) row.status = data.status || status;
    return { ok: true, status: data.status || status };
  }

  async function loadInbox() {
    setStatus("Loading pre-quotes…", false);
    inboxRows = [];
    renderInbox();
    $("aclInboxEmpty").hidden = true;

    try {
      const response = await fetch(`${LIST_API}?limit=50`, {
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
        renderLocalFallback(loadLatestLocalQuote());
        return;
      }

      if (!response.ok || data.ok !== true) {
        setStatus("Could not load pre-quotes right now. Try again shortly.", true);
        renderLocalFallback(loadLatestLocalQuote());
        return;
      }

      inboxRows = Array.isArray(data.prequotes) ? data.prequotes : [];
      setStatus(inboxRows.length ? `${inboxRows.length} pre-quote(s) loaded.` : "", false);
      renderInbox();
      renderLocalFallback(null);

      if (!inboxRows.length) {
        renderLocalFallback(loadLatestLocalQuote());
      }
    } catch (_err) {
      setStatus("Could not reach the server. Check your connection and try again.", true);
      renderLocalFallback(loadLatestLocalQuote());
    }
  }

  function bindEvents() {
    $("aclOwnerRefresh")?.addEventListener("click", () => {
      void loadInbox();
    });

    $("aclFilterTabs")?.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-filter]");
      if (!btn) return;
      activeFilter = btn.getAttribute("data-filter") || "all";
      renderInbox();
    });

    $("aclInboxList")?.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-prequote-action]");
      if (!btn || btn.disabled) return;
      const prequoteId = btn.getAttribute("data-prequote-id");
      const status = btn.getAttribute("data-prequote-action");
      if (!prequoteId || !status) return;
      btn.disabled = true;
      void updatePrequoteStatus(prequoteId, status).then((result) => {
        if (result.ok) {
          setStatus(`Status updated to ${statusLabel(result.status)}.`, false);
          renderInbox();
          setTimeout(() => setStatus("", false), 3000);
        } else {
          setStatus(result.error || "Could not update status.", true);
          btn.disabled = false;
        }
      });
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
