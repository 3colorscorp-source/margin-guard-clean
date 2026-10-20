/**
 * Shared scheduling-deposit verification for public checkout, finalize, and
 * the public estimate. Ledger row is the paid proof. Quote flags alone are not.
 * Does not create projects or invoices and does not send email.
 */
"use strict";

const DEPOSIT_PURPOSE = "project_deposit";
const PAYMENT_TYPE = "deposit";
const PAYMENT_METHOD = "stripe";

const PENDING_COPY =
  "Payment verification is pending. Please contact your contractor before paying again.";
const UNAVAILABLE_COPY =
  "Payment status could not be verified. Please refresh or contact your contractor before paying again.";
const CONFLICT_COPY =
  "This scheduling payment needs manual reconciliation. Another payment was not recorded.";
const MULTIPLE_DEPOSIT_COPY =
  "More than one scheduling payment is recorded for this estimate. Both payments were kept for reconciliation. Do not pay again.";

function depositRequiredToCents(raw) {
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const cents = Math.round(dollars * 100);
  if (!Number.isInteger(cents) || cents < 50) return null;
  return cents;
}

function amountToCents(raw) {
  const dollars = Number(raw);
  if (!Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  return Number.isInteger(cents) ? cents : null;
}

function centsToDollars(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

function idsEqual(left, right) {
  const a = String(left == null ? "" : left).trim();
  const b = String(right == null ? "" : right).trim();
  return a !== "" && a === b;
}

function isDepositRow(row) {
  return String(row?.payment_type || "").trim().toLowerCase() === PAYMENT_TYPE;
}

function hasQuotePaymentEvidence(quote) {
  if (!quote || typeof quote !== "object") return false;
  if (quote.deposit_paid === true || String(quote.deposit_paid).toLowerCase() === "true") {
    return true;
  }
  if (String(quote.deposit_paid_at || "").trim()) return true;
  const amount = Number(quote.deposit_paid_amount);
  return Number.isFinite(amount) && amount > 0;
}

function scopedProjects(projects, quote) {
  return (Array.isArray(projects) ? projects : []).filter(
    (row) =>
      idsEqual(row?.tenant_id, quote?.tenant_id) && idsEqual(row?.quote_id, quote?.id)
  );
}

function qualifyingDepositRows(payments, { tenantId, quoteId, projectId, requiredCents }) {
  return (Array.isArray(payments) ? payments : []).filter((row) => {
    if (!isDepositRow(row)) return false;
    if (!idsEqual(row.tenant_id, tenantId)) return false;
    if (!idsEqual(row.quote_id, quoteId)) return false;
    if (!idsEqual(row.project_id, projectId)) return false;
    return amountToCents(row.amount) === requiredCents;
  });
}

function schedulingEventRows(events, quote) {
  return (Array.isArray(events) ? events : []).filter((row) => {
    if (!row) return false;
    if (!idsEqual(row.tenant_id, quote?.tenant_id)) return false;
    if (!idsEqual(row.quote_id, quote?.id)) return false;
    const disposition = String(row.disposition || "").trim().toLowerCase();
    return disposition === "applied" || disposition === "needs_review";
  });
}

function isCheckoutSessionKey(value) {
  const key = String(value || "").trim();
  return key.length >= 8 && key.startsWith("cs_");
}

function isSchedulingLedgerRow(row) {
  if (!isDepositRow(row)) return false;
  if (String(row.created_by || "").trim() === "stripe-scheduling-deposit") return true;
  return (
    String(row.payment_method || "").trim().toLowerCase() === PAYMENT_METHOD &&
    isCheckoutSessionKey(row.idempotency_key)
  );
}

function appliedEventsForQuote(events, quote) {
  return schedulingEventRows(events, quote).filter(
    (row) => String(row.disposition || "").trim().toLowerCase() === "applied"
  );
}

function schedulingCreditMatches(event, payment, quote, project, requiredCents) {
  if (!event || !payment || !quote || !project) return false;
  if (!idsEqual(event.applied_payment_id, payment.id)) return false;
  if (!idsEqual(event.tenant_id, quote.tenant_id) || !idsEqual(event.quote_id, quote.id)) {
    return false;
  }
  if (!idsEqual(event.project_id, project.id)) return false;
  if (!idsEqual(payment.tenant_id, quote.tenant_id)) return false;
  if (!idsEqual(payment.quote_id, quote.id)) return false;
  if (!idsEqual(payment.project_id, project.id)) return false;
  if (!isSchedulingLedgerRow(payment)) return false;
  if (String(payment.payment_method || "").trim().toLowerCase() !== PAYMENT_METHOD) return false;
  if (!String(payment.paid_at || "").trim()) return false;
  if (!idsEqual(event.checkout_session_id, payment.idempotency_key)) return false;
  if (amountToCents(payment.amount) !== requiredCents) return false;
  if (amountToCents(event.gross_amount) !== requiredCents) return false;
  return true;
}

function unixSecondsToIso(raw) {
  const created = Number(raw);
  if (!Number.isFinite(created) || created <= 0) return "";
  const millis = created > 100000000000 ? created : created * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

/**
 * Confirmed payment time from the retrieved Checkout Session.
 * PaymentIntent.created is when Stripe created the intent, including for a
 * bank debit that succeeds days later. Charge.created can also be the pending
 * charge. The balance transaction is absent until the charge succeeds, so its
 * created time is the confirmed payment time on this evidence.
 * Returns "" when that evidence is missing. Callers must not record a deposit.
 */
function stripePaidAt(session) {
  const intent = session?.payment_intent;
  if (!intent || typeof intent !== "object") return "";
  if (String(intent.status || "").toLowerCase() !== "succeeded") return "";
  const charge = intent.latest_charge;
  if (!charge || typeof charge !== "object") return "";
  if (String(charge.status || "").toLowerCase() !== "succeeded") return "";
  const balance = charge.balance_transaction;
  if (!balance || typeof balance !== "object") return "";
  return unixSecondsToIso(balance.created);
}

/**
 * paid: one project and one verified scheduling credit, identified by the
 * applied Stripe event and its matching ledger row. A later owner deposit on
 * the same quote does not turn that credit into a duplicate. A needs_review
 * event does not remove it.
 * Without an applied event, paid still requires exactly one qualifying deposit
 * and no other deposit row.
 * pending: the applied event does not match the ledger, another Stripe
 * scheduling credit exists, a null-quote deposit makes the evidence ambiguous,
 * or there is no single project.
 * unavailable: the ledger or project read failed.
 * unpaid: one project and no payment evidence.
 * not_required: deposit_required is not a positive checkout amount.
 */
function classifySchedulingDeposit({ quote, projects, payments, events, readError }) {
  if (readError) {
    return {
      state: "unavailable",
      project: null,
      qualifying: [],
      requiredCents: null,
      copy: UNAVAILABLE_COPY,
    };
  }
  const requiredCents = depositRequiredToCents(quote?.deposit_required);
  if (requiredCents == null) {
    return {
      state: "not_required",
      project: null,
      qualifying: [],
      requiredCents: null,
      copy: "",
    };
  }
  const list = scopedProjects(projects, quote);
  const project = list.length === 1 ? list[0] : null;
  const qualifying = project
    ? qualifyingDepositRows(payments, {
        tenantId: quote.tenant_id,
        quoteId: quote.id,
        projectId: project.id,
        requiredCents,
      })
    : [];
  const reviewRows = schedulingEventRows(events, quote);
  const applied = appliedEventsForQuote(events, quote);
  const paymentRows = Array.isArray(payments) ? payments : [];
  if (project && applied.length > 1) {
    return {
      state: "pending",
      project,
      qualifying,
      requiredCents,
      copy: MULTIPLE_DEPOSIT_COPY,
      events: reviewRows,
    };
  }
  if (project && applied.length === 1) {
    const matches = paymentRows.filter((row) =>
      schedulingCreditMatches(applied[0], row, quote, project, requiredCents)
    );
    if (matches.length !== 1) {
      return {
        state: "pending",
        project,
        qualifying,
        requiredCents,
        copy: PENDING_COPY,
        events: reviewRows,
      };
    }
    const otherScheduling = paymentRows.filter(
      (row) => row !== matches[0] && isSchedulingLedgerRow(row)
    );
    const legacyNullQuote = paymentRows.filter(
      (row) =>
        isDepositRow(row) &&
        !String(row.quote_id || "").trim() &&
        idsEqual(row.tenant_id, quote.tenant_id) &&
        idsEqual(row.project_id, project.id)
    );
    if (otherScheduling.length > 0) {
      return {
        state: "pending",
        project,
        qualifying,
        requiredCents,
        copy: MULTIPLE_DEPOSIT_COPY,
        events: reviewRows,
      };
    }
    if (legacyNullQuote.length > 0) {
      return {
        state: "pending",
        project,
        qualifying,
        requiredCents,
        copy: PENDING_COPY,
        events: reviewRows,
      };
    }
    return {
      state: "paid",
      project,
      qualifying: matches,
      requiredCents,
      copy: "",
      events: reviewRows,
    };
  }
  if (project && qualifying.length === 1) {
    const extraDeposits = (Array.isArray(payments) ? payments : []).filter(
      (row) => isDepositRow(row) && !qualifying.includes(row)
    );
    if (extraDeposits.length === 0) {
      return {
        state: "paid",
        project,
        qualifying,
        requiredCents,
        copy: "",
        events: reviewRows,
      };
    }
  }
  if (project && qualifying.length > 1) {
    return {
      state: "pending",
      project,
      qualifying,
      requiredCents,
      copy: MULTIPLE_DEPOSIT_COPY,
      events: reviewRows,
    };
  }
  const evidence =
    hasQuotePaymentEvidence(quote) ||
    (Array.isArray(payments) ? payments : []).some(isDepositRow) ||
    reviewRows.length > 0;
  if (!project || evidence) {
    return {
      state: "pending",
      project,
      qualifying: [],
      requiredCents,
      copy: PENDING_COPY,
      events: reviewRows,
    };
  }
  return {
    state: "unpaid",
    project,
    qualifying: [],
    requiredCents,
    copy: "",
    events: reviewRows,
  };
}

function publicDepositFields(view) {
  const state = String(view?.state || "unavailable");
  const safeState = ["paid", "unpaid", "pending", "unavailable", "not_required"].includes(state)
    ? state
    : "unavailable";
  const message =
    safeState === "pending" || safeState === "unavailable" ? String(view?.copy || "") : "";
  return {
    deposit_verification_state: safeState,
    deposit_verification_message: message,
  };
}

function publicStep4Presentation(state, needsDeposit) {
  const verification = String(state || "").toLowerCase();
  if (!needsDeposit) {
    return { done: true, status: "Completed", offerCheckout: false, showPaid: false };
  }
  if (verification === "paid") {
    return { done: true, status: "Completed", offerCheckout: false, showPaid: true };
  }
  if (verification === "pending" || verification === "unavailable") {
    return {
      done: false,
      status: "Verification pending",
      offerCheckout: false,
      showPaid: false,
    };
  }
  if (verification === "unpaid") {
    return { done: false, status: "Current step", offerCheckout: true, showPaid: false };
  }
  return { done: false, status: "Verification pending", offerCheckout: false, showPaid: false };
}

function validatePaidCheckoutSession(session, quote, suppliedToken) {
  const paymentStatus = String(session?.payment_status || "").toLowerCase();
  if (paymentStatus !== "paid") {
    return {
      ok: false,
      status: 400,
      code: "stripe_not_paid",
      error: "Stripe session is not paid.",
    };
  }
  const meta = session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
  if (String(meta.purpose || "").trim() !== DEPOSIT_PURPOSE) {
    return {
      ok: false,
      status: 403,
      code: "stripe_purpose_mismatch",
      error: "Payment session does not match this scheduling deposit.",
    };
  }
  if (!idsEqual(meta.tenant_id, quote?.tenant_id) || !idsEqual(meta.quote_id, quote?.id)) {
    return {
      ok: false,
      status: 403,
      code: "stripe_quote_mismatch",
      error: "Payment session does not match this quote.",
    };
  }
  const metaToken = String(meta.public_token || "").trim();
  const reference = String(session?.client_reference_id || "").trim();
  const supplied = String(suppliedToken || "").trim();
  const quoteToken = String(quote?.public_token || "").trim();
  if (!metaToken || !reference || !supplied || !quoteToken) {
    return {
      ok: false,
      status: 400,
      code: "stripe_token_missing",
      error: "Payment session is missing a matching public token.",
    };
  }
  if (metaToken !== reference || metaToken !== supplied || metaToken !== quoteToken) {
    return {
      ok: false,
      status: 403,
      code: "stripe_token_mismatch",
      error: "Payment session does not match this estimate link.",
    };
  }
  if (String(session?.currency || "").toLowerCase() !== "usd") {
    return {
      ok: false,
      status: 400,
      code: "stripe_currency_mismatch",
      error: "Payment currency does not match this estimate.",
    };
  }
  const requiredCents = depositRequiredToCents(quote?.deposit_required);
  const amountTotal = Number(session?.amount_total);
  if (
    requiredCents == null ||
    !Number.isInteger(amountTotal) ||
    amountTotal !== requiredCents
  ) {
    return {
      ok: false,
      status: 400,
      code: "stripe_amount_mismatch",
      error: "Payment amount does not match the Initial Scheduling Payment.",
    };
  }
  return {
    ok: true,
    grossCents: amountTotal,
    grossAmount: centsToDollars(amountTotal),
  };
}

function preservedPaidAt(quote) {
  return String(quote?.deposit_paid_at || "").trim();
}

function quoteDepositPatch(quote, grossAmount) {
  const prior = preservedPaidAt(quote);
  return {
    deposit_paid: true,
    deposit_paid_amount: grossAmount,
    deposit_paid_at: prior || new Date().toISOString(),
  };
}

function projectDepositPatch(project, nowIso) {
  const status = String(project?.status || "").trim().toLowerCase();
  const body = {
    deposit_paid: true,
    updated_at: nowIso,
  };
  if (status === "signed") body.status = "deposit_paid";
  return body;
}

function rowMatchesVerifiedSession(row, { tenantId, quoteId, projectId, requiredCents, sessionId }) {
  if (!row) return false;
  if (String(row.idempotency_key || "") !== String(sessionId || "")) return false;
  if (String(row.payment_method || "").trim().toLowerCase() !== PAYMENT_METHOD) return false;
  return (
    qualifyingDepositRows([row], {
      tenantId,
      quoteId,
      projectId,
      requiredCents,
    }).length === 1
  );
}

async function readSchedulingDeposit(request, quote) {
  const tenantId = String(quote?.tenant_id || "").trim();
  const quoteId = String(quote?.id || "").trim();
  if (!tenantId || !quoteId) {
    return classifySchedulingDeposit({
      quote,
      projects: [],
      payments: [],
      readError: true,
    });
  }
  const tid = encodeURIComponent(tenantId);
  const qid = encodeURIComponent(quoteId);
  try {
    const flagRows = await request(
      `quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=id,tenant_id,public_token,deposit_required,deposit_paid,deposit_paid_at,deposit_paid_amount&limit=2`,
      { method: "GET" }
    );
    if (!Array.isArray(flagRows) || flagRows.length !== 1) {
      return classifySchedulingDeposit({
        quote,
        projects: [],
        payments: [],
        readError: true,
      });
    }
    const flags = { ...quote, ...flagRows[0] };
    const [projects, payments, events] = await Promise.all([
      request(
        `tenant_projects?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id,tenant_id,quote_id,status,deposit_paid&limit=5`,
        { method: "GET" }
      ),
      request(
        `tenant_project_payments?tenant_id=eq.${tid}&quote_id=eq.${qid}&payment_type=eq.deposit&select=id,tenant_id,quote_id,project_id,payment_type,payment_method,amount,paid_at,idempotency_key,created_by&limit=20`,
        { method: "GET" }
      ),
      request(
        `stripe_scheduling_deposit_events?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id,tenant_id,quote_id,project_id,checkout_session_id,disposition,gross_amount,applied_payment_id&limit=20`,
        { method: "GET" }
      ),
    ]);
    const projectList = Array.isArray(projects) ? projects : [];
    const paymentList = Array.isArray(payments) ? payments : [];
    if (projectList.length === 1 && projectList[0]?.id) {
      const legacy = await request(
        `tenant_project_payments?tenant_id=eq.${tid}&project_id=eq.${encodeURIComponent(String(projectList[0].id))}&quote_id=is.null&payment_type=eq.deposit&select=id,tenant_id,quote_id,project_id,payment_type,payment_method,amount,paid_at,idempotency_key,created_by&limit=20`,
        { method: "GET" }
      );
      if (Array.isArray(legacy)) {
        legacy.forEach((row) => {
          if (row && !paymentList.some((existing) => existing.id && existing.id === row.id)) {
            paymentList.push(row);
          }
        });
      }
    }
    const view = classifySchedulingDeposit({
      quote: flags,
      projects: projectList,
      payments: paymentList,
      events: Array.isArray(events) ? events : [],
      readError: false,
    });
    return {
      ...view,
      quote: flags,
      payments: paymentList,
      events: Array.isArray(events) ? events : [],
    };
  } catch (_err) {
    return classifySchedulingDeposit({
      quote,
      projects: [],
      payments: [],
      readError: true,
    });
  }
}

module.exports = {
  DEPOSIT_PURPOSE,
  PAYMENT_TYPE,
  PAYMENT_METHOD,
  PENDING_COPY,
  UNAVAILABLE_COPY,
  CONFLICT_COPY,
  MULTIPLE_DEPOSIT_COPY,
  depositRequiredToCents,
  centsToDollars,
  classifySchedulingDeposit,
  publicDepositFields,
  publicStep4Presentation,
  validatePaidCheckoutSession,
  preservedPaidAt,
  quoteDepositPatch,
  projectDepositPatch,
  rowMatchesVerifiedSession,
  stripePaidAt,
  readSchedulingDeposit,
  qualifyingDepositRows,
};
