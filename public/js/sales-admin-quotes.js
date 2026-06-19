(() => {
  "use strict";

  const API = "/.netlify/functions/list-tenant-quotes";
  const GET_EDIT_API = "/.netlify/functions/get-tenant-quote-edit";
  const UPDATE_EDIT_API = "/.netlify/functions/update-tenant-quote-edit";
  const RESEND_QUOTE_API = "/.netlify/functions/resend-tenant-quote";
  const LIST_QUERY = "?limit=25&offset=0";

  const RESEND_DEFAULT_MESSAGE_NOTE =
    "We updated your estimate as requested. Please review the corrected version using the same link.";

  const RESEND_CONFIRM_TEXT =
    "This will resend the updated quote to the client using the same public quote link. Continue?";

  const LOCK_REASON_LABELS = {
    quote_accepted_status: "Quote has been accepted",
    quote_accepted_at: "Quote has an accepted timestamp",
    quote_has_project: "Project already exists",
    quote_has_invoice: "Invoice already exists",
    quote_has_payment: "Payment exists",
    deposit_paid: "Deposit was paid",
    client_ack_started: "Client acknowledgement/signature started",
    quote_archived_status: "Quote is archived",
    quote_approved_status: "Quote is approved",
  };

  const EDIT_FIELD_IDS = {
    client_name: "saEditClientName",
    client_email: "saEditClientEmail",
    client_phone: "saEditClientPhone",
    project_name: "saEditProjectName",
    title: "saEditTitle",
    project_address: "saEditProjectAddress",
    job_site: "saEditJobSite",
    notes: "saEditNotes",
    terms: "saEditTerms",
    start_date: "saEditStartDate",
    due_date: "saEditDueDate",
  };

  let publishedThisMonth = null;
  let kpiObserverInstalled = false;
  let editState = {
    quoteId: "",
    locked: false,
    requiresSentConfirm: false,
    saving: false,
    resending: false,
    saveSucceeded: false,
    canResend: false,
  };

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

  function normStatus(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  function formatStatusLabel(raw) {
    const st = normStatus(raw);
    if (st === "ready_to_send") return "Ready to send";
    if (st === "accepted") return "Accepted";
    if (st === "approved") return "Approved";
    if (st === "archived") return "Archived";
    if (st === "declined") return "Declined";
    if (st === "draft") return "Draft";
    if (st === "sent") return "Sent";
    if (!st) return "—";
    return st.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatDate(iso) {
    const t = String(iso || "").trim();
    if (!t) return "—";
    const d = t.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "—";
  }

  function formatMoney(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return "—";
    const cur = String(currency || "USD").trim() || "USD";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: cur,
        maximumFractionDigits: 2,
      }).format(n);
    } catch (_err) {
      return `${cur} ${n.toFixed(2)}`;
    }
  }

  function sellerOwnerLabel(quote) {
    const email = String(quote?.seller_email || "").trim();
    if (email) return email;
    if (normStatus(quote?.created_by_role) === "seller") return "Seller";
    return "Owner";
  }

  function projectLabel(quote) {
    const name = String(quote?.project_name || "").trim();
    if (name) return name;
    const title = String(quote?.title || "").trim();
    return title || "—";
  }

  function isLikelyLockedRow(quote) {
    const st = normStatus(quote?.status);
    if (["accepted", "approved", "archived"].includes(st)) return true;
    if (quote?.has_tenant_project) return true;
    if (String(quote?.accepted_at || "").trim()) return true;
    return false;
  }

  function lockReasonLabel(code) {
    return LOCK_REASON_LABELS[code] || String(code || "").replace(/_/g, " ");
  }

  function applyPublishedKpi() {
    const labelEl = $("saKpiSentLabel");
    const valueEl = $("saKpiSent");
    if (labelEl) labelEl.textContent = "Published This Month";
    if (valueEl && publishedThisMonth != null) {
      valueEl.textContent = String(publishedThisMonth);
      valueEl.title = "Quotes published (created) this UTC month — not email sent";
    }
  }

  function installKpiOverwriteGuard() {
    if (kpiObserverInstalled) return;
    const valueEl = $("saKpiSent");
    if (!valueEl) return;
    kpiObserverInstalled = true;
    const observer = new MutationObserver(() => {
      if (valueEl.textContent === "Not available yet" && publishedThisMonth != null) {
        applyPublishedKpi();
      }
    });
    observer.observe(valueEl, { childList: true, characterData: true, subtree: true });
  }

  function setPipelineState(state, message) {
    const loading = $("saQuotePipelineLoading");
    const err = $("saQuotePipelineError");
    const errMsg = $("saQuotePipelineErrorMsg");
    const empty = $("saQuotePipelineEmpty");
    const wrap = $("saQuotePipelineTableWrap");
    if (loading) loading.hidden = state !== "loading";
    if (err) err.hidden = state !== "error";
    if (errMsg && message) errMsg.textContent = message;
    if (empty) empty.hidden = state !== "empty";
    if (wrap) wrap.hidden = state !== "ready";
    if (state === "loading") {
      if (empty) empty.hidden = true;
      if (err) err.hidden = true;
      if (wrap) wrap.hidden = true;
    }
  }

  function setEditFeedback(message, tone) {
    const el = $("saQuoteEditFeedback");
    if (!el) return;
    const text = String(message || "").trim();
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      el.className = "sa-edit-banner";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = "sa-edit-banner";
    if (tone === "ok") el.classList.add("sa-edit-banner--ok");
    else if (tone === "err") el.classList.add("sa-edit-banner--err");
    else if (tone === "warn") el.classList.add("sa-edit-banner--warn");
  }

  function setEditFormDisabled(disabled) {
    const form = $("saQuoteEditForm");
    if (!form) return;
    form.querySelectorAll("input, textarea").forEach((el) => {
      el.disabled = Boolean(disabled);
    });
    const confirm = $("saQuoteEditSentConfirm");
    if (confirm) confirm.disabled = Boolean(disabled);
  }

  function isClientEmailPresent(raw) {
    const s = String(raw || "").trim();
    if (!s) return false;
    const at = s.indexOf("@");
    if (at < 1) return false;
    return s.indexOf(".", at + 1) > at;
  }

  function canResendQuote(quote, edit) {
    if (!quote || !edit) return false;
    if (Boolean(edit.locked) || !edit.is_editable) return false;
    const publicUrl = String(quote.public_url || "").trim();
    if (!publicUrl) return false;
    return isClientEmailPresent(quote.client_email);
  }

  function updateResendButtonState() {
    const resendBtn = $("saQuoteEditResend");
    const hint = $("saQuoteEditResendHint");
    if (!resendBtn) return;

    const showResend = editState.canResend && !editState.locked;
    resendBtn.hidden = !showResend;

    const emailField = $("saEditClientEmail");
    const emailFromForm = emailField ? String(emailField.value || "").trim() : "";
    const hasEmail = isClientEmailPresent(emailFromForm);

    if (hint) {
      const showHint = showResend && !hasEmail && !editState.locked;
      hint.hidden = !showHint;
    }

    if (!showResend) {
      resendBtn.disabled = true;
      return;
    }

    if (editState.resending) {
      resendBtn.disabled = true;
      resendBtn.textContent = "Resending…";
      return;
    }

    resendBtn.textContent = "Resend Edited Quote";
    resendBtn.disabled =
      editState.saving || editState.resending || !hasEmail || !editState.saveSucceeded;
  }

  function updateSaveButtonState() {
    const saveBtn = $("saQuoteEditSave");
    if (saveBtn) {
      if (editState.locked) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Quote locked";
      } else if (editState.saving) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
      } else if (editState.requiresSentConfirm) {
        const checked = Boolean($("saQuoteEditSentConfirm")?.checked);
        saveBtn.disabled = !checked;
        saveBtn.textContent = checked ? "Save changes" : "Confirm public link update";
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
      }
    }
    updateResendButtonState();
  }

  function isoDateForInput(value) {
    const t = String(value ?? "").trim();
    if (!t) return "";
    const d = t.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
  }

  function fillEditForm(quote) {
    const q = quote && typeof quote === "object" ? quote : {};
    for (const [key, id] of Object.entries(EDIT_FIELD_IDS)) {
      const el = $(id);
      if (!el) continue;
      const raw = q[key];
      if (key === "start_date" || key === "due_date") {
        el.value = isoDateForInput(raw);
      } else {
        el.value = raw == null ? "" : String(raw);
      }
    }
  }

  function readEditFormBody() {
    const body = { quote_id: editState.quoteId };
    for (const key of Object.keys(EDIT_FIELD_IDS)) {
      const el = $(EDIT_FIELD_IDS[key]);
      if (!el) continue;
      body[key] = el.value;
    }
    if (editState.requiresSentConfirm && $("saQuoteEditSentConfirm")?.checked) {
      body.confirm_sent_update = true;
    }
    return body;
  }

  function mapApiError(data, status) {
    const code = String(data?.code || "").trim();
    const err = String(data?.error || "").trim();
    if (status === 401) return "Sign in required to edit quotes.";
    if (status === 403) return err || "Owner or admin permission required.";
    if (code === "quote_not_found") return "Quote not found.";
    if (code === "quote_locked") {
      const reasons = Array.isArray(data?.lock_reasons) ? data.lock_reasons : [];
      if (reasons.length) {
        return `Quote is locked: ${reasons.map(lockReasonLabel).join("; ")}`;
      }
      return err || "Quote is locked.";
    }
    if (code === "sent_quote_confirmation_required") {
      return "Check the box to confirm updating the public quote link.";
    }
    if (code === "unknown_fields") {
      const fields = Array.isArray(data?.fields) ? data.fields.join(", ") : "";
      return fields ? `Disallowed fields: ${fields}` : err || "Unknown fields in request.";
    }
    if (code === "no_edit_fields") return "No editable fields were provided.";
    if (code === "invalid_date") return err || "Invalid date format. Use YYYY-MM-DD.";
    return err || "Unable to complete request.";
  }

  function mapResendApiError(data, status) {
    const code = String(data?.code || "").trim();
    const err = String(data?.error || "").trim();
    if (status === 401) return "Sign in required to resend quotes.";
    if (status === 403) return err || "Owner or admin permission required.";
    if (code === "client_email_required") {
      return "Client email is required before resending.";
    }
    if (code === "quote_locked") {
      const reasons = Array.isArray(data?.lock_reasons) ? data.lock_reasons : [];
      if (reasons.length) {
        return `Quote is locked: ${reasons.map(lockReasonLabel).join("; ")}`;
      }
      return err || "Quote is locked.";
    }
    if (code === "public_link_missing") {
      return "Quote has no public link. Publish the quote before resending.";
    }
    if (code === "zapier_not_configured") {
      return "Quote was saved, but resend email is not configured.";
    }
    if (code === "zapier_send_failed") {
      return "Quote was saved, but resend email failed. Please try again.";
    }
    if (code === "unknown_fields") {
      const fields = Array.isArray(data?.fields) ? data.fields.join(", ") : "";
      return fields ? `Disallowed fields: ${fields}` : err || "Unknown fields in request.";
    }
    return err || "Unable to resend quote.";
  }

  function readResendBody() {
    return {
      quote_id: editState.quoteId,
      message_note: RESEND_DEFAULT_MESSAGE_NOTE,
    };
  }

  function applyResendLockFromResponse(data) {
    const reasons = Array.isArray(data?.lock_reasons) ? data.lock_reasons : [];
    editState.locked = true;
    editState.canResend = false;
    const lockBanner = $("saQuoteEditLockBanner");
    const lockList = $("saQuoteEditLockList");
    if (lockBanner && lockList && reasons.length) {
      lockBanner.hidden = false;
      lockList.innerHTML = reasons
        .map((code) => `<li>${escapeHtml(lockReasonLabel(code))}</li>`)
        .join("");
    }
    setEditFormDisabled(true);
    updateSaveButtonState();
    updateResendButtonState();
  }

  function closeEditModal() {
    const modal = $("saQuoteEditModal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    editState = {
      quoteId: "",
      locked: false,
      requiresSentConfirm: false,
      saving: false,
      resending: false,
      saveSucceeded: false,
      canResend: false,
    };
    setEditFeedback("");
    updateResendButtonState();
    const hint = $("saQuoteEditResendHint");
    if (hint) hint.hidden = true;
  }

  function openEditModalShell() {
    const modal = $("saQuoteEditModal");
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    setEditFeedback("");
    editState.saveSucceeded = false;
    editState.canResend = false;
    editState.resending = false;
    const resendBtn = $("saQuoteEditResend");
    if (resendBtn) resendBtn.hidden = true;
    const hint = $("saQuoteEditResendHint");
    if (hint) hint.hidden = true;
    const lockBanner = $("saQuoteEditLockBanner");
    const warnBanner = $("saQuoteEditWarning");
    const loading = $("saQuoteEditLoading");
    const meta = $("saQuoteEditMeta");
    const lockList = $("saQuoteEditLockList");
    if (lockBanner) lockBanner.hidden = true;
    if (warnBanner) warnBanner.hidden = true;
    if (loading) loading.hidden = false;
    if (meta) meta.hidden = true;
    if (lockList) lockList.innerHTML = "";
    const confirm = $("saQuoteEditSentConfirm");
    if (confirm) confirm.checked = false;
    setEditFormDisabled(true);
    updateSaveButtonState();
    updateResendButtonState();
  }

  function applyEditPayload(data) {
    const quote = data?.quote || {};
    const edit = data?.edit || {};
    const locked = Boolean(edit.locked) || !edit.is_editable;
    editState.locked = locked;
    editState.canResend = canResendQuote(quote, edit);
    editState.requiresSentConfirm =
      !locked && Array.isArray(edit.warnings) && edit.warnings.includes("quote_viewed_or_sent");

    const subtitle = $("saQuoteEditSubtitle");
    if (subtitle) {
      const num = String(quote.quote_number_display || "").trim() || "—";
      const proj = String(quote.project_name || quote.title || "").trim() || "—";
      subtitle.textContent = `${num} · ${proj}`;
    }

    const meta = $("saQuoteEditMeta");
    const metaStatus = $("saQuoteEditMetaStatus");
    const metaTotal = $("saQuoteEditMetaTotal");
    if (meta) meta.hidden = false;
    if (metaStatus) metaStatus.textContent = formatStatusLabel(quote.status);
    if (metaTotal) metaTotal.textContent = formatMoney(quote.total, quote.currency);

    const lockBanner = $("saQuoteEditLockBanner");
    const lockList = $("saQuoteEditLockList");
    const reasons = Array.isArray(edit.lock_reasons) ? edit.lock_reasons : [];
    if (locked && lockBanner && lockList) {
      lockBanner.hidden = false;
      lockList.innerHTML = reasons
        .map((code) => `<li>${escapeHtml(lockReasonLabel(code))}</li>`)
        .join("");
    } else if (lockBanner) {
      lockBanner.hidden = true;
    }

    const warnBanner = $("saQuoteEditWarning");
    if (warnBanner) warnBanner.hidden = !editState.requiresSentConfirm;

    fillEditForm(quote);
    setEditFormDisabled(locked);
    updateSaveButtonState();
    updateResendButtonState();
  }

  async function fetchQuoteEdit(quoteId) {
    const qid = encodeURIComponent(String(quoteId || "").trim());
    const response = await fetch(`${GET_EDIT_API}?quote_id=${qid}`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      data = {};
    }
    return { response, data };
  }

  async function openQuoteEdit(quoteId) {
    if (!quoteId) return;
    editState.quoteId = String(quoteId).trim();
    openEditModalShell();

    try {
      const { response, data } = await fetchQuoteEdit(editState.quoteId);
      const loading = $("saQuoteEditLoading");
      if (loading) loading.hidden = true;

      if (!response.ok || data.ok !== true) {
        setEditFeedback(mapApiError(data, response.status), "err");
        editState.locked = true;
        setEditFormDisabled(true);
        updateSaveButtonState();
        updateResendButtonState();
        return;
      }

      applyEditPayload(data);
    } catch (err) {
      const loading = $("saQuoteEditLoading");
      if (loading) loading.hidden = true;
      setEditFeedback(err?.message || "Network error loading quote.", "err");
      editState.locked = true;
      setEditFormDisabled(true);
      updateSaveButtonState();
      updateResendButtonState();
    }
  }

  async function saveQuoteEdit() {
    if (editState.locked || editState.saving || !editState.quoteId) return;

    if (editState.requiresSentConfirm && !$("saQuoteEditSentConfirm")?.checked) {
      setEditFeedback("Check the box to confirm updating the public quote link.", "warn");
      updateSaveButtonState();
      return;
    }

    editState.saving = true;
    updateSaveButtonState();
    setEditFeedback("");

    try {
      const body = readEditFormBody();
      const response = await fetch(UPDATE_EDIT_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        data = {};
      }

      if (!response.ok || data.ok !== true) {
        setEditFeedback(mapApiError(data, response.status), "err");
        if (data?.code === "sent_quote_confirmation_required") {
          editState.requiresSentConfirm = true;
          const warnBanner = $("saQuoteEditWarning");
          if (warnBanner) warnBanner.hidden = false;
        }
        return;
      }

      applyEditPayload(data);
      editState.saveSucceeded = true;
      setEditFeedback("Quote updated successfully.", "ok");
      void loadQuotePipeline();
    } catch (err) {
      setEditFeedback(err?.message || "Network error saving quote.", "err");
    } finally {
      editState.saving = false;
      updateSaveButtonState();
      updateResendButtonState();
    }
  }

  async function resendQuoteEdit() {
    if (
      editState.locked ||
      editState.resending ||
      editState.saving ||
      !editState.quoteId ||
      !editState.canResend ||
      !editState.saveSucceeded
    ) {
      return;
    }

    const emailField = $("saEditClientEmail");
    if (!isClientEmailPresent(emailField?.value)) {
      setEditFeedback("Client email is required before resending.", "warn");
      updateResendButtonState();
      return;
    }

    if (!window.confirm(RESEND_CONFIRM_TEXT)) {
      return;
    }

    editState.resending = true;
    updateResendButtonState();
    setEditFeedback("");

    try {
      const body = readResendBody();
      const response = await fetch(RESEND_QUOTE_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        data = {};
      }

      if (!response.ok || data.ok !== true) {
        const msg = mapResendApiError(data, response.status);
        const tone =
          data?.code === "zapier_not_configured" || data?.code === "zapier_send_failed"
            ? "warn"
            : "err";
        setEditFeedback(msg, tone);
        if (data?.code === "quote_locked") {
          applyResendLockFromResponse(data);
        }
        return;
      }

      const sentTo = String(data.sent_to || "").trim();
      setEditFeedback(
        sentTo ? `Updated quote resent to ${sentTo}.` : "Updated quote resent to client.",
        "ok"
      );
      void loadQuotePipeline();
    } catch (err) {
      setEditFeedback(err?.message || "Network error resending quote.", "err");
    } finally {
      editState.resending = false;
      updateResendButtonState();
    }
  }

  function renderQuotePipeline(quotes) {
    const body = $("saQuotePipelineBody");
    if (!body) return;

    if (!Array.isArray(quotes) || quotes.length === 0) {
      body.innerHTML = "";
      setPipelineState("empty");
      return;
    }

    body.innerHTML = quotes
      .map((quote) => {
        const estimate = String(quote.quote_number_display || "").trim() || "—";
        const status = formatStatusLabel(quote.status);
        const linked = quote.has_tenant_project ? "Yes" : "No";
        const qid = String(quote.id || "").trim();
        const likelyLocked = isLikelyLockedRow(quote);
        const editBtnClass = likelyLocked ? "btn ghost sa-edit-btn-locked" : "btn ghost";
        const editTitle = likelyLocked
          ? "View lock status — this quote may not be editable"
          : "Edit quote metadata";
        return (
          "<tr>" +
          `<td>${escapeHtml(estimate)}</td>` +
          `<td>${escapeHtml(projectLabel(quote))}</td>` +
          `<td>${escapeHtml(String(quote.client_name || "").trim() || "—")}</td>` +
          `<td>${escapeHtml(status)}</td>` +
          `<td>${escapeHtml(sellerOwnerLabel(quote))}</td>` +
          `<td>${escapeHtml(formatMoney(quote.total, quote.currency))}</td>` +
          `<td>${escapeHtml(formatDate(quote.created_at))}</td>` +
          `<td>${escapeHtml(formatDate(quote.accepted_at))}</td>` +
          `<td>${escapeHtml(linked)}</td>` +
          `<td><div class="sa-row-actions">` +
          `<button type="button" class="${editBtnClass}" data-sa-quote-edit="${escapeHtml(qid)}" title="${escapeHtml(editTitle)}">Edit</button>` +
          `</div></td>` +
          "</tr>"
        );
      })
      .join("");

    setPipelineState("ready");
  }

  async function loadQuotePipeline() {
    if (!$("saQuotePipelineSection")) return;

    setPipelineState("loading");

    try {
      const response = await fetch(`${API}${LIST_QUERY}`, {
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
        setPipelineState("error", "Owner sign-in required to view quote pipeline.");
        return;
      }

      if (!response.ok || data.ok !== true) {
        const msg = String(data.error || "Unable to load quotes.").trim();
        setPipelineState("error", msg);
        return;
      }

      if (data.summary && typeof data.summary.published_this_month === "number") {
        publishedThisMonth = data.summary.published_this_month;
        applyPublishedKpi();
        installKpiOverwriteGuard();
      }

      renderQuotePipeline(data.quotes);
    } catch (err) {
      setPipelineState("error", err?.message || "Unexpected error loading quotes.");
    }
  }

  function installEditModalHandlers() {
    const modal = $("saQuoteEditModal");
    const closeBtn = $("saQuoteEditClose");
    const cancelBtn = $("saQuoteEditCancel");
    const saveBtn = $("saQuoteEditSave");
    const resendBtn = $("saQuoteEditResend");
    const confirm = $("saQuoteEditSentConfirm");
    const body = $("saQuotePipelineBody");
    const emailField = $("saEditClientEmail");

    if (closeBtn) closeBtn.addEventListener("click", closeEditModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeEditModal);
    if (saveBtn) saveBtn.addEventListener("click", () => void saveQuoteEdit());
    if (resendBtn) resendBtn.addEventListener("click", () => void resendQuoteEdit());
    if (emailField) {
      emailField.addEventListener("input", () => updateResendButtonState());
    }
    if (confirm) {
      confirm.addEventListener("change", () => {
        updateSaveButtonState();
        if (confirm.checked) setEditFeedback("");
      });
    }
    if (modal) {
      modal.addEventListener("click", (ev) => {
        if (ev.target === modal) closeEditModal();
      });
    }
    if (body) {
      body.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-sa-quote-edit]");
        if (!btn) return;
        const qid = String(btn.getAttribute("data-sa-quote-edit") || "").trim();
        if (qid) void openQuoteEdit(qid);
      });
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (modal && !modal.hidden) closeEditModal();
    });
  }

  function boot() {
    if (!$("saQuotePipelineSection")) return;

    installEditModalHandlers();

    const refreshBtn = $("saQuotePipelineRefresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        void loadQuotePipeline();
      });
    }

    void loadQuotePipeline();

    window.setTimeout(applyPublishedKpi, 0);
    window.setTimeout(applyPublishedKpi, 250);
    window.setTimeout(applyPublishedKpi, 1000);
    window.setTimeout(applyPublishedKpi, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
