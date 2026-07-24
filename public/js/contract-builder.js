(() => {
  "use strict";

  const PROJECTS_API = "/.netlify/functions/get-project-control-projects";
  const QUOTE_EDIT_API = "/.netlify/functions/get-tenant-quote-edit";
  const BRANDING_API = "/.netlify/functions/get-tenant-branding";
  const LEGAL_PROFILE_API = "/.netlify/functions/tenant-legal-profile";
  const LEGAL_NOTICES_API = "/.netlify/functions/tenant-contract-legal-notices";
  const CONTRACT_SETUP_API = "/.netlify/functions/project-contract-setup";
  const PAYMENT_SCHEDULE_API = "/.netlify/functions/project-contract-payment-schedule";
  const DEFAULT_CURRENCY = "USD";
  const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);

  /** Display order for tenant legal notice fields (read-only). */
  const LEGAL_NOTICE_FIELDS = [
    { key: "contract_notice", label: "Contract Notice" },
    { key: "payment_notice", label: "Payment Notice" },
    { key: "change_order_notice", label: "Change Order Notice" },
    { key: "cancellation_notice", label: "Cancellation Notice" },
    { key: "warranty_notice", label: "Warranty Notice" },
    { key: "limitation_of_liability", label: "Limitation of Liability" },
    { key: "permit_notice", label: "Permit Notice" },
    { key: "site_conditions_notice", label: "Site Conditions Notice" },
    { key: "cleanup_notice", label: "Cleanup Notice" },
    { key: "material_notice", label: "Material Notice" },
    { key: "dispute_notice", label: "Dispute Notice" },
    { key: "force_majeure_notice", label: "Force Majeure" },
    { key: "governing_law_notice", label: "Governing Law" },
    { key: "additional_terms", label: "Additional Terms" },
  ];

  /** Browser-memory-only draft edits. Never persist. */
  let sourceSnapshot = null;
  let draftEdits = null;
  const undoStacks = Object.create(null);
  const redoStacks = Object.create(null);
  const revealSecrets = Object.create(null);

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

  function setTextMany(ids, value) {
    for (const id of ids) setText(id, value);
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

  function initialsFromName(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "MG";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function buildSource(
    project,
    quote,
    branding,
    legalBundle,
    setupBundle,
    scheduleBundle,
    legalNoticesBundle
  ) {
    const currency = String(quote?.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY;
    const contractTotal = resolveContractTotal(project, quote);
    const address = String(quote?.project_address || quote?.job_site || "").trim();
    const notes = String(quote?.notes || "").trim();
    const terms = String(quote?.terms || "").trim();
    const scope = notes || terms || "";
    const deposit = finiteNumber(quote?.deposit_required, NaN);
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
      depositRequired: Number.isFinite(deposit) && deposit > 0 ? deposit : null,
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
        logoUrl: String(branding?.logo_url || "").trim(),
      },
      legal: legalBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        readiness: null,
        profile: null,
      },
      contractSetup: setupBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        setup: null,
        readiness: null,
      },
      paymentSchedule: scheduleBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        schedule: null,
        items: [],
        readiness: null,
        source: null,
      },
      legalNotices: legalNoticesBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        notices: null,
        readiness: { status: "missing" },
      },
    };
  }

  function formatPropertyLine(setup) {
    if (!setup) return "";
    const line1 = String(setup.property_address_line1 || "").trim();
    const line2 = String(setup.property_address_line2 || "").trim();
    const city = String(setup.property_city || "").trim();
    const state = String(setup.property_state || "").trim();
    const zip = String(setup.property_postal_code || "").trim();
    const cityState = [city, state].filter(Boolean).join(", ");
    const locality = [cityState, zip].filter(Boolean).join(" ");
    return [line1, line2, locality].filter(Boolean).join(", ");
  }

  function propertyConfigured(setupBundle) {
    return String(setupBundle?.readiness?.project_address || "").toLowerCase() === "confirmed";
  }

  function warrantyConfigured(setupBundle) {
    return String(setupBundle?.readiness?.warranty || "").toLowerCase() === "configured";
  }

  function paymentConfigured(scheduleBundle) {
    return String(scheduleBundle?.readiness?.status || "").toLowerCase() === "configured";
  }

  function signatureConfigured(setupBundle) {
    return String(setupBundle?.readiness?.signature_method || "").toLowerCase() === "configured";
  }

  function isPlainNoticesObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeLegalNoticeText(raw) {
    if (raw == null) return "";
    if (typeof raw !== "string") return "";
    return raw.trim();
  }

  /** Ordered populated notices from the 14 approved fields only. */
  function normalizeLegalNoticesPopulated(notices) {
    if (!isPlainNoticesObject(notices)) return [];
    const rows = [];
    for (const field of LEGAL_NOTICE_FIELDS) {
      const text = normalizeLegalNoticeText(notices[field.key]);
      if (!text) continue;
      rows.push({ label: field.label, text });
    }
    return rows;
  }

  /**
   * Defensive Contract Builder legal status (display + readiness contribution).
   * CH-004A7B: consumes confirmed snapshot (effective_for_contracts) only.
   */
  function resolveLegalNoticesEffective(legalNoticesBundle) {
    const bundle = legalNoticesBundle || {};
    const missingCopy = "No legal notices have been added yet.";
    const draftCopy =
      "Legal notices are still being prepared. Draft changes are not published to contracts.";
    const reviewCopy =
      "Legal notices require review before they can be considered ready.";

    if (bundle.loadError || bundle.forbidden) {
      return {
        effectiveStatus: "missing",
        contribution: "missing",
        label: "Missing",
        hint: missingCopy,
        rows: [],
      };
    }

    const effective = bundle.effective_for_contracts;
    if (
      effective &&
      effective.notices &&
      typeof effective.notices === "object" &&
      !Array.isArray(effective.notices) &&
      effective.enabled &&
      typeof effective.enabled === "object" &&
      !Array.isArray(effective.enabled)
    ) {
      const rows = [];
      for (const field of LEGAL_NOTICE_FIELDS) {
        const enabled = effective.enabled[field.key] === true;
        const text = normalizeLegalNoticeText(effective.notices[field.key]);
        if (!enabled || !text) continue;
        rows.push({ label: field.label, text });
      }
      if (!rows.length) {
        return {
          effectiveStatus: "draft",
          contribution: "draft",
          label: "Draft",
          hint: reviewCopy,
          rows: [],
        };
      }
      return {
        effectiveStatus: "configured",
        contribution: "configured",
        label: "Configured ✓",
        hint: null,
        rows,
      };
    }

    // No usable confirmed snapshot
    const apiStatus = String(bundle.readiness?.status ?? "missing")
      .trim()
      .toLowerCase();
    if (apiStatus === "missing" && !bundle.notices) {
      return {
        effectiveStatus: "missing",
        contribution: "missing",
        label: "Missing",
        hint: missingCopy,
        rows: [],
      };
    }
    return {
      effectiveStatus: "draft",
      contribution: "draft",
      label: "Draft",
      hint: draftCopy,
      rows: [],
    };
  }

  function legalNoticesConfigured(legalNoticesBundle) {
    return resolveLegalNoticesEffective(legalNoticesBundle).contribution === "configured";
  }

  function sectionStatusLabel(configured) {
    return configured ? "Configured" : "Missing";
  }

  function paymentStatusLabel(scheduleBundle) {
    const status = String(scheduleBundle?.readiness?.status || "missing").toLowerCase();
    if (status === "configured") return "Confirmed";
    if (status === "draft") return "Payment schedule awaiting confirmation";
    return "Not yet defined";
  }

  function dueRuleLabel(raw) {
    const key = String(raw || "").trim().toLowerCase();
    const map = {
      custom: "Custom milestone",
      on_acceptance: "Upon acceptance",
      before_start: "Before work begins",
      on_start: "At project start",
      on_completion: "Upon completion",
      net_7: "Within 7 days",
      net_15: "Within 15 days",
      net_30: "Within 30 days",
    };
    if (!key) return "—";
    if (map[key]) return map[key];
    return "Custom payment timing";
  }

  function quoteStatusDisplay(raw) {
    const status = String(raw || "").trim().toLowerCase();
    if (!status) return "—";
    if (status === "accepted" || status === "approved") return "Approved";
    return String(raw || "").trim();
  }

  function looksLikeEstimateEmail(text) {
    const t = String(text || "");
    if (!t.trim()) return false;

    // Strong email cues only. "please find/review/see" never triggers alone.
    if (/^(hi\b|hello\b|dear\b|good (morning|afternoon|evening)\b)/im.test(t)) return true;
    if (
      /\b(best regards|kind regards|sincerely|thank you for (your )?interest|looking forward to hearing from you)\b/i.test(
        t
      )
    ) {
      return true;
    }
    if (/\bsubject\s*:/i.test(t) || /\b(sent from|mailto:|unsubscribe)\b/i.test(t)) return true;
    if (/https?:\/\//i.test(t) && /\b(estimate|quote|proposal)\b/i.test(t)) return true;
    return false;
  }

  function looksLikeTechnicalQaLabel(text) {
    const t = String(text || "");
    if (!t.trim()) return false;

    if (/\bCH[-_ ]?004\b/i.test(t)) return true;
    if (/\btechnical draft\b/i.test(t)) return true;
    if (/\bsmoke test\b/i.test(t)) return true;
    if (/\btest stage\b/i.test(t)) return true;
    if (/\btest payment\b/i.test(t)) return true;
    if (/\bQA\s+(technical|smoke|test)\b/i.test(t)) return true;

    // Standalone "QA" only when paired with another technical/test cue.
    if (!/\bQA\b/i.test(t)) return false;
    return /\b(CH[-_ ]?004|technical|smoke|test|draft)\b/i.test(t);
  }

  function undefinedMoneyLabel(scheduleStatus) {
    if (String(scheduleStatus || "").toLowerCase() === "draft") return "Draft payment schedule";
    return "Not yet defined";
  }

  function legalNoticesStatusLabel(legalNoticesBundle) {
    return resolveLegalNoticesEffective(legalNoticesBundle).label;
  }

  function signatureMethodLabel(setupBundle) {
    return signatureConfigured(setupBundle) ? "Configured" : "Missing";
  }

  function signatureRequestLabel(setupBundle) {
    if (!signatureConfigured(setupBundle)) return "—";
    const actual = String(setupBundle?.readiness?.actual_signature_status || "not_requested").toLowerCase();
    if (actual === "not_requested") return "Not Requested";
    return actual || "Not Requested";
  }

  function overallContractReadiness(source) {
    const setup = source?.contractSetup;
    const schedule = source?.paymentSchedule;
    const legalNotices = source?.legalNotices;
    const propOk = propertyConfigured(setup);
    const warOk = warrantyConfigured(setup);
    const payOk = paymentConfigured(schedule);
    const sigOk = signatureConfigured(setup);
    const legalEffective = resolveLegalNoticesEffective(legalNotices);
    const legalOk = legalEffective.contribution === "configured";
    if (propOk && warOk && payOk && sigOk && legalOk) return "configured";

    const propRaw = String(setup?.readiness?.project_address || "missing").toLowerCase();
    const warRaw = String(setup?.readiness?.warranty || "missing").toLowerCase();
    const payRaw = String(schedule?.readiness?.status || "missing").toLowerCase();
    const legalRaw = legalEffective.contribution;
    const anyPartial =
      propRaw === "needs_confirmation" ||
      warRaw === "needs_confirmation" ||
      payRaw === "draft" ||
      legalRaw === "draft" ||
      propOk ||
      warOk ||
      payOk ||
      sigOk ||
      legalOk;
    return anyPartial ? "draft" : "missing";
  }

  function readinessMapStatus(kind, source) {
    if (kind === "property") {
      return propertyConfigured(source.contractSetup) ? "available" : "missing";
    }
    if (kind === "warranty") {
      return warrantyConfigured(source.contractSetup) ? "available" : "missing";
    }
    if (kind === "payment") {
      const st = String(source.paymentSchedule?.readiness?.status || "missing").toLowerCase();
      if (st === "configured") return "available";
      if (st === "draft") return "needs_confirmation";
      return "missing";
    }
    if (kind === "signature") {
      return signatureConfigured(source.contractSetup) ? "available" : "missing";
    }
    if (kind === "legal_notices") {
      const st = resolveLegalNoticesEffective(source.legalNotices).contribution;
      if (st === "configured") return "available";
      if (st === "draft") return "needs_confirmation";
      return "missing";
    }
    return "missing";
  }

  function normalizeLegalProfile(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      legalBusinessName: String(raw.legal_business_name || "").trim(),
      dbaName: String(raw.dba_name || "").trim(),
      entityType: String(raw.entity_type || "").trim(),
      businessAddressLine1: String(raw.business_address_line1 || "").trim(),
      businessAddressLine2: String(raw.business_address_line2 || "").trim(),
      businessCity: String(raw.business_city || "").trim(),
      businessState: String(raw.business_state || "").trim(),
      businessPostalCode: String(raw.business_postal_code || "").trim(),
      mailingSameAsBusiness: raw.mailing_same_as_business !== false,
      mailingAddressLine1: String(raw.mailing_address_line1 || "").trim(),
      mailingAddressLine2: String(raw.mailing_address_line2 || "").trim(),
      mailingCity: String(raw.mailing_city || "").trim(),
      mailingState: String(raw.mailing_state || "").trim(),
      mailingPostalCode: String(raw.mailing_postal_code || "").trim(),
      businessPhone: String(raw.business_phone || "").trim(),
      businessEmail: String(raw.business_email || "").trim(),
      contractorLicenseStatus: String(raw.contractor_license_status || "unknown").trim().toLowerCase() || "unknown",
      contractorLicenseNumber: String(raw.contractor_license_number || "").trim(),
      contractorLicenseClassification: String(raw.contractor_license_classification || "").trim(),
      contractorLicenseState: String(raw.contractor_license_state || "").trim(),
      contractorLicenseExpiration: raw.contractor_license_expiration
        ? String(raw.contractor_license_expiration).slice(0, 10)
        : "",
      bondCompany: String(raw.bond_company || "").trim(),
      bondNumber: String(raw.bond_number || "").trim(),
      generalLiabilityCarrier: String(raw.general_liability_carrier || "").trim(),
      generalLiabilityPolicyNumber: String(raw.general_liability_policy_number || "").trim(),
      workersCompStatus: String(raw.workers_comp_status || "").trim(),
      workersCompCarrier: String(raw.workers_comp_carrier || "").trim(),
      workersCompPolicyNumber: String(raw.workers_comp_policy_number || "").trim(),
      authorizedSignerName: String(raw.authorized_signer_name || "").trim(),
      authorizedSignerTitle: String(raw.authorized_signer_title || "").trim(),
      primaryServiceState: String(raw.primary_service_state || "").trim(),
      timezone: String(raw.timezone || "").trim(),
      defaultContractLanguage: String(raw.default_contract_language || "en").trim().toLowerCase() || "en",
    };
  }

  function formatStructuredAddress(parts) {
    const line1 = [parts.line1, parts.line2].filter(Boolean).join(", ");
    const cityLine = [parts.city, parts.state, parts.zip].filter(Boolean).join(", ");
    return [line1, cityLine].filter(Boolean).join("\n");
  }

  function pickDisplay(legalValue, brandingValue) {
    const legal = String(legalValue || "").trim();
    if (legal) return { text: legal, source: "legal" };
    const brand = String(brandingValue || "").trim();
    if (brand) return { text: brand, source: "branding" };
    return { text: "", source: "missing" };
  }

  function entityTypeLabel(code) {
    const map = {
      sole_proprietor: "Sole Proprietor",
      llc: "LLC",
      corporation: "Corporation",
      partnership: "Partnership",
      other: "Other",
    };
    const key = String(code || "").trim().toLowerCase();
    if (!key) return "";
    return map[key] || code;
  }

  function licenseStatusLabel(status) {
    const map = {
      licensed: "Licensed",
      not_required: "Not required",
      exempt: "Exempt",
      unknown: "Unknown",
    };
    return map[status] || status || "Unknown";
  }

  function languageLabel(code) {
    const map = { en: "English", es: "Spanish", bilingual: "Bilingual" };
    return map[code] || code || "";
  }

  function maskSecret(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    if (s.length <= 4) return "••••";
    return `${"•".repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
  }

  function setMaskedField(id, rawValue) {
    const el = $(id);
    if (!el) return;
    const raw = String(rawValue || "").trim();
    if (!raw) {
      el.textContent = "—";
      el.removeAttribute("data-secret");
      return;
    }
    el.setAttribute("data-secret", raw);
    const revealed = Boolean(revealSecrets[id]);
    const shown = revealed ? raw : maskSecret(raw);
    el.innerHTML =
      `<span class="cb-masked">${escapeHtml(shown)}</span>` +
      `<button type="button" class="cb-show-secret" data-reveal="${escapeHtml(id)}">${
        revealed ? "Hide" : "Show"
      }</button>`;
  }

  function legalAddressComplete(profile) {
    if (!profile) return false;
    return Boolean(
      profile.businessAddressLine1 &&
        profile.businessCity &&
        profile.businessState &&
        profile.businessPostalCode
    );
  }

  function licenseCheckStatus(profile) {
    if (!profile) return "missing";
    const st = profile.contractorLicenseStatus;
    if (st === "not_required" || st === "exempt") return "available";
    if (st === "unknown") return "needs_confirmation";
    if (st === "licensed") {
      return profile.contractorLicenseNumber && profile.contractorLicenseState
        ? "available"
        : "missing";
    }
    return "needs_confirmation";
  }

  function insuranceCheckStatus(profile) {
    if (!profile) return "needs_confirmation";
    const has =
      profile.bondCompany ||
      profile.bondNumber ||
      profile.generalLiabilityCarrier ||
      profile.generalLiabilityPolicyNumber ||
      profile.workersCompStatus ||
      profile.workersCompCarrier ||
      profile.workersCompPolicyNumber;
    return has ? "available" : "needs_confirmation";
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
    const legal = source.legal || {};
    const profile = legal.profile;

    const legalIdentity = profile?.legalBusinessName ? "available" : "missing";
    const bizAddress = legalAddressComplete(profile) ? "available" : "missing";
    const bizContact =
      profile && (profile.businessPhone || profile.businessEmail)
        ? "available"
        : profile
          ? "missing"
          : "missing";
    const signer =
      profile?.authorizedSignerName && profile?.authorizedSignerTitle
        ? "available"
        : "missing";

    const propertyStatus = readinessMapStatus("property", source);
    const warrantyStatus = readinessMapStatus("warranty", source);
    const paymentStatus = readinessMapStatus("payment", source);
    const signatureStatus = readinessMapStatus("signature", source);
    const legalNoticesStatus = readinessMapStatus("legal_notices", source);
    const overall = overallContractReadiness(source);

    return [
      { label: "Approved quote", status: source.quoteId ? "available" : "missing" },
      { label: "Customer identity", status: source.customerName ? "available" : "missing" },
      {
        label: "Contract total",
        status: source.contractTotal != null && source.contractTotal > 0 ? "available" : "missing",
      },
      { label: "Existing scope", status: scope ? "available" : "missing" },
      { label: "Legal business identity", status: legalIdentity },
      { label: "Business address", status: bizAddress },
      { label: "Business contact", status: bizContact },
      { label: "License status", status: licenseCheckStatus(profile) },
      { label: "Authorized signer", status: signer },
      { label: "Insurance / bond information", status: insuranceCheckStatus(profile) },
      {
        label: "Project address",
        status: propertyStatus === "available" ? "available" : address ? "needs_confirmation" : "missing",
      },
      { label: "Payment schedule", status: paymentStatus },
      { label: "State-required legal notices", status: legalNoticesStatus },
      { label: "Warranty terms", status: warrantyStatus },
      { label: "Signature method", status: signatureStatus },
      {
        label: "Contract Builder readiness",
        status:
          overall === "configured"
            ? "available"
            : overall === "draft"
              ? "needs_confirmation"
              : "missing",
      },
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
    const items = readinessItems(source, edits);
    const overall = overallContractReadiness(source);
    const list = $("cbReadiness");
    if (list) {
      list.innerHTML = items
        .map((item) => {
          const extra = item.note ? ` (${escapeHtml(item.note)})` : "";
          return (
            `<li><span class="cb-check-status ${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</span>` +
            `<span>${escapeHtml(item.label)}${extra}</span></li>`
          );
        })
        .join("");
    }

    const ul = $("cbRequiredList");
    if (ul) {
      ul.innerHTML = items
        .map((item) => {
          const extra = item.note ? ` (${item.note})` : "";
          return `<li>${escapeHtml(item.label)} — ${escapeHtml(statusLabel(item.status))}${escapeHtml(extra)}</li>`;
        })
        .join("");
    }

    const available = items.filter((i) => i.status === "available").length;
    const pct = Math.round((available / items.length) * 100);
    const overallLabel =
      overall === "configured" ? "Configured" : overall === "draft" ? "Draft" : "Missing";
    setText("cbReadyPct", `${overallLabel} · ${pct}%`);

    const missingEl = $("cbMissingList");
    if (missingEl) {
      const missing = items.filter((i) => i.status === "missing");
      missingEl.innerHTML = missing.length
        ? missing.map((i) => `<li><span class="cb-check-status is-missing">Missing</span><span>${escapeHtml(i.label)}${i.note ? ` (${escapeHtml(i.note)})` : ""}</span></li>`).join("")
        : `<li><span class="cb-check-status is-available">Clear</span><span>No critical gaps listed</span></li>`;
    }

    const warnEl = $("cbWarningsList");
    if (warnEl) {
      const warns = items.filter((i) => i.status === "needs_confirmation");
      warnEl.innerHTML = warns.length
        ? warns.map((i) => `<li><span class="cb-check-status is-needs">Confirm</span><span>${escapeHtml(i.label)}</span></li>`).join("")
        : `<li><span class="cb-check-status is-available">Clear</span><span>No confirmation warnings</span></li>`;
    }

    const printReady = pct >= 35;
    const reviewReady = Boolean(source.customerName && source.contractTotal > 0 && source.quoteId);
    const signReady = overall === "configured";

    const setGate = (id, ok) => {
      const el = $(id);
      if (!el) return;
      el.textContent = ok ? "Yes" : "No";
      el.setAttribute("data-ok", ok ? "1" : "0");
    };
    setGate("cbPrintReady", printReady);
    setGate("cbReviewReady", reviewReady);
    setGate("cbSignReady", signReady);

    const next = $("cbNextStep");
    if (next) {
      const profile = source.legal?.profile;
      if (!reviewReady) {
        next.textContent = "Confirm customer and approved total before sharing this draft.";
      } else if (!profile?.legalBusinessName) {
        next.textContent = "Complete Legal & Contract Profile in Business Settings, then continue draft review.";
      } else if (!propertyConfigured(source.contractSetup)) {
        next.textContent = "Confirm the project address in contract setup, then continue draft review.";
      } else if (!paymentConfigured(source.paymentSchedule)) {
        next.textContent = "Confirm the payment schedule so stages exactly total the approved contract price.";
      } else if (!warrantyConfigured(source.contractSetup)) {
        next.textContent = "Confirm warranty terms in contract setup before signature readiness.";
      } else if (!signatureConfigured(source.contractSetup)) {
        next.textContent = "Configure the signature method in contract setup before signature readiness.";
      } else if (!legalNoticesConfigured(source.legalNotices)) {
        const legalSt = resolveLegalNoticesEffective(source.legalNotices).contribution;
        next.textContent =
          legalSt === "draft"
            ? "Confirm tenant legal notices before signature readiness."
            : "Configure and confirm tenant legal notices before signature readiness.";
      } else {
        next.textContent =
          "All required sections are configured. Signature sending is not available from this draft yet.";
      }
    }
  }

  function renderLogo(branding, displayName) {
    const img = $("cbLogoImg");
    const fallback = $("cbLogoFallback");
    const url = String(branding?.logoUrl || "").trim();
    const name = String(displayName || branding?.businessName || "").trim();
    if (img && url) {
      img.src = url;
      img.alt = name ? `${name} logo` : "Business logo";
      img.hidden = false;
      if (fallback) fallback.hidden = true;
    } else {
      if (img) {
        img.removeAttribute("src");
        img.hidden = true;
      }
      if (fallback) {
        fallback.hidden = false;
        fallback.textContent = initialsFromName(name || "MG");
      }
    }
  }

  function renderLegalBanner(legal) {
    const banner = $("cbLegalBanner");
    if (!banner) return;
    if (legal?.forbidden) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal &amp; Contract Profile is unavailable for this account.`;
      return;
    }
    if (legal?.loadError) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal profile could not be loaded right now. Draft review continues with available quote data. ` +
        `<a href="/business-settings#legal-contract-profile">Open Legal Profile</a>`;
      return;
    }
    if (!legal?.profile) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal &amp; Contract Profile not completed. ` +
        `<a href="/business-settings#legal-contract-profile">Complete Legal Profile</a>`;
      return;
    }
    const missing = [];
    const p = legal.profile;
    if (!p.legalBusinessName) missing.push("Legal business name");
    if (!legalAddressComplete(p)) missing.push("Business address");
    if (!p.businessPhone && !p.businessEmail) missing.push("Business contact");
    if (licenseCheckStatus(p) === "missing") missing.push("License details");
    if (!(p.authorizedSignerName && p.authorizedSignerTitle)) missing.push("Authorized signer");
    if (missing.length) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal &amp; Contract Profile needs attention: ${escapeHtml(missing.join(", "))}. ` +
        `<a href="/business-settings#legal-contract-profile">Update Legal Profile</a>`;
      return;
    }
    banner.hidden = true;
    banner.innerHTML = "";
  }

  function renderContractorArticle(source) {
    const b = source.branding || {};
    const legal = source.legal || {};
    const p = legal.profile;

    renderLegalBanner(legal);

    const namePick = pickDisplay(p?.legalBusinessName || p?.dbaName, b.businessName);
    const phonePick = pickDisplay(p?.businessPhone, b.businessPhone);
    const emailPick = pickDisplay(p?.businessEmail, b.businessEmail);
    const structured = p
      ? formatStructuredAddress({
          line1: p.businessAddressLine1,
          line2: p.businessAddressLine2,
          city: p.businessCity,
          state: p.businessState,
          zip: p.businessPostalCode,
        })
      : "";
    const addressPick = pickDisplay(structured, b.businessAddress);

    setText("cbBizName", namePick.text || "—");
    setText("cbLegalName", p?.legalBusinessName || (namePick.source === "branding" ? namePick.text : "") || "—");
    // Branding fallback still supplies the value; do not expose source labels to the customer.

    const dba = p?.dbaName || "";
    setText("cbLegalDba", dba || "—");
    const dbaLine = $("cbBizDba");
    if (dbaLine) {
      if (dba && dba !== namePick.text) {
        dbaLine.hidden = false;
        dbaLine.textContent = `DBA: ${dba}`;
      } else {
        dbaLine.hidden = true;
        dbaLine.textContent = "";
      }
    }

    setText("cbLegalEntity", entityTypeLabel(p?.entityType) || "—");
    setTextMany(["cbBizPhone", "cbBizPhoneBody"], phonePick.text || "—");
    setTextMany(["cbBizEmail", "cbBizEmailBody"], emailPick.text || "—");
    setText("cbBizAddress", addressPick.text ? addressPick.text.replace(/\n/g, ", ") : "—");
    setText("cbBizAddressBody", addressPick.text || "—");

    let mailing = "—";
    if (p) {
      if (p.mailingSameAsBusiness) {
        mailing = addressPick.text ? `${addressPick.text}\n(Same as business)` : "Same as business";
      } else {
        mailing =
          formatStructuredAddress({
            line1: p.mailingAddressLine1,
            line2: p.mailingAddressLine2,
            city: p.mailingCity,
            state: p.mailingState,
            zip: p.mailingPostalCode,
          }) || "—";
      }
    }
    setText("cbMailingAddress", mailing);

    setText("cbLicenseStatus", p ? licenseStatusLabel(p.contractorLicenseStatus) : "—");
    const hideLicenseDetails =
      p &&
      (p.contractorLicenseStatus === "exempt" || p.contractorLicenseStatus === "not_required");
    setText(
      "cbLicenseNumber",
      hideLicenseDetails ? "Not applicable" : p?.contractorLicenseNumber || "—"
    );
    setText(
      "cbLicenseClass",
      hideLicenseDetails ? "Not applicable" : p?.contractorLicenseClassification || "—"
    );
    setText(
      "cbLicenseState",
      hideLicenseDetails ? "Not applicable" : p?.contractorLicenseState || "—"
    );
    setText(
      "cbLicenseExp",
      hideLicenseDetails
        ? "Not applicable"
        : p?.contractorLicenseExpiration
          ? formatDate(p.contractorLicenseExpiration)
          : "—"
    );

    setText("cbBondCompany", p?.bondCompany || "—");
    setMaskedField("cbBondNumber", p?.bondNumber || "");
    setText("cbGlCarrier", p?.generalLiabilityCarrier || "—");
    setMaskedField("cbGlPolicy", p?.generalLiabilityPolicyNumber || "");
    setText("cbWcStatus", p?.workersCompStatus || "—");
    setText("cbWcCarrier", p?.workersCompCarrier || "—");
    setMaskedField("cbWcPolicy", p?.workersCompPolicyNumber || "");

    setText("cbSignerName", p?.authorizedSignerName || "—");
    setText("cbSignerTitle", p?.authorizedSignerTitle || "—");
    setText("cbServiceState", p?.primaryServiceState || "—");
    setText("cbTimezone", p?.timezone || "—");
    setText("cbContractLang", p ? languageLabel(p.defaultContractLanguage) : "—");

    const signerRef = $("cbHeaderSigner");
    if (signerRef) {
      if (p?.authorizedSignerName) {
        signerRef.hidden = false;
        signerRef.textContent = p.authorizedSignerTitle
          ? `Authorized signer: ${p.authorizedSignerName}, ${p.authorizedSignerTitle}`
          : `Authorized signer: ${p.authorizedSignerName}`;
      } else {
        signerRef.hidden = true;
        signerRef.textContent = "";
      }
    }

    renderLogo(b, namePick.text);

    const badges = [];
    const pushBadge = (label, status) => {
      if (status === "available" || status === "not_applicable") return;
      const text =
        status === "needs_confirmation"
          ? `Needs confirmation: ${label}`
          : `Missing: ${label}`;
      badges.push(`<span class="cb-missing">${escapeHtml(text)}</span>`);
    };

    pushBadge("Legal business name", p?.legalBusinessName ? "available" : "missing");
    pushBadge("Business address", legalAddressComplete(p) ? "available" : "missing");
    pushBadge(
      "License",
      (() => {
        const st = licenseCheckStatus(p);
        if (p && (p.contractorLicenseStatus === "exempt" || p.contractorLicenseStatus === "not_required")) {
          return "not_applicable";
        }
        return st;
      })()
    );
    pushBadge(
      "Authorized signer",
      p?.authorizedSignerName && p?.authorizedSignerTitle ? "available" : "missing"
    );
    pushBadge("Insurance / bond", insuranceCheckStatus(p));

    const missingEl = $("cbContractorMissing");
    if (missingEl) {
      missingEl.innerHTML = badges.join(" ");
    }
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

  function pushUndo(id, value) {
    if (!id) return;
    if (!undoStacks[id]) undoStacks[id] = [];
    undoStacks[id].push(String(value ?? ""));
    if (undoStacks[id].length > 40) undoStacks[id].shift();
    redoStacks[id] = [];
  }

  function renderDocument(source, edits) {
    const money = formatMoney(source.contractTotal, source.currency);

    renderContractorArticle(source);

    setText("cbCustomerName", source.customerName || "—");
    setText("cbCoverCustomer", source.customerName || "—");
    setText("cbCustomerEmail", source.customerEmail || "—");
    setText("cbCustomerPhone", source.customerPhone || "—");
    setText("cbProjectName", source.projectName || "—");
    setTextMany(["cbQuoteNumber", "cbQuoteNumberBody"], source.quoteNumber || "—");
    setText("cbCoverDate", formatDate(source.acceptedAt) || formatDate(new Date().toISOString()) || "—");

    const setup = source.contractSetup?.setup || null;
    const propConfigured = propertyConfigured(source.contractSetup);
    setText("cbPropStatus", sectionStatusLabel(propConfigured));
    setText("cbPropLine1", setup?.property_address_line1 || "—");
    setText("cbPropLine2", setup?.property_address_line2 || "—");
    setText("cbPropCity", setup?.property_city || "—");
    setText("cbPropState", setup?.property_state || "—");
    setText("cbPropZip", setup?.property_postal_code || "—");

    const livePropertyLine = formatPropertyLine(setup);
    const proposedAddress = String(edits.address || "").trim();
    const propEl = $("cbPropertyDisplay");
    const proposedWrap = $("cbPropProposedWrap");
    const proposedEl = $("cbPropProposed");

    if (propConfigured && livePropertyLine) {
      if (propEl) propEl.textContent = livePropertyLine;
      if (proposedWrap) proposedWrap.hidden = true;
      if (proposedEl) proposedEl.textContent = "—";
    } else if (!propConfigured && proposedAddress) {
      if (propEl) propEl.textContent = "Property address pending confirmation";
      if (proposedWrap) proposedWrap.hidden = false;
      if (proposedEl) proposedEl.textContent = proposedAddress;
    } else if (livePropertyLine) {
      if (propEl) propEl.textContent = livePropertyLine;
      if (proposedWrap) proposedWrap.hidden = true;
    } else {
      if (propEl) propEl.textContent = "—";
      if (proposedWrap) proposedWrap.hidden = true;
    }

    setText("cbQuoteStatus", quoteStatusDisplay(source.quoteStatus));
    setText("cbAcceptedAt", formatDate(source.acceptedAt) || "—");
    setText("cbContractTotal", money);

    const scope = String(edits.scope || "").trim();
    const exclusions = String(edits.exclusions || "").trim();
    const scopeEl = $("cbScopeDisplay");
    const scopeWarn = $("cbScopeEmailWarn");
    if (scopeEl) {
      if (scope) {
        scopeEl.textContent = exclusions ? `${scope}\n\nExclusions:\n${exclusions}` : scope;
      } else {
        scopeEl.textContent =
          "A clear description of the work has not been provided yet.";
      }
    }
    if (scopeWarn) {
      const showWarn = Boolean(scope && looksLikeEstimateEmail(scope));
      scopeWarn.hidden = !showWarn;
    }

    setText("cbPriceLine", money);
    setText("cbPayTotalLine", `Contract Total: ${money}`);

    const payStatus = String(source.paymentSchedule?.readiness?.status || "missing").toLowerCase();
    const undefinedLabel = undefinedMoneyLabel(payStatus);

    const depositEl = $("cbSumDeposit");
    if (depositEl) {
      depositEl.textContent =
        source.depositRequired != null
          ? formatMoney(source.depositRequired, source.currency)
          : undefinedLabel;
    }
    setText("cbSumProgress", undefinedLabel);
    setText("cbSumFinal", undefinedLabel);
    setText("cbSumChangeOrders", "Not yet defined");
    setText("cbSumTaxes", "Not yet defined");
    setText(
      "cbSumBalance",
      source.depositRequired != null && source.contractTotal != null
        ? formatMoney(Math.max(0, source.contractTotal - source.depositRequired), source.currency)
        : "Not yet defined"
    );

    renderPaymentScheduleSection(source);
    renderWarrantySection(source, edits);
    renderSignatureSection(source);
    renderLegalNoticesSection(source);

    const payNotes = String(edits.paymentNotes || "").trim();
    const payNotesEl = $("cbPaymentNotesDisplay");
    if (payNotesEl) payNotesEl.textContent = payNotes ? `Draft payment notes: ${payNotes}` : "";

    setText(
      "cbStartDisplay",
      edits.startDate ? formatDate(edits.startDate) : "To be confirmed"
    );
    setText(
      "cbDueDisplay",
      edits.dueDate ? formatDate(edits.dueDate) : "To be confirmed"
    );

    const terms = String(edits.additionalTerms || "").trim();
    const termsEl = $("cbTermsDisplay");
    if (termsEl) {
      if (terms) {
        termsEl.hidden = false;
        termsEl.textContent = terms;
      } else {
        termsEl.hidden = true;
        termsEl.textContent = "";
      }
    }

    renderReadiness(source, edits);
  }

  function renderLegalNoticesSection(source) {
    const effective = resolveLegalNoticesEffective(source.legalNotices);
    const statusEl = $("cbLegalNoticesStatus");
    if (statusEl) statusEl.textContent = effective.label;

    const hint = $("cbLegalNoticesHint");
    const listEl = $("cbLegalNoticesList");

    if (hint) {
      if (effective.hint) {
        hint.hidden = false;
        hint.innerHTML = `<span class="cb-missing">${escapeHtml(effective.hint)}</span>`;
      } else {
        hint.hidden = true;
        hint.innerHTML = "";
      }
    }

    if (listEl) {
      if (!effective.rows.length) {
        listEl.innerHTML = "";
      } else {
        listEl.innerHTML = effective.rows
          .map(
            (row) =>
              `<div class="cb-field" style="margin-bottom:10px;">` +
              `<span class="k">${escapeHtml(row.label)}</span>` +
              `<div class="v" style="white-space:pre-wrap;">${escapeHtml(row.text)}</div>` +
              `</div>`
          )
          .join("");
      }
    }
  }

  function renderPaymentScheduleSection(source) {
    const bundle = source.paymentSchedule || {};
    const readiness = bundle.readiness || {};
    const status = String(readiness.status || "missing").toLowerCase();
    const currency = source.currency || DEFAULT_CURRENCY;
    const undefinedLabel = undefinedMoneyLabel(status);
    const statusEl = $("cbPayScheduleStatus");
    if (statusEl) statusEl.textContent = paymentStatusLabel(bundle);

    const hint = $("cbPayScheduleHint");
    const meta = $("cbPayScheduleMeta");
    const stagesEl = $("cbPayScheduleStages");
    const qaWarn = $("cbPayQaWarn");

    if (status === "missing" || bundle.loadError || bundle.forbidden) {
      if (meta) {
        meta.hidden = true;
        meta.innerHTML = "";
      }
      if (stagesEl) stagesEl.innerHTML = "";
      if (qaWarn) {
        qaWarn.hidden = true;
        qaWarn.textContent = "";
      }
      if (hint) hint.hidden = false;
      if (status === "missing") {
        setText("cbSumProgress", "Not yet defined");
        setText("cbSumFinal", "Not yet defined");
      }
      return;
    }

    if (hint) {
      if (status === "configured") {
        hint.hidden = true;
      } else {
        hint.hidden = false;
        hint.innerHTML =
          status === "draft"
            ? `<span class="cb-missing">Payment schedule awaiting confirmation</span>`
            : `<span class="cb-missing">Payment stages and amounts must be confirmed and must total the approved contract price before signature.</span>`;
      }
    }

    const items = Array.isArray(bundle.items) ? bundle.items : [];
    const qaLabels = items.filter((item) => looksLikeTechnicalQaLabel(item.label));
    if (qaWarn) {
      if (qaLabels.length) {
        qaWarn.hidden = false;
        qaWarn.textContent =
          "This payment stage appears to contain test or technical wording and should be replaced before the contract is sent to the customer.";
      } else {
        qaWarn.hidden = true;
        qaWarn.textContent = "";
      }
    }

    if (stagesEl) {
      if (!items.length) {
        stagesEl.innerHTML = `<p><em>No payment stages have been defined yet.</em></p>`;
      } else {
        const rows = items
          .map((item) => {
            const seq = item.sequence_number ?? "—";
            const label = escapeHtml(item.label || "—");
            const amount = escapeHtml(formatMoney(item.amount, currency));
            const due = escapeHtml(dueRuleLabel(item.due_rule));
            const milestone = escapeHtml(item.milestone_description || "—");
            const amountNote =
              status === "draft"
                ? `<div class="cb-field"><span class="k">Status</span><div class="v">Draft payment schedule</div></div>`
                : "";
            return (
              `<div class="cb-meta-grid" style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--cb-line);">` +
              `<div class="cb-field"><span class="k">Sequence</span><div class="v">${escapeHtml(String(seq))}</div></div>` +
              `<div class="cb-field"><span class="k">Label</span><div class="v">${label}</div></div>` +
              `<div class="cb-field"><span class="k">Amount</span><div class="v">${amount}</div></div>` +
              `<div class="cb-field"><span class="k">Due</span><div class="v">${due}</div></div>` +
              `<div class="cb-field"><span class="k">Milestone</span><div class="v">${milestone}</div></div>` +
              amountNote +
              `</div>`
            );
          })
          .join("");
        stagesEl.innerHTML = rows;
      }
    }

    if (meta) {
      meta.hidden = false;
      const contractTotal = readiness.contract_total ?? source.contractTotal;
      const scheduled = readiness.scheduled_total;
      const remaining = readiness.remaining_difference;
      const confirmedAt = bundle.schedule?.confirmed_at || readiness.confirmed_at;
      let html =
        `<div class="cb-field"><span class="k">Contract Total</span><div class="v">${escapeHtml(formatMoney(contractTotal, currency))}</div></div>` +
        `<div class="cb-field"><span class="k">Total Scheduled</span><div class="v">${escapeHtml(formatMoney(scheduled, currency))}</div></div>` +
        `<div class="cb-field"><span class="k">Remaining Difference</span><div class="v">${escapeHtml(formatMoney(remaining, currency))}</div></div>`;
      if (status === "configured") {
        html +=
          `<div class="cb-field"><span class="k">Confirmed Date</span><div class="v">${escapeHtml(formatDate(confirmedAt) || "—")}</div></div>`;
      }
      meta.innerHTML = html;
    }

    const depositItem = items.find((i) => String(i.payment_type || "").toLowerCase() === "deposit");
    const finalItem = items.find((i) =>
      ["final", "completion"].includes(String(i.payment_type || "").toLowerCase())
    );
    const progressItems = items.filter((i) =>
      ["progress", "start", "material", "custom"].includes(String(i.payment_type || "").toLowerCase())
    );
    if (depositItem) {
      const depositAmt = formatMoney(depositItem.amount, currency);
      setText(
        "cbSumDeposit",
        status === "draft" ? `${depositAmt} (draft payment schedule)` : depositAmt
      );
    }
    setText(
      "cbSumProgress",
      progressItems.length
        ? (() => {
            const amt = formatMoney(
              progressItems.reduce((sum, i) => sum + finiteNumber(i.amount, 0), 0),
              currency
            );
            return status === "draft" ? `${amt} (draft payment schedule)` : amt;
          })()
        : undefinedLabel
    );
    setText(
      "cbSumFinal",
      finalItem
        ? (() => {
            const amt = formatMoney(finalItem.amount, currency);
            return status === "draft" ? `${amt} (draft payment schedule)` : amt;
          })()
        : undefinedLabel
    );
  }

  function renderWarrantySection(source, edits) {
    const setup = source.contractSetup?.setup || null;
    const configured = warrantyConfigured(source.contractSetup);
    setText("cbWarrantyStatus", sectionStatusLabel(configured));

    const durationValue = setup?.warranty_duration_value;
    const durationUnit = String(setup?.warranty_duration_unit || "").trim();
    const summary = String(setup?.warranty_summary || "").trim();
    const exclusions = String(setup?.warranty_exclusions || "").trim();
    const length =
      durationValue != null && durationUnit
        ? `${durationValue} ${durationUnit}`
        : "";

    setText("cbWarrantyName", configured ? "Project warranty" : "—");
    setText("cbWarrantyLength", length || "—");
    const descriptionParts = [];
    if (summary) descriptionParts.push(summary);
    if (exclusions) descriptionParts.push(`Exclusions:\n${exclusions}`);
    const description = descriptionParts.join("\n\n");
    setText("cbWarrantyDescription", description || "—");

    if (configured && description) {
      setText("cbWarrantyDisplay", description);
    } else {
      setText("cbWarrantyDisplay", "Warranty terms have not yet been confirmed.");
    }
  }

  function renderSignatureSection(source) {
    setText("cbSignatureMethodStatus", signatureMethodLabel(source.contractSetup));
    setText("cbSignatureRequestStatus", signatureRequestLabel(source.contractSetup));
  }

  function renderAll() {
    if (!sourceSnapshot || !draftEdits) return;
    syncInputsFromEdits(draftEdits);
    renderDocument(sourceSnapshot, draftEdits);
  }

  function wrapSelection(el, before, after) {
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = String(el.value || "");
    pushUndo(el.id, value);
    const selected = value.slice(start, end) || "text";
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    el.value = next;
    const cursor = start + before.length + selected.length + after.length;
    el.focus();
    el.setSelectionRange(cursor, cursor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function prefixLines(el, prefixFn) {
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = String(el.value || "");
    pushUndo(el.id, value);
    const blockStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const blockEnd = (() => {
      const i = value.indexOf("\n", end);
      return i === -1 ? value.length : i;
    })();
    const block = value.slice(blockStart, blockEnd);
    const lines = block.split("\n");
    const nextBlock = lines.map((line, idx) => prefixFn(line, idx)).join("\n");
    const next = value.slice(0, blockStart) + nextBlock + value.slice(blockEnd);
    el.value = next;
    el.focus();
    el.setSelectionRange(blockStart, blockStart + nextBlock.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function undoField(el) {
    if (!el?.id || !undoStacks[el.id]?.length) return;
    if (!redoStacks[el.id]) redoStacks[el.id] = [];
    redoStacks[el.id].push(String(el.value || ""));
    el.value = undoStacks[el.id].pop();
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function redoField(el) {
    if (!el?.id || !redoStacks[el.id]?.length) return;
    if (!undoStacks[el.id]) undoStacks[el.id] = [];
    undoStacks[el.id].push(String(el.value || ""));
    el.value = redoStacks[el.id].pop();
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function buildToolbar(bar) {
    const targetId = bar.getAttribute("data-target");
    const actions = [
      { label: "B", title: "Bold", run: (el) => wrapSelection(el, "**", "**") },
      { label: "I", title: "Italic", run: (el) => wrapSelection(el, "*", "*") },
      { label: "•", title: "Bullets", run: (el) => prefixLines(el, (line) => (line ? `• ${line.replace(/^([•\-]|\d+\.)\s+/, "")}` : "• ")) },
      {
        label: "1.",
        title: "Numbering",
        run: (el) => prefixLines(el, (line, idx) => `${idx + 1}. ${line.replace(/^([•\-]|\d+\.)\s+/, "")}`),
      },
      { label: "↶", title: "Undo", run: (el) => undoField(el) },
      { label: "↷", title: "Redo", run: (el) => redoField(el) },
    ];
    bar.innerHTML = "";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = action.label;
      btn.title = action.title;
      btn.addEventListener("click", () => {
        const el = $(targetId);
        if (!el) return;
        action.run(el);
      });
      bar.appendChild(btn);
    }
  }

  function bindCollapsibleArticles() {
    document.querySelectorAll("[data-article]").forEach((article) => {
      const head = article.querySelector("[data-collapse]");
      if (!head) return;
      head.addEventListener("click", () => {
        article.classList.toggle("is-collapsed");
      });
    });
  }

  function bindIndexNav() {
    const links = [...document.querySelectorAll("#cbIndexNav a")];
    if (!links.length) return;

    links.forEach((link) => {
      link.addEventListener("click", (ev) => {
        const id = link.getAttribute("data-section");
        const target = id ? document.getElementById(id) : null;
        if (!target) return;
        ev.preventDefault();
        target.classList.remove("is-collapsed");
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        links.forEach((l) => l.classList.toggle("is-active", l === link));
      });
    });

    const sections = links
      .map((link) => document.getElementById(link.getAttribute("data-section") || ""))
      .filter(Boolean);

    if (!("IntersectionObserver" in window) || !sections.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible?.target?.id) return;
        links.forEach((l) =>
          l.classList.toggle("is-active", l.getAttribute("data-section") === visible.target.id)
        );
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: [0.15, 0.35, 0.6] }
    );
    sections.forEach((section) => observer.observe(section));
  }

  function expandAllArticlesForPrint() {
    document.querySelectorAll("[data-article].is-collapsed").forEach((el) => {
      el.classList.remove("is-collapsed");
    });
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
      el.addEventListener("focus", () => {
        if (!undoStacks[id]?.length) pushUndo(id, el.value);
      });
    }

    document.querySelectorAll("[data-rich-toolbar]").forEach(buildToolbar);

    document.getElementById("cbDocument")?.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("[data-reveal]");
      if (!btn) return;
      ev.preventDefault();
      const id = btn.getAttribute("data-reveal");
      if (!id) return;
      revealSecrets[id] = !revealSecrets[id];
      if (sourceSnapshot && draftEdits) renderDocument(sourceSnapshot, draftEdits);
    });

    $("cbResetDraft")?.addEventListener("click", () => {
      if (!sourceSnapshot) return;
      draftEdits = cloneEdits(sourceSnapshot);
      renderAll();
    });

    $("cbPrintDraft")?.addEventListener("click", () => {
      expandAllArticlesForPrint();
      window.print();
    });

    $("cbPreviewToggle")?.addEventListener("click", () => {
      const main = $("cbMain");
      if (!main) return;
      const on = main.classList.toggle("is-preview");
      document.body.classList.toggle("cb-customer-preview", on);
      const btn = $("cbPreviewToggle");
      if (btn) btn.textContent = on ? "Edit" : "Preview";
    });

    window.addEventListener("beforeprint", expandAllArticlesForPrint);
  }

  /**
   * Early Owner/Admin fail-closed gate.
   * Uses existing tenant-legal-profile (Owner/Admin membership check) before any
   * project/quote/branding/setup/schedule fetches. No new backend endpoint.
   */
  async function assertOwnerOrAdminAccess() {
    let legalRes;
    try {
      legalRes = await fetchJson(LEGAL_PROFILE_API);
    } catch (_err) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: "unavailable",
          forbidden: false,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage: "Contract Builder access could not be verified. Try again.",
      };
    }

    if (legalRes.status === 401) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: null,
          forbidden: false,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage: "Sign in to open Contract Builder.",
      };
    }

    if (legalRes.status === 403) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: null,
          forbidden: true,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage:
          "Owner or admin membership is required to open Contract Builder.",
      };
    }

    if (!(legalRes.ok && legalRes.data?.ok === true)) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: "unavailable",
          forbidden: false,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage: "Contract Builder access could not be verified. Try again.",
      };
    }

    return {
      ok: true,
      legalBundle: {
        available: true,
        loadError: null,
        forbidden: false,
        readiness: legalRes.data.readiness || null,
        profile: normalizeLegalProfile(legalRes.data.profile),
      },
    };
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
    bindCollapsibleArticles();
    bindIndexNav();

    const params = new URLSearchParams(window.location.search);
    const projectId = String(params.get("project_id") || "").trim();
    const quoteIdParam = String(params.get("quote_id") || "").trim();

    const back = $("cbBackHub");
    if (back && isPlausibleId(projectId)) {
      const hubParams = new URLSearchParams({ project_id: projectId });
      if (quoteIdParam) hubParams.set("quote_id", quoteIdParam);
      back.href = `/contract-hub?${hubParams.toString()}`;
    }

    // Early Owner/Admin gate — before projects/quote/branding/setup/schedule.
    const access = await assertOwnerOrAdminAccess();
    if (!access.ok) {
      showError(access.errorTitle, access.errorMessage);
      return;
    }
    const legalBundle = access.legalBundle;

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

    const setupQs =
      `project_id=${encodeURIComponent(projectId)}&quote_id=${encodeURIComponent(quoteId)}`;
    const [setupRes, scheduleRes, legalNoticesRes] = await Promise.all([
      fetchJson(`${CONTRACT_SETUP_API}?${setupQs}`),
      fetchJson(`${PAYMENT_SCHEDULE_API}?${setupQs}`),
      fetchJson(LEGAL_NOTICES_API),
    ]);

    if (
      setupRes.status === 403 ||
      scheduleRes.status === 403 ||
      legalNoticesRes.status === 403
    ) {
      showError(
        "Contract Builder",
        "Owner or admin membership is required to open Contract Builder readiness data."
      );
      return;
    }
    if (
      setupRes.status === 401 ||
      scheduleRes.status === 401 ||
      legalNoticesRes.status === 401
    ) {
      showError("Contract Builder", "Sign in to open Contract Builder.");
      return;
    }

    let setupBundle = {
      available: false,
      loadError: null,
      forbidden: false,
      setup: null,
      readiness: null,
    };
    if (setupRes.ok && setupRes.data?.ok === true) {
      setupBundle = {
        available: true,
        loadError: null,
        forbidden: false,
        setup: setupRes.data.setup || null,
        readiness: setupRes.data.readiness || null,
      };
    } else if (setupRes.status !== 404) {
      setupBundle.loadError = "unavailable";
    }

    let scheduleBundle = {
      available: false,
      loadError: null,
      forbidden: false,
      schedule: null,
      items: [],
      readiness: { status: "missing" },
      source: null,
    };
    if (scheduleRes.ok && scheduleRes.data?.ok === true) {
      scheduleBundle = {
        available: true,
        loadError: null,
        forbidden: false,
        schedule: scheduleRes.data.schedule || null,
        items: Array.isArray(scheduleRes.data.items) ? scheduleRes.data.items : [],
        readiness: scheduleRes.data.readiness || { status: "missing" },
        source: scheduleRes.data.source || null,
      };
    } else if (scheduleRes.status !== 404) {
      scheduleBundle.loadError = "unavailable";
      scheduleBundle.readiness = { status: "missing" };
    }

    let legalNoticesBundle = {
      available: false,
      loadError: null,
      forbidden: false,
      notices: null,
      readiness: { status: "missing" },
      effective_for_contracts: null,
      has_unconfirmed_changes: false,
    };
    if (legalNoticesRes.ok && legalNoticesRes.data?.ok === true) {
      legalNoticesBundle = {
        available: true,
        loadError: null,
        forbidden: false,
        notices: legalNoticesRes.data.notices || null,
        readiness: legalNoticesRes.data.readiness || { status: "missing" },
        effective_for_contracts:
          legalNoticesRes.data.effective_for_contracts || null,
        has_unconfirmed_changes:
          legalNoticesRes.data.has_unconfirmed_changes === true,
      };
    } else if (legalNoticesRes.status !== 404) {
      legalNoticesBundle.loadError = "unavailable";
      legalNoticesBundle.readiness = { status: "missing" };
    }

    const contractTotal = resolveContractTotal(project, quote);
    const customerName = String(
      project.clientName || project.client_name || quote.client_name || ""
    ).trim();
    if (!(contractTotal > 0) || !customerName) {
      showError(
        "Contract Builder",
        "A customer name and approved contract total are required before opening a draft preview."
      );
      return;
    }

    sourceSnapshot = buildSource(
      project,
      quote,
      branding,
      legalBundle,
      setupBundle,
      scheduleBundle,
      legalNoticesBundle
    );
    draftEdits = cloneEdits(sourceSnapshot);
    const liveAddress = formatPropertyLine(setupBundle.setup);
    if (liveAddress && !String(draftEdits.address || "").trim()) {
      draftEdits.address = liveAddress;
    }
    bindEditors();
    renderAll();
    showMain();
  }

  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
})();
