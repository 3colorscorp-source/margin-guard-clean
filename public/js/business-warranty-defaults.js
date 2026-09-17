/**
 * CH-082 — Business Settings standard warranty preset (browser + Node).
 *
 * GET loads the tenant row. PATCH saves only the five warranty columns.
 * Does not GET-merge-POST, and does not send trade/name/language/signer fields.
 *
 * Does not write Contract Builder, project_contract_setups, packages, or PDFs.
 * Does not author legal warranty language.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MarginGuardBusinessWarrantyDefaults = api;
  }
  if (typeof document !== "undefined") {
    api.mountBusinessWarrantyCard(document);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var API = "/.netlify/functions/tenant-contract-preferences";
  var WARRANTY_TEXT_MAX = 4000;
  var WARRANTY_UNITS = ["days", "months", "years"];
  var WARRANTY_UNIT_SET = {};
  WARRANTY_UNITS.forEach(function (unit) {
    WARRANTY_UNIT_SET[unit] = true;
  });

  var WARRANTY_PATCH_KEYS = [
    "default_warranty_enabled",
    "default_warranty_duration_value",
    "default_warranty_duration_unit",
    "default_warranty_summary",
    "default_warranty_exclusions",
  ];

  var PRESERVED_PREFERENCE_KEYS = [
    "primary_trade_module",
    "custom_trade_label",
    "default_contract_name",
    "change_order_requirement",
    "require_customer_initials",
    "default_signer_mode",
    "default_contract_language",
    "dispute_resolution_preference",
    "default_signature_order",
    "automatically_attach_warranty",
    "automatically_attach_completion_certificate",
  ];

  function trimValue(value) {
    return String(value == null ? "" : value).trim();
  }

  function parseDurationValue(raw) {
    if (raw == null || raw === "") return null;
    var n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return NaN;
    return Math.floor(n);
  }

  function normalizeWarrantyFields(input) {
    var src = input && typeof input === "object" ? input : {};
    var unit = trimValue(src.default_warranty_duration_unit).toLowerCase() || "months";
    return {
      default_warranty_enabled: Boolean(src.default_warranty_enabled),
      default_warranty_duration_value: parseDurationValue(src.default_warranty_duration_value),
      default_warranty_duration_unit: WARRANTY_UNIT_SET[unit] ? unit : "",
      default_warranty_summary: trimValue(src.default_warranty_summary),
      default_warranty_exclusions: trimValue(src.default_warranty_exclusions),
    };
  }

  function warrantyFieldsFromPreferences(preferences) {
    var row = preferences && typeof preferences === "object" ? preferences : {};
    return normalizeWarrantyFields({
      default_warranty_enabled: row.default_warranty_enabled,
      default_warranty_duration_value: row.default_warranty_duration_value,
      default_warranty_duration_unit: row.default_warranty_duration_unit,
      default_warranty_summary: row.default_warranty_summary,
      default_warranty_exclusions: row.default_warranty_exclusions,
    });
  }

  function evaluateWarrantyPresetStatus(fields) {
    var war = normalizeWarrantyFields(fields);
    if (!war.default_warranty_enabled) {
      return { status: "disabled", label: "Disabled" };
    }
    var missing = warrantyMissingLabels(war);
    if (missing.length) {
      return {
        status: "incomplete",
        label: "Incomplete — add duration, summary, and exclusions",
        missing: missing,
      };
    }
    return { status: "complete", label: "Complete" };
  }

  function warrantyMissingLabels(fields) {
    var war = normalizeWarrantyFields(fields);
    var missing = [];
    var duration = war.default_warranty_duration_value;
    if (!(Number.isInteger(duration) && duration > 0)) missing.push("duration");
    if (!WARRANTY_UNIT_SET[war.default_warranty_duration_unit]) missing.push("unit");
    if (!war.default_warranty_summary) missing.push("summary");
    if (!war.default_warranty_exclusions) missing.push("exclusions");
    return missing;
  }

  function validateWarrantyDraft(fields) {
    var war = normalizeWarrantyFields(fields);
    var errors = [];
    if (war.default_warranty_summary.length > WARRANTY_TEXT_MAX) {
      errors.push("Warranty summary exceeds 4000 characters.");
    }
    if (war.default_warranty_exclusions.length > WARRANTY_TEXT_MAX) {
      errors.push("Warranty exclusions exceed 4000 characters.");
    }
    if (
      war.default_warranty_duration_value != null &&
      !Number.isInteger(war.default_warranty_duration_value)
    ) {
      errors.push("Warranty duration must be a whole number.");
    }
    if (
      war.default_warranty_duration_unit &&
      !WARRANTY_UNIT_SET[war.default_warranty_duration_unit]
    ) {
      errors.push("Choose Days, Months, or Years.");
    }
    if (war.default_warranty_enabled) {
      if (!(Number.isInteger(war.default_warranty_duration_value) && war.default_warranty_duration_value > 0)) {
        errors.push("Enable standard warranty requires a duration greater than 0.");
      }
      if (!WARRANTY_UNIT_SET[war.default_warranty_duration_unit]) {
        errors.push("Enable standard warranty requires a duration unit.");
      }
      if (!war.default_warranty_summary) {
        errors.push("Enable standard warranty requires coverage summary.");
      }
      if (!war.default_warranty_exclusions) {
        errors.push("Enable standard warranty requires exclusions.");
      }
    }
    return { ok: errors.length === 0, errors: errors, fields: war };
  }

  function buildWarrantyPatchBody(warrantyInput) {
    var war = normalizeWarrantyFields(warrantyInput);
    var unit = war.default_warranty_duration_unit || "months";
    var duration = war.default_warranty_duration_value;
    if (!Number.isInteger(duration) || duration < 0) duration = null;
    return {
      default_warranty_enabled: Boolean(war.default_warranty_enabled),
      default_warranty_duration_value: duration,
      default_warranty_duration_unit: unit,
      default_warranty_summary: war.default_warranty_summary,
      default_warranty_exclusions: war.default_warranty_exclusions,
    };
  }

  function applyWarrantyPatchToRow(existing, patch) {
    var row = existing && typeof existing === "object" ? Object.assign({}, existing) : {};
    var body = buildWarrantyPatchBody(patch);
    WARRANTY_PATCH_KEYS.forEach(function (key) {
      row[key] = body[key];
    });
    return row;
  }

  function $(doc, id) {
    return doc.getElementById(id);
  }

  function setStatus(doc, message, kind) {
    var el = $(doc, "bsWarrantyStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.color =
      kind === "error" ? "#fca5a5" : kind === "ok" ? "#86efac" : "rgba(232,238,252,0.72)";
  }

  function setReadiness(doc, statusObj) {
    var el = $(doc, "bsWarrantyReadiness");
    if (!el) return;
    var status = statusObj && statusObj.status ? statusObj.status : "disabled";
    el.classList.remove("is-ready", "is-incomplete", "is-disabled");
    if (status === "complete") el.classList.add("is-ready");
    else if (status === "incomplete") el.classList.add("is-incomplete");
    else el.classList.add("is-disabled");
    el.textContent = (statusObj && statusObj.label) || "Disabled";
  }

  function clearFieldErrors(doc) {
    if (!doc) return;
    doc.querySelectorAll("#bsStandardWarrantyCard .bs-legal-field-error").forEach(function (el) {
      el.classList.remove("bs-legal-field-error");
    });
  }

  function markError(doc, id) {
    var el = $(doc, id);
    if (el) el.classList.add("bs-legal-field-error");
  }

  function fillForm(doc, fields) {
    var war = warrantyFieldsFromPreferences(fields);
    var enabled = $(doc, "bsWarEnabled");
    var duration = $(doc, "bsWarDurationValue");
    var unit = $(doc, "bsWarDurationUnit");
    var summary = $(doc, "bsWarSummary");
    var exclusions = $(doc, "bsWarExclusions");
    if (enabled) enabled.checked = Boolean(war.default_warranty_enabled);
    if (duration) {
      duration.value =
        war.default_warranty_duration_value == null ||
        !Number.isInteger(war.default_warranty_duration_value)
          ? ""
          : String(war.default_warranty_duration_value);
    }
    if (unit) unit.value = WARRANTY_UNIT_SET[war.default_warranty_duration_unit]
      ? war.default_warranty_duration_unit
      : "months";
    if (summary) summary.value = war.default_warranty_summary || "";
    if (exclusions) exclusions.value = war.default_warranty_exclusions || "";
    setReadiness(doc, evaluateWarrantyPresetStatus(war));
  }

  function readForm(doc) {
    var durationRaw = trimValue($(doc, "bsWarDurationValue") && $(doc, "bsWarDurationValue").value);
    return normalizeWarrantyFields({
      default_warranty_enabled: Boolean($(doc, "bsWarEnabled") && $(doc, "bsWarEnabled").checked),
      default_warranty_duration_value: durationRaw,
      default_warranty_duration_unit:
        ($(doc, "bsWarDurationUnit") && $(doc, "bsWarDurationUnit").value) || "months",
      default_warranty_summary: $(doc, "bsWarSummary") && $(doc, "bsWarSummary").value,
      default_warranty_exclusions: $(doc, "bsWarExclusions") && $(doc, "bsWarExclusions").value,
    });
  }

  function markValidationErrors(doc, fields) {
    clearFieldErrors(doc);
    var check = validateWarrantyDraft(fields);
    if (fields.default_warranty_enabled) {
      if (!(Number.isInteger(fields.default_warranty_duration_value) && fields.default_warranty_duration_value > 0)) {
        markError(doc, "bsWarDurationValue");
      }
      if (!WARRANTY_UNIT_SET[fields.default_warranty_duration_unit]) {
        markError(doc, "bsWarDurationUnit");
      }
      if (!fields.default_warranty_summary) markError(doc, "bsWarSummary");
      if (!fields.default_warranty_exclusions) markError(doc, "bsWarExclusions");
    }
    if (fields.default_warranty_summary.length > WARRANTY_TEXT_MAX) markError(doc, "bsWarSummary");
    if (fields.default_warranty_exclusions.length > WARRANTY_TEXT_MAX) markError(doc, "bsWarExclusions");
    return check;
  }

  async function apiJson(method, body) {
    var opts = {
      method: method,
      credentials: "include",
      headers: { Accept: "application/json" },
    };
    if (method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body || {});
    }
    var res = await fetch(API, opts);
    var data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return { res: res, data: data };
  }

  async function loadWarranty(doc) {
    setStatus(doc, "Loading…", "");
    try {
      var result = await apiJson("GET");
      if (result.res.status === 403) {
        setStatus(doc, result.data && result.data.error ? result.data.error : "Not allowed for this role.", "error");
        setReadiness(doc, { status: "disabled", label: "Disabled" });
        return;
      }
      if (!result.res.ok || result.data.ok !== true) {
        setStatus(doc, (result.data && result.data.error) || "Could not load standard warranty.", "error");
        return;
      }
      fillForm(doc, result.data.preferences || {});
      setStatus(doc, result.data.preferences ? "Standard warranty loaded." : "No preferences yet — fill and save.", "ok");
    } catch (err) {
      setStatus(doc, (err && err.message) || "Could not load standard warranty.", "error");
    }
  }

  async function saveWarranty(doc) {
    var fields = readForm(doc);
    var check = markValidationErrors(doc, fields);
    setReadiness(doc, evaluateWarrantyPresetStatus(fields));
    if (!check.ok) {
      setStatus(doc, check.errors[0] || "Fix validation errors before saving.", "error");
      return;
    }

    setStatus(doc, "Saving…", "");
    try {
      var body = buildWarrantyPatchBody(fields);
      var saved = await apiJson("PATCH", body);
      if (saved.res.status === 403) {
        setStatus(doc, (saved.data && saved.data.error) || "Not allowed for this role.", "error");
        return;
      }
      if (!saved.res.ok || saved.data.ok !== true) {
        setStatus(doc, (saved.data && saved.data.error) || "Save failed.", "error");
        return;
      }
      fillForm(doc, saved.data.preferences || body);
      setStatus(doc, "Standard warranty saved.", "ok");
    } catch (err) {
      setStatus(doc, (err && err.message) || "Save failed.", "error");
    }
  }

  function waitForAuthReady(doc) {
    return new Promise(function (resolve) {
      if (doc.body && doc.body.classList.contains("auth-ready")) {
        resolve();
        return;
      }
      var timer = setInterval(function () {
        if (doc.body && doc.body.classList.contains("auth-ready")) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
      setTimeout(function () {
        clearInterval(timer);
        resolve();
      }, 10000);
    });
  }

  function bind(doc) {
    var saveBtn = $(doc, "btnSaveStandardWarranty");
    var reloadBtn = $(doc, "btnReloadStandardWarranty");
    var enabled = $(doc, "bsWarEnabled");
    if (saveBtn) {
      saveBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        void saveWarranty(doc);
      });
    }
    if (reloadBtn) {
      reloadBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        void loadWarranty(doc);
      });
    }
    if (enabled) {
      enabled.addEventListener("change", function () {
        setReadiness(doc, evaluateWarrantyPresetStatus(readForm(doc)));
      });
    }
    var pageReload = $(doc, "btnReloadBusinessSettings");
    if (pageReload) {
      pageReload.addEventListener("click", function () {
        void loadWarranty(doc);
      });
    }
  }

  function mountBusinessWarrantyCard(doc) {
    if (!doc || typeof doc.addEventListener !== "function") return;
    if (!$(doc, "bsStandardWarrantyCard")) return;
    doc.addEventListener("DOMContentLoaded", function () {
      if (!$(doc, "bsStandardWarrantyCard")) return;
      bind(doc);
      waitForAuthReady(doc).then(function () {
        void loadWarranty(doc);
      });
    });
  }

  return {
    API: API,
    WARRANTY_TEXT_MAX: WARRANTY_TEXT_MAX,
    WARRANTY_UNITS: WARRANTY_UNITS,
    WARRANTY_PATCH_KEYS: WARRANTY_PATCH_KEYS,
    PRESERVED_PREFERENCE_KEYS: PRESERVED_PREFERENCE_KEYS,
    warrantyFieldsFromPreferences: warrantyFieldsFromPreferences,
    evaluateWarrantyPresetStatus: evaluateWarrantyPresetStatus,
    validateWarrantyDraft: validateWarrantyDraft,
    buildWarrantyPatchBody: buildWarrantyPatchBody,
    applyWarrantyPatchToRow: applyWarrantyPatchToRow,
    mountBusinessWarrantyCard: mountBusinessWarrantyCard,
  };
});
