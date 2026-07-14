(() => {
  "use strict";

  const PROJECTS_API = "/.netlify/functions/get-project-control-projects";
  const QUOTE_EDIT_API = "/.netlify/functions/get-tenant-quote-edit";
  const BRANDING_API = "/.netlify/functions/get-tenant-branding";
  const DEFAULT_CURRENCY = "USD";
  const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);

  /** Browser-memory-only draft edits. Never persist. */
  let sourceSnapshot = null;
  let draftEdits = null;

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

  function setText(id, value) {
    const el = $(id);
    if (!el) return;
    el.textContent = value == null || value === "" ? "—" : String(value);
  }

  function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function formatMoney(amount, currency) {
    const n = finiteNumber(amount, NaN);
    if (!Number.isFinite(n)) return "—";
    const cur = String(currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY;
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n);
    } catch (_err) {
      return `${cur} ${n.toFixed(2)}`;
    }
  }

  function formatDate(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.slice(0, 10);
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);
    } catch (_err) {
      return s.slice(0, 10);
    }
  }

  function toDateInput(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  function isPlausibleId(raw) {
    const id = String(raw || "").trim();
    if (!id || id.length < 8 || id.length > 80) return false;
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  function normStatus(raw) {
    return String(raw || "").trim().toLowerCase();
  }

  function showLoading() {
    $("cbLoading")?.removeAttribute("hidden");
    $("cbError")?.setAttribute("hidden", "");
    $("cbMain")?.setAttribute("hidden", "");
  }

  function showError(title, message) {
    $("cbLoading")?.setAttribute("hidden", "");
    $("cbMain")?.setAttribute("hidden", "");
    const wrap = $("cbError");
    if ($("cbErrorTitle")) $("cbErrorTitle").textContent = title;
    if ($("cbErrorMessage")) $("cbErrorMessage").textContent = message;
    if (wrap) wrap.removeAttribute("hidden");
  }

  function showMain() {
    $("cbLoading")?.setAttribute("hidden", "");
    $("cbError")?.setAttribute("hidden", "");
    $("cbMain")?.removeAttribute("hidden");
  }

  function waitForAuthReady() {
    return new Promise((resolve) => {
      if (document.body?.classList.contains("auth-ready")) {
        resolve();
        return;
      }
      const timer = setInterval(() => {
        if (document.body?.classList.contains("auth-ready")) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 8000);
    });
  }

  async function fetchJson(url) {
    const res = await fetch(url, { method: "GET", credentials: "include" });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  function quoteLabel(quote) {
    const display = String(quote?.quote_number_display || "").trim();
    if (display) return display;
    const id = String(quote?.id || "").trim();
    if (id.length >= 5) return `Quote …${id.slice(-5)}`;
    return "Not available";
  }

  function resolveContractTotal(project, quote) {
    const sale = finiteNumber(project?.salePrice ?? project?.sale_price, NaN);
    if (Number.isFinite(sale) && sale > 0) return sale;
    const total = finiteNumber(quote?.total, NaN);
    if (Number.isFinite(total) && total > 0) return total;
    return null;
  }

  function buildSource(project, quote, branding) {
    const currency = String(quote?.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY;
    const contractTotal = resolveContractTotal(project, quote);
    const address = String(quote?.project_address || quote?.job_site || "").trim();
    const notes = String(quote?.notes || "").trim();
    const terms = String(quote?.terms || "").trim();
    const scope = notes || terms || "";
    return {
      projectId: String(project.id || "").trim(),
      quoteId: String(quote?.id || project.quoteId || project.quote_id || "").trim(),
      projectName: String(project.projectName || project.project_name || quote?.project_name || "").trim(),
      customerName: String(project.clientName || project.client_name || quote?.client_name || "").trim(),
      customerEmail: String(project.clientEmail || project.client_email || quote?.client_email || "").trim(),
      customerPhone: String(quote?.client_phone || "").trim(),
      quoteNumber: quoteLabel(quote),
      quoteStatus: String(quote?.status || "").trim(),
      acceptedAt: quote?.accepted_at || null,
      contractTotal,
      currency,
      address,
      scope,
      terms,
      exclusions: "",
      startDate: toDateInput(quote?.start_date),
      dueDate: toDateInput(quote?.due_date),
      paymentNotes: "",
      warrantyNotes: "",
      additionalTerms: "",
      branding: {
        businessName: String(branding?.business_name || "").trim(),
        businessPhone: String(branding?.business_phone || "").trim(),
        businessEmail: String(branding?.business_email || "").trim(),
        businessAddress: String(branding?.business_address || "").trim(),
      },
    };
  }

  function cloneEdits(source) {
    return {
      address: source.address,
      scope: source.scope,
      exclusions: source.exclusions,
      startDate: source.startDate,
      dueDate: source.dueDate,
      paymentNotes: source.paymentNotes,
      warrantyNotes: source.warrantyNotes,
      additionalTerms: source.additionalTerms || source.terms || "",
    };
  }

  function readinessItems(source, edits) {
    const address = String(edits.address || "").trim();
    const scope = String(edits.scope || "").trim();
    return [
      { label: "Approved quote", status: source.quoteId ? "available" : "missing" },
      { label: "Customer identity", status: source.customerName ? "available" : "missing" },
      {
        label: "Contract total",
        status: source.contractTotal != null && source.contractTotal > 0 ? "available" : "missing",
      },
      {
        label: "Existing scope",
        status: scope ? "available" : "missing",
      },
      { label: "Legal contractor profile", status: "missing" },
      {
        label: "Project address",
        status: address ? "needs_confirmation" : "missing",
      },
      { label: "Authorized signer", status: "missing" },
      { label: "Payment schedule", status: "missing" },
      { label: "State-required legal notices", status: "missing" },
      {
        label: "Warranty terms",
        status: String(edits.warrantyNotes || "").trim() ? "needs_confirmation" : "missing",
      },
      { label: "Signature method", status: "missing" },
    ];
  }

  function statusClass(status) {
    if (status === "available") return "is-available";
    if (status === "needs_confirmation") return "is-needs";
    return "is-missing";
  }

  function statusLabel(status) {
    if (status === "available") return "Available";
    if (status === "needs_confirmation") return "Needs confirmation";
    return "Missing";
  }

  function renderReadiness(source, edits) {
    const list = $("cbReadiness");
    if (!list) return;
    list.innerHTML = readinessItems(source, edits)
      .map((item) => {
        return (
          `<li><span class="cb-check-status ${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</span>` +
          `<span>${escapeHtml(item.label)}</span></li>`
        );
      })
      .join("");
  }

  function renderRequiredList(source, edits) {
    const ul = $("cbRequiredList");
    if (!ul) return;
    const items = readinessItems(source, edits).map((item) => {
      return `<li>${escapeHtml(item.label)} — ${escapeHtml(statusLabel(item.status))}</li>`;
    });
    ul.innerHTML = items.join("");
  }

  function syncInputsFromEdits(edits) {
    if ($("cbEditAddress")) $("cbEditAddress").value = edits.address || "";
    if ($("cbEditScope")) $("cbEditScope").value = edits.scope || "";
    if ($("cbEditExclusions")) $("cbEditExclusions").value = edits.exclusions || "";
    if ($("cbEditStart")) $("cbEditStart").value = edits.startDate || "";
    if ($("cbEditDue")) $("cbEditDue").value = edits.dueDate || "";
    if ($("cbEditPaymentNotes")) $("cbEditPaymentNotes").value = edits.paymentNotes || "";
    if ($("cbEditWarranty")) $("cbEditWarranty").value = edits.warrantyNotes || "";
    if ($("cbEditTerms")) $("cbEditTerms").value = edits.additionalTerms || "";
  }

  function readEditsFromInputs() {
    if (!draftEdits) return;
    draftEdits.address = String($("cbEditAddress")?.value || "").trim();
    draftEdits.scope = String($("cbEditScope")?.value || "").trim();
    draftEdits.exclusions = String($("cbEditExclusions")?.value || "").trim();
    draftEdits.startDate = String($("cbEditStart")?.value || "").trim();
    draftEdits.dueDate = String($("cbEditDue")?.value || "").trim();
    draftEdits.paymentNotes = String($("cbEditPaymentNotes")?.value || "").trim();
    draftEdits.warrantyNotes = String($("cbEditWarranty")?.value || "").trim();
    draftEdits.additionalTerms = String($("cbEditTerms")?.value || "").trim();
  }

  function renderDocument(source, edits) {
    const money = formatMoney(source.contractTotal, source.currency);
    const b = source.branding || {};

    setText("cbBizName", b.businessName || "—");
    setText("cbBizPhone", b.businessPhone || "—");
    setText("cbBizEmail", b.businessEmail || "—");
    setText("cbBizAddress", b.businessAddress || "—");

    const contractorMissing = $("cbContractorMissing");
    if (contractorMissing) {
      contractorMissing.innerHTML =
        `<span class="cb-missing">Missing: Legal business name</span> ` +
        `<span class="cb-missing">Missing: License number</span> ` +
        `<span class="cb-missing">Missing: Authorized signer</span> ` +
        `<span class="cb-missing">Missing: Insurance disclosures</span>`;
    }

    setText("cbCustomerName", source.customerName || "—");
    setText("cbCustomerEmail", source.customerEmail || "—");
    setText("cbCustomerPhone", source.customerPhone || "—");
    setText("cbProjectName", source.projectName || "—");

    const address = String(edits.address || "").trim();
    const propEl = $("cbPropertyDisplay");
    if (propEl) {
      if (address) {
        propEl.textContent = address;
      } else {
        propEl.innerHTML = `— <span class="cb-missing">Needs confirmation</span>`;
      }
    }

    setText("cbQuoteNumber", source.quoteNumber || "—");
    setText("cbQuoteStatus", source.quoteStatus || "—");
    setText("cbAcceptedAt", formatDate(source.acceptedAt) || "—");
    setText("cbContractTotal", money);

    const scope = String(edits.scope || "").trim();
    const exclusions = String(edits.exclusions || "").trim();
    const scopeEl = $("cbScopeDisplay");
    if (scopeEl) {
      if (scope) {
        scopeEl.textContent = exclusions
          ? `${scope}\n\nExclusions:\n${exclusions}`
          : scope;
      } else {
        scopeEl.innerHTML = `Scope is not available from the approved quote. <span class="cb-missing">Needs confirmation</span>`;
      }
    }

    setText("cbPriceLine", `Contract Total: ${money}`);
    setText("cbPayTotalLine", `Contract Total: ${money}`);

    const payNotes = String(edits.paymentNotes || "").trim();
    setText("cbPaymentNotesDisplay", payNotes ? `Notes: ${payNotes}` : "");

    setText("cbStartDisplay", edits.startDate ? formatDate(edits.startDate) : "—");
    setText("cbDueDisplay", edits.dueDate ? formatDate(edits.dueDate) : "—");

    const warranty = String(edits.warrantyNotes || "").trim();
    setText("cbWarrantyDisplay", warranty || "Warranty terms are not yet configured.");

    const terms = String(edits.additionalTerms || "").trim();
    setText("cbTermsDisplay", terms || "Additional general terms are not yet configured.");

    renderReadiness(source, edits);
    renderRequiredList(source, edits);
  }

  function renderAll() {
    if (!sourceSnapshot || !draftEdits) return;
    syncInputsFromEdits(draftEdits);
    renderDocument(sourceSnapshot, draftEdits);
  }

  function bindEditors() {
    const ids = [
      "cbEditAddress",
      "cbEditScope",
      "cbEditExclusions",
      "cbEditStart",
      "cbEditDue",
      "cbEditPaymentNotes",
      "cbEditWarranty",
      "cbEditTerms",
    ];
    for (const id of ids) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("input", () => {
        readEditsFromInputs();
        renderDocument(sourceSnapshot, draftEdits);
      });
    }

    $("cbResetDraft")?.addEventListener("click", () => {
      if (!sourceSnapshot) return;
      draftEdits = cloneEdits(sourceSnapshot);
      renderAll();
    });

    $("cbPrintDraft")?.addEventListener("click", () => {
      window.print();
    });
  }

  async function init() {
    if (document.body?.dataset?.requiresAuth === "true" && !document.body.classList.contains("auth-ready")) {
      if (window.location.pathname.includes("index.html")) return;
    }

    await waitForAuthReady();
    if (document.body?.dataset?.requiresAuth === "true" && !document.body.classList.contains("auth-ready")) {
      return;
    }

    showLoading();

    const params = new URLSearchParams(window.location.search);
    const projectId = String(params.get("project_id") || "").trim();
    const quoteIdParam = String(params.get("quote_id") || "").trim();

    const back = $("cbBackHub");
    if (back && isPlausibleId(projectId)) {
      const hubParams = new URLSearchParams({ project_id: projectId });
      if (quoteIdParam) hubParams.set("quote_id", quoteIdParam);
      back.href = `/contract-hub?${hubParams.toString()}`;
    }

    if (!isPlausibleId(projectId)) {
      showError(
        "Contract Builder",
        "Select an approved project from Contract Hub to open a draft preview."
      );
      return;
    }

    const projectsRes = await fetchJson(PROJECTS_API);
    if (!projectsRes.ok || projectsRes.data?.ok !== true || !Array.isArray(projectsRes.data.projects)) {
      showError(
        "Contract Builder",
        "This project is unavailable or does not belong to the current workspace."
      );
      return;
    }

    const key = projectId.toLowerCase();
    const project = projectsRes.data.projects.find(
      (row) => String(row?.id || "").trim().toLowerCase() === key
    );
    if (!project) {
      showError(
        "Contract Builder",
        "This project is unavailable or does not belong to the current workspace."
      );
      return;
    }

    const quoteId = quoteIdParam || String(project.quoteId || project.quote_id || "").trim();
    if (!isPlausibleId(quoteId)) {
      showError(
        "Contract Builder",
        "An approved quote is required before a contract draft can be prepared."
      );
      return;
    }

    const quoteRes = await fetchJson(
      `${QUOTE_EDIT_API}?quote_id=${encodeURIComponent(quoteId)}`
    );
    if (!quoteRes.ok || quoteRes.data?.ok !== true || !quoteRes.data?.quote) {
      showError(
        "Contract Builder",
        "The approved quote could not be loaded for this project."
      );
      return;
    }

    const quote = quoteRes.data.quote;
    const st = normStatus(quote.status);
    if (st && !APPROVED_QUOTE_STATUSES.has(st)) {
      showError(
        "Contract Builder",
        "Only accepted or approved quotes can open a contract draft preview."
      );
      return;
    }

    const brandingRes = await fetchJson(BRANDING_API);
    const branding =
      brandingRes.ok && brandingRes.data?.ok === true && brandingRes.data.branding
        ? brandingRes.data.branding
        : {};

    const contractTotal = resolveContractTotal(project, quote);
    const customerName = String(project.clientName || project.client_name || quote.client_name || "").trim();
    if (!(contractTotal > 0) || !customerName) {
      showError(
        "Contract Builder",
        "A customer name and approved contract total are required before opening a draft preview."
      );
      return;
    }

    sourceSnapshot = buildSource(project, quote, branding);
    draftEdits = cloneEdits(sourceSnapshot);
    bindEditors();
    renderAll();
    showMain();
  }

  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
})();
