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
  let openDetailId = null;
  let openPreviewId = null;
  let copyToastTimer = null;

  const CONVERSION_CHECKLIST = [
    "Owner reviewed lead",
    "Scope confirmed",
    "Measurements confirmed",
    "Materials/tile status confirmed",
    "Start date reviewed",
    "Final price to be set by owner",
  ];

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

  function formatDateOnly(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch (_err) {
      return String(iso).slice(0, 10);
    }
  }

  function preferredContactLabel(value) {
    const key = String(value || "").trim().toLowerCase();
    const map = {
      email: "Email",
      phone: "Phone",
      text: "Text",
      call: "Phone call",
    };
    return map[key] || (value ? String(value) : "—");
  }

  function fileListHtml(row) {
    const items = [
      row.plan_file_name ? { label: "Plan", name: row.plan_file_name } : null,
      row.current_photo_name ? { label: "Current photo", name: row.current_photo_name } : null,
      row.inspiration_photo_name
        ? { label: "Inspiration photo", name: row.inspiration_photo_name }
        : null,
    ].filter(Boolean);
    if (!items.length) return "—";
    return items.map((item) => `${escapeHtml(item.label)}: ${escapeHtml(item.name)}`).join("<br>");
  }

  function planningRange(row) {
    if (row.range_low != null && row.range_high != null) {
      return `${formatMoney(row.range_low)} – ${formatMoney(row.range_high)}`;
    }
    return "—";
  }

  function scopeLine(row) {
    return row.scope_size != null
      ? `${row.scope_size} ${unitLabel(row.unit_type)}`
      : "—";
  }

  function buildOwnerReviewSummary(row) {
    const lines = [
      "AI Closer Starter Pre-Quote — Not Final",
      "",
      `Project: ${row.project_name || "—"}`,
      `Work type: ${row.work_type || "—"}`,
      `Scope: ${scopeLine(row)}`,
      `Estimated crew days: ${row.estimated_crew_days != null ? row.estimated_crew_days : "—"}`,
      `Planning range: ${planningRange(row)}`,
      `Client budget: ${row.client_budget || "—"}`,
      `Budget signal: ${budgetSignalLabel(row.budget_signal)}`,
      "",
      `Client: ${row.client_name || "—"}`,
      `Email: ${row.client_email || "—"}`,
      `Phone: ${row.client_phone || "—"}`,
      `Preferred contact: ${preferredContactLabel(row.preferred_contact)}`,
      "",
      `Zoom slot: ${row.zoom_slot || "—"}`,
      `Target date: ${formatDateOnly(row.target_date)}`,
    ];
    if (row.scope_notes) lines.push("", `Scope notes: ${row.scope_notes}`);
    if (row.plan_file_name || row.current_photo_name || row.inspiration_photo_name) {
      lines.push("", "Attachments (filenames only):");
      if (row.plan_file_name) lines.push(`  Plan: ${row.plan_file_name}`);
      if (row.current_photo_name) lines.push(`  Current photo: ${row.current_photo_name}`);
      if (row.inspiration_photo_name) lines.push(`  Inspiration: ${row.inspiration_photo_name}`);
    }
    if (row.client_notes) lines.push("", `Client notes: ${row.client_notes}`);
    lines.push(
      "",
      `Status: ${statusLabel(row.status)}`,
      `Submitted: ${formatDate(row.created_at)}`
    );
    return lines.join("\n");
  }

  function copyViaTextarea(value) {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  async function writeClipboard(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (_err) {
        // Fall through to textarea fallback.
      }
    }
    return copyViaTextarea(value);
  }

  function showDetailCopyToast(message, isError) {
    const el = $("aclDetailCopyToast");
    if (!el) return;
    if (copyToastTimer) {
      clearTimeout(copyToastTimer);
      copyToastTimer = null;
    }
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("acl-detail-copy-toast--error");
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("acl-detail-copy-toast--error", Boolean(isError));
    if (!isError) {
      copyToastTimer = setTimeout(() => showDetailCopyToast("", false), 3000);
    }
  }

  function flashCopiedButton(btn) {
    if (!btn) return;
    const label = btn.getAttribute("data-copy-label") || btn.textContent;
    if (!btn.getAttribute("data-copy-label")) {
      btn.setAttribute("data-copy-label", label);
    }
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = btn.getAttribute("data-copy-label") || label;
    }, 1500);
  }

  async function handleCopyAction(btn, text, successMessage) {
    const value = String(text || "").trim();
    if (!value) {
      showDetailCopyToast("Nothing to copy.", true);
      return false;
    }
    const ok = await writeClipboard(value);
    if (ok) {
      showDetailCopyToast(successMessage, false);
      flashCopiedButton(btn);
      return true;
    }
    showDetailCopyToast("Copy failed. Please select and copy manually.", true);
    return false;
  }

  function closeConversionPreview() {
    const modal = $("aclConversionPreview");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    openPreviewId = null;
    const body = $("aclConversionPreviewBody");
    if (body) body.innerHTML = "";
  }

  function renderConversionPreview(row) {
    const body = $("aclConversionPreviewBody");
    if (!body || !row) return;

    const st = statusKey(row.status);
    const checklist = CONVERSION_CHECKLIST.map(
      (item) =>
        `<li><span class="acl-conversion-check" aria-hidden="true"></span>${escapeHtml(item)}</li>`
    ).join("");

    body.innerHTML = `
      <p class="acl-conversion-preview__warning">
        This preview does not create an official quote. A later owner-approved step will map this pre-quote into the real Margin Guard quote workflow.
      </p>
      <dl class="acl-detail-meta acl-detail-meta--preview">
        <div><dt>Client name</dt><dd>${escapeHtml(row.client_name || "—")}</dd></div>
        <div><dt>Client email</dt><dd>${escapeHtml(row.client_email || "—")}</dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(row.client_phone || "—")}</dd></div>
        <div><dt>Project name</dt><dd>${escapeHtml(row.project_name || "—")}</dd></div>
        <div><dt>Work type</dt><dd>${escapeHtml(row.work_type || "—")}</dd></div>
        <div><dt>Scope size</dt><dd>${escapeHtml(scopeLine(row))}</dd></div>
        <div><dt>Estimated crew days</dt><dd>${escapeHtml(row.estimated_crew_days != null ? String(row.estimated_crew_days) : "—")}</dd></div>
        <div><dt>Planning range</dt><dd>${escapeHtml(planningRange(row))}</dd></div>
        <div><dt>Budget signal</dt><dd>${escapeHtml(budgetSignalLabel(row.budget_signal))}</dd></div>
        <div><dt>Zoom slot</dt><dd>${escapeHtml(row.zoom_slot || "—")}</dd></div>
        <div><dt>Current prequote status</dt><dd><span class="acl-status-badge acl-status-badge--${escapeHtml(st)}">${escapeHtml(statusLabel(row.status))}</span></dd></div>
        ${
          row.scope_notes
            ? `<div class="acl-detail-meta__full"><dt>Scope notes</dt><dd>${escapeHtml(row.scope_notes)}</dd></div>`
            : ""
        }
      </dl>
      <div class="acl-conversion-section">
        <h4 class="acl-conversion-section__title">Before conversion</h4>
        <ul class="acl-conversion-checklist" aria-label="Conversion readiness checklist">${checklist}</ul>
      </div>`;
  }

  function openConversionPreview(prequoteId) {
    const row = inboxRows.find((r) => r.id === prequoteId);
    const modal = $("aclConversionPreview");
    if (!row || !modal) return;
    openPreviewId = prequoteId;
    renderConversionPreview(row);
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    modal.querySelector(".acl-conversion-preview__close")?.focus();
  }

  function closeDetailModal() {
    const modal = $("aclDetailModal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("acl-modal-open");
    openDetailId = null;
    closeConversionPreview();
    showDetailCopyToast("", false);
    const body = $("aclDetailBody");
    if (body) body.innerHTML = "";
  }

  function renderDetailModal(row) {
    const body = $("aclDetailBody");
    const title = $("aclDetailTitle");
    if (!body || !row) return;

    const st = statusKey(row.status);
    if (title) {
      title.textContent = row.project_name || "Pre-quote details";
    }

    body.innerHTML = `
      <span class="acl-detail-pill">Starter Pre-Quote — Not Final</span>
      <p class="acl-detail-warning">
        Review manually before creating an official quote. This screen does not create or modify official quotes.
      </p>
      <div class="acl-detail-copy-row">
        <button type="button" class="btn ghost" data-copy-label="Copy client email" data-copy-email="${escapeHtml(row.client_email || "")}"${row.client_email ? "" : " disabled"}>Copy client email</button>
        <button type="button" class="btn ghost" data-copy-label="Copy owner review summary" data-copy-summary="1" data-prequote-id="${escapeHtml(row.id)}">Copy owner review summary</button>
      </div>
      <p class="acl-detail-range">${escapeHtml(planningRange(row))}</p>
      <dl class="acl-detail-meta">
        <div><dt>Status</dt><dd><span class="acl-status-badge acl-status-badge--${escapeHtml(st)}">${escapeHtml(statusLabel(row.status))}</span></dd></div>
        <div><dt>Submitted</dt><dd>${escapeHtml(formatDate(row.created_at))}</dd></div>
        <div><dt>Client name</dt><dd>${escapeHtml(row.client_name || "—")}</dd></div>
        <div><dt>Client email</dt><dd>${escapeHtml(row.client_email || "—")}</dd></div>
        <div><dt>Client phone</dt><dd>${escapeHtml(row.client_phone || "—")}</dd></div>
        <div><dt>Preferred contact</dt><dd>${escapeHtml(preferredContactLabel(row.preferred_contact))}</dd></div>
        <div><dt>Project name</dt><dd>${escapeHtml(row.project_name || "—")}</dd></div>
        <div><dt>Work type</dt><dd>${escapeHtml(row.work_type || "—")}</dd></div>
        <div><dt>Scope size</dt><dd>${escapeHtml(scopeLine(row))}</dd></div>
        <div><dt>Unit type</dt><dd>${escapeHtml(unitLabel(row.unit_type))}</dd></div>
        <div><dt>Estimated crew days</dt><dd>${escapeHtml(row.estimated_crew_days != null ? String(row.estimated_crew_days) : "—")}</dd></div>
        <div><dt>Client budget</dt><dd>${escapeHtml(row.client_budget || "—")}</dd></div>
        <div><dt>Budget signal</dt><dd>${escapeHtml(budgetSignalLabel(row.budget_signal))}</dd></div>
        <div><dt>Zoom slot</dt><dd>${escapeHtml(row.zoom_slot || "—")}</dd></div>
        <div><dt>Target date</dt><dd>${escapeHtml(formatDateOnly(row.target_date))}</dd></div>
        <div class="acl-detail-meta__full"><dt>Plan / photo filenames</dt><dd>${fileListHtml(row)}</dd></div>
      </dl>
      ${
        row.scope_notes
          ? `<div class="acl-detail-meta__full"><dt style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.06em;color:rgba(232,238,252,0.55);margin:0 0 4px;">Scope notes</dt><div class="acl-detail-notes">${escapeHtml(row.scope_notes)}</div></div>`
          : ""
      }
      ${
        row.client_notes
          ? `<div class="acl-detail-meta__full" style="margin-top:10px;"><dt style="font-size:0.625rem;text-transform:uppercase;letter-spacing:0.06em;color:rgba(232,238,252,0.55);margin:0 0 4px;">Client notes</dt><div class="acl-detail-notes">${escapeHtml(row.client_notes)}</div></div>`
          : ""
      }
      <div class="acl-detail-convert-row">
        <button type="button" class="btn acl-convert-btn" data-prequote-preview="${escapeHtml(row.id)}">
          Create Official Quote
          <span class="acl-convert-btn__badge">Preview only</span>
        </button>
      </div>`;

    body.dataset.prequoteId = row.id;
  }

  function openDetailModal(prequoteId) {
    const row = inboxRows.find((r) => r.id === prequoteId);
    const modal = $("aclDetailModal");
    if (!row || !modal) return;
    openDetailId = prequoteId;
    showDetailCopyToast("", false);
    renderDetailModal(row);
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("acl-modal-open");
    modal.querySelector(".acl-detail-modal__close")?.focus();
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
        <div class="acl-card-actions">
          <button type="button" class="btn" data-prequote-view="${escapeHtml(row.id)}">View Details</button>
          ${actionButtons}
        </div>
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
    if (openDetailId === prequoteId) {
      const updated = inboxRows.find((r) => r.id === prequoteId);
      if (updated) {
        renderDetailModal(updated);
        if (openPreviewId === prequoteId) renderConversionPreview(updated);
      }
    }
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
      const viewBtn = ev.target.closest("[data-prequote-view]");
      if (viewBtn) {
        const prequoteId = viewBtn.getAttribute("data-prequote-view");
        if (prequoteId) openDetailModal(prequoteId);
        return;
      }

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

    $("aclDetailModal")?.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-detail-close]")) {
        closeDetailModal();
        return;
      }
      const previewBtn = ev.target.closest("[data-prequote-preview]");
      if (previewBtn) {
        const prequoteId = previewBtn.getAttribute("data-prequote-preview");
        if (prequoteId) openConversionPreview(prequoteId);
        return;
      }
      const emailBtn = ev.target.closest("[data-copy-email]");
      if (emailBtn && !emailBtn.disabled) {
        void handleCopyAction(emailBtn, emailBtn.getAttribute("data-copy-email"), "Client email copied.");
        return;
      }
      const summaryBtn = ev.target.closest("[data-copy-summary]");
      if (summaryBtn) {
        const prequoteId = summaryBtn.getAttribute("data-prequote-id");
        const row = inboxRows.find((r) => r.id === prequoteId);
        if (row) {
          void handleCopyAction(
            summaryBtn,
            buildOwnerReviewSummary(row),
            "Owner review summary copied."
          );
        }
      }
    });

    $("aclConversionPreview")?.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-preview-close]")) {
        closeConversionPreview();
      }
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (openPreviewId) {
        closeConversionPreview();
        return;
      }
      if (openDetailId) closeDetailModal();
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
