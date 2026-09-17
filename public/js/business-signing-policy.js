/**
 * CH-084 — Business Settings contractor signature policy (browser + Node).
 *
 * GET loads the tenant row. PATCH saves only require_contractor_signature.
 * Does not GET-merge-POST, and does not send warranty/trade fields.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MarginGuardBusinessSigningPolicy = api;
  }
  if (typeof document !== "undefined") {
    api.mountBusinessSigningPolicyCard(document);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var API = "/.netlify/functions/tenant-contract-preferences";
  var SIGNING_PATCH_KEYS = ["require_contractor_signature"];

  function $(doc, id) {
    return doc.getElementById(id);
  }

  function trimValue(value) {
    return String(value == null ? "" : value).trim();
  }

  function partiesLabel(required) {
    return required ? "Contractor + Customer" : "Customer only";
  }

  function policyFromPreferences(preferences) {
    return {
      require_contractor_signature: Boolean(
        preferences && preferences.require_contractor_signature
      ),
    };
  }

  function readForm(doc) {
    var box = $(doc, "bsRequireContractorSignature");
    return {
      require_contractor_signature: Boolean(box && box.checked),
    };
  }

  function fillForm(doc, policy) {
    var box = $(doc, "bsRequireContractorSignature");
    if (box) box.checked = Boolean(policy && policy.require_contractor_signature);
    setSummary(doc, policy);
  }

  function setStatus(doc, message, kind) {
    var el = $(doc, "bsSigningPolicyStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", kind === "error");
    el.classList.toggle("is-ok", kind === "ok");
  }

  function setSummary(doc, policy) {
    var el = $(doc, "bsSigningPolicySummary");
    if (!el) return;
    var required = Boolean(policy && policy.require_contractor_signature);
    el.textContent = required
      ? "Enabled — " + partiesLabel(true) + ". The contractor signs first in Margin Guard, then the customer can be sent the signing link."
      : "Disabled — " + partiesLabel(false) + ". Only the customer is required to sign.";
  }

  function apiJson(method, body) {
    return fetch(API, {
      method: method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        return { res: res, data: data || {} };
      }).catch(function () {
        return { res: res, data: {} };
      });
    });
  }

  async function loadPolicy(doc) {
    setStatus(doc, "Loading…", "");
    try {
      var loaded = await apiJson("GET");
      if (loaded.res.status === 403) {
        setStatus(doc, (loaded.data && loaded.data.error) || "Not allowed for this role.", "error");
        return;
      }
      if (!loaded.res.ok || loaded.data.ok !== true) {
        setStatus(doc, (loaded.data && loaded.data.error) || "Could not load signing policy.", "error");
        return;
      }
      fillForm(doc, policyFromPreferences(loaded.data.preferences));
      setStatus(doc, "", "");
    } catch (err) {
      setStatus(doc, (err && err.message) || "Could not load signing policy.", "error");
    }
  }

  async function savePolicy(doc) {
    var fields = readForm(doc);
    setStatus(doc, "Saving…", "");
    try {
      var saved = await apiJson("PATCH", {
        require_contractor_signature: fields.require_contractor_signature,
      });
      if (saved.res.status === 403) {
        setStatus(doc, (saved.data && saved.data.error) || "Not allowed for this role.", "error");
        return;
      }
      if (!saved.res.ok || saved.data.ok !== true) {
        setStatus(doc, (saved.data && saved.data.error) || "Save failed.", "error");
        return;
      }
      fillForm(doc, policyFromPreferences(saved.data.preferences || fields));
      setStatus(doc, "Signing policy saved.", "ok");
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
    var saveBtn = $(doc, "btnSaveSigningPolicy");
    var reloadBtn = $(doc, "btnReloadSigningPolicy");
    var box = $(doc, "bsRequireContractorSignature");
    if (saveBtn) {
      saveBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        void savePolicy(doc);
      });
    }
    if (reloadBtn) {
      reloadBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        void loadPolicy(doc);
      });
    }
    if (box) {
      box.addEventListener("change", function () {
        setSummary(doc, readForm(doc));
      });
    }
    var pageReload = $(doc, "btnReloadBusinessSettings");
    if (pageReload) {
      pageReload.addEventListener("click", function () {
        void loadPolicy(doc);
      });
    }
  }

  function mountBusinessSigningPolicyCard(doc) {
    if (!doc || typeof doc.addEventListener !== "function") return;
    if (!$(doc, "bsSigningPolicyCard")) return;
    doc.addEventListener("DOMContentLoaded", function () {
      if (!$(doc, "bsSigningPolicyCard")) return;
      bind(doc);
      waitForAuthReady(doc).then(function () {
        void loadPolicy(doc);
      });
    });
  }

  return {
    API: API,
    SIGNING_PATCH_KEYS: SIGNING_PATCH_KEYS,
    partiesLabel: partiesLabel,
    policyFromPreferences: policyFromPreferences,
    mountBusinessSigningPolicyCard: mountBusinessSigningPolicyCard,
  };
});
