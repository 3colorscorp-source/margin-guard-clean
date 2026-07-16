(() => {
  "use strict";

  const API = "/.netlify/functions/tenant-legal-profile";

  const FIELD_MAP = [
    ["legalBusinessName", "legal_business_name"],
    ["legalDbaName", "dba_name"],
    ["legalEntityType", "entity_type"],
    ["legalBizAddr1", "business_address_line1"],
    ["legalBizAddr2", "business_address_line2"],
    ["legalBizCity", "business_city"],
    ["legalBizState", "business_state"],
    ["legalBizZip", "business_postal_code"],
    ["legalMailAddr1", "mailing_address_line1"],
    ["legalMailAddr2", "mailing_address_line2"],
    ["legalMailCity", "mailing_city"],
    ["legalMailState", "mailing_state"],
    ["legalMailZip", "mailing_postal_code"],
    ["legalPhone", "business_phone"],
    ["legalEmail", "business_email"],
    ["legalLicenseStatus", "contractor_license_status"],
    ["legalLicenseNumber", "contractor_license_number"],
    ["legalLicenseClass", "contractor_license_classification"],
    ["legalLicenseState", "contractor_license_state"],
    ["legalLicenseExp", "contractor_license_expiration"],
    ["legalBondCompany", "bond_company"],
    ["legalBondNumber", "bond_number"],
    ["legalGlCarrier", "general_liability_carrier"],
    ["legalGlPolicy", "general_liability_policy_number"],
    ["legalWcStatus", "workers_comp_status"],
    ["legalWcCarrier", "workers_comp_carrier"],
    ["legalWcPolicy", "workers_comp_policy_number"],
    ["legalSignerName", "authorized_signer_name"],
    ["legalSignerTitle", "authorized_signer_title"],
    ["legalServiceState", "primary_service_state"],
    ["legalTimezone", "timezone"],
    ["legalContractLanguage", "default_contract_language"],
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value ?? "").trim();
  }

  function setStatus(message, kind) {
    const el = $("bsLegalStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.color =
      kind === "error" ? "#fca5a5" : kind === "ok" ? "#86efac" : "rgba(232,238,252,0.72)";
  }

  function setReadiness(readiness) {
    const el = $("bsLegalReadiness");
    if (!el) return;
    el.classList.remove("is-ready", "is-incomplete");
    if (!readiness || readiness.status !== "ready") {
      const missing = Array.isArray(readiness?.missing) ? readiness.missing.length : 0;
      el.textContent =
        missing > 0
          ? `Incomplete — ${missing} field(s) still helpful for contracts`
          : "No legal profile saved yet";
      el.classList.add("is-incomplete");
      return;
    }
    el.textContent = "Ready for contract preparation";
    el.classList.add("is-ready");
  }

  function clearFieldErrors() {
    document.querySelectorAll(".bs-legal-field-error").forEach((el) => {
      el.classList.remove("bs-legal-field-error");
    });
    ["legalLicenseNumberHint", "legalLicenseStateHint"].forEach((id) => {
      const hint = $(id);
      if (hint) {
        hint.hidden = true;
        hint.textContent = "";
      }
    });
  }

  function markError(inputId, hintId, message) {
    const input = $(inputId);
    if (input) input.classList.add("bs-legal-field-error");
    const hint = $(hintId);
    if (hint) {
      hint.hidden = false;
      hint.textContent = message;
    }
  }

  function licenseStatus() {
    return trim($("legalLicenseStatus")?.value || "unknown").toLowerCase() || "unknown";
  }

  function syncLicenseUi() {
    const status = licenseStatus();
    const details = $("bsLegalLicenseDetails");
    if (!details) return;
    // Exempt / not required: hide license number block (and related fields).
    const hide = status === "exempt" || status === "not_required";
    details.hidden = hide;
  }

  function syncMailingUi() {
    const same = Boolean($("legalMailingSame")?.checked);
    const wrap = $("bsLegalMailingFields");
    if (wrap) wrap.hidden = same;
  }

  function emptyProfile() {
    return {
      legal_business_name: "",
      dba_name: "",
      entity_type: "",
      business_address_line1: "",
      business_address_line2: "",
      business_city: "",
      business_state: "",
      business_postal_code: "",
      mailing_same_as_business: true,
      mailing_address_line1: "",
      mailing_address_line2: "",
      mailing_city: "",
      mailing_state: "",
      mailing_postal_code: "",
      business_phone: "",
      business_email: "",
      contractor_license_status: "unknown",
      contractor_license_number: "",
      contractor_license_classification: "",
      contractor_license_state: "",
      contractor_license_expiration: null,
      bond_company: "",
      bond_number: "",
      general_liability_carrier: "",
      general_liability_policy_number: "",
      workers_comp_status: "",
      workers_comp_carrier: "",
      workers_comp_policy_number: "",
      authorized_signer_name: "",
      authorized_signer_title: "",
      primary_service_state: "",
      timezone: "",
      default_contract_language: "en",
    };
  }

  function applyPrefillHints(profile, hints) {
    if (!hints || typeof hints !== "object") return profile;
    const next = { ...profile };
    const pairs = [
      ["legal_business_name", "legal_business_name"],
      ["dba_name", "dba_name"],
      ["business_phone", "business_phone"],
      ["business_email", "business_email"],
      ["business_address_line1", "business_address_line1"],
    ];
    for (const [profileKey, hintKey] of pairs) {
      if (!trim(next[profileKey]) && trim(hints[hintKey])) {
        next[profileKey] = trim(hints[hintKey]);
      }
    }
    return next;
  }

  function fillForm(profile) {
    const p = profile && typeof profile === "object" ? profile : emptyProfile();
    for (const [domId, key] of FIELD_MAP) {
      const el = $(domId);
      if (!el) continue;
      let value = p[key];
      if (key === "contractor_license_expiration") {
        value = value ? String(value).slice(0, 10) : "";
      } else if (key === "contractor_license_status") {
        value = trim(value).toLowerCase() || "unknown";
      } else if (key === "default_contract_language") {
        value = trim(value).toLowerCase() || "en";
      } else if (value == null) {
        value = "";
      }
      if (domId === "legalTimezone" && value) {
        const has = [...el.options].some((o) => o.value === String(value));
        if (!has) {
          const opt = document.createElement("option");
          opt.value = String(value);
          opt.textContent = String(value);
          el.appendChild(opt);
        }
      }
      el.value = String(value);
    }
    const same = p.mailing_same_as_business !== false;
    if ($("legalMailingSame")) $("legalMailingSame").checked = same;
    syncMailingUi();
    syncLicenseUi();
    clearFieldErrors();
  }

  function readFormBody() {
    const status = licenseStatus();
    const mailingSame = Boolean($("legalMailingSame")?.checked);
    const body = {
      legal_business_name: trim($("legalBusinessName")?.value),
      dba_name: trim($("legalDbaName")?.value),
      entity_type: trim($("legalEntityType")?.value),
      business_address_line1: trim($("legalBizAddr1")?.value),
      business_address_line2: trim($("legalBizAddr2")?.value),
      business_city: trim($("legalBizCity")?.value),
      business_state: trim($("legalBizState")?.value),
      business_postal_code: trim($("legalBizZip")?.value),
      mailing_same_as_business: mailingSame,
      mailing_address_line1: mailingSame ? "" : trim($("legalMailAddr1")?.value),
      mailing_address_line2: mailingSame ? "" : trim($("legalMailAddr2")?.value),
      mailing_city: mailingSame ? "" : trim($("legalMailCity")?.value),
      mailing_state: mailingSame ? "" : trim($("legalMailState")?.value),
      mailing_postal_code: mailingSame ? "" : trim($("legalMailZip")?.value),
      business_phone: trim($("legalPhone")?.value),
      business_email: trim($("legalEmail")?.value),
      contractor_license_status: status,
      contractor_license_number:
        status === "exempt" || status === "not_required"
          ? ""
          : trim($("legalLicenseNumber")?.value),
      contractor_license_classification:
        status === "exempt" || status === "not_required"
          ? ""
          : trim($("legalLicenseClass")?.value),
      contractor_license_state:
        status === "exempt" || status === "not_required"
          ? ""
          : trim($("legalLicenseState")?.value),
      contractor_license_expiration:
        status === "exempt" || status === "not_required"
          ? null
          : trim($("legalLicenseExp")?.value) || null,
      bond_company: trim($("legalBondCompany")?.value),
      bond_number: trim($("legalBondNumber")?.value),
      general_liability_carrier: trim($("legalGlCarrier")?.value),
      general_liability_policy_number: trim($("legalGlPolicy")?.value),
      workers_comp_status: trim($("legalWcStatus")?.value),
      workers_comp_carrier: trim($("legalWcCarrier")?.value),
      workers_comp_policy_number: trim($("legalWcPolicy")?.value),
      authorized_signer_name: trim($("legalSignerName")?.value),
      authorized_signer_title: trim($("legalSignerTitle")?.value),
      primary_service_state: trim($("legalServiceState")?.value),
      timezone: trim($("legalTimezone")?.value),
      default_contract_language: trim($("legalContractLanguage")?.value) || "en",
    };
    return body;
  }

  function validateClient(body) {
    clearFieldErrors();
    const errors = [];

    if (body.business_email) {
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.business_email);
      if (!emailOk) {
        errors.push("Enter a valid business email, or leave it blank.");
        markError("legalEmail", null, "");
        $("legalEmail")?.classList.add("bs-legal-field-error");
      }
    }

    if (body.contractor_license_status === "licensed") {
      if (!body.contractor_license_number) {
        errors.push("License Number is required when status is Licensed.");
        markError("legalLicenseNumber", "legalLicenseNumberHint", "Required for Licensed status");
      }
      if (!body.contractor_license_state) {
        errors.push("License State is required when status is Licensed.");
        markError("legalLicenseState", "legalLicenseStateHint", "Required for Licensed status");
      }
    }

    return { ok: errors.length === 0, errors };
  }

  async function apiJson(method, body) {
    const opts = {
      method,
      credentials: "include",
      headers: { Accept: "application/json" },
    };
    if (method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body || {});
    }
    const res = await fetch(API, opts);
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return { res, data };
  }

  async function loadLegalProfile() {
    setStatus("Loading…", "");
    try {
      const { res, data } = await apiJson("GET");
      if (res.status === 403) {
        setStatus(data?.error || "Not allowed for this role.", "error");
        setReadiness({ status: "incomplete", missing: [] });
        return;
      }
      if (!res.ok || data?.ok !== true) {
        setStatus(data?.error || "Could not load legal profile.", "error");
        setReadiness({ status: "incomplete", missing: [] });
        return;
      }
      let profile = data.profile || emptyProfile();
      if (!data.profile) {
        profile = applyPrefillHints(emptyProfile(), data.prefill_hints);
      }
      fillForm(profile);
      setReadiness(data.readiness || { status: "incomplete", missing: [] });
      setStatus(data.profile ? "Legal profile loaded." : "No profile yet — fill and save.", "ok");
    } catch (err) {
      setStatus(err?.message || "Could not load legal profile.", "error");
    }
  }

  async function saveLegalProfile() {
    const body = readFormBody();
    const client = validateClient(body);
    if (!client.ok) {
      setStatus(client.errors[0] || "Fix validation errors before saving.", "error");
      return;
    }

    setStatus("Saving…", "");
    try {
      const { res, data } = await apiJson("POST", body);
      if (res.status === 403) {
        setStatus(data?.error || "Not allowed for this role.", "error");
        return;
      }
      if (!res.ok || data?.ok !== true) {
        setStatus(data?.error || "Save failed.", "error");
        if (data?.code === "license_fields_required") {
          markError("legalLicenseNumber", "legalLicenseNumberHint", "Required for Licensed status");
          markError("legalLicenseState", "legalLicenseStateHint", "Required for Licensed status");
        }
        return;
      }
      fillForm(data.profile || body);
      setReadiness(data.readiness || { status: "incomplete", missing: [] });
      setStatus("Legal profile saved.", "ok");
    } catch (err) {
      setStatus(err?.message || "Save failed.", "error");
    }
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
      }, 10000);
    });
  }

  function bind() {
    $("legalMailingSame")?.addEventListener("change", syncMailingUi);
    $("legalLicenseStatus")?.addEventListener("change", syncLicenseUi);
    $("btnSaveLegalProfile")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      void saveLegalProfile();
    });
    $("btnReloadLegalProfile")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      void loadLegalProfile();
    });
    $("btnReloadBusinessSettings")?.addEventListener("click", () => {
      void loadLegalProfile();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!$("bsLegalProfileCard")) return;
    bind();
    syncMailingUi();
    syncLicenseUi();
    void waitForAuthReady().then(() => loadLegalProfile());
  });
})();
