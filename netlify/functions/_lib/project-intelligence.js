/**
 * MG-200B — Project Intelligence pure derivation (read-model only).
 * No I/O. No writes. Facts are TRUE | FALSE | UNKNOWN.
 */

const VERSION = "mg-200b-v1";
const MONEY_TOLERANCE = 0.01;

const STAGES = [
  "Lead",
  "Qualified",
  "Quote Draft",
  "Quote Sent",
  "Quote Approved",
  "Project Opened",
  "Deposit Collected",
  "Contract Ready",
  "Scheduled",
  "In Progress",
  "Progress Billing",
  "Substantial Completion",
  "Final Settled",
  "Warranty Active",
  "Closed",
];

function trim(v) {
  return String(v == null ? "" : v).trim();
}

function normStatus(v) {
  return trim(v).toLowerCase();
}

function num(v, fallback = null) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fact(state, confidence, reason, source, timestamp) {
  return {
    state,
    confidence: confidence || "medium",
    reason: reason || "",
    source: source || "",
    timestamp: timestamp || null,
  };
}

function andFacts(facts, names) {
  const list = names.map((n) => facts[n]).filter(Boolean);
  if (!list.length) return fact("UNKNOWN", "low", "No inputs", "derived");
  if (list.some((f) => f.state === "FALSE")) {
    const bad = names.find((n) => facts[n]?.state === "FALSE");
    return fact("FALSE", "high", `${bad} is FALSE`, "derived");
  }
  if (list.some((f) => f.state === "UNKNOWN")) {
    const unk = names.find((n) => facts[n]?.state === "UNKNOWN");
    return fact("UNKNOWN", "medium", `${unk} is UNKNOWN`, "derived");
  }
  return fact("TRUE", "high", `${names.join(" AND ")} are TRUE`, "derived");
}

function orFacts(facts, names) {
  const list = names.map((n) => facts[n]).filter(Boolean);
  if (!list.length) return fact("UNKNOWN", "low", "No inputs", "derived");
  if (list.some((f) => f.state === "TRUE")) {
    const ok = names.find((n) => facts[n]?.state === "TRUE");
    return fact("TRUE", facts[ok].confidence || "high", `${ok} is TRUE`, "derived");
  }
  if (list.every((f) => f.state === "FALSE")) {
    return fact("FALSE", "high", `${names.join(" AND ")} are FALSE`, "derived");
  }
  return fact("UNKNOWN", "medium", "No TRUE; at least one UNKNOWN", "derived");
}

/** Millicents ($0.001) — preserves $0.01 vs $0.011 for settlement tolerance. */
function toMilliCents(n) {
  const v = num(n, null);
  if (v == null) return null;
  return Math.round(v * 1000);
}

/** Settlement tolerance in millicents ($0.01). */
const TOLERANCE_MILLI = Math.round(MONEY_TOLERANCE * 1000);

function sumPayments(payments) {
  let totalMilli = 0;
  for (const p of Array.isArray(payments) ? payments : []) {
    const a = num(p?.amount, null);
    if (a == null) continue;
    // Net ledger: positive payments and negative adjustments/refunds both count.
    // Schema allows nonzero amounts only; there is no separate voided_at on payments.
    const milli = toMilliCents(a);
    if (milli == null) continue;
    totalMilli += milli;
  }
  return round2(totalMilli / 1000);
}

function sumPaymentsMilli(payments) {
  let totalMilli = 0;
  for (const p of Array.isArray(payments) ? payments : []) {
    const a = num(p?.amount, null);
    if (a == null) continue;
    const milli = toMilliCents(a);
    if (milli == null) continue;
    totalMilli += milli;
  }
  return totalMilli;
}

function depositLedgerPayments(payments) {
  return (Array.isArray(payments) ? payments : []).filter((p) => {
    const type = normStatus(p?.payment_type);
    const amount = num(p?.amount, 0);
    return type === "deposit" && amount > 0;
  });
}

function isTerminalInvoiceStatus(status) {
  const s = normStatus(status);
  return ["archived", "void", "cancelled", "canceled"].includes(s);
}

function isIssuedInvoiceStatus(status) {
  const s = normStatus(status);
  if (isTerminalInvoiceStatus(s)) return false;
  if (["draft", "open"].includes(s)) return false;
  return ["sent", "issued", "partial", "paid", "overdue", "unpaid", "pending"].includes(s) || Boolean(s);
}

function invoiceLabelClass(inv) {
  const label = trim(inv?.invoice_label).toLowerCase();
  const notes = trim(inv?.notes).toLowerCase();
  if (label.includes("material") || notes.includes("unexpected_material_cost")) return "material";
  if (label.includes("remaining") || label.includes("final") || label === "final payment") return "final";
  if (label.includes("progress") || label.includes("start")) return "progress";
  const type = normStatus(inv?.type);
  if (type === "final") return "final";
  return "other";
}

/**
 * @param {object} bundle - loaded domain snapshot (may include sourceErrors)
 */
function deriveProjectIntelligence(bundle) {
  const generatedAt = new Date().toISOString();
  const conflicts = [];
  const facts = {};
  const project = bundle.project || null;
  const quote = bundle.quote || null;
  const setup = bundle.setup || null;
  const schedule = bundle.schedule || null;
  const scheduleItems = Array.isArray(bundle.scheduleItems) ? bundle.scheduleItems : [];
  const notices = bundle.notices || null;
  const noticesEffective = bundle.noticesEffective || null;
  const payments = Array.isArray(bundle.payments) ? bundle.payments : [];
  const invoices = Array.isArray(bundle.invoices) ? bundle.invoices : [];
  const dayProgress = Array.isArray(bundle.dayProgress) ? bundle.dayProgress : [];
  const sourceErrors = bundle.sourceErrors || {};

  const projectId = trim(project?.id || bundle.projectId);
  const tenantId = trim(bundle.tenantId);
  const quoteId = trim(project?.quote_id || quote?.id || "");

  // --- Quote facts ---
  if (sourceErrors.quote) {
    facts.QuoteExists = fact("UNKNOWN", "low", "Quote source unavailable", "quotes", null);
    facts.QuotePublished = fact("UNKNOWN", "low", "Quote source unavailable", "quotes", null);
    facts.QuoteSent = fact("UNKNOWN", "low", "Quote source unavailable", "quotes", null);
    facts.QuoteViewed = fact("UNKNOWN", "low", "Quote source unavailable", "quotes", null);
    facts.QuoteApproved = fact("UNKNOWN", "low", "Quote source unavailable", "quotes", null);
  } else if (!quote?.id) {
    facts.QuoteExists = fact("FALSE", "high", "No quote linked to project", "quotes", null);
    facts.QuotePublished = fact("FALSE", "high", "No quote", "quotes", null);
    facts.QuoteSent = fact("FALSE", "high", "No quote", "quotes", null);
    facts.QuoteViewed = fact("FALSE", "high", "No quote", "quotes", null);
    facts.QuoteApproved = fact("FALSE", "high", "No quote", "quotes", null);
  } else {
    const st = normStatus(quote.status);
    facts.QuoteExists = fact("TRUE", "high", "Quote row exists", "quotes", quote.created_at || null);
    const hasToken = Boolean(trim(quote.public_token));
    facts.QuotePublished = hasToken
      ? fact("TRUE", "high", "public_token present", "quotes.public_token", quote.updated_at || null)
      : fact("FALSE", "high", "No public_token", "quotes.public_token", null);

    if (st === "sent") {
      facts.QuoteSent = fact("TRUE", "medium", "quotes.status=sent", "quotes.status", quote.updated_at || null);
    } else if (!hasToken) {
      facts.QuoteSent = fact("FALSE", "high", "Not published", "quotes", null);
    } else {
      facts.QuoteSent = fact(
        "UNKNOWN",
        "medium",
        "Published but send status not durably recorded",
        "quotes.status",
        null
      );
    }

    if (quote.first_view_tracked_at) {
      facts.QuoteViewed = fact(
        "TRUE",
        "high",
        "first_view_tracked_at set",
        "quotes.first_view_tracked_at",
        quote.first_view_tracked_at
      );
    } else {
      facts.QuoteViewed = fact("FALSE", "high", "No view tracked", "quotes.first_view_tracked_at", null);
    }

    if (st === "accepted" || st === "approved") {
      facts.QuoteApproved = fact(
        "TRUE",
        "high",
        `quotes.status=${st}`,
        "quotes.status",
        quote.accepted_at || quote.updated_at || null
      );
    } else {
      facts.QuoteApproved = fact("FALSE", "high", `quotes.status=${st || "empty"}`, "quotes.status", null);
    }

    if (st === "accepted" || st === "approved") {
      // ok
    } else if (st && st !== "accepted" && st !== "approved") {
      // no discrepancy
    }
  }

  // accepted/approved discrepancy: only if both signals somehow conflict — rare
  // Surface if UI-normalized paths differ: status approved vs accepted both OK — no conflict

  // --- Project ---
  if (sourceErrors.project) {
    facts.ProjectExists = fact("UNKNOWN", "low", "Project source unavailable", "tenant_projects", null);
  } else if (project?.id) {
    facts.ProjectExists = fact("TRUE", "high", "tenant_projects row exists", "tenant_projects", project.created_at || project.signed_at || null);
  } else {
    facts.ProjectExists = fact("FALSE", "high", "Project not found", "tenant_projects", null);
  }

  // --- Deposit ---
  const depositRequiredAmt = quote ? num(quote.deposit_required, null) : null;
  if (sourceErrors.quote) {
    facts.DepositRequired = fact("UNKNOWN", "low", "Quote unavailable", "quotes.deposit_required", null);
  } else if (depositRequiredAmt != null && depositRequiredAmt > 0) {
    facts.DepositRequired = fact(
      "TRUE",
      "high",
      `deposit_required=${depositRequiredAmt}`,
      "quotes.deposit_required",
      null
    );
  } else if (depositRequiredAmt === 0 || depositRequiredAmt == null) {
    // Policy: deposit mandatory for production — if required is 0/null, still DepositRequired FALSE
    // but DepositSatisfied may need collected/waived. Required FALSE means amount not set.
    facts.DepositRequired = fact(
      depositRequiredAmt === 0 ? "FALSE" : "UNKNOWN",
      depositRequiredAmt === 0 ? "high" : "medium",
      depositRequiredAmt === 0 ? "deposit_required is 0" : "deposit_required missing",
      "quotes.deposit_required",
      null
    );
  }

  const flagPaid =
    Boolean(quote?.deposit_paid_at) ||
    Boolean(project?.deposit_paid) ||
    normStatus(project?.status) === "deposit_paid" ||
    invoices.some((inv) => normStatus(inv?.payment_status) === "deposit_paid");

  let depositCollected;
  if (sourceErrors.payments) {
    depositCollected = fact("UNKNOWN", "low", "Ledger source unavailable", "tenant_project_payments", null);
  } else {
    const depRows = depositLedgerPayments(payments);
    if (depRows.length) {
      const latest = depRows[0];
      depositCollected = fact(
        "TRUE",
        "high",
        "Ledger has payment_type=deposit",
        "tenant_project_payments",
        latest.paid_at || latest.created_at || null
      );
    } else if (flagPaid) {
      depositCollected = fact(
        "UNKNOWN",
        "low",
        "Flags claim deposit paid but ledger has no deposit row",
        "quotes.deposit_paid_at|project.deposit_paid|invoices.payment_status",
        quote?.deposit_paid_at || null
      );
      conflicts.push({
        code: "deposit_flags_without_ledger",
        severity: "critical",
        message:
          "Deposit flags indicate paid, but tenant_project_payments has no qualifying deposit row.",
        winning_authority: "tenant_project_payments (ledger)",
        affected_fact: "DepositCollected",
        recommended_action: "Record or reconcile the deposit in Invoice Hub so ledger proves payment.",
      });
    } else {
      depositCollected = fact(
        "FALSE",
        "high",
        "No ledger deposit and no paid flags",
        "tenant_project_payments",
        null
      );
    }
  }
  facts.DepositCollected = depositCollected;

  // Inverse conflict: ledger deposit but flags unpaid
  if (
    !sourceErrors.payments &&
    depositLedgerPayments(payments).length &&
    quote &&
    !quote.deposit_paid_at &&
    !project?.deposit_paid &&
    normStatus(project?.status) !== "deposit_paid"
  ) {
    conflicts.push({
      code: "deposit_ledger_without_flags",
      severity: "warning",
      message: "Ledger proves a deposit payment, but quote/project deposit flags remain unpaid.",
      winning_authority: "tenant_project_payments (ledger)",
      affected_fact: "DepositCollected",
      recommended_action: "Treat deposit as collected; sync Hub flags in a later cleanup phase.",
    });
  }

  // V1 policy: no operational waiver mechanism exists yet.
  facts.DepositWaived = fact(
    "FALSE",
    "medium",
    "V1 has no durable deposit-waiver mechanism; DepositWaived is FALSE by policy until an audited waiver fact exists",
    "policy:mg-200b-v1",
    null
  );

  facts.DepositSatisfied = orFacts(facts, ["DepositCollected", "DepositWaived"]);

  // --- Contract setup ---
  if (sourceErrors.setup) {
    facts.ContractPropertyReady = fact("UNKNOWN", "low", "Setup source unavailable", "project_contract_setups", null);
    facts.ContractWarrantyReady = fact("UNKNOWN", "low", "Setup source unavailable", "project_contract_setups", null);
    facts.WarrantyTermsExist = fact("UNKNOWN", "low", "Setup source unavailable", "project_contract_setups", null);
  } else if (!setup) {
    facts.ContractPropertyReady = fact("FALSE", "high", "No contract setup row", "project_contract_setups", null);
    facts.ContractWarrantyReady = fact("FALSE", "high", "No contract setup row", "project_contract_setups", null);
    facts.WarrantyTermsExist = fact("FALSE", "high", "No warranty terms configured", "project_contract_setups", null);
  } else {
    const propOk =
      Boolean(trim(setup.property_address_line1)) &&
      Boolean(trim(setup.property_city)) &&
      Boolean(trim(setup.property_state)) &&
      Boolean(trim(setup.property_postal_code)) &&
      Boolean(setup.property_confirmed_at);
    facts.ContractPropertyReady = propOk
      ? fact("TRUE", "high", "Property confirmed", "project_contract_setups", setup.property_confirmed_at)
      : fact("FALSE", "high", "Property not confirmed", "project_contract_setups", setup.property_confirmed_at || null);

    const warOk =
      setup.warranty_duration_value != null &&
      Boolean(trim(setup.warranty_duration_unit)) &&
      Boolean(trim(setup.warranty_summary)) &&
      Boolean(trim(setup.warranty_exclusions)) &&
      Boolean(setup.warranty_confirmed_at);
    facts.ContractWarrantyReady = warOk
      ? fact("TRUE", "high", "Warranty configured and confirmed", "project_contract_setups", setup.warranty_confirmed_at)
      : fact("FALSE", "high", "Warranty not configured/confirmed", "project_contract_setups", setup.warranty_confirmed_at || null);

    facts.WarrantyTermsExist = warOk
      ? fact("TRUE", "high", "Warranty terms confirmed", "project_contract_setups", setup.warranty_confirmed_at)
      : setup.warranty_confirmed_at || trim(setup.warranty_summary)
        ? fact("FALSE", "medium", "Warranty incomplete", "project_contract_setups", null)
        : fact("FALSE", "high", "No warranty terms", "project_contract_setups", null);
  }

  // Legal notices
  if (sourceErrors.notices) {
    facts.ContractLegalNoticesReady = fact(
      "UNKNOWN",
      "low",
      "Legal notices source unavailable",
      "tenant_contract_legal_notices",
      null
    );
  } else if (noticesEffective && noticesEffective.confirmed_at) {
    facts.ContractLegalNoticesReady = fact(
      "TRUE",
      "high",
      "Confirmed legal notices snapshot present",
      "tenant_contract_legal_notices.confirmed_notices",
      noticesEffective.confirmed_at
    );
  } else if (notices && notices.confirmed_at && notices.confirmed_notices) {
    facts.ContractLegalNoticesReady = fact(
      "TRUE",
      "high",
      "confirmed_notices present",
      "tenant_contract_legal_notices",
      notices.confirmed_at
    );
  } else if (notices === null && !sourceErrors.notices) {
    facts.ContractLegalNoticesReady = fact(
      "FALSE",
      "high",
      "No legal notices row / snapshot",
      "tenant_contract_legal_notices",
      null
    );
  } else {
    facts.ContractLegalNoticesReady = fact(
      "FALSE",
      "medium",
      "Legal notices not confirmed for contracts",
      "tenant_contract_legal_notices",
      notices?.confirmed_at || null
    );
  }

  // Payment plan
  const contractTotal =
    num(schedule?.contract_total, null) ??
    num(quote?.total, null) ??
    num(project?.sale_price, null) ??
    num(project?.project_total, null);

  if (sourceErrors.schedule) {
    facts.PaymentPlanConfigured = fact(
      "UNKNOWN",
      "low",
      "Payment schedule source unavailable",
      "project_contract_payment_schedules",
      null
    );
  } else if (!schedule) {
    facts.PaymentPlanConfigured = fact(
      "FALSE",
      "high",
      "No payment schedule",
      "project_contract_payment_schedules",
      null
    );
  } else {
    const scheduledTotal = scheduleItems.reduce((s, it) => s + (num(it.amount, 0) || 0), 0);
    const scheduledCents = Math.round(round2(scheduledTotal) * 100);
    const contractCents =
      contractTotal != null ? Math.round(round2(contractTotal) * 100) : null;
    const status = normStatus(schedule.status);
    const sumMatch =
      contractCents != null && scheduledCents === contractCents && scheduleItems.length > 0;
    const configured =
      status === "confirmed" && Boolean(schedule.confirmed_at) && sumMatch;

    if (status === "confirmed" && schedule.confirmed_at && contractCents != null && !sumMatch) {
      conflicts.push({
        code: "payment_plan_sum_mismatch",
        severity: "high",
        message: "Payment schedule is confirmed but scheduled total does not match contract total.",
        winning_authority: "sum validation (scheduled vs contract total)",
        affected_fact: "PaymentPlanConfigured",
        recommended_action: "Fix payment plan amounts so they equal the contract total, then re-confirm.",
      });
      facts.PaymentPlanConfigured = fact(
        "FALSE",
        "high",
        "Confirmed but sum mismatch",
        "project_contract_payment_schedules",
        schedule.confirmed_at
      );
    } else if (configured) {
      facts.PaymentPlanConfigured = fact(
        "TRUE",
        "high",
        "Schedule confirmed and sums match",
        "project_contract_payment_schedules",
        schedule.confirmed_at
      );
    } else {
      facts.PaymentPlanConfigured = fact(
        "FALSE",
        "high",
        status === "confirmed" ? "Confirmed incomplete" : "Schedule missing or draft",
        "project_contract_payment_schedules",
        schedule.confirmed_at || null
      );
    }
  }

  facts.ContractReady = andFacts(facts, [
    "ContractPropertyReady",
    "ContractWarrantyReady",
    "ContractLegalNoticesReady",
    "PaymentPlanConfigured",
  ]);

  // Schedule / capacity — no durable confirm/reservation → UNKNOWN
  facts.ScheduleDatesConfirmed = fact(
    "UNKNOWN",
    "low",
    "No durable schedule confirmation flag; quote/project dates are not proof",
    "none",
    null
  );
  facts.CapacityReserved = fact(
    "UNKNOWN",
    "low",
    "No durable per-project capacity reservation record",
    "none",
    null
  );
  facts.ProjectScheduled = andFacts(facts, [
    "ScheduleDatesConfirmed",
    "CapacityReserved",
    "ContractReady",
    "DepositSatisfied",
  ]);

  // Supervisor / field
  if (sourceErrors.project) {
    facts.SupervisorAssigned = fact("UNKNOWN", "low", "Project unavailable", "tenant_projects.supervisor_user_id", null);
  } else if (trim(project?.supervisor_user_id)) {
    facts.SupervisorAssigned = fact(
      "TRUE",
      "high",
      "supervisor_user_id set",
      "tenant_projects.supervisor_user_id",
      project.updated_at || null
    );
  } else {
    facts.SupervisorAssigned = fact(
      "FALSE",
      "high",
      "No supervisor assigned",
      "tenant_projects.supervisor_user_id",
      null
    );
  }

  if (sourceErrors.dayProgress) {
    facts.WorkStarted = fact("UNKNOWN", "low", "Day progress unavailable", "tenant_project_day_progress", null);
    facts.WorkInProgress = fact("UNKNOWN", "low", "Day progress unavailable", "tenant_project_day_progress", null);
    facts.SubstantialCompletionReached = fact(
      "UNKNOWN",
      "low",
      "Day progress unavailable; no durable substantial-completion fact",
      "none",
      null
    );
  } else {
    const completedDays = dayProgress.filter((d) => normStatus(d?.status) === "completed");
    if (completedDays.length) {
      const first = completedDays.slice().sort((a, b) => String(a.completed_at || "").localeCompare(String(b.completed_at || "")))[0];
      facts.WorkStarted = fact(
        "TRUE",
        "high",
        "At least one day_progress completed",
        "tenant_project_day_progress",
        first?.completed_at || first?.updated_at || null
      );
    } else {
      facts.WorkStarted = fact(
        "FALSE",
        "high",
        "No completed day progress",
        "tenant_project_day_progress",
        null
      );
    }

    const statusInProgress = normStatus(project?.status) === "in_progress";
    if (statusInProgress || facts.WorkStarted.state === "TRUE") {
      facts.WorkInProgress = fact(
        "TRUE",
        statusInProgress ? "high" : "medium",
        statusInProgress ? "project.status=in_progress" : "WorkStarted is TRUE",
        statusInProgress ? "tenant_projects.status" : "derived",
        null
      );
    } else {
      facts.WorkInProgress = fact("FALSE", "medium", "Not in progress", "tenant_projects.status|day_progress", null);
    }

    // Weak heuristic only → UNKNOWN (do not claim TRUE)
    facts.SubstantialCompletionReached = fact(
      "UNKNOWN",
      "low",
      "No durable substantial-completion fact; day-count heuristic is not authoritative",
      "none",
      null
    );

    if (
      ["completed"].includes(normStatus(project?.status)) &&
      facts.WorkStarted.state === "FALSE"
    ) {
      conflicts.push({
        code: "completed_without_day_progress",
        severity: "warning",
        message: "Project status looks completed but no completed day progress was found.",
        winning_authority: "Prefer durable day progress; status alone is weak",
        affected_fact: "SubstantialCompletionReached",
        recommended_action: "Confirm field completion in Supervisor / Project Control.",
      });
    }
  }

  // Billing
  if (sourceErrors.invoices) {
    facts.ProgressInvoiceIssued = fact("UNKNOWN", "low", "Invoices unavailable", "invoices", null);
    facts.FinalInvoiceIssued = fact("UNKNOWN", "low", "Invoices unavailable", "invoices", null);
  } else {
    const active = invoices.filter((inv) => !isTerminalInvoiceStatus(inv?.status));
    const progressIssued = active.some(
      (inv) => invoiceLabelClass(inv) === "progress" && isIssuedInvoiceStatus(inv.status)
    );
    const finalIssued = active.some(
      (inv) =>
        (invoiceLabelClass(inv) === "final" || normStatus(inv?.type) === "final") &&
        isIssuedInvoiceStatus(inv.status)
    );
    // Accept-bridge DRAFT final does not count as issued
    facts.ProgressInvoiceIssued = progressIssued
      ? fact("TRUE", "medium", "Progress-class invoice issued", "invoices", null)
      : fact("FALSE", "medium", "No progress invoice issued", "invoices", null);
    facts.FinalInvoiceIssued = finalIssued
      ? fact("TRUE", "medium", "Final/remaining invoice issued", "invoices", null)
      : fact("FALSE", "medium", "No final invoice issued", "invoices", null);
  }

  let openBalance = null;
  let openBalanceMilli = null;
  if (sourceErrors.payments) {
    facts.ProjectOpenBalance = fact("UNKNOWN", "low", "Ledger unavailable", "tenant_project_payments", null);
  } else if (contractTotal == null) {
    facts.ProjectOpenBalance = fact("UNKNOWN", "low", "Contract total unavailable", "quotes.total", null);
  } else {
    const paidMilli = sumPaymentsMilli(payments);
    const contractMilli = toMilliCents(contractTotal);
    openBalanceMilli = Math.max(0, contractMilli - paidMilli);
    // Keep millicent precision (do not round2 — that collapses $0.011 → $0.01).
    openBalance = openBalanceMilli / 1000;
    facts.ProjectOpenBalance = fact(
      "TRUE",
      "high",
      `open_balance=${openBalance.toFixed(3)}`,
      "contract_total - Σ tenant_project_payments (millicents; clamped ≥ 0)",
      null
    );
  }

  const projectStatus = normStatus(project?.status);
  const looksCompleted = ["completed"].includes(projectStatus);
  if (looksCompleted && openBalanceMilli != null && openBalanceMilli > TOLERANCE_MILLI) {
    conflicts.push({
      code: "completed_with_open_balance",
      severity: "critical",
      message: `Project status is completed but open balance is $${openBalance.toFixed(2)}.`,
      winning_authority: "ProjectOpenBalance (ledger)",
      affected_fact: "FinalSettled",
      recommended_action: "Collect remaining balance in Invoice Hub before treating the job as settled.",
    });
  }

  if (openBalanceMilli == null || sourceErrors.payments || contractTotal == null) {
    facts.FinalSettled = fact(
      "UNKNOWN",
      "low",
      "Cannot reconcile final settlement from available financial sources",
      "ledger+contract_total",
      null
    );
  } else if (openBalanceMilli <= TOLERANCE_MILLI) {
    facts.FinalSettled = fact(
      "TRUE",
      "high",
      `Open balance ${Number(openBalance).toFixed(3)} ≤ ${MONEY_TOLERANCE} (millicent check)`,
      "contract_total - ledger",
      null
    );
  } else {
    facts.FinalSettled = fact(
      "FALSE",
      "high",
      `Open balance ${Number(openBalance).toFixed(3)} > ${MONEY_TOLERANCE}`,
      "contract_total - ledger",
      null
    );
  }

  // Warranty activated
  if (facts.WarrantyTermsExist.state === "FALSE") {
    facts.WarrantyActivated = fact(
      "FALSE",
      "high",
      "Warranty terms do not exist",
      "derived",
      null
    );
  } else if (facts.SubstantialCompletionReached.state === "TRUE" && facts.WarrantyTermsExist.state === "TRUE") {
    facts.WarrantyActivated = fact("TRUE", "medium", "SC AND warranty terms", "derived", null);
  } else {
    facts.WarrantyActivated = fact(
      "UNKNOWN",
      "low",
      "Substantial completion not durably proven",
      "derived",
      null
    );
    if (facts.WarrantyTermsExist.state === "TRUE") {
      conflicts.push({
        code: "warranty_terms_without_substantial_completion",
        severity: "info",
        message: "Warranty terms exist but substantial completion is not durably proven.",
        winning_authority: "SubstantialCompletionReached must be TRUE to activate warranty",
        affected_fact: "WarrantyActivated",
        recommended_action: "Confirm substantial completion when a durable field milestone exists.",
      });
    }
  }

  const archivedLike = ["archived", "cancelled", "canceled"].includes(projectStatus);
  if (sourceErrors.project) {
    facts.ProjectClosed = fact("UNKNOWN", "low", "Project unavailable", "tenant_projects.status", null);
  } else if (archivedLike) {
    if (openBalanceMilli != null && openBalanceMilli > TOLERANCE_MILLI) {
      facts.ProjectClosed = fact(
        "FALSE",
        "high",
        "Archive/cancel present but open balance blocks Closed",
        "tenant_projects.status+ledger",
        null
      );
      conflicts.push({
        code: "closed_with_open_balance",
        severity: "critical",
        message: "Project appears archived/cancelled but open balance exceeds $0.01.",
        winning_authority: "ProjectOpenBalance",
        affected_fact: "ProjectClosed",
        recommended_action: "Resolve balance before treating the project as closed.",
      });
    } else if (openBalanceMilli == null) {
      facts.ProjectClosed = fact(
        "UNKNOWN",
        "medium",
        "Archive/cancel present but balance not reconciled",
        "tenant_projects.status",
        null
      );
    } else {
      facts.ProjectClosed = fact(
        "TRUE",
        "medium",
        `status=${projectStatus} and balance settled`,
        "tenant_projects.status",
        project.updated_at || null
      );
    }
  } else if (looksCompleted) {
    facts.ProjectClosed = fact(
      "FALSE",
      "high",
      "completed status alone does not equal Closed",
      "tenant_projects.status",
      null
    );
  } else {
    facts.ProjectClosed = fact("FALSE", "high", "Not archived/cancelled", "tenant_projects.status", null);
  }

  // Lifecycle
  const lifecycle = deriveLifecycle(facts);
  const blockers = buildBlockers(facts, conflicts);
  const nextAction = pickNextAction(facts, conflicts, blockers, {
    projectId,
    quoteId,
  });

  const snapshots = {
    commercial: {
      quote_id: quoteId || null,
      quote_status: quote ? normStatus(quote.status) : null,
      quote_total: quote ? num(quote.total, null) : null,
      deposit_required: depositRequiredAmt,
      accepted_at: quote?.accepted_at || null,
    },
    contract: {
      property_confirmed_at: setup?.property_confirmed_at || null,
      warranty_confirmed_at: setup?.warranty_confirmed_at || null,
      payment_schedule_status: schedule ? normStatus(schedule.status) : null,
      payment_schedule_confirmed_at: schedule?.confirmed_at || null,
      legal_notices_confirmed_at:
        noticesEffective?.confirmed_at || notices?.confirmed_at || null,
    },
    deposit: {
      deposit_paid_at: quote?.deposit_paid_at || null,
      project_deposit_paid: project?.deposit_paid ?? null,
      project_status: projectStatus || null,
      ledger_deposit_count: depositLedgerPayments(payments).length,
      ledger_paid_total: sumPayments(payments),
    },
    schedule: {
      quote_start_date: quote?.start_date || null,
      quote_due_date: quote?.due_date || null,
      project_due_date: project?.due_date || null,
      note: "Dates shown are tentative display only; they do not prove ProjectScheduled",
    },
    field: {
      supervisor_user_id: project?.supervisor_user_id || null,
      project_status: projectStatus || null,
      completed_day_count: dayProgress.filter((d) => normStatus(d?.status) === "completed").length,
    },
    billing: {
      invoice_count: invoices.length,
      open_balance: openBalance,
      contract_total: contractTotal,
      tolerance: MONEY_TOLERANCE,
    },
    warranty: {
      terms_exist: facts.WarrantyTermsExist.state,
      activated: facts.WarrantyActivated.state,
      start_policy: "substantial_completion",
    },
  };

  return {
    version: VERSION,
    project_id: projectId,
    tenant_id: tenantId,
    generated_at: generatedAt,
    lifecycle,
    facts,
    conflicts,
    blockers,
    next_action: nextAction,
    snapshots,
  };
}

function deriveLifecycle(facts) {
  const checks = [
    ["Closed", () => facts.ProjectClosed?.state === "TRUE"],
    ["Warranty Active", () => facts.WarrantyActivated?.state === "TRUE"],
    ["Final Settled", () => facts.FinalSettled?.state === "TRUE"],
    ["Substantial Completion", () => facts.SubstantialCompletionReached?.state === "TRUE"],
    [
      "In Progress",
      () => facts.WorkStarted?.state === "TRUE" || facts.WorkInProgress?.state === "TRUE",
    ],
    ["Scheduled", () => facts.ProjectScheduled?.state === "TRUE"],
    ["Contract Ready", () => facts.ContractReady?.state === "TRUE" && facts.DepositSatisfied?.state === "TRUE"],
    ["Deposit Collected", () => facts.DepositSatisfied?.state === "TRUE" && facts.ProjectExists?.state === "TRUE"],
    ["Project Opened", () => facts.ProjectExists?.state === "TRUE"],
    ["Quote Approved", () => facts.QuoteApproved?.state === "TRUE"],
    [
      "Quote Sent",
      () =>
        facts.QuotePublished?.state === "TRUE" ||
        facts.QuoteSent?.state === "TRUE" ||
        facts.QuoteViewed?.state === "TRUE",
    ],
    ["Quote Draft", () => facts.QuoteExists?.state === "TRUE"],
  ];

  let selected = "Lead";
  for (const [name, pred] of checks) {
    if (pred()) {
      selected = name;
      break;
    }
  }

  // Progress Billing is supporting — annotate in reason if active while In Progress
  let reason = `Furthest proven stage by precedence (${checks.map((c) => c[0]).join(" > ")})`;
  if (
    selected === "In Progress" &&
    (facts.ProgressInvoiceIssued?.state === "TRUE" || facts.FinalInvoiceIssued?.state === "TRUE")
  ) {
    reason += "; Progress/Final billing is active in parallel and does not replace In Progress";
  }

  // Conservative UNKNOWN if next mandatory gate unknown
  let state = "TRUE";
  let confidence = "medium";
  const nextGateUnknown = (() => {
    if (selected === "Project Opened" && facts.DepositSatisfied?.state === "UNKNOWN") return "DepositSatisfied";
    if (selected === "Deposit Collected" && facts.ContractReady?.state === "UNKNOWN") return "ContractReady";
    if (selected === "Contract Ready" && facts.ProjectScheduled?.state === "UNKNOWN") return "ProjectScheduled";
    if (selected === "Scheduled" && facts.WorkStarted?.state === "UNKNOWN") return "WorkStarted";
    if (
      selected === "In Progress" &&
      facts.SubstantialCompletionReached?.state === "UNKNOWN"
    ) {
      return "SubstantialCompletionReached";
    }
    if (selected === "Final Settled" && facts.WarrantyActivated?.state === "UNKNOWN") {
      return "WarrantyActivated";
    }
    return null;
  })();

  if (nextGateUnknown) {
    state = "UNKNOWN";
    confidence = "low";
    reason += `; next gate ${nextGateUnknown} is UNKNOWN — not skipping forward`;
  } else if (selected === "Lead" && facts.QuoteExists?.state === "UNKNOWN") {
    state = "UNKNOWN";
    confidence = "low";
  } else {
    confidence =
      selected === "Closed" || selected === "Quote Approved" || selected === "Project Opened"
        ? "high"
        : "medium";
  }

  return {
    stage: selected,
    state,
    confidence,
    reason,
    stages_catalog: STAGES,
  };
}

function buildBlockers(facts, conflicts) {
  const blockers = [];
  for (const c of conflicts) {
    if (c.severity === "critical" || c.severity === "high") {
      blockers.push({
        code: c.code,
        message: c.message,
        fact: c.affected_fact,
      });
    }
  }
  const gateOrder = [
    ["DepositSatisfied", "Deposit is not satisfied"],
    ["ContractReady", "Contract is not ready"],
    ["ProjectScheduled", "Project is not scheduled"],
    ["SupervisorAssigned", "No supervisor assigned"],
    ["FinalSettled", "Final balance is not settled"],
  ];
  for (const [name, msg] of gateOrder) {
    if (facts[name]?.state === "FALSE") {
      blockers.push({ code: `fact_${name}_false`, message: msg, fact: name });
    } else if (facts[name]?.state === "UNKNOWN") {
      blockers.push({
        code: `fact_${name}_unknown`,
        message: `${name} cannot be proven yet`,
        fact: name,
      });
    }
  }
  // de-dupe by code
  const seen = new Set();
  return blockers.filter((b) => {
    if (seen.has(b.code)) return false;
    seen.add(b.code);
    return true;
  });
}

function pickNextAction(facts, conflicts, blockers, ids) {
  const pid = encodeURIComponent(ids.projectId || "");
  const qid = encodeURIComponent(ids.quoteId || "");
  const cb = `/contract-builder.html?project_id=${pid}&quote_id=${qid}`;
  const hub = `/estimates-invoices`;
  const pc = `/project-control`;
  const sales = `/sales`;
  const supervisor = `/supervisor`;

  const critical = conflicts.find((c) => c.severity === "critical");
  if (critical?.code === "deposit_flags_without_ledger" || facts.DepositSatisfied?.state === "UNKNOWN") {
    return {
      code: "reconcile_deposit",
      label: "Confirm whether the project deposit was recorded in Invoice Hub.",
      module: "Invoice Hub",
      deep_link: hub,
    };
  }
  if (critical?.code === "completed_with_open_balance" || critical?.code === "closed_with_open_balance") {
    return {
      code: "collect_open_balance",
      label: "Collect remaining project balance in Invoice Hub.",
      module: "Invoice Hub",
      deep_link: hub,
    };
  }
  if (facts.DepositSatisfied?.state === "FALSE" && facts.ProjectExists?.state === "TRUE") {
    return {
      code: "collect_deposit",
      label: "Collect project deposit.",
      module: "Invoice Hub",
      deep_link: hub,
    };
  }
  if (facts.ContractReady?.state === "FALSE") {
    return {
      code: "complete_contract",
      label: "Complete contract readiness (property, warranty, notices, payment plan).",
      module: "Contract Builder",
      deep_link: cb,
    };
  }
  if (facts.ContractReady?.state === "UNKNOWN") {
    return {
      code: "review_contract_readiness",
      label: "Review contract readiness — some contract sources could not be proven yet.",
      module: "Contract Builder",
      deep_link: cb,
    };
  }
  if (facts.ProjectScheduled?.state !== "TRUE") {
    return {
      code: "confirm_schedule",
      label: "Confirm schedule dates and capacity (quote dates alone are not enough).",
      module: "Scheduler",
      deep_link: pc,
    };
  }
  if (facts.SupervisorAssigned?.state === "FALSE") {
    return {
      code: "assign_supervisor",
      label: "Assign a supervisor.",
      module: "Project Control",
      deep_link: pc,
    };
  }
  if (facts.WorkStarted?.state === "FALSE") {
    return {
      code: "start_field_work",
      label: "Start field execution and record day progress.",
      module: "Supervisor",
      deep_link: supervisor,
    };
  }
  if (facts.FinalSettled?.state === "FALSE") {
    return {
      code: "settle_final",
      label: "Issue or collect the remaining balance.",
      module: "Invoice Hub",
      deep_link: hub,
    };
  }
  if (facts.SubstantialCompletionReached?.state === "UNKNOWN" && facts.WorkStarted?.state === "TRUE") {
    return {
      code: "confirm_substantial_completion",
      label: "Confirm substantial completion when field work is done.",
      module: "Supervisor",
      deep_link: supervisor,
    };
  }
  if (facts.ProjectClosed?.state === "FALSE" && facts.FinalSettled?.state === "TRUE") {
    return {
      code: "close_project",
      label: "Close the project in Project Control.",
      module: "Project Control",
      deep_link: pc,
    };
  }
  if (facts.QuoteExists?.state === "TRUE" && facts.QuoteApproved?.state === "FALSE") {
    return {
      code: "advance_quote",
      label: "Advance the quote (publish, send, or obtain approval).",
      module: "Sales",
      deep_link: sales,
    };
  }
  return {
    code: "review_project",
    label: "Review project status in Project Control.",
    module: "Project Control",
    deep_link: pc,
  };
}

module.exports = {
  VERSION,
  MONEY_TOLERANCE,
  STAGES,
  deriveProjectIntelligence,
  fact,
  andFacts,
  orFacts,
  depositLedgerPayments,
  sumPayments,
  toMilliCents,
  // test helpers
  _test: {
    normStatus,
    invoiceLabelClass,
    isIssuedInvoiceStatus,
    deriveLifecycle,
    pickNextAction,
    TOLERANCE_MILLI,
  },
};
