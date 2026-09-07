/**
 * Authoritative crew-schedule guard for real quote acceptance.
 * Occupancy definition is the sales capacity calendar engine (not quotes).
 */

const { supabaseRequest } = require("./supabase-admin");
const {
  computeSalesCapacityCalendar,
  loadScheduleSettingsForTenant,
  projectFinishFromStart,
  nextWorkdayOnOrAfter,
  todayYmdLocal,
  blockingProjectOverlapsPeriod,
  normDate,
} = require("./sales-capacity-calendar");
const { scheduleFieldsFromQuoteRow } = require("./operational-plan");

const SCHEDULE_CONFLICT_CODE = "schedule_conflict";
const SCHEDULE_CONFLICT_MESSAGE =
  "The proposed dates are no longer available. The company will contact you to reschedule.";
const SCHEDULE_CONFLICT_MESSAGE_ES =
  "Las fechas propuestas ya no están disponibles. La compañía se comunicará para reprogramar.";

const PUBLIC_ACCEPT_QUOTE_STATUSES = new Set(["accepted", "approved"]);

function quoteHasPublicAcceptance(quoteRow) {
  const st = String(quoteRow?.status || "")
    .trim()
    .toLowerCase();
  return PUBLIC_ACCEPT_QUOTE_STATUSES.has(st);
}

class ScheduleConflictError extends Error {
  constructor(details) {
    super(SCHEDULE_CONFLICT_MESSAGE);
    this.name = "ScheduleConflictError";
    this.code = SCHEDULE_CONFLICT_CODE;
    this.statusCode = 409;
    this.details = details && typeof details === "object" ? details : {};
  }
}

function scheduleConflictPayload(extra) {
  return {
    ok: false,
    error: SCHEDULE_CONFLICT_MESSAGE,
    error_es: SCHEDULE_CONFLICT_MESSAGE_ES,
    code: SCHEDULE_CONFLICT_CODE,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

function isScheduleConflictError(err) {
  return Boolean(
    err &&
      (err.code === SCHEDULE_CONFLICT_CODE || err.name === "ScheduleConflictError")
  );
}

function isRpcMissingError(err) {
  const msg = String(err?.message || err || "");
  return /Could not find the function|PGRST202|does not exist/i.test(msg);
}

function numDays(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveProposedOccupation(quoteRow, settings) {
  const schedule = scheduleFieldsFromQuoteRow(quoteRow);
  let start = schedule.start_date;
  let finish = schedule.due_date;
  const estimatedDays = numDays(quoteRow?.estimated_days);
  if (start && !finish && estimatedDays > 0) {
    finish = projectFinishFromStart(start, estimatedDays, settings);
  }
  if (!start) {
    start = nextWorkdayOnOrAfter(todayYmdLocal(), settings);
  }
  if (!finish) {
    finish =
      estimatedDays > 0
        ? projectFinishFromStart(start, estimatedDays, settings)
        : start;
  }
  return {
    start_date: normDate(start),
    due_date: normDate(finish),
    estimated_days: estimatedDays,
  };
}

function findBlockingPeriodOverlap(calendar, proposedStart, proposedEnd) {
  const rows = Array.isArray(calendar?.blocking_projects)
    ? calendar.blocking_projects
    : [];
  return (
    rows.find((row) => blockingProjectOverlapsPeriod(row, proposedStart, proposedEnd)) ||
    null
  );
}

/**
 * Canonical occupancy check used before confirming acceptance.
 * @param {object} quoteRow
 * @param {{ excludeProjectId?: string, computeCalendar?: Function }} [options]
 */
async function assertQuoteScheduleAvailable(quoteRow, options = {}) {
  const tenantId = String(quoteRow?.tenant_id || "").trim();
  if (!tenantId) {
    return { ok: true, skipped: true, reason: "missing_tenant" };
  }
  const excludeProjectId = String(options.excludeProjectId || "").trim();
  const compute = options.computeCalendar || computeSalesCapacityCalendar;
  const settings = options.settings || (await loadScheduleSettingsForTenant(tenantId));
  const proposed = resolveProposedOccupation(quoteRow, settings);
  const estimatedDays = Math.max(1, proposed.estimated_days || 1);
  const calendar = await compute({
    tenantId,
    estimatedDays,
    desiredStartDate: proposed.start_date,
    excludeProjectId,
    settings,
  });
  const overlap = findBlockingPeriodOverlap(
    calendar,
    proposed.start_date,
    proposed.due_date
  );
  if (overlap) {
    throw new ScheduleConflictError({
      proposed,
      conflict_project_id: overlap.project_id || overlap.id || null,
      conflict_project_name: overlap.project_name || "",
      occupation_end: overlap.occupation_end || overlap.target_finish_date || null,
    });
  }
  return { ok: true, proposed, calendar };
}

function pickProjectInsertPayload(quoteRow, proposed) {
  const projectName = String(quoteRow?.project_name || quoteRow?.title || "Project")
    .trim()
    .slice(0, 2000) || "Project";
  const salePrice = Number(quoteRow?.total);
  const price = Number.isFinite(salePrice) ? Math.round(salePrice * 100) / 100 : 0;
  const start = proposed?.start_date || scheduleFieldsFromQuoteRow(quoteRow).start_date;
  const due = proposed?.due_date || scheduleFieldsFromQuoteRow(quoteRow).due_date;
  const signedAt = start ? `${start}T12:00:00.000Z` : String(quoteRow?.accepted_at || "").trim();
  const contactId = String(quoteRow?.contact_id || "").trim();
  return {
    project_name: projectName,
    client_name: String(quoteRow?.client_name || "").trim().slice(0, 500),
    client_email: String(quoteRow?.client_email || "").trim().slice(0, 320),
    contact_id: contactId,
    signed_at: signedAt,
    due_date: due || "",
    estimated_days: Math.max(0, Number(quoteRow?.estimated_days) || 0),
    sale_price: price,
    recommended_price: price,
    minimum_price: price,
  };
}

function unwrapRpcResult(raw) {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return { ok: false, code: "invalid_rpc_result" };
  return row;
}

/**
 * Atomic accept + signed project insert. Returns rpc_missing when SQL is not applied.
 */
async function tryAtomicAcceptQuoteReservingSchedule(quoteRow, proposed) {
  const tenantId = String(quoteRow?.tenant_id || "").trim();
  const quoteId = String(quoteRow?.id || "").trim();
  if (!tenantId || !quoteId) {
    return { ok: false, code: "invalid_request" };
  }
  const occupyStart = proposed?.start_date;
  const occupyEnd = proposed?.due_date;
  if (!occupyStart || !occupyEnd) {
    return { ok: false, code: "invalid_request" };
  }
  const acceptedAt = String(quoteRow?.accepted_at || "").trim() || new Date().toISOString();
  try {
    const raw = await supabaseRequest("rpc/mg_accept_quote_reserving_schedule", {
      method: "POST",
      body: {
        p_tenant_id: tenantId,
        p_quote_id: quoteId,
        p_occupy_start: occupyStart,
        p_occupy_end: occupyEnd,
        p_accepted_at: acceptedAt,
        p_project: pickProjectInsertPayload(quoteRow, proposed),
      },
    });
    return unwrapRpcResult(raw);
  } catch (err) {
    if (isRpcMissingError(err)) {
      return { ok: false, code: "rpc_missing" };
    }
    throw err;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RESERVATION_FAILED_CODE = "reservation_failed";
const RESERVATION_FAILED_MESSAGE =
  "The estimate could not be reserved on the production schedule. Please try again or contact the company.";

function hasConfirmedReservation(result) {
  if (!result || result.ok !== true) return false;
  return UUID_RE.test(String(result.project_id || "").trim());
}

function reservationFailedPayload(extra) {
  return {
    ok: false,
    error: RESERVATION_FAILED_MESSAGE,
    code: RESERVATION_FAILED_CODE,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

async function revertQuoteAcceptance(quoteRow, previousStatus) {
  const tenantId = String(quoteRow?.tenant_id || "").trim();
  const quoteId = String(quoteRow?.id || "").trim();
  if (!tenantId || !quoteId) return { ok: false, error: "missing_ids" };
  const prior = String(
    previousStatus != null && String(previousStatus).trim()
      ? previousStatus
      : quoteRow?.status || "READY_TO_SEND"
  ).trim() || "READY_TO_SEND";
  const priorAcceptedAt = Object.prototype.hasOwnProperty.call(quoteRow || {}, "accepted_at")
    ? quoteRow.accepted_at
    : null;
  const nowIso = new Date().toISOString();
  try {
    await supabaseRequest(
      `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      {
        method: "PATCH",
        body: {
          status: prior,
          accepted_at: priorAcceptedAt,
          updated_at: nowIso,
        },
      }
    );
    return { ok: true, restored_status: prior, restored_accepted_at: priorAcceptedAt };
  } catch (err) {
    console.error("[accept-reservation] rollback failed; quote needs manual repair", {
      quote_id: quoteId,
      tenant_id: tenantId,
      error: err?.message || String(err),
    });
    return { ok: false, error: err?.message || "rollback_failed", needs_manual_repair: true };
  }
}

module.exports = {
  SCHEDULE_CONFLICT_CODE,
  SCHEDULE_CONFLICT_MESSAGE,
  SCHEDULE_CONFLICT_MESSAGE_ES,
  PUBLIC_ACCEPT_QUOTE_STATUSES,
  quoteHasPublicAcceptance,
  ScheduleConflictError,
  scheduleConflictPayload,
  isScheduleConflictError,
  isRpcMissingError,
  resolveProposedOccupation,
  findBlockingPeriodOverlap,
  assertQuoteScheduleAvailable,
  pickProjectInsertPayload,
  RESERVATION_FAILED_CODE,
  RESERVATION_FAILED_MESSAGE,
  hasConfirmedReservation,
  reservationFailedPayload,
  tryAtomicAcceptQuoteReservingSchedule,
  revertQuoteAcceptance,
};
