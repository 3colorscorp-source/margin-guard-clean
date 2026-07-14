(() => {
  "use strict";

  const PROJECTS_API = "/.netlify/functions/get-project-control-projects";
  const QUOTES_API = "/.netlify/functions/list-tenant-quotes";
  const LS_SETTINGS = "mg_settings_v2";
  const DEFAULT_CURRENCY = "USD";
  const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);

  const WORKFLOW_STAGES = [
    "Approved Quote",
    "Contract Draft",
    "Customer Review",
    "Digital Signature",
    "Signed Contract",
    "Deposit & Invoices",
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

  function setText(id, value) {
    const el = $(id);
    if (!el) return;
    el.textContent = value == null || value === "" ? "—" : String(value);
  }

  function readSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_err) {
      return {};
    }
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

  function isPlausibleProjectId(raw) {
    const id = String(raw || "").trim();
    if (!id || id.length < 8 || id.length > 80) return false;
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  function formatQuoteLabel(quote, quoteId) {
    const display = String(quote?.quote_number_display || "").trim();
    if (display) return display;
    const id = String(quoteId || quote?.id || "").trim();
    if (!id) return "Not available";
    if (id.length >= 5) return `Quote …${id.slice(-5)}`;
    return "Not available";
  }

  function normStatus(raw) {
    return String(raw || "").trim().toLowerCase();
  }

  function projectHasApprovedQuote(project) {
    const qid = String(project?.quoteId || project?.quote_id || "").trim();
    return Boolean(qid);
  }

  function isBuilderEligible(project, quote) {
    const clientName = String(project?.clientName || project?.client_name || "").trim();
    const salePrice = finiteNumber(project?.salePrice ?? project?.sale_price, 0);
    const quoteId = String(project?.quoteId || project?.quote_id || "").trim();
    if (!quoteId || !clientName || !(salePrice > 0)) return false;
    if (!quote) return true;
    const st = normStatus(quote.status);
    return !st || APPROVED_QUOTE_STATUSES.has(st);
  }

  function builderHref(projectId, quoteId) {
    const pid = String(projectId || "").trim();
    if (!pid) return "/contract-hub";
    const params = new URLSearchParams({ project_id: pid });
    const qid = String(quoteId || "").trim();
    if (qid) params.set("quote_id", qid);
    return `/contract-builder?${params.toString()}`;
  }

  function setLaunchBuilderState(eligible, projectId, quoteId) {
    const link = $("chLaunchBuilder");
    const disabledBtn = $("chLaunchBuilderDisabled");
    if (eligible) {
      if (link) {
        link.href = builderHref(projectId, quoteId);
        link.hidden = false;
        link.removeAttribute("aria-disabled");
      }
      if (disabledBtn) disabledBtn.hidden = true;
    } else {
      if (link) {
        link.hidden = true;
        link.setAttribute("aria-disabled", "true");
        link.href = "#";
      }
      if (disabledBtn) disabledBtn.hidden = false;
    }
  }

  function showLoading() {
    $("chLoading")?.removeAttribute("hidden");
    $("chError")?.setAttribute("hidden", "");
    $("chMain")?.setAttribute("hidden", "");
  }

  function showError(title, message) {
    $("chLoading")?.setAttribute("hidden", "");
    $("chMain")?.setAttribute("hidden", "");
    const wrap = $("chError");
    const titleEl = $("chErrorTitle");
    const msgEl = $("chErrorMessage");
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (wrap) wrap.removeAttribute("hidden");
  }

  function showMain() {
    $("chLoading")?.setAttribute("hidden", "");
    $("chError")?.setAttribute("hidden", "");
    $("chMain")?.removeAttribute("hidden");
  }

  function renderChecklist(items) {
    const list = $("chChecklist");
    if (!list) return;
    list.innerHTML = items
      .map((item) => {
        const mark = item.ok ? "✓" : "—";
        const cls = item.ok ? "is-ok" : "is-miss";
        return (
          `<li><span class="ch-checklist__mark ${cls}" aria-hidden="true">${mark}</span>` +
          `<span>${escapeHtml(item.label)}</span></li>`
        );
      })
      .join("");
  }

  function renderWorkflow() {
    const list = $("chWorkflow");
    if (!list) return;
    list.innerHTML = WORKFLOW_STAGES.map((label, index) => {
      let cls = "is-future";
      if (index === 0) cls = "is-done";
      if (index === 1) cls = "is-next";
      const suffix =
        index === 0 ? " — complete" : index === 1 ? " — next" : "";
      return `<li class="${cls}">${escapeHtml(label + suffix)}</li>`;
    }).join("");
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

  async function loadQuoteById(quoteId) {
    const qid = String(quoteId || "").trim();
    if (!qid) return null;
    const res = await fetchJson(`${QUOTES_API}?limit=200&sort=created_at_desc`);
    if (!res.ok || res.data?.ok !== true || !Array.isArray(res.data.quotes)) return null;
    const key = qid.toLowerCase();
    return res.data.quotes.find((q) => String(q?.id || "").trim().toLowerCase() === key) || null;
  }

  function renderWorkspace(project, quote, settings) {
    const currency = settings?.currency || DEFAULT_CURRENCY;
    const quoteId = String(project.quoteId || project.quote_id || "").trim();
    const quoteStatus = normStatus(quote?.status);
    const salePrice = finiteNumber(project.salePrice ?? project.sale_price, 0);
    const clientName = String(project.clientName || project.client_name || "").trim();
    const clientEmail = String(project.clientEmail || project.client_email || "").trim();
    const scopeText = String(project.notes || "").trim();

    setText("chProject", String(project.projectName || project.project_name || "").trim() || "—");
    setText("chCustomer", clientName || "—");
    setText("chCustomerEmail", clientEmail || "—");
    setText("chQuote", formatQuoteLabel(quote, quoteId));
    setText("chTotal", formatMoney(salePrice, currency));
    setText("chProjectStatus", String(project.status || "—"));
    setText("chContractStatus", "Ready to Create");
    setText("chDocuments", "No contract documents yet.");

    const quoteApproved =
      !quote || APPROVED_QUOTE_STATUSES.has(quoteStatus) || quoteStatus === "";

    renderChecklist([
      { label: "Approved project selected", ok: true },
      { label: "Customer information available", ok: Boolean(clientName) },
      { label: "Approved contract total available", ok: salePrice > 0 },
      { label: "Scope available", ok: Boolean(scopeText) },
      { label: "Property address available", ok: false },
      { label: "Customer email available", ok: Boolean(clientEmail) },
    ]);

    renderWorkflow();

    const eligible = isBuilderEligible(project, quote);
    setLaunchBuilderState(eligible, String(project.id || "").trim(), quoteId);

    if (!projectHasApprovedQuote(project) || (quote && !APPROVED_QUOTE_STATUSES.has(quoteStatus))) {
      showError(
        "Contract unavailable",
        "This project does not have an approved quote that can be converted into a contract."
      );
      return;
    }

    showMain();
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

    if (!isPlausibleProjectId(projectId)) {
      showError(
        "Contract Hub",
        "Select an approved project from Sales Admin to open Contract Hub."
      );
      return;
    }

    const settings = readSettings();

    const projectsRes = await fetchJson(PROJECTS_API);
    if (!projectsRes.ok || projectsRes.data?.ok !== true || !Array.isArray(projectsRes.data.projects)) {
      showError(
        "Contract Hub",
        "Contract Hub could not load this project. Refresh and try again."
      );
      return;
    }

    const key = projectId.toLowerCase();
    const project = projectsRes.data.projects.find(
      (row) => String(row?.id || "").trim().toLowerCase() === key
    );

    if (!project) {
      showError(
        "Contract Hub",
        "This project is unavailable or does not belong to the current workspace."
      );
      return;
    }

    const quoteId = quoteIdParam || String(project.quoteId || project.quote_id || "").trim();
    const quote = await loadQuoteById(quoteId);
    renderWorkspace(project, quote, settings);
  }

  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
})();
