(() => {
  "use strict";

  const PROJECTS_API = "/.netlify/functions/get-project-control-projects";
  const QUOTES_API = "/.netlify/functions/list-tenant-quotes";
  const PACKAGES_API = "/.netlify/functions/contract-packages";
  const ENVELOPES_API = "/.netlify/functions/contract-envelopes";
  const SETUP_API = "/.netlify/functions/project-contract-setup";
  const SCHEDULE_API = "/.netlify/functions/project-contract-payment-schedule";
  const LEGAL_NOTICES_API = "/.netlify/functions/tenant-contract-legal-notices";
  const LEGAL_PROFILE_API = "/.netlify/functions/tenant-legal-profile";
  const LS_SETTINGS = "mg_settings_v2";
  const DEFAULT_CURRENCY = "USD";
  const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);

  const WORKFLOW_STAGES = [
    "Approved Quote",
    "Complete Contract",
    "Freeze Contract",
    "Configure Signing",
    "Customer Signs",
    "Signed Contract",
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

  function signingHref(projectId) {
    const pid = String(projectId || "").trim();
    if (!pid) return "/signature-workspace";
    return `/signature-workspace?project_id=${encodeURIComponent(pid)}`;
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

  function legalNoticesConfigured(noticesData) {
    const effective = noticesData?.effective_for_contracts || noticesData?.effective || null;
    const contribution = String(
      effective?.contribution ||
        noticesData?.readiness?.status ||
        noticesData?.status ||
        ""
    ).toLowerCase();
    return contribution === "configured";
  }

  function legalProfileReady(profileData) {
    const p = profileData?.profile || profileData;
    if (!p || typeof p !== "object") return false;
    const name = String(p.legal_business_name || p.legalBusinessName || "").trim();
    return Boolean(name);
  }

  function evaluateContractReadiness(ctx) {
    const setupReady = ctx.setup?.readiness || {};
    const scheduleReady = ctx.schedule?.readiness || {};
    const propOk = String(setupReady.project_address || "").toLowerCase() === "confirmed";
    const warOk = String(setupReady.warranty || "").toLowerCase() === "configured";
    const sigOk = String(setupReady.signature_method || "").toLowerCase() === "configured";
    const payOk = String(scheduleReady.status || "").toLowerCase() === "configured";
    const legalOk = legalNoticesConfigured(ctx.legalNotices);
    const profileOk = legalProfileReady(ctx.legalProfile);

    const missing = [];
    if (!profileOk) missing.push("Complete Legal Business Profile");
    if (!propOk) missing.push("Confirm Project Address");
    if (!payOk) {
      const paySt = String(scheduleReady.status || "").toLowerCase();
      missing.push(
        paySt === "draft" ? "Confirm Payment Schedule" : "Complete Payment Schedule"
      );
    }
    if (!warOk) missing.push("Confirm Warranty");
    if (!legalOk) missing.push("Confirm Legal Notices");
    if (!sigOk) missing.push("Configure Signature Method");

    const checks = [profileOk, propOk, payOk, warOk, legalOk, sigOk];
    const done = checks.filter(Boolean).length;
    const pct = Math.round((done / checks.length) * 100);
    const complete = missing.length === 0;
    return { complete, pct, missing, checks: { profileOk, propOk, payOk, warOk, legalOk, sigOk } };
  }

  function pickActivePackage(packages) {
    const list = Array.isArray(packages) ? packages : [];
    const ready = list.find((p) => ["ready", "executed"].includes(normStatus(p.status)));
    return ready || list[0] || null;
  }

  function pickActiveEnvelope(envelopes) {
    const list = Array.isArray(envelopes) ? envelopes : [];
    const order = ["completed", "opened", "sent", "draft"];
    for (const st of order) {
      const hit = list.find((e) => normStatus(e.status) === st);
      if (hit) return hit;
    }
    return list[0] || null;
  }

  function resolveGuidance(project, quote, readiness, pkg, envelope) {
    const quoteId = String(project.quoteId || project.quote_id || "").trim();
    const projectId = String(project.id || "").trim();
    const envSt = normStatus(envelope?.status);
    const pkgSt = normStatus(pkg?.status);
    const signed =
      envSt === "completed" || pkgSt === "executed";

    if (signed) {
      return {
        stageIndex: 5,
        stageLabel: "Signed Contract",
        statusLabel: "Fully Signed",
        blocker: null,
        primary: {
          label: "Open Signed Contract",
          href: signingHref(projectId),
          kind: "link",
        },
        docs: pkg?.version != null
          ? `Frozen Contract Version v${pkg.version} — Fully Signed`
          : "Signed contract is ready in Signature Workspace.",
      };
    }

    if (pkg && (envSt === "sent" || envSt === "opened")) {
      return {
        stageIndex: 4,
        stageLabel: "Customer Signs",
        statusLabel:
          envSt === "opened"
            ? "Waiting for Customer Signature"
            : "Secure Link Ready",
        blocker:
          envSt === "opened"
            ? "Waiting for the customer to sign."
            : "Signing request is prepared. No email has been sent yet.",
        primary: {
          label: "Open Signature Workspace",
          href: signingHref(projectId),
          kind: "link",
        },
        docs: pkg?.version != null
          ? `Frozen Contract Version v${pkg.version} — ${
              envSt === "opened"
                ? "Waiting for Customer Signature"
                : "Secure Link Ready"
            }`
          : envSt === "opened"
            ? "Waiting for customer signature."
            : "Secure signing link is ready.",
      };
    }

    if (pkg && ["ready", "executed"].includes(pkgSt)) {
      return {
        stageIndex: 3,
        stageLabel: "Configure Signing",
        statusLabel:
          envSt === "draft"
            ? "Signing Request Ready"
            : "Frozen Contract Ready",
        blocker: envSt === "draft"
          ? "Add signers and prepare the secure signing link."
          : "Create a signing request and add the customer signer.",
        primary: {
          label: "Open Signature Workspace",
          href: signingHref(projectId),
          kind: "link",
        },
        docs: pkg?.version != null
          ? `Frozen Contract Version v${pkg.version}`
          : "Frozen contract is ready.",
      };
    }

    if (readiness.complete) {
      return {
        stageIndex: 2,
        stageLabel: "Freeze Contract",
        statusLabel: "Ready to freeze",
        blocker: "Freeze the contract before configuring signing.",
        primary: {
          label: "Freeze Contract",
          href: builderHref(projectId, quoteId) + "#freeze",
          kind: "link",
        },
        docs: "Contract readiness is complete. Freeze to create an immutable version.",
      };
    }

    return {
      stageIndex: 1,
      stageLabel: "Complete Contract",
      statusLabel: `Draft · ${readiness.pct}% ready`,
      blocker: readiness.missing[0] || "Complete required contract sections.",
      primary: {
        label: "Open Contract Builder",
        href: builderHref(projectId, quoteId),
        kind: "link",
        disabled: !isBuilderEligible(project, quote),
      },
      docs: "No frozen contract version yet.",
      missing: readiness.missing,
    };
  }

  function renderWorkflow(stageIndex) {
    const list = $("chWorkflow");
    if (!list) return;
    list.innerHTML = WORKFLOW_STAGES.map((label, index) => {
      let cls = "is-future";
      let suffix = "";
      if (index < stageIndex) {
        cls = "is-done";
        suffix = " — complete";
      } else if (index === stageIndex) {
        cls = "is-next";
        suffix = " — current";
      }
      return `<li class="${cls}">${escapeHtml(label + suffix)}</li>`;
    }).join("");
  }

  function renderMissing(items) {
    const list = $("chMissingList");
    const wrap = $("chMissingWrap");
    if (!list) return;
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) {
      list.innerHTML = "";
      if (wrap) wrap.hidden = true;
      return;
    }
    if (wrap) wrap.hidden = false;
    list.innerHTML = rows
      .map((label) => `<li><span class="ch-checklist__mark is-miss">—</span><span>${escapeHtml(label)}</span></li>`)
      .join("");
  }

  function renderPrimaryCta(guidance) {
    const link = $("chPrimaryCta");
    const disabledBtn = $("chPrimaryCtaDisabled");
    const secondary = $("chSecondaryCta");
    const hint = $("chLaunchHint");
    const primary = guidance.primary || {};

    if (secondary) {
      secondary.hidden = true;
      secondary.href = "#";
    }

    if (primary.disabled) {
      if (link) {
        link.hidden = true;
        link.href = "#";
      }
      if (disabledBtn) {
        disabledBtn.hidden = false;
        disabledBtn.textContent = primary.label || "Action unavailable";
      }
    } else if (link) {
      link.hidden = false;
      link.href = primary.href || "#";
      link.textContent = primary.label || "Continue";
      link.removeAttribute("aria-disabled");
      if (disabledBtn) disabledBtn.hidden = true;
    }

    if (hint) {
      hint.textContent = guidance.blocker
        ? `Next: ${guidance.blocker}`
        : "Follow the current stage action above.";
    }

    // Keep a quiet secondary path only when the primary is not the builder.
    if (secondary && guidance.stageIndex >= 2 && guidance.stageIndex < 5) {
      const pid = new URLSearchParams(window.location.search).get("project_id");
      const qid = new URLSearchParams(window.location.search).get("quote_id");
      if (guidance.stageIndex === 2 || guidance.stageIndex === 3) {
        secondary.hidden = false;
        secondary.href = builderHref(pid, qid);
        secondary.textContent = "Open Contract Builder";
      }
    }
  }

  function renderGuidanceBanner(guidance) {
    setText("chStageCurrent", guidance.stageLabel);
    setText("chStageStatus", guidance.statusLabel);
    setText("chBlocker", guidance.blocker || "No blockers — continue with the primary action.");
    const stageEl = $("chStageCurrent");
    if (stageEl) stageEl.setAttribute("data-stage", String(guidance.stageIndex));
  }

  async function loadContractContext(projectId, quoteId) {
    const qs = new URLSearchParams({
      project_id: projectId,
      quote_id: quoteId,
    }).toString();

    const [setupRes, scheduleRes, noticesRes, profileRes, packagesRes] = await Promise.all([
      fetchJson(`${SETUP_API}?${qs}`),
      fetchJson(`${SCHEDULE_API}?${qs}`),
      fetchJson(LEGAL_NOTICES_API),
      fetchJson(LEGAL_PROFILE_API),
      fetchJson(`${PACKAGES_API}?project_id=${encodeURIComponent(projectId)}`),
    ]);

    const setup = setupRes.ok && setupRes.data?.ok !== false ? setupRes.data : null;
    const schedule = scheduleRes.ok && scheduleRes.data?.ok !== false ? scheduleRes.data : null;
    const legalNotices = noticesRes.ok ? noticesRes.data : null;
    const legalProfile = profileRes.ok ? profileRes.data : null;
    const packages =
      packagesRes.ok && packagesRes.data?.ok === true && Array.isArray(packagesRes.data.packages)
        ? packagesRes.data.packages
        : [];

    const pkg = pickActivePackage(packages);
    let envelopes = [];
    if (pkg?.id) {
      const envRes = await fetchJson(
        `${ENVELOPES_API}?package_id=${encodeURIComponent(pkg.id)}`
      );
      if (envRes.ok && envRes.data?.ok === true && Array.isArray(envRes.data.envelopes)) {
        envelopes = envRes.data.envelopes;
      }
    }
    const envelope = pickActiveEnvelope(envelopes);
    const readiness = evaluateContractReadiness({
      setup,
      schedule,
      legalNotices,
      legalProfile,
    });

    return { readiness, packages, pkg, envelopes, envelope };
  }

  async function renderWorkspace(project, quote, settings) {
    const currency = settings?.currency || DEFAULT_CURRENCY;
    const quoteId = String(project.quoteId || project.quote_id || "").trim();
    const projectId = String(project.id || "").trim();
    const quoteStatus = normStatus(quote?.status);
    const salePrice = finiteNumber(project.salePrice ?? project.sale_price, 0);
    const clientName = String(project.clientName || project.client_name || "").trim();
    const clientEmail = String(project.clientEmail || project.client_email || "").trim();

    setText("chProject", String(project.projectName || project.project_name || "").trim() || "—");
    setText("chCustomer", clientName || "—");
    setText("chCustomerEmail", clientEmail || "—");
    setText("chQuote", formatQuoteLabel(quote, quoteId));
    setText("chTotal", formatMoney(salePrice, currency));
    setText("chProjectStatus", String(project.status || "—"));

    if (!projectHasApprovedQuote(project) || (quote && !APPROVED_QUOTE_STATUSES.has(quoteStatus))) {
      showError(
        "Contract unavailable",
        "This project does not have an approved quote that can be converted into a contract."
      );
      return;
    }

    let ctx = {
      readiness: { complete: false, pct: 0, missing: ["Unable to load readiness"] },
      pkg: null,
      envelope: null,
    };
    try {
      ctx = await loadContractContext(projectId, quoteId);
    } catch (_err) {
      /* keep defaults */
    }

    const guidance = resolveGuidance(project, quote, ctx.readiness, ctx.pkg, ctx.envelope);
    setText("chContractStatus", guidance.statusLabel);
    setText("chDocuments", guidance.docs || "—");
    renderGuidanceBanner(guidance);
    renderWorkflow(guidance.stageIndex);
    renderMissing(guidance.missing || ctx.readiness.missing);
    renderPrimaryCta(guidance);

    const checklist = $("chChecklist");
    if (checklist) {
      const items = [
        { label: "Approved quote", ok: true },
        { label: "Customer information", ok: Boolean(clientName) },
        { label: "Contract total", ok: salePrice > 0 },
        {
          label: `Contract readiness ${ctx.readiness.pct}%`,
          ok: ctx.readiness.complete,
        },
        {
          label: "Frozen contract version",
          ok: Boolean(ctx.pkg),
        },
        {
          label: "Signing request",
          ok: Boolean(ctx.envelope),
        },
      ];
      checklist.innerHTML = items
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
    await renderWorkspace(project, quote, settings);
  }

  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
})();
