/**
 * Closed supervisor-portal visibility answers for Support AI.
 * Built from already-safe project diagnostic facts. No extra reads.
 * OpenAI must not generate this conclusion.
 */
"use strict";

const CASE_A =
  "The project meets the requirements to appear in the Supervisor portal for the supervisor currently assigned to this project. Margin Guard Support cannot verify that the person you have in mind is the same supervisor currently assigned to the project.";

const CASE_A_PERSON_UNVERIFIED =
  "Based on the facts available to Support, the reason that person cannot see the project is not verified.";

const CASE_A_NEXT_STEP =
  "Verify the project assignment in Project Control or create a support case.";

const CASE_B =
  "The project does not currently have a supervisor assigned, so it does not meet the requirements to appear for a supervisor in the Supervisor portal.";

const CASE_C =
  "The project lifecycle state does not currently meet the Supervisor portal visibility requirements.";

const CASE_D =
  "The project's linked quote does not currently meet the accepted/approved quote requirement for Supervisor portal visibility.";

const CASE_E =
  "The project is missing more than one requirement needed for Supervisor portal visibility.";

const CASE_F =
  "Margin Guard Support could not verify all of the project visibility requirements.";

function isSupervisorVisibilityQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!/\bprojects?\b/.test(text)) return false;
  if (
    /\bquote\b/.test(text) ||
    /\bquotes\b/.test(text) ||
    /\bestimate\b/.test(text) ||
    /\bestimates\b/.test(text) ||
    /\binvoice\b/.test(text) ||
    /\binvoices\b/.test(text) ||
    /\bcontract\b/.test(text) ||
    /\bcontracts\b/.test(text)
  ) {
    return false;
  }
  if (
    /\bmy supervisor\b/.test(text) ||
    /\bsupervisor portal\b/.test(text) ||
    /\bsupervisor (see|sees|seeing)\b/.test(text) ||
    /\b(see|sees|seeing|visible|visibility)\b[\s\S]{0,48}\bsupervisor\b/.test(text) ||
    /\bsupervisor\b[\s\S]{0,48}\b(see|sees|seeing|visible|visibility|appear|show|shown)\b/.test(text)
  ) {
    return true;
  }
  return /\b(can|can't|cannot|could)\b[\s\S]{0,40}\bsee\b[\s\S]{0,40}\bprojects?\b/.test(text);
}

function asksWhyPersonCannotSee(message) {
  const text = String(message || "").toLowerCase();
  return (
    /\bwhy\b/.test(text) ||
    /\bcan'?t\b/.test(text) ||
    /\bcannot\b/.test(text) ||
    /\bdoesn'?t\b/.test(text) ||
    /\bcouldn'?t\b/.test(text) ||
    /\bnot see\b/.test(text)
  );
}

function enumerateMissingRequirements(vis) {
  const bits = [];
  if (vis.lifecycle_allows_supervisor_visibility === false) {
    bits.push("lifecycle eligibility is not met");
  }
  if (vis.approved_or_accepted_quote_present === false) {
    bits.push("an accepted or approved linked quote is not present");
  }
  if (vis.supervisor_assigned === false) {
    bits.push("no supervisor is assigned");
  }
  if (!bits.length) return CASE_E;
  return CASE_E + " " + bits.join("; ") + ".";
}

function buildSupervisorVisibilityConclusion(facts, message, diagnosticOutcome) {
  if (diagnosticOutcome === "status_unverified") {
    return CASE_F;
  }
  const vis = facts && facts.supervisor_visibility;
  if (!vis || typeof vis !== "object") return null;
  const reason = String(vis.visibility_reason || "");
  if (reason === "eligible_for_assigned_supervisor" || vis.eligible_for_assigned_supervisor === true) {
    const parts = [CASE_A];
    if (asksWhyPersonCannotSee(message)) parts.push(CASE_A_PERSON_UNVERIFIED);
    parts.push(CASE_A_NEXT_STEP);
    return parts.join(" ");
  }
  if (reason === "supervisor_not_assigned") return CASE_B;
  if (reason === "lifecycle_not_eligible") return CASE_C;
  if (reason === "quote_not_approved_or_accepted") return CASE_D;
  if (reason === "multiple_requirements_missing") return enumerateMissingRequirements(vis);
  if (reason === "status_unverified") return CASE_F;
  return null;
}

function supervisorVisibilityAnswer(intent, diagnostic, message) {
  if (intent !== "project_diagnostic") return null;
  if (!isSupervisorVisibilityQuestion(message)) return null;
  if (!diagnostic) return null;
  if (diagnostic.outcome === "status_unverified") {
    return buildSupervisorVisibilityConclusion(null, message, "status_unverified");
  }
  if (diagnostic.outcome === "ok") {
    return buildSupervisorVisibilityConclusion(diagnostic.facts, message, "ok");
  }
  return null;
}

module.exports = {
  CASE_A,
  CASE_A_PERSON_UNVERIFIED,
  CASE_A_NEXT_STEP,
  CASE_B,
  CASE_C,
  CASE_D,
  CASE_E,
  CASE_F,
  isSupervisorVisibilityQuestion,
  asksWhyPersonCannotSee,
  buildSupervisorVisibilityConclusion,
  supervisorVisibilityAnswer,
};
