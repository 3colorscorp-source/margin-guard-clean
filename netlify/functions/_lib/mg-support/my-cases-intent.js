/**
 * MG-SUPPORT-003E.1 — explicit owner My Cases / support-case status intent.
 * Does not route on bare "case" or "ticket".
 * Does not steal invoice, quote, project, contract, or legal "use case" wording.
 * Does not steal "create a support case" / how-to questions.
 */
"use strict";

const { extractSupportCaseRef } = require("./my-cases");

function isMyCasesQuestion(message) {
  const original = String(message || "");
  const text = original.toLowerCase();
  if (!text) return false;
  if (/\binvoice(s)?\b/.test(text)) return false;
  if (/\b(create|how do i|how can i|how to)\b/.test(text)) return false;
  if (extractSupportCaseRef(original)) return true;
  if (/\bmy cases\b/.test(text)) return true;
  if (/\b(show|list|view|open|check|see)\b[\s\S]{0,48}\b(my\s+)?support cases?\b/.test(text)) {
    return true;
  }
  if (/\b(status|happened)\b[\s\S]{0,48}\b(my\s+)?support cases?\b/.test(text)) {
    return true;
  }
  if (
    /\b(is|did|was|has)\b[\s\S]{0,48}\b(my\s+)?support cases?\b[\s\S]{0,24}\b(resolved|open|received)\b/.test(
      text
    )
  ) {
    return true;
  }
  return false;
}

module.exports = {
  isMyCasesQuestion,
  extractSupportCaseRef,
};
