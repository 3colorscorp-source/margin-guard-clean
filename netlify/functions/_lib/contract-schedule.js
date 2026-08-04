/**
 * CH-012F — Canonical contract schedule (estimated start / completion).
 *
 * Field semantics:
 * - quotes.start_date = planned project start (Create Schedule / publish)
 * - quotes.due_date = target finish / commitment date (NOT invoice or payment due)
 * - tenant_projects.due_date = project commitment finish mirror (legacy finish fallback)
 * - target_finish_date = publish payload alias for quotes.due_date only
 * - issue_date = quote document issue date (never schedule)
 * - expiration_date = quote offer expiration (never schedule)
 *
 * Precedence:
 * 1. quotes.start_date + quotes.due_date when both persisted
 * 2. tenant_projects.due_date as legacy finish-only fallback
 * 3. otherwise missing
 */

"use strict";

/** Date-only: keep calendar YYYY-MM-DD; never Date→UTC conversion. */
function normIsoDate(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const slice = t.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(slice) ? slice : null;
}

const SOURCE_APPROVED_QUOTE = "approved_quote";
const SOURCE_APPROVED_QUOTE_PARTIAL = "approved_quote_partial";
const SOURCE_PROJECT_LEGACY = "project_legacy_due_date";
const SOURCE_BUILDER_CONFIRMED = "contract_builder_confirmed";
const SOURCE_MISSING = "missing";

/**
 * @param {{ quote?: object|null, project?: object|null }} input
 * @returns {{ start_date: string|null, due_date: string|null, source: string }}
 */
function resolveCanonicalContractSchedule(input = {}) {
  const quote = input.quote && typeof input.quote === "object" ? input.quote : null;
  const project = input.project && typeof input.project === "object" ? input.project : null;

  const quoteStart = normIsoDate(quote?.start_date ?? quote?.startDate ?? null);
  const quoteDue = normIsoDate(
    quote?.due_date ??
      quote?.target_finish_date ??
      quote?.targetFinishDate ??
      quote?.dueDate ??
      null
  );

  if (quoteStart && quoteDue) {
    return {
      start_date: quoteStart,
      due_date: quoteDue,
      source: SOURCE_APPROVED_QUOTE,
    };
  }

  if (quoteStart || quoteDue) {
    return {
      start_date: quoteStart,
      due_date: quoteDue,
      source: SOURCE_APPROVED_QUOTE_PARTIAL,
    };
  }

  // Legacy finish-only: never invent a start date from project fields.
  const projectDue = normIsoDate(project?.due_date ?? project?.dueDate ?? null);
  if (projectDue) {
    return {
      start_date: null,
      due_date: projectDue,
      source: SOURCE_PROJECT_LEGACY,
    };
  }

  return { start_date: null, due_date: null, source: SOURCE_MISSING };
}

function scheduleSourceLabel(source) {
  const s = String(source || "");
  if (s === SOURCE_APPROVED_QUOTE) return "Approved Quote";
  if (s === SOURCE_APPROVED_QUOTE_PARTIAL) return "Approved Quote (incomplete)";
  if (s === SOURCE_PROJECT_LEGACY) return "Project legacy fallback";
  if (s === SOURCE_BUILDER_CONFIRMED) return "Contract Builder confirmation";
  return "Missing";
}

function validateContractSchedule(startRaw, dueRaw) {
  const start_date = normIsoDate(startRaw);
  const due_date = normIsoDate(dueRaw);
  const errors = [];

  if (!start_date) {
    errors.push({
      code: "schedule_start_missing",
      message: "Estimated start date is required.",
    });
  }
  if (!due_date) {
    errors.push({
      code: "schedule_completion_missing",
      message: "Estimated completion date is required.",
    });
  }
  if (start_date && due_date && due_date < start_date) {
    errors.push({
      code: "schedule_completion_before_start",
      message:
        "Estimated completion date cannot be before the estimated start date.",
    });
  }

  return {
    ok: errors.length === 0,
    complete: Boolean(start_date && due_date && due_date >= start_date),
    start_date,
    due_date,
    errors,
  };
}

/**
 * Locked accepted/approved quotes: one-time fill only when BOTH dates are null.
 */
function isAuthorizedLockedScheduleFillPatch(updatedFields, quoteRow) {
  if (!Array.isArray(updatedFields) || updatedFields.length === 0) return false;
  const allowed = new Set(["start_date", "due_date"]);
  if (!updatedFields.every((f) => allowed.has(f))) return false;
  if (!(updatedFields.includes("start_date") && updatedFields.includes("due_date"))) {
    return false;
  }
  const status = String(quoteRow?.status || "")
    .trim()
    .toLowerCase();
  if (status !== "accepted" && status !== "approved") return false;
  const existingStart = normIsoDate(quoteRow?.start_date);
  const existingDue = normIsoDate(quoteRow?.due_date);
  return !existingStart && !existingDue;
}

function buildQuoteScheduleFillPatch(quoteRow, startRaw, dueRaw) {
  if (!isAuthorizedLockedScheduleFillPatch(["start_date", "due_date"], quoteRow)) {
    return { ok: false, patch: null, reason: "not_fillable" };
  }
  const validated = validateContractSchedule(startRaw, dueRaw);
  if (!validated.ok) {
    return { ok: false, patch: null, reason: "invalid", errors: validated.errors };
  }
  return {
    ok: true,
    patch: {
      start_date: validated.start_date,
      due_date: validated.due_date,
    },
  };
}

module.exports = {
  normIsoDate,
  resolveCanonicalContractSchedule,
  validateContractSchedule,
  isAuthorizedLockedScheduleFillPatch,
  buildQuoteScheduleFillPatch,
  scheduleSourceLabel,
  SOURCE_APPROVED_QUOTE,
  SOURCE_APPROVED_QUOTE_PARTIAL,
  SOURCE_PROJECT_LEGACY,
  SOURCE_BUILDER_CONFIRMED,
  SOURCE_MISSING,
};
