(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MgOwnerMultiAreaEntry = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var KEY = "mg_owner_multi_area_entry_v1";
  var TTL_MS = 120000;
  var ENTRY_PATH = "/sales?portal=owner";

  function storageOf(storage) {
    if (storage) return storage;
    try {
      return typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch (_err) {
      return null;
    }
  }

  function nonceOf(explicit) {
    if (explicit) return String(explicit);
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (_err) { /* keep the fallback */ }
    return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  function arm(options) {
    var opts = options || {};
    var store = storageOf(opts.storage);
    if (!store) return { ok: false, href: ENTRY_PATH };
    var now = Number.isFinite(opts.now) ? opts.now : Date.now();
    var record = { v: 1, nonce: nonceOf(opts.nonce), exp: now + TTL_MS };
    store.setItem(KEY, JSON.stringify(record));
    return { ok: true, href: ENTRY_PATH, record: record };
  }

  function authorized(opts) {
    return opts.portal === "owner" &&
      opts.authMode === "owner" &&
      opts.portalMode !== "seller-device" &&
      opts.portalMode !== "seller-blocked" &&
      opts.portalMode !== "device";
  }

  function consume(options) {
    var opts = options || {};
    var store = storageOf(opts.storage);
    if (!authorized(opts)) return { ok: false, consumed: false, reset: false };
    if (!store) return { ok: false, consumed: false, reset: false };
    var raw = store.getItem(KEY);
    store.removeItem(KEY);
    if (!raw) return { ok: true, consumed: false, reset: false };
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return { ok: false, consumed: true, reset: false };
    }
    var now = Number.isFinite(opts.now) ? opts.now : Date.now();
    var safe = parsed &&
      parsed.v === 1 &&
      typeof parsed.nonce === "string" &&
      parsed.nonce &&
      typeof parsed.exp === "number" &&
      now <= parsed.exp &&
      !Object.prototype.hasOwnProperty.call(parsed, "tenant_id") &&
      JSON.stringify(parsed).indexOf("tenant_id") === -1;
    if (!safe) return { ok: false, consumed: true, reset: false };
    return { ok: true, consumed: true, reset: true, quoteMode: "multi_area" };
  }

  return { KEY: KEY, ENTRY_PATH: ENTRY_PATH, arm: arm, consume: consume };
});
