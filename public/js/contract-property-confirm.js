/**
 * Contract Builder Article 3 — property confirm decisions (browser + Node).
 *
 * Owns CTA plan, payload shape, busy lock, and persist/no-persist outcomes.
 * Does not freeze, sign, or invent city/state/zip.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MarginGuardContractPropertyConfirm = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SETUP_API = "/.netlify/functions/project-contract-setup";
  var confirmLock = false;

  function trimField(value) {
    return String(value == null ? "" : value).trim();
  }

  function propertyFieldsFromSetup(setup) {
    return {
      line1: trimField(setup && setup.property_address_line1),
      line2: trimField(setup && setup.property_address_line2),
      city: trimField(setup && setup.property_city),
      state: trimField(setup && setup.property_state),
      zip: trimField(setup && setup.property_postal_code),
    };
  }

  function propertyFieldsFromEdits(edits) {
    return {
      line1: trimField(edits && edits.propLine1),
      line2: trimField(edits && edits.propLine2),
      city: trimField(edits && edits.propCity),
      state: trimField(edits && edits.propState),
      zip: trimField(edits && edits.propZip),
    };
  }

  function cloneFields(fields) {
    var row = fields || {};
    return {
      line1: trimField(row.line1),
      line2: trimField(row.line2),
      city: trimField(row.city),
      state: trimField(row.state),
      zip: trimField(row.zip),
    };
  }

  function propertyMissingLabels(fields) {
    var row = cloneFields(fields);
    var missing = [];
    if (!row.line1) missing.push("Address Line 1");
    if (!row.city) missing.push("City");
    if (!row.state) missing.push("State");
    if (!row.zip) missing.push("ZIP Code");
    return missing;
  }

  function propertyFieldsComplete(fields) {
    return propertyMissingLabels(fields).length === 0;
  }

  function formatPropertyLine(setup) {
    if (!setup) return "";
    var fields = propertyFieldsFromSetup(setup);
    var cityState = [fields.city, fields.state].filter(Boolean).join(", ");
    var locality = [cityState, fields.zip].filter(Boolean).join(" ");
    return [fields.line1, fields.line2, locality].filter(Boolean).join(", ");
  }

  function propertyAddressPresent(fields, extraAddress, setup) {
    var row = cloneFields(fields);
    return Boolean(
      row.line1 ||
        row.line2 ||
        row.city ||
        row.state ||
        row.zip ||
        trimField(extraAddress) ||
        formatPropertyLine(setup)
    );
  }

  function propertyConfigured(setupBundle) {
    return String((setupBundle && setupBundle.readiness && setupBundle.readiness.project_address) || "")
      .toLowerCase() === "confirmed";
  }

  function resolvePropertyFields(input) {
    var src = input || {};
    var setupFields = propertyFieldsFromSetup(src.setup);
    var editFields = propertyFieldsFromEdits(src.edits);
    if (src.mode === "edit" && src.domFields) return cloneFields(src.domFields);
    if (propertyFieldsComplete(editFields)) return editFields;
    if (propertyFieldsComplete(setupFields)) return setupFields;
    return {
      line1: editFields.line1 || setupFields.line1 || trimField(src.edits && src.edits.address),
      line2: editFields.line2 || setupFields.line2,
      city: editFields.city || setupFields.city,
      state: editFields.state || setupFields.state,
      zip: editFields.zip || setupFields.zip,
    };
  }

  function propertyKind(input) {
    var src = input || {};
    var fields = src.fields ? cloneFields(src.fields) : resolvePropertyFields(src);
    var configured = src.configured === true || propertyConfigured(src.setupBundle);
    var present = propertyAddressPresent(fields, src.extraAddress, src.setup || (src.setupBundle && src.setupBundle.setup));
    var complete = propertyFieldsComplete(fields);
    if (configured) return "confirmed";
    if (!present) return "missing";
    if (!complete) return "incomplete";
    return "unconfirmed";
  }

  function propertyFooterPlan(input) {
    var kind = propertyKind(input);
    var busy = Boolean(input && input.busy);
    var buttons = [];
    if (kind === "missing") {
      buttons.push({
        id: "add",
        label: "Add Project Address",
        style: "primary",
        enabled: !busy,
      });
    } else {
      buttons.push({
        id: "edit",
        label: "Edit Project Address",
        style: "ghost",
        enabled: !busy,
      });
    }
    if (kind === "unconfirmed" || kind === "incomplete") {
      buttons.push({
        id: "confirm",
        label: "Confirm Project Address",
        style: "primary",
        enabled: !busy,
      });
    }
    if (kind === "confirmed") {
      buttons.push({
        id: "continue",
        label: "Continue",
        style: "primary",
        enabled: !busy,
      });
    }
    var primaryEnabled = buttons.filter(function (btn) {
      return btn.style === "primary" && btn.enabled;
    });
    return {
      kind: kind,
      buttons: buttons,
      continueVisible: kind === "confirmed",
      continueEnabled: kind === "confirmed" && !busy,
      primaryEnabledCount: primaryEnabled.length,
      primaryLabel: primaryEnabled[0] ? primaryEnabled[0].label : "",
    };
  }

  function buildPropertyConfirmPayload(projectId, quoteId, fields) {
    var row = cloneFields(fields);
    return {
      project_id: projectId,
      quote_id: quoteId,
      property_address_line1: row.line1,
      property_address_line2: row.line2,
      property_city: row.city,
      property_state: row.state,
      property_postal_code: row.zip,
      confirm_property_address: true,
    };
  }

  function displayedAddressLines(fields) {
    var row = cloneFields(fields);
    var cityState = [row.city, row.state].filter(Boolean).join(", ");
    var locality = [cityState, row.zip].filter(Boolean).join(" ");
    return [row.line1, row.line2, locality].filter(Boolean);
  }

  function createPropertyConfirmRunner(hooks) {
    var h = hooks || {};

    function tryLock() {
      if (confirmLock) return false;
      if (typeof h.getBusy === "function" && h.getBusy()) return false;
      confirmLock = true;
      if (typeof h.setBusy === "function") h.setBusy(true);
      return true;
    }

    function unlock() {
      confirmLock = false;
      if (typeof h.setBusy === "function") h.setBusy(false);
    }

    async function confirm() {
      if (!tryLock()) {
        return { ok: false, reason: "busy", posted: false };
      }
      try {
        if (typeof h.isConfirmed === "function" && h.isConfirmed()) {
          return { ok: true, reason: "already_confirmed", posted: false };
        }
        var fields = typeof h.getFields === "function" ? cloneFields(h.getFields()) : cloneFields();
        var extra = typeof h.getExtraAddress === "function" ? h.getExtraAddress() : "";
        var setup = typeof h.getSetup === "function" ? h.getSetup() : null;
        if (!propertyAddressPresent(fields, extra, setup)) {
          return { ok: false, reason: "missing", posted: false };
        }
        var missing = propertyMissingLabels(fields);
        if (missing.length) {
          return {
            ok: false,
            reason: "incomplete",
            posted: false,
            openEdit: true,
            missing: missing,
            fields: fields,
          };
        }
        var ids = typeof h.getIds === "function" ? h.getIds() : {};
        var payload = buildPropertyConfirmPayload(ids.projectId, ids.quoteId, fields);
        if (typeof h.postJson !== "function") {
          throw new Error("postJson is required to confirm a project address.");
        }
        var res = await h.postJson(h.apiUrl || SETUP_API, payload);
        if (!res || res.ok !== true || !res.data || res.data.ok !== true || !res.data.setup) {
          return {
            ok: false,
            reason: "http",
            posted: true,
            payload: payload,
            fields: fields,
            error: trimField(res && res.data && res.data.error) || "Property address could not be saved.",
            status: res && res.status,
          };
        }
        if (typeof h.applySuccess === "function") {
          h.applySuccess(res.data, payload);
        }
        return {
          ok: true,
          reason: "confirmed",
          posted: true,
          payload: payload,
          setup: res.data.setup,
          readiness: res.data.readiness || null,
        };
      } finally {
        unlock();
      }
    }

    return {
      confirm: confirm,
      isLocked: function () {
        return confirmLock;
      },
    };
  }

  return {
    SETUP_API: SETUP_API,
    propertyFieldsFromSetup: propertyFieldsFromSetup,
    propertyFieldsFromEdits: propertyFieldsFromEdits,
    propertyMissingLabels: propertyMissingLabels,
    propertyFieldsComplete: propertyFieldsComplete,
    propertyAddressPresent: propertyAddressPresent,
    propertyConfigured: propertyConfigured,
    resolvePropertyFields: resolvePropertyFields,
    propertyKind: propertyKind,
    propertyFooterPlan: propertyFooterPlan,
    buildPropertyConfirmPayload: buildPropertyConfirmPayload,
    displayedAddressLines: displayedAddressLines,
    createPropertyConfirmRunner: createPropertyConfirmRunner,
    cloneFields: cloneFields,
  };
});
