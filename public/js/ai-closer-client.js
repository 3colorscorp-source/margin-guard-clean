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

  function openContactModal(mode) {
    const modal = $("aclContactModal");
    if (!modal) return;
    modal.dataset.mode = mode;
    $("aclContactTitle").textContent =
      mode === "zoom" ? "Book your 15-minute Zoom" : mode === "send" ? "Send starter quote" : "Your details";
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
    const contact = {
      name: String($("aclContactName")?.value || "").trim(),
      email: String($("aclContactEmail")?.value || "").trim(),
      phone: String($("aclContactPhone")?.value || "").trim(),
    };
    if (!contact.name || !contact.email) {
      $("aclContactError").textContent = "Name and email are required.";
      $("aclContactError").hidden = false;
      return;
    }
    $("aclContactError").hidden = true;
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

  function printStarterQuote() {
    const quote = state.quote || computeQuote();
    if (!quote || quote.error) return;
    const service = findService(state.serviceId);
    const html = `<!doctype html><html><head><title>Starter Quote — ${escapeHtml(state.projectName)}</title>
      <style>body{font-family:system-ui,sans-serif;padding:32px;color:#111}h1{margin:0 0 8px} .range{font-size:28px;font-weight:800;margin:16px 0}</style></head><body>
      <h1>Starter Quote</h1>
      <p>${escapeHtml(state.projectName)} · ${escapeHtml(service?.name || "")}</p>
      <div class="range">${formatMoney(quote.rangeLow)} – ${formatMoney(quote.rangeHigh)}</div>
      <p>Scope: ${escapeHtml(state.area)} ${escapeHtml(unitLabel(service?.unitType))}</p>
      <p>Estimated schedule: ~${quote.estimatedDays} crew day(s)</p>
      <p><small>Lab mock — not a binding contract. Margin Guard AI Closer Lab.</small></p>
      </body></html>`;
    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
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
    $("aclPrintQuote")?.addEventListener("click", printStarterQuote);
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
