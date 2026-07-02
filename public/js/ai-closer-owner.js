(() => {
  "use strict";

  const LS_QUOTES = "mg_ai_closer_lab_quotes_v1";
  const LIST_API = "/.netlify/functions/ai-closer-list-prequotes";
  const UPDATE_API = "/.netlify/functions/ai-closer-update-prequote-status";
  const CREATE_DRAFT_API = "/.netlify/functions/ai-closer-create-draft-quote";

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
  let createSubmitting = false;
  const convertedByPrequoteId = new Map();

  const ELIGIBLE_CREATE_STATUSES = new Set(["reviewed", "good_lead", "needs_site_visit"]);

  const OWNER_CONFIRMATION_ITEMS = [
    { key: "owner_reviewed_lead", label: "Owner reviewed lead" },
    { key: "scope_confirmed", label: "Scope confirmed" },
    { key: "measurements_confirmed", label: "Measurements confirmed" },
    { key: "materials_status_confirmed", label: "Materials/tile status confirmed" },
    { key: "start_date_reviewed", label: "Start date reviewed" },
    { key: "final_price_approved", label: "Final price approved" },
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

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function getCurrentMonthPickerMeta() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    return {
      year,
      month,
      monthLabel: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      daysInMonth: new Date(year, month + 1, 0).getDate(),
      firstWeekday: new Date(year, month, 1).getDay(),
      todayDay: now.getDate(),
    };
  }

  function isoFromPickerDay(year, month, day) {
    return `${year}-${pad2(month + 1)}-${pad2(day)}`;
  }

  function formatFriendlyStartDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(`${iso}T12:00:00`);
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (_err) {
      return iso;
    }
  }

  function buildMonthDayPickerHtml(disabled) {
    const meta = getCurrentMonthPickerMeta();
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekdayHtml = weekdays
      .map((w) => `<span class="acl-month-picker__weekday">${escapeHtml(w)}</span>`)
      .join("");

    let cells = "";
    for (let i = 0; i < meta.firstWeekday; i++) {
      cells += `<span class="acl-month-picker__pad" aria-hidden="true"></span>`;
    }
    for (let day = 1; day <= meta.daysInMonth; day++) {
      const todayClass = day === meta.todayDay ? " acl-month-picker__day--today" : "";
      cells += `<button type="button" class="acl-month-picker__day${todayClass}" data-pick-day="${day}"${disabled ? " disabled" : ""}>${day}</button>`;
    }

    return `
      <div class="acl-month-picker" data-picker-year="${meta.year}" data-picker-month="${meta.month}">
        <div class="acl-month-picker__head">
          <span class="acl-month-picker__month">${escapeHtml(meta.monthLabel)}</span>
          <button type="button" class="acl-month-picker__clear" id="aclConversionClearDate"${disabled ? " disabled" : ""}>Clear date</button>
        </div>
        <div class="acl-month-picker__weekdays">${weekdayHtml}</div>
        <div class="acl-month-picker__grid" id="aclConversionDayGrid">${cells}</div>
        <p class="acl-conversion-field__help acl-month-picker__selected" id="aclConversionSelectedDateHelp">No start day selected.</p>
        <input type="hidden" id="aclConversionStartDate" value="" />
      </div>`;
  }

  function setStartDateFromDay(day) {
    const picker = document.querySelector("#aclConversionPreviewBody .acl-month-picker");
    if (!picker) return;
    const year = Number(picker.dataset.pickerYear);
    const month = Number(picker.dataset.pickerMonth);
    const dayNum = Number(day);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(dayNum)) return;

    const iso = isoFromPickerDay(year, month, dayNum);
    const hidden = $("aclConversionStartDate");
    if (hidden) hidden.value = iso;

    const grid = $("aclConversionDayGrid");
    if (grid) {
      grid.querySelectorAll(".acl-month-picker__day").forEach((btn) => {
        btn.classList.toggle(
          "acl-month-picker__day--selected",
          Number(btn.getAttribute("data-pick-day")) === dayNum
        );
      });
    }

    const help = $("aclConversionSelectedDateHelp");
    if (help) help.textContent = `Selected: ${formatFriendlyStartDate(iso)}`;
  }

  function clearStartDatePicker() {
    const hidden = $("aclConversionStartDate");
    if (hidden) hidden.value = "";
    $("aclConversionDayGrid")?.querySelectorAll(".acl-month-picker__day").forEach((btn) => {
      btn.classList.remove("acl-month-picker__day--selected");
    });
    const help = $("aclConversionSelectedDateHelp");
    if (help) help.textContent = "No start day selected.";
  }

  function getSelectedStartDateIso() {
    return String($("aclConversionStartDate")?.value || "").trim();
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

  function isEligibleCreateStatus(raw) {
    return ELIGIBLE_CREATE_STATUSES.has(statusKey(raw));
  }

  function getConvertedState(prequoteId) {
    return convertedByPrequoteId.get(String(prequoteId || "")) || null;
  }

  function getConversionInfoForPrequote(prequoteId) {
    const local = getConvertedState(prequoteId);
    if (local?.converted) return local;

    const row = inboxRows.find((r) => r.id === prequoteId);
    if (row?.conversion?.is_converted) {
      return {
        converted: true,
        duplicate: true,
        preloaded: true,
        draftQuoteId: row.conversion.draft_quote_id
          ? String(row.conversion.draft_quote_id)
          : "",
        status: row.conversion.conversion_status
          ? String(row.conversion.conversion_status)
          : "draft_created",
      };
    }
    return null;
  }

  function markPrequoteConverted(prequoteId, info) {
    convertedByPrequoteId.set(String(prequoteId), { ...info, converted: true });
  }

  function parseFinalPriceInput() {
    const input = $("aclConversionFinalPrice");
    if (!input) return null;
    const n = Number(input.value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function gatherOwnerConfirmations() {
    const out = {};
    let allTrue = true;
    for (const item of OWNER_CONFIRMATION_ITEMS) {
      const cb = document.querySelector(`[data-confirm-key="${item.key}"]`);
      const checked = Boolean(cb?.checked);
      out[item.key] = checked;
      if (!checked) allTrue = false;
    }
    return { confirmations: out, allTrue };
  }

  function showPreviewFeedback(message, tone) {
    const el = $("aclConversionPreviewFeedback");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.className = "acl-conversion-preview__feedback";
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.className = "acl-conversion-preview__feedback";
    if (tone === "success") el.classList.add("acl-conversion-preview__feedback--success");
    else if (tone === "error") el.classList.add("acl-conversion-preview__feedback--error");
    else el.classList.add("acl-conversion-preview__feedback--info");
  }

  function updateCreateButtonState() {
    const btn = $("aclConversionCreateBtn");
    if (!btn || !openPreviewId) return;

    const row = inboxRows.find((r) => r.id === openPreviewId);
    const converted = getConversionInfoForPrequote(openPreviewId);
    const footNote = $("aclConversionFootNote");

    if (converted?.converted) {
      btn.disabled = true;
      btn.textContent = converted.duplicate
        ? "Draft quote already created"
        : "Draft quote created";
      if (footNote) {
        footNote.textContent =
          "DRAFT only · Not sent · Not published · No invoice · No payment · No email";
      }
      return;
    }

    btn.textContent = "Create Draft Quote Only";

    const price = parseFinalPriceInput();
    const { allTrue } = gatherOwnerConfirmations();
    const eligible = row ? isEligibleCreateStatus(row.status) : false;
    const canCreate =
      Boolean(price) && allTrue && eligible && !createSubmitting;

    btn.disabled = !canCreate;

    if (footNote) {
      if (!eligible && row) {
        footNote.textContent =
          "Pre-quote status must be Reviewed, Good Lead, or Needs Site Visit to create a draft quote.";
      } else {
        footNote.textContent =
          "DRAFT only · Not sent · Not published · No invoice · No payment · No email";
      }
    }
  }

  function closeCreateConfirm() {
    const modal = $("aclConversionConfirm");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function openCreateConfirm() {
    if (createSubmitting || !openPreviewId) return;
    const converted = getConversionInfoForPrequote(openPreviewId);
    if (converted?.converted) return;

    const price = parseFinalPriceInput();
    const { allTrue } = gatherOwnerConfirmations();
    const row = inboxRows.find((r) => r.id === openPreviewId);
    if (!price || !allTrue || !row || !isEligibleCreateStatus(row.status)) {
      showPreviewFeedback("Complete the final price and all confirmations first.", "error");
      updateCreateButtonState();
      return;
    }

    const modal = $("aclConversionConfirm");
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    $("aclConversionConfirmSubmit")?.focus();
  }

  function buildCreateDraftPayload(row) {
    const price = parseFinalPriceInput();
    const { confirmations } = gatherOwnerConfirmations();
    const ownerNoteInput = $("aclConversionOwnerNote");
    const payload = {
      dry_run: false,
      create_draft_quote: true,
      prequote_id: row.id,
      final_price_owner_approved: price,
      owner_confirmations: confirmations,
    };
    const startDate = getSelectedStartDateIso();
    if (startDate) payload.start_date = startDate;
    const ownerNote = String(ownerNoteInput?.value || "").trim();
    if (ownerNote) payload.owner_note = ownerNote;
    return payload;
  }

  function renderConvertedSuccessBlock(info, price) {
    const lines = [
      "Draft quote created. It was not sent, published, invoiced, or emailed.",
      "",
      info.draftQuoteId ? `Draft quote ID: ${info.draftQuoteId}` : "",
      info.status ? `Status: ${info.status}` : "",
      price != null ? `Final owner-approved amount: ${formatMoney(price)}` : "",
      "",
      "Side effects: No invoice · No payment · No publish · No email",
    ].filter(Boolean);
    return lines.join("\n");
  }

  async function submitCreateDraftQuote() {
    if (createSubmitting || !openPreviewId) return;
    const row = inboxRows.find((r) => r.id === openPreviewId);
    if (!row) return;

    closeCreateConfirm();
    createSubmitting = true;
    updateCreateButtonState();
    showPreviewFeedback("Creating draft quote…", "info");

    try {
      const response = await fetch(CREATE_DRAFT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(buildCreateDraftPayload(row)),
      });

      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        data = {};
      }

      if (response.status === 409) {
        markPrequoteConverted(openPreviewId, { duplicate: true });
        showPreviewFeedback("Draft quote already created for this prequote.", "info");
        disablePreviewForm(true);
        updateCreateButtonState();
        return;
      }

      if (!response.ok || data.ok !== true) {
        const msg =
          response.status === 401 || response.status === 403
            ? "Owner sign-in required to create a draft quote."
            : String(data.error || "Could not create draft quote. Check the form and try again.");
        showPreviewFeedback(msg, "error");
        return;
      }

      const draft = data.draft_quote || {};
      const price = parseFinalPriceInput();
      markPrequoteConverted(openPreviewId, {
        draftQuoteId: draft.id ? String(draft.id) : "",
        status: draft.status ? String(draft.status) : "DRAFT",
        estimatedAmount: draft.estimated_amount ?? price,
      });
      showPreviewFeedback(renderConvertedSuccessBlock(getConvertedState(openPreviewId), price), "success");
      disablePreviewForm(true);
      updateCreateButtonState();
    } catch (_err) {
      showPreviewFeedback("Could not reach the server. Check your connection and try again.", "error");
    } finally {
      createSubmitting = false;
      updateCreateButtonState();
    }
  }

  function disablePreviewForm(disabled) {
    const body = $("aclConversionPreviewBody");
    if (!body) return;
    body.querySelectorAll("input, textarea, .acl-month-picker__day, .acl-month-picker__clear").forEach((el) => {
      el.disabled = disabled;
    });
  }

  function closeConversionPreview() {
    const modal = $("aclConversionPreview");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    openPreviewId = null;
    createSubmitting = false;
    closeCreateConfirm();
    showPreviewFeedback("", "");
    const body = $("aclConversionPreviewBody");
    if (body) body.innerHTML = "";
    const btn = $("aclConversionCreateBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Create Draft Quote Only";
    }
  }

  function renderConversionPreview(row) {
    const body = $("aclConversionPreviewBody");
    if (!body || !row) return;

    const st = statusKey(row.status);
    const converted = getConversionInfoForPrequote(row.id);
    const eligible = isEligibleCreateStatus(row.status);

    const checklist = OWNER_CONFIRMATION_ITEMS.map(
      (item) =>
        `<li>
          <input type="checkbox" id="aclConfirm_${escapeHtml(item.key)}" data-confirm-key="${escapeHtml(item.key)}"${converted?.converted ? " disabled" : ""} />
          <label for="aclConfirm_${escapeHtml(item.key)}">${escapeHtml(item.label)}</label>
        </li>`
    ).join("");

    const convertedBanner = converted?.converted
      ? `<p class="acl-conversion-converted-banner" role="status">Draft quote already created for this prequote.</p>`
      : "";

    const formDisabled = converted?.converted ? " disabled" : "";

    body.innerHTML = `
      <p class="acl-conversion-preview__warning">
        Create a DRAFT quote only after owner review. This does not send, publish, invoice, request payment, or email the client.
      </p>
      <div class="acl-conversion-safety-pills" aria-label="Safety labels">
        <span class="acl-conversion-safety-pill">DRAFT only</span>
        <span class="acl-conversion-safety-pill">Not sent</span>
        <span class="acl-conversion-safety-pill">Not published</span>
        <span class="acl-conversion-safety-pill">No invoice</span>
        <span class="acl-conversion-safety-pill">No payment</span>
        <span class="acl-conversion-safety-pill">No email</span>
      </div>
      ${convertedBanner}
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
        <h4 class="acl-conversion-section__title">Owner approvals required</h4>
        <div class="acl-conversion-form">
          <div class="acl-conversion-field">
            <label for="aclConversionFinalPrice">Final owner-approved price</label>
            <input type="number" id="aclConversionFinalPrice" min="1" step="0.01" placeholder="12000"${formDisabled} />
            <p class="acl-conversion-field__help">This is the final DRAFT quote amount approved by the owner. It is not auto-calculated by AI.</p>
          </div>
          <ul class="acl-conversion-checklist acl-conversion-checklist--interactive" aria-label="Owner confirmation checklist">${checklist}</ul>
          <div class="acl-conversion-field">
            <span class="acl-conversion-field__label" id="aclConversionStartDayLabel">Start day (optional)</span>
            ${buildMonthDayPickerHtml(Boolean(converted?.converted))}
          </div>
          <div class="acl-conversion-field">
            <label for="aclConversionOwnerNote">Owner note (optional)</label>
            <textarea id="aclConversionOwnerNote" maxlength="5000" placeholder="Optional note for the draft quote"${formDisabled}></textarea>
          </div>
        </div>
        ${
          !eligible && !converted?.converted
            ? `<p class="acl-conversion-field__help" style="margin-top:12px;">Status must be Reviewed, Good Lead, or Needs Site Visit before creating a draft quote.</p>`
            : ""
        }
      </div>`;

    if (converted?.converted) {
      if (converted.preloaded || converted.duplicate) {
        showPreviewFeedback("Draft quote already created for this prequote.", "info");
      } else if (converted.draftQuoteId) {
        showPreviewFeedback(
          renderConvertedSuccessBlock(converted, converted.estimatedAmount),
          "success"
        );
      } else {
        showPreviewFeedback("Draft quote already created for this prequote.", "info");
      }
      disablePreviewForm(true);
    } else {
      showPreviewFeedback("", "");
    }

    updateCreateButtonState();
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
    const converted = getConversionInfoForPrequote(row.id);
    if (title) {
      title.textContent = row.project_name || "Pre-quote details";
    }

    body.innerHTML = `
      <div class="acl-detail-workspace">
        <div class="acl-detail-workspace__banner">
          <span class="acl-detail-pill">Starter Pre-Quote — Not Final</span>
          ${
            converted?.converted
              ? `<p class="acl-conversion-converted-banner" role="status">Draft quote already created</p>`
              : `<p class="acl-detail-warning">
            Review manually before creating an official quote. This screen does not create or modify official quotes.
          </p>`
          }
          <div class="acl-detail-copy-row">
            <button type="button" class="btn ghost" data-copy-label="Copy client email" data-copy-email="${escapeHtml(row.client_email || "")}"${row.client_email ? "" : " disabled"}>Copy client email</button>
            <button type="button" class="btn ghost" data-copy-label="Copy owner review summary" data-copy-summary="1" data-prequote-id="${escapeHtml(row.id)}">Copy owner review summary</button>
          </div>
        </div>
        <div class="acl-detail-workspace__cols">
          <section class="acl-detail-workspace__panel">
            <h4 class="acl-detail-section__title">Lead &amp; project</h4>
            <dl class="acl-detail-meta acl-detail-meta--stack">
              <div><dt>Client name</dt><dd>${escapeHtml(row.client_name || "—")}</dd></div>
              <div><dt>Client email</dt><dd>${escapeHtml(row.client_email || "—")}</dd></div>
              <div><dt>Client phone</dt><dd>${escapeHtml(row.client_phone || "—")}</dd></div>
              <div><dt>Preferred contact</dt><dd>${escapeHtml(preferredContactLabel(row.preferred_contact))}</dd></div>
              <div><dt>Project name</dt><dd>${escapeHtml(row.project_name || "—")}</dd></div>
              <div><dt>Work type</dt><dd>${escapeHtml(row.work_type || "—")}</dd></div>
              <div><dt>Scope size</dt><dd>${escapeHtml(scopeLine(row))}</dd></div>
              <div><dt>Unit type</dt><dd>${escapeHtml(unitLabel(row.unit_type))}</dd></div>
              <div class="acl-detail-meta__full"><dt>Plan / photo filenames</dt><dd>${fileListHtml(row)}</dd></div>
            </dl>
            ${
              row.scope_notes
                ? `<div class="acl-detail-meta__full" style="margin-top:14px;"><dt class="acl-detail-section__title" style="margin-bottom:8px;">Scope notes</dt><div class="acl-detail-notes">${escapeHtml(row.scope_notes)}</div></div>`
                : ""
            }
            ${
              row.client_notes
                ? `<div class="acl-detail-meta__full" style="margin-top:14px;"><dt class="acl-detail-section__title" style="margin-bottom:8px;">Client notes</dt><div class="acl-detail-notes">${escapeHtml(row.client_notes)}</div></div>`
                : ""
            }
          </section>
          <section class="acl-detail-workspace__panel acl-detail-workspace__panel--accent">
            <h4 class="acl-detail-section__title">Planning &amp; status</h4>
            <p class="acl-detail-range">${escapeHtml(planningRange(row))}</p>
            <dl class="acl-detail-meta acl-detail-meta--stack">
              <div><dt>Status</dt><dd><span class="acl-status-badge acl-status-badge--${escapeHtml(st)}">${escapeHtml(statusLabel(row.status))}</span></dd></div>
              <div><dt>Submitted</dt><dd>${escapeHtml(formatDate(row.created_at))}</dd></div>
              <div><dt>Estimated crew days</dt><dd>${escapeHtml(row.estimated_crew_days != null ? String(row.estimated_crew_days) : "—")}</dd></div>
              <div><dt>Client budget</dt><dd>${escapeHtml(row.client_budget || "—")}</dd></div>
              <div><dt>Budget signal</dt><dd>${escapeHtml(budgetSignalLabel(row.budget_signal))}</dd></div>
              <div><dt>Zoom slot</dt><dd>${escapeHtml(row.zoom_slot || "—")}</dd></div>
              <div><dt>Target date</dt><dd>${escapeHtml(formatDateOnly(row.target_date))}</dd></div>
            </dl>
            <div class="acl-detail-convert-row">
              <button type="button" class="btn acl-convert-btn" data-prequote-preview="${escapeHtml(row.id)}">
                Create Draft Quote Only
                <span class="acl-convert-btn__badge">DRAFT ONLY</span>
              </button>
            </div>
          </section>
        </div>
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
    const converted = getConversionInfoForPrequote(row.id);
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
            ${
              converted?.converted
                ? `<span class="acl-status-badge acl-status-badge--draft_created">DRAFT CREATED</span>`
                : ""
            }
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
        <p class="acl-inbox-card__action">${
          converted?.converted
            ? "Draft quote already created for this pre-quote."
            : "Review in View Details to create a DRAFT quote when ready."
        }</p>
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
        return;
      }
      if (ev.target.closest("#aclConversionCreateBtn")) {
        const btn = $("aclConversionCreateBtn");
        if (!btn || btn.disabled) return;
        openCreateConfirm();
        return;
      }
      const dayBtn = ev.target.closest("[data-pick-day]");
      if (dayBtn && !dayBtn.disabled) {
        setStartDateFromDay(dayBtn.getAttribute("data-pick-day"));
        return;
      }
      if (ev.target.closest("#aclConversionClearDate")) {
        const clearBtn = $("aclConversionClearDate");
        if (!clearBtn || clearBtn.disabled) return;
        clearStartDatePicker();
      }
    });

    $("aclConversionPreview")?.addEventListener("input", () => {
      if (openPreviewId) updateCreateButtonState();
    });

    $("aclConversionPreview")?.addEventListener("change", () => {
      if (openPreviewId) updateCreateButtonState();
    });

    $("aclConversionConfirm")?.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-confirm-cancel]")) {
        closeCreateConfirm();
        return;
      }
      if (ev.target.closest("#aclConversionConfirmSubmit")) {
        void submitCreateDraftQuote();
      }
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      const confirmOpen = $("aclConversionConfirm") && !$("aclConversionConfirm").hidden;
      if (confirmOpen) {
        closeCreateConfirm();
        return;
      }
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
