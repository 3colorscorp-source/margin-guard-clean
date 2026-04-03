(() => {
  const LS_ESTIMATES = "mg_estimates_v1";
  const LS_ESTIMATE_DRAFT = "mg_estimate_draft_v1";
  const TENANT_SNAPSHOT_VERSION = 1;
  const TENANT_STORAGE_KEYS = [
    "mg_settings_v2",
    "mg_owner_v2",
    "mg_dashboard_v2",
    "mg_sales_v2",
    "mg_supervisor_v2",
    "mg_approvals_v2",
    "mg_active_project_v1",
    "mg_projects_v1",
    "mg_supervisor_reports_v1",
    "mg_supervisor_selected_project_v1",
    "mg_hub_view_v1",
    "mg_hub_templates_v1",
    LS_ESTIMATES,
    LS_ESTIMATE_DRAFT
  ];

  const $ = (id) => document.getElementById(id);
  const currencySymbol = "$";

  function parseJSON(raw, fallback) {
    try { return JSON.parse(raw); } catch (_err) { return fallback; }
  }

  function readStore(key, fallback) {
    const raw = localStorage.getItem(key);
    return raw ? parseJSON(raw, fallback) : fallback;
  }

  async function syncTenantSnapshot() {
    if (!window.MarginGuardTenant?.saveTenantSnapshot) return;
    const storage = {};
    TENANT_STORAGE_KEYS.forEach((key) => {
      const raw = localStorage.getItem(key);
      if (raw != null) storage[key] = parseJSON(raw, raw);
    });
    try {
      await window.MarginGuardTenant.saveTenantSnapshot({
        snapshot_version: TENANT_SNAPSHOT_VERSION,
        payload: { version: TENANT_SNAPSHOT_VERSION, storage }
      });
    } catch (_err) {
    }
  }

  function writeStore(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    syncTenantSnapshot();
  }

  function money(value, currency = currencySymbol) {
    const n = Number(value || 0);
    return `${currency}${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m]));
  }

  function normalizeDateInput(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
  }

  function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function setNotice(id, message, tone) {
    const node = $(id);
    if (!node) return;
    if (!message) {
      node.style.display = "none";
      node.className = "notice";
      node.textContent = "";
      return;
    }
    node.style.display = "block";
    node.className = `notice ${tone || ""}`.trim();
    node.textContent = message;
  }

  function uid(prefix) {
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function token() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, "");
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  }

  function loadEstimates() {
    const saved = readStore(LS_ESTIMATES, []);
    return Array.isArray(saved) ? saved : [];
  }

  function saveEstimates(estimates) {
    writeStore(LS_ESTIMATES, Array.isArray(estimates) ? estimates : []);
  }

  function createEstimateNumber() {
    const estimates = loadEstimates();
    return `EST-${String(estimates.length + 1001).padStart(4, "0")}`;
  }

  function createLine(type = "service") {
    return {
      id: uid("line"),
      sort_order: 0,
      item_type: type,
      name: "",
      description: "",
      qty: 1,
      unit: type === "labor" ? "day" : "ea",
      unit_price: 0,
      discount_type: "amount",
      discount_value: 0,
      taxable: false,
      tax_rate: 0,
      line_subtotal: 0,
      line_total: 0
    };
  }

  function createEmptyEstimate() {
    const today = new Date().toISOString().slice(0, 10);
    const expiration = new Date(Date.now() + 1000 * 60 * 60 * 24 * 15).toISOString().slice(0, 10);
    return {
      id: uid("est"),
      estimate_number: createEstimateNumber(),
      status: "draft",
      customer_id: "",
      customer_name: "",
      customer_email: "",
      customer_phone: "",
      customer_address: "",
      project_name: "",
      title: "",
      message_to_client: "",
      terms: "",
      internal_notes: "",
      currency: currencySymbol,
      issue_date: today,
      expiration_date: expiration,
      subtotal: 0,
      discount_total: 0,
      tax_total: 0,
      total: 0,
      deposit_required: 0,
      estimated_start_date: "",
      estimated_duration: "",
      sales_rep_initials: "",
      contract_url: "",
      auto_convert_to_invoice: false,
      auto_create_project: false,
      require_signature: true,
      public_token: token(),
      sent_at: "",
      viewed_at: "",
      accepted_at: "",
      declined_at: "",
      converted_invoice_id: "",
      created_by: "",
      updated_by: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items: [createLine("service")]
    };
  }

  function loadEstimateDraft() {
    const saved = readStore(LS_ESTIMATE_DRAFT, null);
    if (saved && typeof saved === "object") return saved;
    const fresh = createEmptyEstimate();
    writeStore(LS_ESTIMATE_DRAFT, fresh);
    return fresh;
  }

  function saveEstimateDraft(estimate) {
    writeStore(LS_ESTIMATE_DRAFT, estimate);
  }

  function calculateLine(line) {
    const qty = Math.max(finiteNumber(line.qty, 1), 0);
    const unitPrice = Math.max(finiteNumber(line.unit_price, 0), 0);
    const subtotal = qty * unitPrice;
    const discount = Math.max(finiteNumber(line.discount_value, 0), 0);
    const net = Math.max(subtotal - discount, 0);
    const taxRate = line.taxable ? Math.max(finiteNumber(line.tax_rate, 0), 0) : 0;
    const taxAmount = net * (taxRate / 100);
    return {
      ...line,
      qty,
      unit_price: unitPrice,
      discount_value: discount,
      tax_rate: taxRate,
      line_subtotal: subtotal,
      line_total: net + taxAmount
    };
  }

  function normalizeEstimateStatus(estimate) {
    const next = { ...estimate };
    const expiration = normalizeDateInput(next.expiration_date);
    if (expiration) {
      const expiryDate = new Date(`${expiration}T23:59:59`);
      const isClosed = ["accepted", "declined", "converted"].includes(String(next.status || "").toLowerCase());
      if (!Number.isNaN(expiryDate.getTime()) && expiryDate < new Date() && !isClosed) {
        next.status = "expired";
      }
    }
    return next;
  }

  function calculateEstimate(estimate) {
    const normalized = normalizeEstimateStatus(estimate);
    const items = (Array.isArray(normalized.items) ? normalized.items : []).map((line, index) => ({
      ...calculateLine(line),
      sort_order: index
    }));
    const subtotal = items.reduce((sum, line) => sum + finiteNumber(line.line_subtotal, 0), 0);
    const discountTotal = items.reduce((sum, line) => sum + finiteNumber(line.discount_value, 0), 0);
    const taxTotal = items.reduce((sum, line) => {
      const base = Math.max(finiteNumber(line.line_subtotal, 0) - finiteNumber(line.discount_value, 0), 0);
      return sum + Math.max(finiteNumber(line.line_total, 0) - base, 0);
    }, 0);
    const total = items.reduce((sum, line) => sum + finiteNumber(line.line_total, 0), 0);
    return {
      ...normalized,
      issue_date: normalizeDateInput(normalized.issue_date),
      expiration_date: normalizeDateInput(normalized.expiration_date),
      estimated_start_date: normalizeDateInput(normalized.estimated_start_date),
      deposit_required: Math.max(finiteNumber(normalized.deposit_required, 0), 0),
      subtotal,
      discount_total: discountTotal,
      tax_total: taxTotal,
      total,
      items
    };
  }

  function saveCurrentEstimate(estimate, statusOverride) {
    const estimates = loadEstimates();
    const next = calculateEstimate({ ...estimate, status: statusOverride || estimate.status || "draft" });
    const index = estimates.findIndex((item) => item.id === next.id);
    next.updated_at = new Date().toISOString();
    if (!next.created_at) next.created_at = next.updated_at;
    if (index >= 0) estimates[index] = next;
    else estimates.unshift(next);
    saveEstimates(estimates);
    saveEstimateDraft(next);
    return next;
  }

  function stampViewed(estimate) {
    if (estimate.viewed_at) return calculateEstimate(estimate);
    const estimates = loadEstimates();
    const index = estimates.findIndex((item) => item.id === estimate.id);
    if (index < 0) return calculateEstimate(estimate);
    const currentStatus = String(estimates[index].status || "draft").toLowerCase();
    estimates[index] = {
      ...estimates[index],
      status: ["accepted", "declined", "converted", "expired"].includes(currentStatus) ? estimates[index].status : "viewed",
      viewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    saveEstimates(estimates);
    return calculateEstimate(estimates[index]);
  }

  function collectEstimateFromForm(current) {
    const next = {
      ...current,
      customer_name: $("estimateCustomerName")?.value?.trim() || "",
      customer_email: $("estimateCustomerEmail")?.value?.trim() || "",
      customer_phone: $("estimateCustomerPhone")?.value?.trim() || "",
      customer_address: $("estimateCustomerAddress")?.value?.trim() || "",
      title: $("estimateTitle")?.value?.trim() || "",
      estimate_number: $("estimateNumber")?.value?.trim() || current.estimate_number || createEstimateNumber(),
      issue_date: normalizeDateInput($("estimateIssueDate")?.value),
      expiration_date: normalizeDateInput($("estimateExpirationDate")?.value),
      project_name: $("estimateProjectName")?.value?.trim() || "",
      currency: $("estimateCurrency")?.value || currencySymbol,
      message_to_client: $("estimateMessage")?.value?.trim() || "",
      terms: $("estimateTerms")?.value?.trim() || "",
      internal_notes: $("estimateInternalNotes")?.value?.trim() || "",
      sales_rep_initials: $("estimateSalesRep")?.value?.trim() || "",
      deposit_required: Math.max(finiteNumber($("estimateDepositRequired")?.value, 0), 0),
      estimated_start_date: normalizeDateInput($("estimateStartDate")?.value),
      estimated_duration: $("estimateDuration")?.value?.trim() || "",
      contract_url: $("estimateContractUrl")?.value?.trim() || "",
      auto_create_project: Boolean($("estimateAutoCreateProject")?.checked),
      auto_convert_to_invoice: Boolean($("estimateAutoConvertInvoice")?.checked),
      require_signature: Boolean($("estimateRequireSignature")?.checked),
      updated_at: new Date().toISOString()
    };
    next.items = Array.isArray(current.items) ? current.items : [createLine("service")];
    return calculateEstimate(next);
  }

  async function renderEstimatePublic() {
    if (!window.location.pathname.includes("estimate-public")) return;

    const tokenValue = new URLSearchParams(window.location.search).get("token") || "";

    if (!tokenValue) {
      document.body.innerHTML = `
        <div class="container narrow">
          <section class="card" style="margin-top:24px;">
            <div class="card-inner">
              <h2>Estimate no encontrado</h2>
              <div class="sub">Falta el token publico en la URL.</div>
            </div>
          </section>
        </div>
      `;
      return;
    }

    let next = null;

    try {
      const response = await fetch(`/.netlify/functions/get-public-estimate?token=${encodeURIComponent(tokenValue)}`);
      const payload = await response.json();

      if (!response.ok || !payload || !payload.estimate) {
        document.body.innerHTML = `
          <div class="container narrow">
            <section class="card" style="margin-top:24px;">
              <div class="card-inner">
                <h2>Estimate no encontrado</h2>
                <div class="sub">No se encontro un estimate real para este token.</div>
              </div>
            </section>
          </div>
        `;
        return;
      }

      next = payload.estimate;
    } catch (err) {
      document.body.innerHTML = `
        <div class="container narrow">
          <section class="card" style="margin-top:24px;">
            <div class="card-inner">
              <h2>Error cargando estimate</h2>
              <div class="sub">No fue posible consultar el estimate publico.</div>
            </div>
          </section>
        </div>
      `;
      return;
    }

    if ($("publicEstimateTitle")) {
      $("publicEstimateTitle").textContent =
        next.title || next.project_name || next.estimate_number || "Estimate";
    }

    if ($("publicEstimateMeta")) {
      $("publicEstimateMeta").textContent =
        `${next.estimate_number || ""} • Expira ${next.expiration_date || "sin fecha"}`;
    }

    if ($("publicEstimateStatus")) {
      $("publicEstimateStatus").textContent = next.status || "READY_TO_SEND";
    }

    if ($("publicEstimateCustomer")) {
      $("publicEstimateCustomer").innerHTML = `
        <strong>${escapeHtml(next.client_name || next.customer_name || "Sin cliente")}</strong><br>
        <small>${escapeHtml(next.client_email || next.customer_email || "")}</small><br>
        <small>${escapeHtml(next.customer_phone || "")}</small><br>
        <small>${escapeHtml(next.customer_address || "")}</small>
      `;
    }

    if ($("publicEstimateTotal")) {
      $("publicEstimateTotal").textContent = money(next.total || 0, next.currency || currencySymbol);
    }

    if ($("publicEstimateDeposit")) {
      $("publicEstimateDeposit").textContent = money(next.deposit_required || 0, next.currency || currencySymbol);
    }

    if ($("publicEstimateItems")) {
      const items = Array.isArray(next.items) ? next.items : [];
      $("publicEstimateItems").innerHTML = items.length
        ? items.map((line) => `
            <div class="sum-row">
              <span>${escapeHtml(line.name || line.title || line.item_type || "item")} x ${Number(line.qty || 1)}</span>
              <strong>${money(line.line_total || line.unit_price || 0, next.currency || currencySymbol)}</strong>
            </div>
            <div class="small-note">${escapeHtml(line.description || "")}</div>
          `).join("")
        : '<div class="small-note">No hay line items todavia.</div>';
    }

    if ($("publicEstimateMessage")) {
      $("publicEstimateMessage").textContent =
        next.notes || next.message_to_client || "Sin mensaje al cliente.";
    }

    if ($("publicEstimateTerms")) {
      $("publicEstimateTerms").textContent =
        next.terms || "Sin terminos especificos.";
    }

    if ($("btnPublicEstimateApprove")) {
      $("btnPublicEstimateApprove").onclick = () => {
        setNotice("publicEstimateFeedback", "Approve listo para conectar al siguiente paso.", "ok");
      };
    }

    if ($("btnPublicEstimateDecline")) {
      $("btnPublicEstimateDecline").onclick = () => {
        setNotice("publicEstimateFeedback", "Decline listo para conectar al siguiente paso.", "warn");
      };
    }
  }

  function renderEstimateBuilder() {
    if (!window.location.pathname.includes("create-estimate")) return;

    let state = calculateEstimate(loadEstimateDraft());

    const syncHeader = () => {
      if ($("estimateStatusBadge")) $("estimateStatusBadge").textContent = state.status || "draft";
      if ($("estimateHeroStatus")) $("estimateHeroStatus").textContent = (state.status || "draft").toUpperCase();
      if ($("estimateHeroMeta")) {
        const pieces = [];
        if (state.customer_name) pieces.push(state.customer_name);
        if (state.project_name) pieces.push(state.project_name);
        pieces.push(state.sent_at ? `Enviado ${new Date(state.sent_at).toLocaleDateString()}` : "Todavia no se ha enviado al cliente.");
        $("estimateHeroMeta").textContent = pieces.join(" • ");
      }
      if ($("estimatePublicLinkMeta")) {
        $("estimatePublicLinkMeta").textContent = state.public_token ? `Link listo: /estimate-public.html?token=${state.public_token}` : "Guarda o envia el estimate para generar un link publico reusable.";
      }
    };

    const fillForm = () => {
      if ($("estimateCustomerName")) $("estimateCustomerName").value = state.customer_name || "";
      if ($("estimateCustomerEmail")) $("estimateCustomerEmail").value = state.customer_email || "";
      if ($("estimateCustomerPhone")) $("estimateCustomerPhone").value = state.customer_phone || "";
      if ($("estimateCustomerAddress")) $("estimateCustomerAddress").value = state.customer_address || "";
      if ($("estimateTitle")) $("estimateTitle").value = state.title || "";
      if ($("estimateNumber")) $("estimateNumber").value = state.estimate_number || "";
      if ($("estimateIssueDate")) $("estimateIssueDate").value = normalizeDateInput(state.issue_date);
      if ($("estimateExpirationDate")) $("estimateExpirationDate").value = normalizeDateInput(state.expiration_date);
      if ($("estimateProjectName")) $("estimateProjectName").value = state.project_name || "";
      if ($("estimateCurrency")) $("estimateCurrency").value = state.currency || currencySymbol;
      if ($("estimateMessage")) $("estimateMessage").value = state.message_to_client || "";
      if ($("estimateTerms")) $("estimateTerms").value = state.terms || "";
      if ($("estimateInternalNotes")) $("estimateInternalNotes").value = state.internal_notes || "";
      if ($("estimateSalesRep")) $("estimateSalesRep").value = state.sales_rep_initials || "";
      if ($("estimateDepositRequired")) $("estimateDepositRequired").value = finiteNumber(state.deposit_required, 0);
      if ($("estimateStartDate")) $("estimateStartDate").value = normalizeDateInput(state.estimated_start_date);
      if ($("estimateDuration")) $("estimateDuration").value = state.estimated_duration || "";
      if ($("estimateContractUrl")) $("estimateContractUrl").value = state.contract_url || "";
      if ($("estimateAutoCreateProject")) $("estimateAutoCreateProject").checked = Boolean(state.auto_create_project);
      if ($("estimateAutoConvertInvoice")) $("estimateAutoConvertInvoice").checked = Boolean(state.auto_convert_to_invoice);
      if ($("estimateRequireSignature")) $("estimateRequireSignature").checked = Boolean(state.require_signature);
      syncHeader();
    };

    const renderItems = () => {
      const body = $("estimateItemsBody");
      if (!body) return;
      body.innerHTML = state.items.map((line, index) => `
        <tr>
          <td>
            <select data-est-line="${index}" data-key="item_type">
              <option value="service" ${line.item_type === "service" ? "selected" : ""}>service</option>
              <option value="material" ${line.item_type === "material" ? "selected" : ""}>material</option>
              <option value="custom" ${line.item_type === "custom" ? "selected" : ""}>custom</option>
            </select>
          </td>
          <td><input data-est-line="${index}" data-key="name" value="${escapeHtml(line.name)}" placeholder="Line item" /></td>
          <td><input data-est-line="${index}" data-key="description" value="${escapeHtml(line.description)}" placeholder="Descripcion" /></td>
          <td><input data-est-line="${index}" data-key="qty" type="number" step="0.01" value="${line.qty}" /></td>
          <td><input data-est-line="${index}" data-key="unit" value="${escapeHtml(line.unit)}" placeholder="ea" /></td>
          <td><input data-est-line="${index}" data-key="unit_price" type="number" step="0.01" value="${finiteNumber(line.unit_price, 0)}" /></td>
          <td><input data-est-line="${index}" data-key="discount_value" type="number" step="0.01" value="${finiteNumber(line.discount_value, 0)}" /></td>
          <td><input data-est-line="${index}" data-key="tax_rate" type="number" step="0.01" value="${finiteNumber(line.tax_rate, 0)}" /></td>
          <td><input data-est-line="${index}" data-key="taxable" type="checkbox" ${line.taxable ? "checked" : ""} /></td>
          <td>${money(line.line_total, state.currency)}</td>
          <td><div class="row-actions"><button class="btn danger" type="button" data-est-remove="${index}">Remove</button></div></td>
        </tr>
      `).join("");

      body.querySelectorAll("[data-key]").forEach((input) => {
        const index = Number(input.dataset.estLine || -1);
        const key = input.dataset.key;
        if (index < 0 || !state.items[index]) return;
        const commit = () => {
          if (input.type === "checkbox") state.items[index][key] = input.checked;
          else if (["qty", "unit_price", "discount_value", "tax_rate"].includes(key)) state.items[index][key] = finiteNumber(input.value, 0);
          else state.items[index][key] = input.value;
          state = collectEstimateFromForm(state);
          saveEstimateDraft(state);
          syncHeader();
          renderItems();
          renderTotals();
          renderRecent();
        };
        input.addEventListener(input.type === "checkbox" ? "change" : "input", commit);
      });

      body.querySelectorAll("[data-est-remove]").forEach((button) => {
        button.onclick = () => {
          const index = Number(button.dataset.estRemove || -1);
          if (index < 0) return;
          state.items.splice(index, 1);
          if (!state.items.length) state.items = [createLine("service")];
          state = collectEstimateFromForm(state);
          saveEstimateDraft(state);
          renderItems();
          renderTotals();
        };
      });
    };

    const renderTotals = () => {
      if ($("estimateSubtotal")) $("estimateSubtotal").textContent = money(state.subtotal, state.currency);
      if ($("estimateDiscountTotal")) $("estimateDiscountTotal").textContent = money(state.discount_total, state.currency);
      if ($("estimateTaxTotal")) $("estimateTaxTotal").textContent = money(state.tax_total, state.currency);
      if ($("estimateDepositSummary")) $("estimateDepositSummary").textContent = money(state.deposit_required, state.currency);
      if ($("estimateTotal")) $("estimateTotal").textContent = money(state.total, state.currency);
      syncHeader();
    };

    const renderRecent = () => {
      const body = $("estimateRecentBody");
      if (!body) return;
      const estimates = loadEstimates().slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).slice(0, 12);
      body.innerHTML = estimates.length ? estimates.map((estimate) => `
        <tr>
          <td>${escapeHtml(estimate.estimate_number || estimate.id)}</td>
          <td>${escapeHtml(estimate.customer_name || "Sin cliente")}</td>
          <td><span class="badge ${estimate.status === "accepted" ? "green" : (estimate.status === "declined" ? "red" : "amber")}">${escapeHtml(estimate.status || "draft")}</span></td>
          <td>${money(estimate.total, estimate.currency || currencySymbol)}</td>
          <td>
            <div class="row-actions wrap">
              <button class="btn" type="button" data-est-open="${estimate.id}">Open</button>
              <button class="btn" type="button" data-est-dup="${estimate.id}">Duplicate</button>
              <button class="btn" type="button" data-est-public="${estimate.public_token}">Public</button>
            </div>
          </td>
        </tr>
      `).join("") : '<tr><td colspan="5">Todavia no hay estimates guardados.</td></tr>';

      body.querySelectorAll("[data-est-open]").forEach((button) => {
        button.onclick = () => {
          const estimate = loadEstimates().find((item) => item.id === button.dataset.estOpen);
          if (!estimate) return;
          state = calculateEstimate(estimate);
          saveEstimateDraft(state);
          fillForm();
          renderItems();
          renderTotals();
          setNotice("estimateFeedback", `Estimate ${estimate.estimate_number} cargado.`, "ok");
        };
      });

      body.querySelectorAll("[data-est-dup]").forEach((button) => {
        button.onclick = () => {
          const estimate = loadEstimates().find((item) => item.id === button.dataset.estDup);
          if (!estimate) return;
          state = {
            ...estimate,
            id: uid("est"),
            estimate_number: createEstimateNumber(),
            status: "draft",
            sent_at: "",
            viewed_at: "",
            accepted_at: "",
            declined_at: "",
            converted_invoice_id: "",
            public_token: token(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            items: estimate.items.map((line) => ({ ...line, id: uid("line") }))
          };
          saveEstimateDraft(state);
          fillForm();
          renderItems();
          renderTotals();
          setNotice("estimateFeedback", "Estimate duplicado en un nuevo draft.", "ok");
        };
      });

      body.querySelectorAll("[data-est-public]").forEach((button) => {
        button.onclick = () => {
          const tokenValue = button.dataset.estPublic;
          if (!tokenValue) return;
          window.open(`/estimate-public.html?token=${encodeURIComponent(tokenValue)}`, "_blank");
        };
      });
    };

    const commitForm = () => {
      state = collectEstimateFromForm(state);
      saveEstimateDraft(state);
      renderTotals();
      renderRecent();
      return state;
    };

    fillForm();
    renderItems();
    renderTotals();
    renderRecent();

    [
      "estimateCustomerName",
      "estimateCustomerEmail",
      "estimateCustomerPhone",
      "estimateCustomerAddress",
      "estimateTitle",
      "estimateNumber",
      "estimateIssueDate",
      "estimateExpirationDate",
      "estimateProjectName",
      "estimateCurrency",
      "estimateMessage",
      "estimateTerms",
      "estimateInternalNotes",
      "estimateSalesRep",
      "estimateDepositRequired",
      "estimateStartDate",
      "estimateDuration",
      "estimateContractUrl",
      "estimateAutoCreateProject",
      "estimateAutoConvertInvoice",
      "estimateRequireSignature"
    ].forEach((id) => {
      const field = $(id);
      if (!field) return;
      field.addEventListener(field.type === "checkbox" ? "change" : "input", commitForm);
    });

    if ($("btnEstimateAddService")) $("btnEstimateAddService").onclick = () => { state.items.push(createLine("service")); commitForm(); renderItems(); };
    if ($("btnEstimateAddMaterial")) $("btnEstimateAddMaterial").onclick = () => { state.items.push(createLine("material")); commitForm(); renderItems(); };
    if ($("btnEstimateAddCustom")) $("btnEstimateAddCustom").onclick = () => { state.items.push(createLine("custom")); commitForm(); renderItems(); };

    if ($("btnEstimateSaveDraft")) {
      $("btnEstimateSaveDraft").onclick = () => {
        state = saveCurrentEstimate(commitForm(), "draft");
        renderRecent();
        setNotice("estimateFeedback", `Draft ${state.estimate_number} guardado.`, "ok");
      };
    }

    const openPublic = () => {
      state = saveCurrentEstimate(commitForm(), state.status || "draft");
      renderRecent();
      window.open(`/estimate-public.html?token=${encodeURIComponent(state.public_token)}`, "_blank");
    };

    if ($("btnEstimatePreview")) $("btnEstimatePreview").onclick = openPublic;
    if ($("btnEstimatePreviewInline")) $("btnEstimatePreviewInline").onclick = openPublic;
    if ($("btnEstimateOpenPublic")) $("btnEstimateOpenPublic").onclick = openPublic;

    if ($("btnEstimateSend")) {
      $("btnEstimateSend").onclick = () => {
        state = commitForm();
        if (!state.customer_name || !state.project_name || !state.items.some((line) => line.name && line.line_total > 0)) {
          setNotice("estimateFeedback", "Completa customer, proyecto y al menos una partida valida antes de enviar.", "err");
          return;
        }
        state.sent_at = new Date().toISOString();
        state.status = "sent";
        state = saveCurrentEstimate(state, "sent");
        renderRecent();
        setNotice("estimateFeedback", `Estimate ${state.estimate_number} enviado. Link publico listo.`, "ok");
      };
    }

    if ($("btnEstimateDuplicate")) {
      $("btnEstimateDuplicate").onclick = () => {
        const clone = {
          ...commitForm(),
          id: uid("est"),
          estimate_number: createEstimateNumber(),
          status: "draft",
          sent_at: "",
          viewed_at: "",
          accepted_at: "",
          declined_at: "",
          converted_invoice_id: "",
          public_token: token(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          items: state.items.map((line) => ({ ...line, id: uid("line") }))
        };
        state = calculateEstimate(clone);
        saveEstimateDraft(state);
        fillForm();
        renderItems();
        renderTotals();
        setNotice("estimateFeedback", "Estimate duplicado y listo como nuevo draft.", "ok");
      };
    }

    if ($("btnEstimateCancel")) {
      $("btnEstimateCancel").onclick = () => {
        if (!confirm("Cancelar este draft y empezar uno nuevo?")) return;
        state = createEmptyEstimate();
        saveEstimateDraft(state);
        fillForm();
        renderItems();
        renderTotals();
        setNotice("estimateFeedback", "Draft reiniciado. Ya puedes crear un estimate nuevo.", "warn");
      };
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderEstimateBuilder();
    renderEstimatePublic();
  });
})();