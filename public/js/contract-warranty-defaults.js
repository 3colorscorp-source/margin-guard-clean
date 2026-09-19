/**
 * Contract Builder warranty defaults (browser + Node).
 *
 * Seeds 1–5 year duration plus protective exclusions into the local draft only.
 * Does not POST, PATCH, confirm, freeze, or change frozen snapshots.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MarginGuardContractWarrantyDefaults = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var WARRANTY_UNITS = ["days", "months", "years"];
  var WARRANTY_UNIT_SET = {};
  WARRANTY_UNITS.forEach(function (unit) {
    WARRANTY_UNIT_SET[unit] = true;
  });

  var YEAR_OPTIONS = [1, 2, 3, 4, 5];
  var YEAR_OPTION_LABELS = {
    1: "1 Year",
    2: "2 Years",
    3: "3 Years",
    4: "4 Years",
    5: "5 Years",
  };
  var SYSTEM_SUMMARY =
    "The contractor warrants that work performed under this contract will be free from defects for the warranty duration. This warranty covers the contractor's own work in the approved Scope of Work and does not reduce any duty the law does not allow the parties to waive.";
  var SYSTEM_EXCLUSIONS = [
    "Work outside the approved Scope of Work, including added, reduced, or changed work that was not approved in writing.",
    "Concealed or unforeseen conditions that could not reasonably be discovered before work began.",
    "Owner-supplied materials, products, or equipment, including defects, shortages, or failures in those materials.",
    "Pre-existing defects, damage, or conditions not caused by the contractor's work.",
    "Damage, alteration, misuse, improper maintenance, or work performed by anyone other than the contractor or the contractor's approved subcontractors.",
  ];

  var LOCKING_PACKAGE_STATUSES = {
    ready: true,
    executed: true,
    superseded: true,
    frozen: true,
  };

  var SETTINGS_HREF = "/business-settings.html#standard-warranty";
  var REPLACE_CONFIRM_MESSAGE =
    "This project already has warranty terms. Replace the draft with the standard warranty? Confirm Warranty is still required after replacing.";

  function trimField(value) {
    return String(value == null ? "" : value).trim();
  }

  function parseDurationValue(raw) {
    if (raw == null || raw === "") return null;
    var n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return NaN;
    return Math.floor(n);
  }

  function normalizePreset(preferences) {
    var src = preferences && typeof preferences === "object" ? preferences : {};
    var unit = trimField(src.default_warranty_duration_unit).toLowerCase();
    return {
      default_warranty_enabled: Boolean(src.default_warranty_enabled),
      default_warranty_duration_value: parseDurationValue(src.default_warranty_duration_value),
      default_warranty_duration_unit: WARRANTY_UNIT_SET[unit] ? unit : "",
      default_warranty_summary: trimField(src.default_warranty_summary),
      default_warranty_exclusions: trimField(src.default_warranty_exclusions),
    };
  }

  function evaluateStandardWarrantyPreset(preferences) {
    if (preferences == null) {
      return { status: "missing", complete: false, preset: null };
    }
    var preset = normalizePreset(preferences);
    if (!preset.default_warranty_enabled) {
      return { status: "disabled", complete: false, preset: preset };
    }
    var duration = preset.default_warranty_duration_value;
    var unitOk = Boolean(WARRANTY_UNIT_SET[preset.default_warranty_duration_unit]);
    var durationOk = Number.isInteger(duration) && duration > 0;
    if (
      durationOk &&
      unitOk &&
      preset.default_warranty_summary &&
      preset.default_warranty_exclusions
    ) {
      return { status: "complete", complete: true, preset: preset };
    }
    return { status: "incomplete", complete: false, preset: preset };
  }

  function presetToDraftFields(preferences) {
    var evaluated = evaluateStandardWarrantyPreset(preferences);
    if (!evaluated.complete) return null;
    var preset = evaluated.preset;
    return {
      durationValue: String(preset.default_warranty_duration_value),
      durationUnit: preset.default_warranty_duration_unit,
      summary: preset.default_warranty_summary,
      exclusions: preset.default_warranty_exclusions,
    };
  }

  function hasExistingWarrantyContent(fields) {
    var src = fields && typeof fields === "object" ? fields : {};
    var durationRaw =
      src.durationValue != null ? src.durationValue : src.warranty_duration_value;
    var summary = trimField(src.summary != null ? src.summary : src.warranty_summary);
    var exclusions = trimField(
      src.exclusions != null ? src.exclusions : src.warranty_exclusions
    );
    if (summary || exclusions) return true;
    if (durationRaw == null || durationRaw === "") return false;
    var n = Number(durationRaw);
    return Number.isFinite(n);
  }

  function isUnsafePackageStatus(status) {
    var key = trimField(status).toLowerCase();
    return Boolean(LOCKING_PACKAGE_STATUSES[key]);
  }

  function findWarrantyLockingPackage(packages) {
    var list = Array.isArray(packages) ? packages : [];
    for (var i = 0; i < list.length; i += 1) {
      if (isUnsafePackageStatus(list[i] && list[i].status)) return list[i];
    }
    return null;
  }

  function evaluateUseStandardWarrantyAction(input) {
    var src = input || {};
    var evaluated = evaluateStandardWarrantyPreset(src.preferences);
    var locking = findWarrantyLockingPackage(src.packages);
    if (!locking && src.unsafeToEdit === true) {
      locking = { status: trimField(src.packageStatus) || "frozen" };
    } else if (!locking && isUnsafePackageStatus(src.packageStatus)) {
      locking = { status: trimField(src.packageStatus) };
    }
    var locked = Boolean(locking);
    var existing = hasExistingWarrantyContent(src.existingFields);
    var complete = evaluated.complete === true && !locked;
    return {
      presetStatus: evaluated.status,
      complete: evaluated.complete,
      locked: locked,
      lockingPackage: locking,
      hasExistingContent: existing,
      showPrimaryApply: complete && !existing,
      showReplace: complete && existing,
      showSettingsHint: !locked && evaluated.status !== "complete",
      settingsHref: SETTINGS_HREF,
      replaceConfirmMessage: REPLACE_CONFIRM_MESSAGE,
    };
  }

  function applyStandardWarrantyToDraft(preferences, options) {
    var opts = options || {};
    var action = evaluateUseStandardWarrantyAction({
      preferences: preferences,
      existingFields: opts.existingFields,
      packages: opts.packages,
      packageStatus: opts.packageStatus,
      unsafeToEdit: opts.unsafeToEdit,
    });
    if (action.locked) {
      return {
        ok: false,
        applied: false,
        confirm: false,
        reason: "package_locked",
        code: "warranty_locked_by_package",
        fields: null,
        action: action,
      };
    }
    if (!action.complete) {
      return {
        ok: false,
        applied: false,
        confirm: false,
        reason: action.presetStatus,
        fields: null,
        action: action,
      };
    }
    if (action.hasExistingContent && opts.replaceConfirmed !== true) {
      return {
        ok: false,
        applied: false,
        confirm: false,
        needsConfirm: true,
        reason: "existing_content",
        fields: null,
        action: action,
      };
    }
    return {
      ok: true,
      applied: true,
      confirm: false,
      reason: "applied_to_draft",
      fields: presetToDraftFields(preferences),
      action: action,
    };
  }

  function yearOptionFromDuration(value, unit) {
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    var u = trimField(unit).toLowerCase();
    var years = n;
    if (u === "months") {
      if (n % 12 !== 0) return null;
      years = n / 12;
    } else if (u === "days") {
      return null;
    } else if (u && u !== "years" && u !== "year") {
      return null;
    }
    years = Math.round(years);
    return YEAR_OPTIONS.indexOf(years) >= 0 ? years : null;
  }

  function systemDefaultFields() {
    return {
      durationValue: "1",
      durationUnit: "years",
      summary: SYSTEM_SUMMARY,
      exclusions: SYSTEM_EXCLUSIONS.join("\n"),
      source: "system",
    };
  }

  function fieldsFromSetup(setup) {
    var src = setup && typeof setup === "object" ? setup : {};
    var rawValue = src.warranty_duration_value != null ? src.warranty_duration_value : src.durationValue;
    var value =
      rawValue == null || rawValue === ""
        ? ""
        : String(parseInt(rawValue, 10));
    var unit = trimField(src.warranty_duration_unit || src.durationUnit || "years").toLowerCase();
    return {
      durationValue: Number.isFinite(Number(value)) ? String(parseInt(value, 10)) : "",
      durationUnit: unit === "year" ? "years" : WARRANTY_UNIT_SET[unit] ? unit : "years",
      summary: trimField(src.warranty_summary != null ? src.warranty_summary : src.summary),
      exclusions: trimField(src.warranty_exclusions != null ? src.warranty_exclusions : src.exclusions),
    };
  }

  function warrantyFieldsComplete(fields) {
    var src = fields && typeof fields === "object" ? fields : {};
    var n = Number(src.durationValue);
    return (
      src.durationValue !== "" &&
      Number.isFinite(n) &&
      Number.isInteger(n) &&
      n >= 0 &&
      Boolean(trimField(src.durationUnit)) &&
      Boolean(trimField(src.summary)) &&
      Boolean(trimField(src.exclusions))
    );
  }

  function tenantOverlayFields(preferences) {
    var preset = normalizePreset(preferences);
    if (!preset.default_warranty_enabled) return null;
    var years = yearOptionFromDuration(
      preset.default_warranty_duration_value,
      preset.default_warranty_duration_unit
    );
    var overlay = { source: "tenant" };
    if (years) {
      overlay.durationValue = String(years);
      overlay.durationUnit = "years";
    }
    if (preset.default_warranty_summary) overlay.summary = preset.default_warranty_summary;
    if (preset.default_warranty_exclusions) overlay.exclusions = preset.default_warranty_exclusions;
    if (!overlay.durationValue && !overlay.summary && !overlay.exclusions) return null;
    return overlay;
  }

  function resolveWarrantyDraft(input) {
    var src = input || {};
    var setup = fieldsFromSetup(src.setup);
    var system = systemDefaultFields();
    if (src.configured === true && (setup.summary || setup.exclusions || setup.durationValue)) {
      return Object.assign({ source: "setup" }, setup);
    }
    if (warrantyFieldsComplete(setup)) {
      return Object.assign({ source: "setup" }, setup);
    }
    var tenant = tenantOverlayFields(src.preferences);
    var years =
      yearOptionFromDuration(setup.durationValue, setup.durationUnit) ||
      (tenant && tenant.durationValue ? Number(tenant.durationValue) : null) ||
      1;
    return {
      durationValue: String(years),
      durationUnit: "years",
      summary: setup.summary || (tenant && tenant.summary) || system.summary,
      exclusions: setup.exclusions || (tenant && tenant.exclusions) || system.exclusions,
      source: setup.summary || setup.exclusions || yearOptionFromDuration(setup.durationValue, setup.durationUnit)
        ? "setup"
        : tenant
          ? "tenant"
          : "system",
    };
  }

  function formatDurationLabel(fields) {
    var src = fields && typeof fields === "object" ? fields : {};
    var years = yearOptionFromDuration(src.durationValue, src.durationUnit);
    if (years) return YEAR_OPTION_LABELS[years];
    var n = Number(src.durationValue);
    var unit = trimField(src.durationUnit);
    if (!Number.isFinite(n) || !unit) return "";
    var singular = unit === "days" ? "Day" : unit === "months" ? "Month" : "Year";
    var plural = unit === "days" ? "Days" : unit === "months" ? "Months" : "Years";
    return n + " " + (n === 1 ? singular : plural);
  }

  function parseExclusionLines(raw) {
    return trimField(raw)
      .split(/\r?\n/)
      .map(function (line) {
        return String(line || "")
          .replace(/^\s*\d+\.\s*/, "")
          .replace(/^[\s•\-\*]+/, "")
          .trim();
      })
      .filter(Boolean);
  }

  function formatExclusionDisplayLines(raw) {
    return parseExclusionLines(raw).map(function (line, idx) {
      return idx + 1 + ". " + line;
    });
  }

  function warrantyFooterPlan(input) {
    var src = input || {};
    var configured = src.configured === true;
    var busy = Boolean(src.busy);
    var buttons = [
      {
        id: "edit",
        label: "Edit Warranty",
        style: "ghost",
        enabled: !busy,
      },
    ];
    if (configured) {
      buttons.push({
        id: "continue",
        label: "Continue",
        style: "primary",
        enabled: !busy,
      });
    } else {
      buttons.push({
        id: "confirm",
        label: "Confirm Warranty",
        style: "primary",
        enabled: !busy,
      });
    }
    var primaryEnabled = buttons.filter(function (btn) {
      return btn.style === "primary" && btn.enabled;
    });
    return {
      kind: configured ? "confirmed" : "unconfirmed",
      buttons: buttons,
      continueVisible: configured,
      continueEnabled: configured && !busy,
      confirmVisible: !configured,
      primaryEnabledCount: primaryEnabled.length,
      primaryLabel: primaryEnabled[0] ? primaryEnabled[0].label : "",
    };
  }

  return {
    WARRANTY_UNITS: WARRANTY_UNITS.slice(),
    YEAR_OPTIONS: YEAR_OPTIONS.slice(),
    YEAR_OPTION_LABELS: YEAR_OPTION_LABELS,
    SYSTEM_SUMMARY: SYSTEM_SUMMARY,
    SYSTEM_EXCLUSIONS: SYSTEM_EXCLUSIONS.slice(),
    SETTINGS_HREF: SETTINGS_HREF,
    REPLACE_CONFIRM_MESSAGE: REPLACE_CONFIRM_MESSAGE,
    evaluateStandardWarrantyPreset: evaluateStandardWarrantyPreset,
    presetToDraftFields: presetToDraftFields,
    hasExistingWarrantyContent: hasExistingWarrantyContent,
    isUnsafePackageStatus: isUnsafePackageStatus,
    findWarrantyLockingPackage: findWarrantyLockingPackage,
    evaluateUseStandardWarrantyAction: evaluateUseStandardWarrantyAction,
    applyStandardWarrantyToDraft: applyStandardWarrantyToDraft,
    yearOptionFromDuration: yearOptionFromDuration,
    systemDefaultFields: systemDefaultFields,
    resolveWarrantyDraft: resolveWarrantyDraft,
    formatDurationLabel: formatDurationLabel,
    parseExclusionLines: parseExclusionLines,
    formatExclusionDisplayLines: formatExclusionDisplayLines,
    warrantyFieldsComplete: warrantyFieldsComplete,
    warrantyFooterPlan: warrantyFooterPlan,
  };
});
