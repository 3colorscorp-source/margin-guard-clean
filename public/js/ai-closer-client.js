(() => {
  "use strict";

  const LS_SETTINGS = "mg_ai_closer_lab_settings_v1";
  const LS_QUOTES = "mg_ai_closer_lab_quotes_v1";

  const STEPS = ["scope", "budget", "quote", "zoom", "send"];

  let settings = null;
  let state = {
    step: 0,
    projectName: "",
    serviceId: "",
    area: "",
    scopeNotes: "",
    budgetMin: "",
    budgetMax: "",
    quote: null,
    zoomSlot: "",
    zoomRequested: false,
    quoteSent: false,
    contact: { name: "", email: "", phone: "" },
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

  function loadSettings() {
    if (window.__mgAiCloserLab?.loadSettings) return window.__mgAiCloserLab.loadSettings();
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      return raw ? JSON.parse(raw) : null;
    } catch (_err) {
      return null;
    }
  }

  function loadQuotes() {
    try {
      const raw = localStorage.getItem(LS_QUOTES);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  function saveQuote(record) {
    const list = loadQuotes();
    list.unshift(record);
    localStorage.setItem(LS_QUOTES, JSON.stringify(list.slice(0, 50)));
  }

  function formatMoney(n) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  }

  function unitLabel(unitType) {
    const map = { sq_ft: "sq ft", fixture: "fixtures", room: "rooms", linear_ft: "linear ft" };
    return map[unitType] || unitType;
  }

  const LAB_BUSINESS_FALLBACK = "Three Colors Corp";

  function getBusinessName(record) {
    const fromRecord = String(record?.businessName || "").trim();
    if (fromRecord) return fromRecord;
    const fromSettings = String(settings?.businessName || settings?.tenantName || "").trim();
    if (fromSettings) return fromSettings;
    return LAB_BUSINESS_FALLBACK;
  }

  function getContactFromForm() {
    return {
      name: String($("aclContactName")?.value || state.contact?.name || "").trim(),
      email: String($("aclContactEmail")?.value || state.contact?.email || "").trim(),
      phone: String($("aclContactPhone")?.value || state.contact?.phone || "").trim(),
    };
  }

  function hasContact() {
    const contact = getContactFromForm();
    return Boolean(contact.name && contact.email);
  }

  function syncContactToState(contact) {
    state.contact = {
      name: contact.name || "",
      email: contact.email || "",
      phone: contact.phone || "",
    };
    if ($("aclContactName")) $("aclContactName").value = state.contact.name;
    if ($("aclContactEmail")) $("aclContactEmail").value = state.contact.email;
    if ($("aclContactPhone")) $("aclContactPhone").value = state.contact.phone;
  }

  function readZoomSlotFromDom() {
    const selected = document.querySelector('input[name="aclZoomSlot"]:checked');
    if (selected) state.zoomSlot = selected.value;
  }

  function syncWizardStateFromForm() {
    state.projectName = String($("aclClientProject")?.value || state.projectName || "").trim();
    state.area = String($("aclClientArea")?.value || state.area || "").trim();
    state.scopeNotes = String($("aclClientNotes")?.value || state.scopeNotes || "").trim();
    state.serviceId = $("aclClientService")?.value || state.serviceId;
    state.budgetMin = String($("aclClientBudgetMin")?.value || state.budgetMin || "").trim();
    state.budgetMax = String($("aclClientBudgetMax")?.value || state.budgetMax || "").trim();
    readZoomSlotFromDom();
  }

  function findService(serviceId) {
    const services = settings?.services || [];
    return services.find((s) => s.id === serviceId) || services[0] || null;
  }

  function computeQuote() {
    const service = findService(state.serviceId);
    const qty = Number(state.area);
    if (!service || !Number.isFinite(qty) || qty <= 0) return null;
    const guardrails = settings?.guardrails || {};
    if (qty < guardrails.minArea || qty > guardrails.maxArea) return { error: "Quantity is outside lab guardrails." };
    if (window.__mgAiCloserLab?.computeStarterQuote) {
      return window.__mgAiCloserLab.computeStarterQuote(service, qty, guardrails);
    }
    const days = Math.ceil(qty / service.capacityPerCrewDay);
    const base = Math.round(days * service.protectedPublicCrewDayPrice * 100) / 100;
    const rangeLow = Math.ceil(base / 100) * 100;
    const rangeHigh = rangeLow + Math.max(500, Math.min(service.bufferMaxDollars || 750, Math.round(base * 0.085)));
    return { estimatedDays: days, rangeLow, rangeHigh, baseAmount: base };
  }

  function renderServiceOptions() {
    const select = $("aclClientService");
    if (!select) return;
    const services = settings?.services || [];
    select.innerHTML = services
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");
    if (services[0]) state.serviceId = services[0].id;
  }

  function updateUnitHint() {
    const service = findService($("aclClientService")?.value || state.serviceId);
    const hint = $("aclClientUnitHint");
    if (hint && service) hint.textContent = `Enter quantity in ${unitLabel(service.unitType)}.`;
    if (service) state.serviceId = service.id;
  }

  function setStep(index) {
    state.step = Math.max(0, Math.min(STEPS.length - 1, index));
    STEPS.forEach((name, i) => {
      const panel = $(`aclStep_${name}`);
      if (panel) panel.hidden = i !== state.step;
      const pill = document.querySelector(`[data-step-pill="${name}"]`);
      if (pill) {
        pill.classList.toggle("acl-step-pill--active", i === state.step);
        pill.classList.toggle("acl-step-pill--done", i < state.step);
      }
    });
    const back = $("aclClientBack");
    const next = $("aclClientNext");
    if (back) back.hidden = state.step === 0;
    if (next) {
      next.textContent = state.step === STEPS.length - 1 ? "Finish" : "Continue";
      next.hidden = state.step === STEPS.length - 1;
    }
    if (state.step === 2) renderQuoteStep();
    if (state.step === 3) renderZoomStep();
    if (state.step === 4) renderSendStep();
  }

  function renderQuoteStep() {
    const quote = computeQuote();
    state.quote = quote;
    const body = $("aclQuoteBody");
    if (!body) return;
    if (!quote || quote.error) {
      body.innerHTML = `<p class="acl-empty">${escapeHtml(quote?.error || "Enter scope and budget to generate a starter quote.")}</p>`;
      return;
    }
    const service = findService(state.serviceId);
    body.innerHTML = `
      <div class="acl-quote-hero">
        <div class="acl-quote-hero__label">Starter quote range</div>
        <div class="acl-quote-hero__value">${formatMoney(quote.rangeLow)} – ${formatMoney(quote.rangeHigh)}</div>
        <p class="acl-quote-hero__sub">Based on your scope — final price confirmed after a quick review.</p>
      </div>
      <ul class="acl-quote-facts">
        <li><span>Project</span><strong>${escapeHtml(state.projectName || "Your project")}</strong></li>
        <li><span>Work type</span><strong>${escapeHtml(service?.name || "—")}</strong></li>
        <li><span>Scope size</span><strong>${escapeHtml(state.area)} ${escapeHtml(unitLabel(service?.unitType))}</strong></li>
        <li><span>Estimated schedule</span><strong>~${quote.estimatedDays} crew day${quote.estimatedDays === 1 ? "" : "s"}</strong></li>
      </ul>
      <p class="acl-safe-note">This is a starter range for planning — not a binding contract. A licensed pro confirms details on your call.</p>`;
  }

  function renderZoomStep() {
    const slots = $("aclZoomSlots");
    if (!slots) return;
    const options = [
      "Tomorrow 10:00 AM",
      "Tomorrow 2:30 PM",
      "Day after 9:00 AM",
      "Day after 4:00 PM",
    ];
    slots.innerHTML = options
      .map(
        (slot, i) =>
          `<label class="acl-zoom-slot"><input type="radio" name="aclZoomSlot" value="${escapeHtml(slot)}" ${i === 0 ? "checked" : ""} /> ${escapeHtml(slot)}</label>`
      )
      .join("");
  }

  function renderSendStep() {
    const quote = state.quote || computeQuote();
    const summary = $("aclSendSummary");
    if (!summary || !quote || quote.error) return;
    summary.innerHTML = `
      <p><strong>${escapeHtml(state.projectName || "Your project")}</strong> · ${formatMoney(quote.rangeLow)} – ${formatMoney(quote.rangeHigh)}</p>
      <p class="sub">Zoom: ${escapeHtml(state.zoomRequested ? state.zoomSlot || "Requested" : "Not booked yet")} · Quote: ${state.quoteSent ? "Sent (lab mock)" : "Ready"}</p>`;
  }

  function validateStep() {
    if (state.step === 0) {
      state.projectName = String($("aclClientProject")?.value || "").trim();
      state.area = String($("aclClientArea")?.value || "").trim();
      state.scopeNotes = String($("aclClientNotes")?.value || "").trim();
      state.serviceId = $("aclClientService")?.value || state.serviceId;
      if (!state.projectName) return "Enter a project name.";
      if (!state.area || Number(state.area) <= 0) return "Enter a valid scope size.";
    }
    if (state.step === 1) {
      state.budgetMin = String($("aclClientBudgetMin")?.value || "").trim();
      state.budgetMax = String($("aclClientBudgetMax")?.value || "").trim();
      if (settings?.guardrails?.requireBudgetBeforeQuote) {
        if (!state.budgetMin || !state.budgetMax) return "Enter your budget range.";
      }
    }
    if (state.step === 2) {
      const quote = computeQuote();
      if (!quote || quote.error) return quote?.error || "Could not build starter quote.";
      state.quote = quote;
    }
    if (state.step === 3) {
      const selected = document.querySelector('input[name="aclZoomSlot"]:checked');
      state.zoomSlot = selected ? selected.value : "";
    }
    return "";
  }

  function buildQuoteRecord(contact) {
    const service = findService(state.serviceId);
    const quote = state.quote || computeQuote();
    return {
      id: `lab_${Date.now()}`,
      createdAt: new Date().toISOString(),
      labOnly: true,
      businessName: getBusinessName(),
      projectName: state.projectName,
      clientName: contact?.name || "",
      clientEmail: contact?.email || "",
      clientPhone: contact?.phone || "",
      serviceId: service?.id,
      serviceName: service?.name,
      unitType: service?.unitType,
      area: Number(state.area),
      scopeNotes: state.scopeNotes,
      budgetMin: Number(state.budgetMin) || null,
      budgetMax: Number(state.budgetMax) || null,
      estimatedDays: quote?.estimatedDays,
      rangeLow: quote?.rangeLow,
      rangeHigh: quote?.rangeHigh,
      zoomSlot: state.zoomSlot,
      zoomRequested: state.zoomRequested,
      quoteSent: state.quoteSent,
      closingStyle: settings?.closingStyle || "consultative",
    };
  }

  function buildPrintableHtml(record) {
    const range =
      record.rangeLow != null && record.rangeHigh != null
        ? `${formatMoney(record.rangeLow)} – ${formatMoney(record.rangeHigh)}`
        : "—";
    const scope =
      record.area != null
        ? `${record.area} ${unitLabel(record.unitType)}`
        : "—";
    const budget =
      record.budgetMin != null && record.budgetMax != null
        ? `${formatMoney(record.budgetMin)} – ${formatMoney(record.budgetMax)}`
        : "—";
    const zoomLine = record.zoomSlot
      ? escapeHtml(record.zoomSlot)
      : record.zoomRequested
        ? "Requested — time pending"
        : "Not selected";
    const contactLines = [
      record.clientName ? `<tr><th>Contact</th><td>${escapeHtml(record.clientName)}</td></tr>` : "",
      record.clientEmail ? `<tr><th>Email</th><td>${escapeHtml(record.clientEmail)}</td></tr>` : "",
      record.clientPhone ? `<tr><th>Phone</th><td>${escapeHtml(record.clientPhone)}</td></tr>` : "",
    ]
      .filter(Boolean)
      .join("");
    const notesBlock = record.scopeNotes
      ? `<section class="block"><h2>Notes</h2><p>${escapeHtml(record.scopeNotes)}</p></section>`
      : "";

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Starter Pre-Quote — ${escapeHtml(record.projectName || "Project")}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      color: #111827;
      line-height: 1.45;
    }
    .banner {
      margin-bottom: 20px;
      padding: 12px 14px;
      border: 2px solid #b45309;
      background: #fffbeb;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #92400e;
    }
    .banner p { margin: 6px 0 0; font-weight: 500; text-transform: none; letter-spacing: 0; }
    h1 { margin: 0 0 4px; font-size: 24px; }
    .business { margin: 0 0 18px; color: #4b5563; font-size: 14px; }
    .range {
      margin: 18px 0;
      font-size: 30px;
      font-weight: 800;
      color: #065f46;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: top;
    }
    th {
      width: 34%;
      color: #6b7280;
      font-weight: 600;
    }
    .block { margin-top: 18px; }
    .block h2 { margin: 0 0 8px; font-size: 15px; }
    .footer {
      margin-top: 28px;
      padding-top: 14px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #6b7280;
    }
    @media print {
      body { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="banner">
    STARTER PRE-QUOTE — NOT FINAL
    <p>Not a contract, invoice, final quote, or promised start date. Final quote requires owner review.</p>
  </div>
  <h1>Starter Pre-Quote</h1>
  <p class="business">${escapeHtml(getBusinessName(record))}</p>
  <div class="range">${range}</div>
  <table>
    <tbody>
      <tr><th>Project</th><td>${escapeHtml(record.projectName || "—")}</td></tr>
      <tr><th>Work type</th><td>${escapeHtml(record.serviceName || "—")}</td></tr>
      <tr><th>Scope size</th><td>${escapeHtml(scope)}</td></tr>
      <tr><th>Estimated crew days</th><td>${escapeHtml(record.estimatedDays != null ? String(record.estimatedDays) : "—")}</td></tr>
      <tr><th>Client budget (planning)</th><td>${escapeHtml(budget)}</td></tr>
      <tr><th>Zoom slot</th><td>${zoomLine}</td></tr>
      ${contactLines}
    </tbody>
  </table>
  ${notesBlock}
  <div class="footer">
    Margin Guard AI Closer Lab — mock starter pre-quote for planning only.
    Generated ${escapeHtml(String(record.createdAt || new Date().toISOString()).slice(0, 19).replace("T", " "))}.
  </div>
</body>
</html>`;
  }

  function downloadStarterQuoteHtml(html) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "starter-pre-quote.html";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function showClientToast(message) {
    const toast = $("aclClientToast");
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 5000);
  }

  function openPrintWindow(record) {
    const html = buildPrintableHtml(record);
    let win = null;
    try {
      win = window.open("", "_blank");
    } catch (_err) {
      win = null;
    }

    if (win) {
      try {
        win.document.open();
        win.document.write(html);
        win.document.close();
        const triggerPrint = () => {
          try {
            win.focus();
            win.print();
          } catch (_err) {
            downloadStarterQuoteHtml(html);
            showClientToast("Print window could not open — downloaded starter-pre-quote.html instead.");
          }
        };
        if (win.document.readyState === "complete") {
          setTimeout(triggerPrint, 200);
        } else {
          win.addEventListener("load", () => setTimeout(triggerPrint, 150));
          setTimeout(triggerPrint, 500);
        }
        return;
      } catch (_err) {
        try {
          win.close();
        } catch (_closeErr) {
          /* ignore */
        }
      }
    }

    downloadStarterQuoteHtml(html);
    showClientToast("Popup blocked — downloaded starter-pre-quote.html. Open it to print or save as PDF.");
  }

  function requestPrintStarterQuote() {
    syncWizardStateFromForm();
    const quote = state.quote || computeQuote();
    if (!quote || quote.error) {
      const err = $("aclClientError");
      if (err) {
        err.textContent = quote?.error || "Complete scope and budget before printing.";
        err.hidden = false;
      }
      return;
    }
    state.quote = quote;
    $("aclClientError").hidden = true;

    if (!hasContact()) {
      openContactModal("print");
      return;
    }

    const contact = getContactFromForm();
    syncContactToState(contact);
    const record = buildQuoteRecord(contact);
    saveQuote(record);
    openPrintWindow(record);
  }

  function openContactModal(mode) {
    const modal = $("aclContactModal");
    if (!modal) return;
    modal.dataset.mode = mode;
    const title = $("aclContactTitle");
    if (title) {
      title.textContent =
        mode === "zoom"
          ? "Book your 15-minute Zoom"
          : mode === "send"
            ? "Send starter quote"
            : mode === "print"
              ? "Your details for starter pre-quote"
              : "Your details";
    }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function closeContactModal() {
    const modal = $("aclContactModal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function handleContactSubmit() {
    const mode = $("aclContactModal")?.dataset.mode || "send";
    const contact = getContactFromForm();
    if (!contact.name || !contact.email) {
      $("aclContactError").textContent = "Name and email are required.";
      $("aclContactError").hidden = false;
      return;
    }
    $("aclContactError").hidden = true;
    syncContactToState(contact);
    syncWizardStateFromForm();
    const record = buildQuoteRecord(contact);
    if (mode === "zoom") {
      state.zoomRequested = true;
      record.zoomRequested = true;
    }
    if (mode === "send") {
      state.quoteSent = true;
      record.quoteSent = true;
    }
    saveQuote(record);
    closeContactModal();

    if (mode === "print") {
      openPrintWindow(record);
      return;
    }

    const toast = $("aclClientToast");
    if (toast) {
      toast.textContent =
        mode === "zoom"
          ? "Zoom request saved (lab mock). Owner briefing updated."
          : "Starter quote saved (lab mock). No real email sent.";
      toast.hidden = false;
      setTimeout(() => {
        toast.hidden = true;
      }, 4000);
    }
    if (state.step === 3 && mode === "zoom") setStep(4);
    if (state.step === 4) renderSendStep();
  }

  function bindEvents() {
    $("aclClientService")?.addEventListener("change", updateUnitHint);
    $("aclClientBack")?.addEventListener("click", () => setStep(state.step - 1));
    $("aclClientNext")?.addEventListener("click", () => {
      const err = validateStep();
      if (err) {
        $("aclClientError").textContent = err;
        $("aclClientError").hidden = false;
        return;
      }
      $("aclClientError").hidden = true;
      setStep(state.step + 1);
    });
    $("aclBookZoom")?.addEventListener("click", () => {
      const err = validateStep();
      if (state.step < 3) return;
      state.zoomSlot = document.querySelector('input[name="aclZoomSlot"]:checked')?.value || "";
      openContactModal("zoom");
    });
    $("aclSendQuote")?.addEventListener("click", () => openContactModal("send"));
    $("aclPrintQuote")?.addEventListener("click", requestPrintStarterQuote);
    $("aclContactClose")?.addEventListener("click", closeContactModal);
    $("aclContactSubmit")?.addEventListener("click", handleContactSubmit);
    $("aclContactModal")?.addEventListener("click", (ev) => {
      if (ev.target === $("aclContactModal")) closeContactModal();
    });
  }

  function boot() {
    if (!$("aclClientRoot")) return;
    settings = loadSettings() || window.__mgAiCloserLab?.defaultSettings?.() || { services: [] };
    renderServiceOptions();
    updateUnitHint();
    setStep(0);
    bindEvents();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
