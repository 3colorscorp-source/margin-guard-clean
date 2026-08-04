/**
 * CH-012E.1 — Canonical contractual Scope of Work resolver (browser).
 * Keep in sync with netlify/functions/_lib/contract-scope.js
 */
(function (root) {
  "use strict";

  var SCOPE_HEADING_RE = /^Scope of Work(?:\s+Draft)?$/i;
  var LEADING_HEADING_BLOCK_RE = /^\uFEFF?\s*Scope of Work(?:\s+Draft)?\s*(?:\r?\n)+/i;

  function normalizeNewlines(value) {
    return String(value == null ? "" : value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  function firstNonEmptyLine(text) {
    var lines = normalizeNewlines(text).split("\n");
    for (var i = 0; i < lines.length; i += 1) {
      var t = String(lines[i] || "").trim();
      if (t) return t;
    }
    return "";
  }

  function isLegacyContractualScopeNotes(notes) {
    var raw = normalizeNewlines(notes);
    if (!String(raw).trim()) return false;
    return SCOPE_HEADING_RE.test(firstNonEmptyLine(raw));
  }

  function stripLeadingScopeHeading(raw) {
    var text = normalizeNewlines(raw);
    text = text.replace(LEADING_HEADING_BLOCK_RE, "");
    var lines = text.split("\n");
    if (lines.length && SCOPE_HEADING_RE.test(String(lines[0] || "").trim())) {
      lines.shift();
      while (lines.length && String(lines[0] || "").trim() === "") lines.shift();
      text = lines.join("\n");
    }
    return text;
  }

  function pickCanonicalScopeField(input) {
    if (input == null) return "";
    if (typeof input === "string") return input;
    if (typeof input !== "object") return "";
    if (Object.prototype.hasOwnProperty.call(input, "scope_of_work")) return input.scope_of_work;
    if (Object.prototype.hasOwnProperty.call(input, "scopeOfWork")) return input.scopeOfWork;
    return "";
  }

  function pickNotesField(input) {
    if (input == null || typeof input !== "object") return "";
    if (Object.prototype.hasOwnProperty.call(input, "notes")) return input.notes;
    return "";
  }

  function resolveContractScope(quoteOrFields) {
    var canonicalRaw = normalizeNewlines(pickCanonicalScopeField(quoteOrFields));
    if (String(canonicalRaw).trim()) {
      var text = stripLeadingScopeHeading(canonicalRaw);
      if (String(text).trim()) {
        return { ok: true, text: text, source: "scope_of_work", reason: "" };
      }
      return { ok: false, text: "", source: "missing", reason: "blank_after_heading_strip" };
    }

    var notesRaw = normalizeNewlines(pickNotesField(quoteOrFields));
    if (isLegacyContractualScopeNotes(notesRaw)) {
      var legacyText = stripLeadingScopeHeading(notesRaw);
      if (String(legacyText).trim()) {
        return { ok: true, text: legacyText, source: "legacy_notes", reason: "legacy_scope_heading" };
      }
    }

    return { ok: false, text: "", source: "missing", reason: "no_trustworthy_scope" };
  }

  var SCOPE_MISSING_MESSAGE =
    "Scope of Work is missing.\n\nThis contract cannot be frozen until the approved quote contains a Scope of Work.";

  var api = {
    resolveContractScope: resolveContractScope,
    stripLeadingScopeHeading: stripLeadingScopeHeading,
    isLegacyContractualScopeNotes: isLegacyContractualScopeNotes,
    SCOPE_MISSING_MESSAGE: SCOPE_MISSING_MESSAGE,
  };

  root.MarginGuardContractScope = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
