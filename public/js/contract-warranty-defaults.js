/**
 * CH-083 — Contract Builder "Use standard warranty" (browser + Node).
 *
 * Copies a tenant preset into the local warranty draft only.
 * Does not POST, PATCH, confirm, freeze, or author legal text.
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

  return {
    WARRANTY_UNITS: WARRANTY_UNITS.slice(),
    SETTINGS_HREF: SETTINGS_HREF,
    REPLACE_CONFIRM_MESSAGE: REPLACE_CONFIRM_MESSAGE,
    evaluateStandardWarrantyPreset: evaluateStandardWarrantyPreset,
    presetToDraftFields: presetToDraftFields,
    hasExistingWarrantyContent: hasExistingWarrantyContent,
    isUnsafePackageStatus: isUnsafePackageStatus,
    findWarrantyLockingPackage: findWarrantyLockingPackage,
    evaluateUseStandardWarrantyAction: evaluateUseStandardWarrantyAction,
    applyStandardWarrantyToDraft: applyStandardWarrantyToDraft,
  };
});
