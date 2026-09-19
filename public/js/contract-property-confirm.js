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

  var US_STATES = {
    AL: 1, AK: 1, AZ: 1, AR: 1, CA: 1, CO: 1, CT: 1, DE: 1, DC: 1, FL: 1,
    GA: 1, HI: 1, ID: 1, IL: 1, IN: 1, IA: 1, KS: 1, KY: 1, LA: 1, ME: 1,
    MD: 1, MA: 1, MI: 1, MN: 1, MS: 1, MO: 1, MT: 1, NE: 1, NV: 1, NH: 1,
    NJ: 1, NM: 1, NY: 1, NC: 1, ND: 1, OH: 1, OK: 1, OR: 1, PA: 1, RI: 1,
    SC: 1, SD: 1, TN: 1, TX: 1, UT: 1, VT: 1, VA: 1, WA: 1, WV: 1, WI: 1,
    WY: 1,
  };

  var STREET_SUFFIXES = {
    ALLEY: 1, ALY: 1, AVENUE: 1, AVE: 1, BOULEVARD: 1, BLVD: 1, CIRCLE: 1,
    CIR: 1, COURT: 1, CT: 1, COVE: 1, CV: 1, CRESCENT: 1, CRES: 1, CROSSING: 1,
    XING: 1, DRIVE: 1, DR: 1, HIGHWAY: 1, HWY: 1, HEIGHTS: 1, HTS: 1, LANE: 1,
    LN: 1, LOOP: 1, PARKWAY: 1, PKWY: 1, PASS: 1, PATH: 1, PIKE: 1, PLACE: 1,
    PL: 1, POINT: 1, PT: 1, ROAD: 1, RD: 1, ROW: 1, RUN: 1, SQUARE: 1, SQ: 1,
    STREET: 1, ST: 1, TERRACE: 1, TER: 1, TRAIL: 1, TRL: 1, WAY: 1,
  };

  function emptyFields() {
    return { line1: "", line2: "", city: "", state: "", zip: "" };
  }

  function parseUsProjectAddress(raw) {
    var original = trimField(raw).replace(/,/g, " ").replace(/\s+/g, " ");
    if (!original) {
      return { ok: false, partial: false, reason: "empty", original: "", fields: emptyFields() };
    }
    var zipMatch = original.match(/\s+(\d{5}(?:-\d{4})?)$/);
    if (!zipMatch) {
      return {
        ok: false,
        partial: false,
        reason: "no_zip",
        original: original,
        fields: { line1: original, line2: "", city: "", state: "", zip: "" },
      };
    }
    var zip = zipMatch[1];
    var beforeZip = original.slice(0, original.length - zipMatch[0].length).trim();
    var stateMatch = beforeZip.match(/\s+([A-Za-z]{2})$/);
    if (!stateMatch) {
      return {
        ok: false,
        partial: false,
        reason: "no_state",
        original: original,
        fields: { line1: original, line2: "", city: "", state: "", zip: "" },
      };
    }
    var state = stateMatch[1].toUpperCase();
    if (!US_STATES[state]) {
      return {
        ok: false,
        partial: false,
        reason: "unknown_state",
        original: original,
        fields: { line1: original, line2: "", city: "", state: "", zip: "" },
      };
    }
    var beforeState = beforeZip.slice(0, beforeZip.length - stateMatch[0].length).trim();
    if (!beforeState) {
      return {
        ok: false,
        partial: true,
        reason: "no_street_or_city",
        original: original,
        fields: { line1: "", line2: "", city: "", state: state, zip: zip },
      };
    }
    var tokens = beforeState.split(/\s+/);
    var suffixIdx = -1;
    for (var i = tokens.length - 1; i >= 0; i -= 1) {
      var token = String(tokens[i] || "").replace(/[.]/g, "").toUpperCase();
      if (STREET_SUFFIXES[token]) {
        suffixIdx = i;
        break;
      }
    }
    if (suffixIdx >= 0 && suffixIdx < tokens.length - 1) {
      return {
        ok: true,
        partial: false,
        reason: "parsed",
        original: original,
        fields: {
          line1: tokens.slice(0, suffixIdx + 1).join(" "),
          line2: "",
          city: tokens.slice(suffixIdx + 1).join(" "),
          state: state,
          zip: zip,
        },
      };
    }
    return {
      ok: false,
      partial: true,
      reason: "ambiguous_city",
      original: original,
      fields: {
        line1: beforeState,
        line2: "",
        city: "",
        state: state,
        zip: zip,
      },
    };
  }

  function looksLikeConcatenatedAddress(value) {
    return /\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/.test(trimField(value));
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
    var extra = trimField(src.extraAddress) || trimField(src.edits && src.edits.address);
    var sparse = {
      line1: editFields.line1 || setupFields.line1 || extra,
      line2: editFields.line2 || setupFields.line2,
      city: editFields.city || setupFields.city,
      state: editFields.state || setupFields.state,
      zip: editFields.zip || setupFields.zip,
    };
    if (propertyFieldsComplete(sparse)) return sparse;
    var candidate =
      extra ||
      (looksLikeConcatenatedAddress(sparse.line1) ? sparse.line1 : "");
    if (!candidate || !looksLikeConcatenatedAddress(candidate)) return sparse;
    var parsed = parseUsProjectAddress(candidate);
    if (!parsed || (!parsed.ok && !parsed.partial)) return sparse;
    var useParsedStreet = !sparse.city && !sparse.state && !sparse.zip;
    return {
      line1: useParsedStreet ? parsed.fields.line1 || sparse.line1 : sparse.line1 || parsed.fields.line1,
      line2: sparse.line2 || parsed.fields.line2,
      city: sparse.city || parsed.fields.city,
      state: sparse.state || parsed.fields.state,
      zip: sparse.zip || parsed.fields.zip,
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
    parseUsProjectAddress: parseUsProjectAddress,
    looksLikeConcatenatedAddress: looksLikeConcatenatedAddress,
    propertyKind: propertyKind,
    propertyFooterPlan: propertyFooterPlan,
    buildPropertyConfirmPayload: buildPropertyConfirmPayload,
    displayedAddressLines: displayedAddressLines,
    createPropertyConfirmRunner: createPropertyConfirmRunner,
    cloneFields: cloneFields,
  };
});
