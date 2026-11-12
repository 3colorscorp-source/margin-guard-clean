/**
 * Permanent contractor preview of the public quote page.
 * Survives New Quote. Logged-in Owner/Seller views do not count as the client opening the quote.
 */
(function (root) {
  "use strict";

  var KEY = "mg_contractor_quote_preview_v1";
  var BUTTON_ID = "btnContractorPreviewClientQuote";

  function sanitizeHttpUrl(raw) {
    var u = String(raw || "").trim();
    if (!/^https?:\/\//i.test(u)) return "";
    try {
      var o = new URL(u);
      if (o.protocol !== "http:" && o.protocol !== "https:") return "";
      if (!/estimate-public\.html/i.test(o.pathname)) return "";
      return o.href;
    } catch (_err) {
      return "";
    }
  }

  function load() {
    try {
      var raw = root.localStorage.getItem(KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return null;
      var publicUrl = sanitizeHttpUrl(parsed.publicUrl || parsed.public_url);
      if (!publicUrl) return null;
      return {
        publicUrl: publicUrl,
        projectName: String(parsed.projectName || "").trim().slice(0, 80),
        clientName: String(parsed.clientName || "").trim().slice(0, 80),
        sentAt: String(parsed.sentAt || "").trim(),
      };
    } catch (_err) {
      return null;
    }
  }

  function save(entry) {
    var src = entry && typeof entry === "object" ? entry : {};
    var publicUrl = sanitizeHttpUrl(src.publicUrl || src.public_url || src.publicQuoteUrl);
    if (!publicUrl) return null;
    var next = {
      publicUrl: publicUrl,
      projectName: String(src.projectName || "").trim().slice(0, 80),
      clientName: String(src.clientName || "").trim().slice(0, 80),
      sentAt: String(src.sentAt || new Date().toISOString()),
    };
    try {
      root.localStorage.setItem(KEY, JSON.stringify(next));
    } catch (_err) {
      return next;
    }
    paint();
    return next;
  }

  function openSaved() {
    var saved = load();
    if (!saved) return false;
    root.open(saved.publicUrl, "_blank", "noopener,noreferrer");
    return true;
  }

  function paint() {
    var btn = root.document && root.document.getElementById(BUTTON_ID);
    if (!btn) return;
    var saved = load();
    if (!saved) {
      btn.hidden = true;
      btn.setAttribute("aria-hidden", "true");
      return;
    }
    btn.hidden = false;
    btn.removeAttribute("aria-hidden");
    var label = saved.projectName ? "Preview client quote — " + saved.projectName : "Preview client quote";
    btn.textContent = label;
    btn.title =
      "Opens the public quote the client sees. Because you are signed in, this does not count as the client opening it.";
  }

  function bind() {
    var btn = root.document && root.document.getElementById(BUTTON_ID);
    if (!btn || btn.getAttribute("data-mg-preview-bound") === "1") {
      paint();
      return;
    }
    btn.setAttribute("data-mg-preview-bound", "1");
    btn.addEventListener("click", function () {
      if (!openSaved()) {
        window.alert("Send a quote first. Then Preview client quote stays here even after New Quote.");
      }
    });
    paint();
  }

  root.MgContractorQuotePreview = {
    KEY: KEY,
    BUTTON_ID: BUTTON_ID,
    load: load,
    save: save,
    openSaved: openSaved,
    paint: paint,
    bind: bind,
  };

  if (root.document) {
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", bind);
    } else {
      bind();
    }
  }
})(typeof window !== "undefined" ? window : this);
