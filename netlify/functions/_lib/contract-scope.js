/**
 * CH-012E.1 — Canonical contractual Scope of Work resolver (server).
 *
 * Precedence:
 *   1. quotes.scope_of_work (canonical)
 *   2. legacy quotes.notes ONLY when the first non-empty line is exactly
 *      "Scope of Work" or "Scope of Work Draft" (Scope-editor convention)
 *   3. otherwise missing
 *
 * Never uses: terms, operational plan, email templates, Day N demo text.
 * Never auto-copies legacy notes into scope_of_work.
 */

"use strict";

const SCOPE_HEADING_RE = /^Scope of Work(?:\s+Draft)?$/i;
const LEADING_HEADING_BLOCK_RE = /^\uFEFF?\s*Scope of Work(?:\s+Draft)?\s*(?:\r?\n)+/i;

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function firstNonEmptyLine(text) {
  const lines = normalizeNewlines(text).split("\n");
  for (const line of lines) {
    const t = String(line || "").trim();
    if (t) return t;
  }
  return "";
}

/**
 * Documented legacy compatibility rule (read-only):
 * Accept notes as contractual Scope only when the Scope editor / Generate Scope
 * Draft convention is present as the first non-empty line:
 *   "Scope of Work" or "Scope of Work Draft"
 * Email templates (Hi/Hello/Thank you…) never match this rule.
 */
function isLegacyContractualScopeNotes(notes) {
  const raw = normalizeNewlines(notes);
  if (!String(raw).trim()) return false;
  return SCOPE_HEADING_RE.test(firstNonEmptyLine(raw));
}

/**
 * Strip only a duplicated leading section title. Never rewrite body content.
 */
function stripLeadingScopeHeading(raw) {
  let text = normalizeNewlines(raw);
  text = text.replace(LEADING_HEADING_BLOCK_RE, "");
  const lines = text.split("\n");
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
  if (Object.prototype.hasOwnProperty.call(input, "scope_of_work")) {
    return input.scope_of_work;
  }
  if (Object.prototype.hasOwnProperty.call(input, "scopeOfWork")) {
    return input.scopeOfWork;
  }
  return "";
}

function pickNotesField(input) {
  if (input == null) return "";
  if (typeof input === "string") return "";
  if (typeof input !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(input, "notes")) return input.notes;
  return "";
}

/**
 * @param {object|string|null|undefined} quoteOrFields
 * @returns {{ ok: boolean, text: string, source: 'scope_of_work'|'legacy_notes'|'missing', reason: string }}
 */
function resolveContractScope(quoteOrFields) {
  const canonicalRaw = normalizeNewlines(pickCanonicalScopeField(quoteOrFields));
  if (String(canonicalRaw).trim()) {
    const text = stripLeadingScopeHeading(canonicalRaw);
    if (String(text).trim()) {
      return { ok: true, text, source: "scope_of_work", reason: "" };
    }
    return { ok: false, text: "", source: "missing", reason: "blank_after_heading_strip" };
  }

  const notesRaw = normalizeNewlines(pickNotesField(quoteOrFields));
  if (isLegacyContractualScopeNotes(notesRaw)) {
    const text = stripLeadingScopeHeading(notesRaw);
    if (String(text).trim()) {
      return { ok: true, text, source: "legacy_notes", reason: "legacy_scope_heading" };
    }
  }

  return { ok: false, text: "", source: "missing", reason: "no_trustworthy_scope" };
}

const SCOPE_MISSING_MESSAGE =
  "Scope of Work is missing.\n\nThis contract cannot be frozen until the approved quote contains a Scope of Work.";

function isMissingScopeOfWorkColumn(errText) {
  const t = String(errText || "").toLowerCase();
  if (!/42703|column|schema cache|could not find/i.test(t)) return false;
  return /scope_of_work/.test(t);
}

/**
 * Normalize inbound write value for quotes.scope_of_work.
 * Empty / whitespace-only → null. Preserves internal line breaks and bullets.
 */
function normalizeScopeOfWorkForWrite(raw, maxLen) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  let s = normalizeNewlines(raw);
  if (!String(s).trim()) return null;
  const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 16000;
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

/**
 * Publish/write policy: only include scope_of_work when the client explicitly
 * submits scope_of_work / scopeOfWork. Email/notes/public_message never map here.
 *
 * @returns {{ include: false } | { include: true, value: string|null }}
 */
function resolveScopeOfWorkWriteFromBody(body, maxLen) {
  const input = body && typeof body === "object" ? body : {};
  const hasExplicit =
    Object.prototype.hasOwnProperty.call(input, "scope_of_work") ||
    Object.prototype.hasOwnProperty.call(input, "scopeOfWork");
  if (!hasExplicit) return { include: false };
  const raw =
    input.scope_of_work !== undefined ? input.scope_of_work : input.scopeOfWork;
  return {
    include: true,
    value: normalizeScopeOfWorkForWrite(raw, maxLen),
  };
}

/** Locked accepted-quote correction may patch scope_of_work only. */
function isAuthorizedLockedScopeOnlyPatch(updatedFields) {
  return (
    Array.isArray(updatedFields) &&
    updatedFields.length === 1 &&
    updatedFields[0] === "scope_of_work"
  );
}

module.exports = {
  resolveContractScope,
  stripLeadingScopeHeading,
  isLegacyContractualScopeNotes,
  isMissingScopeOfWorkColumn,
  normalizeScopeOfWorkForWrite,
  resolveScopeOfWorkWriteFromBody,
  isAuthorizedLockedScopeOnlyPatch,
  SCOPE_MISSING_MESSAGE,
  SCOPE_HEADING_RE,
};
