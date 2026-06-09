/**
 * Owner Project Financial Detail — server-side read model (Project Control modal).
 * Pure calculations + assembly; no financial fields in Supervisor responses.
 */

const { computeProjectSnapshot, round2, num } = require("./project-snapshot");
const { computeProjectOperationalSnapshot } = require("./project-operational-snapshot");
const { normalizeQuotedLaborPlan } = require("./project-labor-plan");
const { countCompletedDays } = require("./project-day-progress");
const {
  parseOperationalPlanJsonb,
  normalizeOperationalPlan,
  planHasDays,
  laborMetricsForCompletedOperationalDays,
  laborCostFromOperationalPlan,
  computeOperationalPlanMetrics,
  computeOperationalPlanExecutionState,
  scheduledDayNumbersSet,
} = require("./operational-plan");
const { applyMigrationBaselineToMetrics } = require("./migration-baseline");
const { computeSupervisorExecutionBonus } = require("./supervisor-execution-bonus");
const { supabaseRequest } = require("./supabase-admin");

const DEFAULT_HOURS_PER_DAY = 8;
const INVOICE_SELECT =
  "id,amount,paid_amount,balance_due,status,due_date,created_at,paid_at,project_id,quote_id,project_name";

function str(v, max = 500) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function extractMgSettings(tenantSnapshotPayload) {
  const storage =
    tenantSnapshotPayload?.storage && typeof tenantSnapshotPayload.storage === "object"
      ? tenantSnapshotPayload.storage
      : {};
  const mg =
    storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
      ? storage.mg_settings_v2
      : null;
  return mg;
}

function sumReportHours(reports) {
  if (!Array.isArray(reports)) return 0;
  return round2(reports.reduce((s, r) => s + num(r?.hours, 0), 0));
}

function sumReportDays(reports) {
  if (!Array.isArray(reports)) return 0;
  return round2(reports.reduce((s, r) => s + num(r?.days, 0), 0));
}

function completedDayNumbersSet(dayProgressRows) {
  const set = new Set();
  for (const row of Array.isArray(dayProgressRows) ? dayProgressRows : []) {
    if (!row || typeof row !== "object") continue;
    const status = str(row.status, 32).toLowerCase();
    if (status !== "completed") continue;
    const dn = Math.max(1, Math.floor(num(row.day_number, 0)));
    if (dn > 0) set.add(dn);
  }
  return set;
}

function supplementalReportTotals(reports, completedDaySet, options) {
  const skipUndifferentiated = Boolean(options?.skipUndifferentiatedReports);
  let hours = 0;
  let days = 0;
  for (const r of Array.isArray(reports) ? reports : []) {
    if (!r || typeof r !== "object") continue;
    const dayRaw = r.day_number;
    const dayNum =
      dayRaw != null && dayRaw !== ""
        ? Math.max(1, Math.floor(num(dayRaw, 0)))
        : null;
    if (dayNum == null) {
      if (skipUndifferentiated) continue;
    } else if (completedDaySet.has(dayNum)) {
      continue;
    }
    hours += num(r.hours, 0);
    days += num(r.days, 0);
  }
  return { hours: round2(hours), days: round2(days) };
}

function computeSupplementalLaborCost(
  supplementalHours,
  rolePlan,
  rates,
  blendedRate,
  hasRoleBreakdown
) {
  if (supplementalHours <= 0) {
    return { cost: 0, pro_hours: 0, assistant_hours: 0 };
  }
  if (hasRoleBreakdown && !rates.role_rates_missing) {
    const planTotal = rolePlan.pro_hours + rolePlan.assistant_hours;
    let proH = 0;
    let asstH = 0;
    if (planTotal > 0) {
      proH = supplementalHours * (rolePlan.pro_hours / planTotal);
      asstH = supplementalHours * (rolePlan.assistant_hours / planTotal);
    } else {
      proH = supplementalHours;
    }
    return {
      cost: round2(proH * rates.pro_rate + asstH * rates.assistant_rate),
      pro_hours: round2(proH),
      assistant_hours: round2(asstH),
    };
  }
  if (blendedRate > 0) {
    return {
      cost: round2(supplementalHours * blendedRate),
      pro_hours: round2(supplementalHours),
      assistant_hours: 0,
    };
  }
  return { cost: 0, pro_hours: 0, assistant_hours: 0 };
}

function resolveNormalizedOperationalPlan(operationalPlanRaw, hoursPerDay) {
  const parsed = parseOperationalPlanJsonb(operationalPlanRaw);
  if (!parsed.length) return [];
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const normalized = normalizeOperationalPlan(parsed, null, hpd);
  return planHasDays(normalized) ? normalized : [];
}

function planRoleBudgetHours(quotedPlanRaw, hoursPerDay, settings) {
  const plan = normalizeQuotedLaborPlan(quotedPlanRaw, { hoursPerDay, settings });
  let proHours = 0;
  let assistantHours = 0;
  for (const w of plan) {
    const h = num(w.budget_hours, 0);
    const type = String(w.type || "").toLowerCase();
    if (type === "helper") assistantHours += h;
    else proHours += h;
  }
  return {
    plan,
    pro_hours: round2(proHours),
    assistant_hours: round2(assistantHours),
    has_role_breakdown: proHours > 0 || assistantHours > 0,
  };
}

function laborRatesFromSettings(mg) {
  const proRate = num(mg?.baseInstaller, 0);
  const assistantRate = num(mg?.baseHelper, 0);
  const roleRatesMissing = !(proRate > 0 && assistantRate > 0);
  return {
    pro_rate: round2(proRate),
    assistant_rate: round2(assistantRate),
    role_rates_missing: roleRatesMissing,
    missing: roleRatesMissing,
    missing_message: "Labor rate settings missing. Configure Business Settings.",
  };
}

/** mg_settings_v2 keys used for owner profit (Business Settings source of truth). */
function parseBusinessSettingsForOwnerProfit(mg) {
  const missing = [];
  if (!mg || typeof mg !== "object") {
    return {
      configured: false,
      missing: ["mg_settings_v2"],
      missing_message: "Configure Business Settings to finalize project profit.",
      pro_rate: null,
      assistant_rate: null,
      fica_pct: null,
      futa_pct: null,
      casui_pct: null,
      wc_pct: null,
      burden_pct_total: null,
      overhead_monthly: null,
      std_hours: null,
      overhead_per_hour: null,
      sales_commission_pct: null,
      supervisor_bonus_pct: null,
      reserve_pct: null,
      profit_pct: null,
      minimum_margin_pct: null,
      hours_per_day: DEFAULT_HOURS_PER_DAY,
      labor_rates_ok: false,
      burden_ok: false,
      overhead_ok: false,
      reserve_ok: false,
      commission_ok: false,
      supervisor_bonus_ok: false,
    };
  }

  const proRate = num(mg.baseInstaller, NaN);
  const assistantRate = num(mg.baseHelper, NaN);
  const ficaPct = num(mg.ficaPct, NaN);
  const futaPct = num(mg.futaPct, NaN);
  const casuiPct = num(mg.casuiPct, NaN);
  const wcPct = num(mg.wcPct, NaN);
  const overheadMonthly = num(mg.overheadMonthly, NaN);
  const stdHours = num(mg.stdHours, NaN);
  const salesCommissionPct = num(mg.salesCommissionPct, NaN);
  const supervisorBonusPct = num(mg.supervisorBonusPct, NaN);
  const reservePct = num(mg.reservePct, NaN);
  const profitPct = num(mg.profitPct, NaN);
  const minimumMarginPct = num(mg.minimumMarginPct, NaN);
  const hoursPerDay = num(mg.hoursPerDay, DEFAULT_HOURS_PER_DAY);

  const laborRatesOk = proRate > 0 && assistantRate > 0;
  const burdenOk =
    ficaPct > 0 &&
    wcPct > 0 &&
    Number.isFinite(futaPct) &&
    futaPct >= 0 &&
    Number.isFinite(casuiPct) &&
    casuiPct >= 0;
  const overheadOk =
    Number.isFinite(overheadMonthly) &&
    overheadMonthly >= 0 &&
    stdHours > 0;
  const reserveOk = reservePct >= 5;
  const commissionOk =
    Number.isFinite(salesCommissionPct) && salesCommissionPct >= 0;
  const supervisorBonusOk =
    Number.isFinite(supervisorBonusPct) && supervisorBonusPct >= 0;
  const targetMarginOk = Number.isFinite(profitPct) && profitPct >= 0;

  if (!(ficaPct > 0)) missing.push("ficaPct");
  if (!(wcPct > 0)) missing.push("wcPct");
  if (!Number.isFinite(futaPct) || futaPct < 0) missing.push("futaPct");
  if (!Number.isFinite(casuiPct) || casuiPct < 0) missing.push("casuiPct");
  if (!overheadOk) {
    if (!Number.isFinite(overheadMonthly) || overheadMonthly < 0) missing.push("overheadMonthly");
    if (!(stdHours > 0)) missing.push("stdHours");
  }
  if (!reserveOk) missing.push("reservePct");
  if (!commissionOk) missing.push("salesCommissionPct");
  if (!supervisorBonusOk) missing.push("supervisorBonusPct");
  if (!targetMarginOk) missing.push("profitPct");

  const burdenPctTotal = burdenOk
    ? round2(ficaPct + futaPct + casuiPct + wcPct)
    : null;
  const overheadPerHour =
    overheadOk && stdHours > 0 ? round2(overheadMonthly / stdHours) : null;

  return {
    configured: true,
    missing,
    missing_message: "Configure Business Settings to finalize project profit.",
    pro_rate: laborRatesOk ? round2(proRate) : null,
    assistant_rate: laborRatesOk ? round2(assistantRate) : null,
    fica_pct: burdenOk ? round2(ficaPct) : null,
    futa_pct: burdenOk ? round2(futaPct) : null,
    casui_pct: burdenOk ? round2(casuiPct) : null,
    wc_pct: burdenOk ? round2(wcPct) : null,
    burden_pct_total: burdenPctTotal,
    overhead_monthly: overheadOk ? round2(overheadMonthly) : null,
    std_hours: overheadOk ? round2(stdHours) : null,
    overhead_per_hour: overheadPerHour,
    sales_commission_pct: commissionOk ? round2(salesCommissionPct) : null,
    supervisor_bonus_pct: supervisorBonusOk ? round2(supervisorBonusPct) : null,
    reserve_pct: reserveOk ? round2(reservePct) : null,
    profit_pct: targetMarginOk ? round2(profitPct) : null,
    minimum_margin_pct:
      Number.isFinite(minimumMarginPct) && minimumMarginPct >= 0
        ? round2(minimumMarginPct)
        : 0,
    hours_per_day: hoursPerDay > 0 ? hoursPerDay : DEFAULT_HOURS_PER_DAY,
    labor_rates_ok: laborRatesOk,
    burden_ok: burdenOk,
    overhead_ok: overheadOk,
    reserve_ok: reserveOk,
    commission_ok: commissionOk,
    supervisor_bonus_ok: supervisorBonusOk,
  };
}

function maxPlanWorkerDays(quotedLaborPlan) {
  if (!Array.isArray(quotedLaborPlan)) return 0;
  let mx = 0;
  for (const w of quotedLaborPlan) {
    if (!w || typeof w !== "object") continue;
    mx = Math.max(mx, num(w.budget_days ?? w.days, 0));
  }
  return round2(mx);
}

function effectiveDaysForSupervisorBonus(project, operational) {
  const fromOperational = round2(num(operational?.estimated_days, 0));
  if (fromOperational > 0) return fromOperational;
  const fromPlan = maxPlanWorkerDays(project?.quoted_labor_plan);
  if (fromPlan > 0) return fromPlan;
  return round2(num(project?.estimated_days, 0));
}

function resolveLaborEstimatesFromOperationalPlan(
  opPlan,
  mgSettings,
  hpd,
  project,
  rolePlan
) {
  const planMetrics = computeOperationalPlanMetrics(opPlan, null, null, hpd);
  let estimatedLaborCost = laborCostFromOperationalPlan(opPlan, mgSettings || {});
  if (!(estimatedLaborCost > 0)) {
    estimatedLaborCost = round2(
      Math.max(num(project?.estimated_labor_cost, 0), num(project?.labor_budget, 0)) ||
        rolePlan.plan.reduce((s, w) => s + num(w.estimated_cost, 0), 0)
    );
  }
  return {
    estimatedDays: planMetrics.estimated_days,
    estimatedHours: planMetrics.estimated_hours,
    estimatedLaborCost,
  };
}

function completedScheduledDaySet(completedDaySet, scheduledSet) {
  const out = new Set();
  for (const dn of completedDaySet) {
    if (scheduledSet.has(dn)) out.add(dn);
  }
  return out;
}

function blendedHourlyRate(project, hoursPerDay) {
  const estDays = num(project?.estimated_days, 0);
  const laborBudget = num(project?.labor_budget, 0);
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  if (estDays > 0 && laborBudget > 0) {
    return round2(laborBudget / (estDays * hpd));
  }
  const estLabor = num(project?.estimated_labor_cost, 0);
  if (estDays > 0 && estLabor > 0) {
    return round2(estLabor / (estDays * hpd));
  }
  return 0;
}

/**
 * @returns {object} labor section for API
 */
function computeLaborCostSection({
  project,
  reports,
  mgSettings,
  hoursPerDay = DEFAULT_HOURS_PER_DAY,
  operationalPlanRaw,
  dayProgressRows,
}) {
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const rates = laborRatesFromSettings(mgSettings);
  const rolePlan = planRoleBudgetHours(project?.quoted_labor_plan, hpd, mgSettings || {});
  const reportedHours = sumReportHours(reports);
  const reportedDays = sumReportDays(reports);
  const completedDaySet = completedDayNumbersSet(dayProgressRows);
  const opPlan = resolveNormalizedOperationalPlan(operationalPlanRaw, hpd);
  const hasOpPlan = opPlan.length > 0;
  const useCompletedPlanDays = hasOpPlan && completedDaySet.size > 0;

  let estimatedDays = round2(
    rolePlan.plan.length
      ? Math.max(...rolePlan.plan.map((w) => num(w.budget_days, 0)), 0)
      : num(project?.estimated_days, 0)
  );
  let estimatedHours =
    rolePlan.pro_hours + rolePlan.assistant_hours > 0
      ? round2(rolePlan.pro_hours + rolePlan.assistant_hours)
      : round2(estimatedDays * hpd);
  let estimatedLaborCost = round2(
    Math.max(num(project?.estimated_labor_cost, 0), num(project?.labor_budget, 0)) ||
      rolePlan.plan.reduce((s, w) => s + num(w.estimated_cost, 0), 0)
  );

  if (hasOpPlan) {
    const planEst = resolveLaborEstimatesFromOperationalPlan(
      opPlan,
      mgSettings,
      hpd,
      project,
      rolePlan
    );
    estimatedDays = planEst.estimatedDays;
    estimatedHours = planEst.estimatedHours;
    estimatedLaborCost = planEst.estimatedLaborCost;
  }

  const base = {
    estimated: {
      hours: estimatedHours,
      days: estimatedDays,
      labor_cost: estimatedLaborCost,
    },
    actual: {
      hours: reportedHours,
      days: reportedDays,
      labor_cost: null,
      pro_hours: null,
      assistant_hours: null,
    },
    variance: {
      hours: round2(reportedHours - estimatedHours),
      days: round2(reportedDays - estimatedDays),
      cost: null,
    },
    cost_method: null,
    labor_rates_missing: false,
    labor_rates_message: null,
    pro_rate: rates.role_rates_missing ? null : rates.pro_rate,
    assistant_rate: rates.role_rates_missing ? null : rates.assistant_rate,
    blended_rate: null,
    has_role_breakdown: rolePlan.has_role_breakdown,
  };

  const blended = blendedHourlyRate(project, hpd);
  base.blended_rate = blended > 0 ? blended : null;

  if (useCompletedPlanDays) {
    if (rates.role_rates_missing) {
      base.labor_rates_missing = true;
      base.labor_rates_message = rates.missing_message;
      base.cost_method = "completed_plan_days";
      return base;
    }

    const scheduledSet = scheduledDayNumbersSet(opPlan);
    const completedScheduled = completedScheduledDaySet(completedDaySet, scheduledSet);
    const laborCompletedSet =
      completedScheduled.size > 0 ? completedScheduled : completedDaySet;

    const planMetrics = laborMetricsForCompletedOperationalDays(
      opPlan,
      laborCompletedSet,
      mgSettings || {},
      hpd
    );
    const supplemental = supplementalReportTotals(reports, laborCompletedSet, {
      skipUndifferentiatedReports: true,
    });
    const supLabor = computeSupplementalLaborCost(
      supplemental.hours,
      rolePlan,
      rates,
      blended,
      rolePlan.has_role_breakdown
    );

    const actualHours = round2(planMetrics.hours + supplemental.hours);
    const actualDays = round2(laborCompletedSet.size + supplemental.days);
    const actualCost = round2(planMetrics.labor_cost + supLabor.cost);
    const proH = round2(planMetrics.pro_hours + supLabor.pro_hours);
    const asstH = round2(planMetrics.assistant_hours + supLabor.assistant_hours);

    base.cost_method = "completed_plan_days";
    base.actual.hours = actualHours;
    base.actual.days = actualDays;
    base.actual.labor_cost = actualCost;
    base.actual.pro_hours = proH;
    base.actual.assistant_hours = asstH;
    base.variance.hours = round2(actualHours - estimatedHours);
    base.variance.days = round2(actualDays - estimatedDays);
    base.variance.cost = round2(actualCost - estimatedLaborCost);
    return base;
  }

  let actualCost = 0;
  let proH = 0;
  let asstH = 0;
  let method = "legacy_fallback";

  if (rolePlan.has_role_breakdown) {
    if (rates.role_rates_missing) {
      base.labor_rates_missing = true;
      base.labor_rates_message = rates.missing_message;
      base.cost_method = "legacy_fallback";
      return base;
    }
    const planTotal = rolePlan.pro_hours + rolePlan.assistant_hours;
    if (reportedHours > 0 && planTotal > 0) {
      method = "field_reports";
      proH = reportedHours * (rolePlan.pro_hours / planTotal);
      asstH = reportedHours * (rolePlan.assistant_hours / planTotal);
    } else if (reportedHours > 0) {
      method = "field_reports";
      proH = reportedHours;
    } else {
      method = "quoted_labor_plan_fallback";
      proH = rolePlan.pro_hours;
      asstH = rolePlan.assistant_hours;
    }
    actualCost = proH * rates.pro_rate + asstH * rates.assistant_rate;
  } else if (reportedHours > 0) {
    if (blended <= 0) {
      base.cost_method = "legacy_fallback";
      base.labor_rates_missing = true;
      base.labor_rates_message =
        "Labor rate settings missing. Configure Business Settings.";
      return base;
    }
    method = "field_reports";
    proH = reportedHours;
    actualCost = reportedHours * blended;
  } else if (blended <= 0) {
    base.cost_method = "legacy_fallback";
    base.labor_rates_missing = true;
    base.labor_rates_message =
      "Labor rate settings missing. Configure Business Settings.";
    return base;
  } else {
    method = "legacy_fallback";
    proH = reportedHours;
    actualCost = reportedHours * blended;
  }

  base.cost_method = method;
  base.actual.labor_cost = round2(actualCost);
  base.actual.pro_hours = round2(proH);
  base.actual.assistant_hours = round2(asstH);
  base.variance.cost = round2(actualCost - estimatedLaborCost);
  return base;
}

function sumAppliedChangeOrders(changeOrders) {
  if (!Array.isArray(changeOrders)) return 0;
  return round2(
    changeOrders.reduce((s, row) => {
      const st = String(row?.status || "")
        .trim()
        .toLowerCase();
      if (st !== "applied") return s;
      return s + Math.max(0, num(row.client_price, 0));
    }, 0)
  );
}

function sumExpenseAmounts(expenses) {
  if (!Array.isArray(expenses)) return 0;
  return round2(expenses.reduce((s, r) => s + num(r?.amount, 0), 0));
}

/** Same ledger rollup as list-tenant-invoices (read-only). */
async function sumLedgerPaidByInvoiceId(tenantId, invoiceIds) {
  const sums = new Map();
  const ids = Array.from(
    new Set((invoiceIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  if (!ids.length) return sums;
  const tid = encodeURIComponent(String(tenantId));
  const chunkSize = 40;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const inList = chunk.map((id) => encodeURIComponent(id)).join(",");
    const rows = await supabaseRequest(
      `tenant_project_payments?tenant_id=eq.${tid}&invoice_id=in.(${inList})&select=invoice_id,amount,paid_at,created_at`,
      { method: "GET" }
    );
    const list = Array.isArray(rows) ? rows : [];
    for (const p of list) {
      const iid = p?.invoice_id != null ? String(p.invoice_id).trim() : "";
      if (!iid) continue;
      sums.set(iid, round2((sums.get(iid) || 0) + num(p.amount, 0)));
    }
  }
  return sums;
}

function invoiceStatusSummary(invoices) {
  if (!Array.isArray(invoices) || !invoices.length) {
    return { label: "No invoice on file", last_payment_date: null };
  }
  const sorted = [...invoices].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  const latest = sorted[0];
  const st = String(latest.status || "")
    .trim()
    .toLowerCase();
  let label = `Invoice ${st.replace(/_/g, " ")}`;
  if (st === "paid") label = "Paid";
  else if (st === "partial") label = "Partially paid";
  else if (st === "sent" || st === "issued") label = "Sent · unpaid";
  else if (st === "draft") label = "Draft";
  else if (st === "overdue") label = "Overdue";
  return { label, latest_invoice_id: latest.id || null };
}

function applyDayProgressToOperationalMetrics(metrics, dayProgressRows) {
  const out = { ...(metrics && typeof metrics === "object" ? metrics : {}) };
  const completedCount = countCompletedDays(dayProgressRows);
  if (completedCount <= 0) return out;
  const reportDays = num(out.actual_days, 0);
  const effectiveDays = Math.max(reportDays, completedCount);
  out.actual_days = round2(effectiveDays);
  const est = num(out.estimated_days, 0);
  if (est > 0) {
    out.days_remaining = round2(Math.max(0, est - effectiveDays));
    out.completion_pace_pct = Math.round((effectiveDays / est) * 100);
    const dev = effectiveDays - est;
    out.labor_deviation_days = round2(dev);
    if (Math.abs(dev) < 0.01) out.labor_deviation_label = "On budget";
    else if (dev > 0) {
      out.labor_deviation_label = `${dev.toFixed(2)} day(s) over budget`;
    } else {
      out.labor_deviation_label = `${Math.abs(dev).toFixed(2)} day(s) under budget`;
    }
  }
  out.completed_days_from_progress = completedCount;
  out.progress_source = "day_progress";
  return out;
}

function applyPlanExecutionToOperationalMetrics(op, planExec, reportDays) {
  const out = { ...(op && typeof op === "object" ? op : {}) };
  out.estimated_days = planExec.estimated_days;
  out.estimated_hours = planExec.estimated_hours;
  out.completed_days = planExec.completed_days;
  out.completed_scheduled_days = planExec.completed_scheduled_days;
  out.over_scheduled_days = planExec.over_scheduled_days;
  out.days_remaining = planExec.days_remaining;
  out.completion_pace_pct = planExec.completion_pace_pct;
  out.progress_source = planExec.progress_source;
  out.actual_days = round2(Math.max(num(reportDays, 0), planExec.completed_days));
  const dev = round2(planExec.completed_scheduled_days - planExec.estimated_days);
  out.labor_deviation_days = dev;
  if (Math.abs(dev) < 0.01) out.labor_deviation_label = "On budget";
  else if (dev > 0) {
    out.labor_deviation_label = `${dev.toFixed(2)} day(s) over budget`;
  } else {
    out.labor_deviation_label = `${Math.abs(dev).toFixed(2)} day(s) under budget`;
  }
  return out;
}

/**
 * Align operational progress with Supervisor: day_progress > migration+reports > reports.
 * When operational_plan exists, scheduled days and progress come from the plan day count.
 */
function computeFinancialOperationalState({
  project,
  reports,
  expenses,
  dayProgressRows,
  migrationBaseline,
  supervisorBonusPct = 1,
  hoursPerDay = DEFAULT_HOURS_PER_DAY,
  operationalPlanRaw,
}) {
  let op = computeProjectOperationalSnapshot({
    project,
    reports,
    expenses,
    supervisorBonusPctPoints: supervisorBonusPct,
    hoursPerDay,
  });

  if (migrationBaseline) {
    op = applyMigrationBaselineToMetrics(op, migrationBaseline, reports);
  }

  const reportDays = num(op.actual_days, 0);
  const opPlan = resolveNormalizedOperationalPlan(operationalPlanRaw, hoursPerDay);
  const planExec =
    opPlan.length > 0
      ? computeOperationalPlanExecutionState(opPlan, dayProgressRows, hoursPerDay)
      : null;

  if (planExec) {
    return applyPlanExecutionToOperationalMetrics(op, planExec, reportDays);
  }

  const completedFromProgress = countCompletedDays(dayProgressRows);
  const estDays = num(op.estimated_days, 0);

  if (completedFromProgress > 0 && estDays > 0) {
    op.completed_days = completedFromProgress;
    op.days_spent = round2(Math.max(num(op.actual_days, 0), completedFromProgress));
    op.days_remaining = round2(Math.max(0, estDays - completedFromProgress));
    op.completion_pace_pct = Math.round((completedFromProgress / estDays) * 100);
    op.progress_source = "day_progress";
    op.over_scheduled_days = completedFromProgress > estDays;
    const dev = completedFromProgress - estDays;
    op.labor_deviation_days = round2(dev);
    if (Math.abs(dev) < 0.01) op.labor_deviation_label = "On budget";
    else if (dev > 0) {
      op.labor_deviation_label = `${dev.toFixed(2)} day(s) over budget`;
    } else {
      op.labor_deviation_label = `${Math.abs(dev).toFixed(2)} day(s) under budget`;
    }
  } else {
    op = applyDayProgressToOperationalMetrics(op, dayProgressRows);
    if (!op.progress_source && completedFromProgress > 0) {
      op.progress_source = "day_progress";
    }
    if (!op.progress_source && migrationBaseline) {
      op.progress_source = "migration_baseline";
    }
    if (!op.progress_source) op.progress_source = "field_reports";
    op.completed_days = completedFromProgress || countCompletedDays(dayProgressRows);
    if (op.over_scheduled_days == null) {
      op.over_scheduled_days =
        estDays > 0 && num(op.completed_days, 0) > estDays;
    }
  }

  return op;
}

function deriveCompletionStatusSuggestion({ progressPct, completedDays, estimatedDays, balanceDue }) {
  const pct = num(progressPct, 0);
  const est = num(estimatedDays, 0);
  const completed = num(completedDays, 0);
  const bal = num(balanceDue, 0);
  const workComplete =
    (est > 0 && completed >= est) || pct >= 100;

  if (workComplete && bal <= 0.01) {
    return { label: "Ready to close", tone: "green" };
  }
  if (workComplete && bal > 0.01) {
    return { label: "Work complete — balance still due", tone: "amber" };
  }
  return null;
}

function buildCollectionSection({
  project,
  invoices,
  payments,
  changeOrders,
  ledgerPaidByInvoiceId,
}) {
  const originalContract = round2(Math.max(0, num(project?.sale_price, 0)));
  const approvedChangeOrders = sumAppliedChangeOrders(changeOrders);
  const storedRev = num(project?.projected_revenue_total, NaN);
  const currentContractTotal =
    Number.isFinite(storedRev) && storedRev > 0
      ? round2(storedRev)
      : round2(originalContract + approvedChangeOrders);

  const ledgerMap =
    ledgerPaidByInvoiceId instanceof Map ? ledgerPaidByInvoiceId : new Map();

  let totalInvoiced = 0;
  let paidToDate = 0;
  for (const inv of invoices || []) {
    const amt = num(inv.amount, 0);
    const iid = inv?.id != null ? String(inv.id).trim() : "";
    const ledgerPaid = iid ? num(ledgerMap.get(iid), 0) : 0;
    const paid = round2(Math.max(num(inv.paid_amount, 0), ledgerPaid));
    totalInvoiced += amt;
    paidToDate += paid;
  }
  totalInvoiced = round2(totalInvoiced);
  paidToDate = round2(paidToDate);

  const paymentRows = Array.isArray(payments) ? payments : [];
  const ledgerPaymentTotal = round2(
    paymentRows.reduce((s, p) => s + num(p.amount, 0), 0)
  );
  if (ledgerPaymentTotal > paidToDate) paidToDate = ledgerPaymentTotal;

  const balanceDue = round2(Math.max(0, currentContractTotal - paidToDate));

  const lastPay = paymentRows
    .map((p) => p.paid_at || p.created_at)
    .filter(Boolean)
    .sort()
    .pop();

  const invStatus = invoiceStatusSummary(invoices);

  let invoice_data_note = null;
  if (!invoices || !invoices.length) {
    if (paidToDate > 0) {
      invoice_data_note =
        "No invoice rows linked by project_id or quote_id; paid total from payment ledger records.";
    } else {
      invoice_data_note = "Invoice data not linked to this project";
    }
  }

  return {
    original_contract: originalContract,
    approved_change_orders: approvedChangeOrders,
    current_contract_total: currentContractTotal,
    total_invoiced: totalInvoiced,
    paid_to_date: paidToDate,
    balance_due: balanceDue,
    invoice_status: invStatus.label,
    last_payment_date: lastPay ? String(lastPay).slice(0, 10) : null,
    invoice_data_note,
    invoices_linked: (invoices || []).length,
  };
}

/** Load invoices the same way Invoice Hub lists them — project_id, then quote_id, then exact project_name. */
async function loadInvoicesForProject(tenantId, project) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(project.id));
  const select = INVOICE_SELECT;

  let rows = await supabaseRequest(
    `invoices?tenant_id=eq.${tid}&project_id=eq.${pid}&select=${select}&order=created_at.desc`
  );
  let list = Array.isArray(rows) ? rows : [];

  if (!list.length && project.quote_id) {
    const qid = encodeURIComponent(String(project.quote_id));
    rows = await supabaseRequest(
      `invoices?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=${select}&order=created_at.desc`
    );
    list = Array.isArray(rows) ? rows : [];
  }

  if (!list.length && project.project_name) {
    const pname = encodeURIComponent(String(project.project_name).trim());
    rows = await supabaseRequest(
      `invoices?tenant_id=eq.${tid}&project_name=eq.${pname}&select=${select}&order=created_at.desc`
    );
    list = Array.isArray(rows) ? rows : [];
  }

  return list;
}

async function loadPaymentsForProject(tenantId, project, invoiceIds) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(project.id));
  const seen = new Set();
  const out = [];

  const pushRows = (rows) => {
    for (const p of Array.isArray(rows) ? rows : []) {
      const key = [
        p?.id,
        p?.invoice_id,
        p?.paid_at,
        p?.created_at,
        p?.amount,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  };

  pushRows(
    await supabaseRequest(
      `tenant_project_payments?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id,amount,paid_at,created_at,invoice_id&order=paid_at.desc`
    )
  );

  if (project.quote_id) {
    const qid = encodeURIComponent(String(project.quote_id));
    pushRows(
      await supabaseRequest(
        `tenant_project_payments?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=id,amount,paid_at,created_at,invoice_id&order=paid_at.desc`
      )
    );
  }

  const ids = Array.from(
    new Set((invoiceIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  const chunkSize = 40;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const inList = chunk.map((id) => encodeURIComponent(id)).join(",");
    pushRows(
      await supabaseRequest(
        `tenant_project_payments?tenant_id=eq.${tid}&invoice_id=in.(${inList})&select=id,amount,paid_at,created_at,invoice_id&order=paid_at.desc`
      )
    );
  }

  return out;
}

function ownerProfitLine(label, amount, status, note) {
  return {
    label,
    amount: amount == null ? null : round2(amount),
    status: status || (amount == null ? "not_configured" : "calculated"),
    note: note || null,
  };
}

function deriveOwnerRiskLabel({ profitIncomplete, marginPct, bs }) {
  if (profitIncomplete || marginPct == null) {
    return { risk_label: "Incomplete", margin_risk: "incomplete" };
  }
  const target = num(bs.profit_pct, 0);
  const minimum = num(bs.minimum_margin_pct, 0);
  if (marginPct >= target) {
    return { risk_label: "Good", margin_risk: "low" };
  }
  if (marginPct >= minimum) {
    return { risk_label: "Watch", margin_risk: "medium" };
  }
  return { risk_label: "At Risk", margin_risk: "high" };
}

/**
 * Owner profit breakdown — all rates and percentages from mg_settings_v2 (Business Settings).
 */
function buildOwnerProfitBreakdown({
  project,
  collection,
  laborSection,
  expenses,
  operational,
  mgSettings,
}) {
  const bs = parseBusinessSettingsForOwnerProfit(mgSettings);
  const snap = computeProjectSnapshot({
    project,
    reports: [],
    expenses,
    changeOrders: [],
  });

  const contractTotal = collection.current_contract_total;
  const unexpectedTotal = sumExpenseAmounts(expenses);
  const reportedHours = num(laborSection.actual.hours, 0);
  const materialCost = round2(Math.max(0, num(project?.estimated_material_cost, 0)));

  const laborDirectMissing =
    Boolean(laborSection.labor_rates_missing) ||
    laborSection.cost_method === "no_rate" ||
    laborSection.actual.labor_cost == null;

  let directLabor = laborDirectMissing ? null : round2(laborSection.actual.labor_cost);

  let employerBurden = null;
  if (!laborDirectMissing && directLabor != null && bs.burden_ok) {
    const taxPct =
      (num(bs.fica_pct, 0) +
        num(bs.futa_pct, 0) +
        num(bs.casui_pct, 0) +
        num(bs.wc_pct, 0)) /
      100;
    employerBurden = round2(directLabor * taxPct);
  }

  let loadedLabor =
    directLabor != null && employerBurden != null
      ? round2(directLabor + employerBurden)
      : null;

  let operatingAllocation = null;
  if (bs.overhead_ok) {
    operatingAllocation = round2(num(bs.overhead_per_hour, 0) * reportedHours);
  }

  let sellerCommission = null;
  let sellerCommissionNote = null;
  const commissionLaborBase = round2(
    Math.max(
      num(project?.estimated_labor_cost, 0),
      num(project?.labor_budget, 0),
      num(laborSection.estimated.labor_cost, 0)
    )
  );
  if (!bs.commission_ok) {
    sellerCommissionNote = "Seller commission not configured.";
  } else if (commissionLaborBase <= 0) {
    sellerCommissionNote = "Labor budget not available yet.";
  } else {
    sellerCommission = round2(
      commissionLaborBase * (num(bs.sales_commission_pct, 0) / 100)
    );
  }

  let supervisorBonus = null;
  let supervisorBonusNote = null;
  const supervisorLaborBase = round2(
    Math.max(
      num(laborSection.estimated?.labor_cost, 0),
      num(laborSection.actual?.labor_cost, 0),
      num(project?.labor_budget, 0),
      num(project?.estimated_labor_cost, 0)
    )
  );
  if (!bs.supervisor_bonus_ok) {
    supervisorBonusNote = "Supervisor bonus not configured.";
  } else if (supervisorLaborBase <= 0) {
    supervisorBonusNote = "Supervisor bonus not configured.";
  } else {
    const bonusCalc = computeSupervisorExecutionBonus({
      laborBudget: supervisorLaborBase,
      effectiveDays: effectiveDaysForSupervisorBonus(project, operational),
      daysSpent: num(operational?.actual_days, num(laborSection.actual.days, 0)),
      supervisorBonusPctPoints: bs.supervisor_bonus_pct,
    });
    supervisorBonus = bonusCalc.bonusActual;
  }

  let savingsReserve = null;
  if (bs.reserve_ok && contractTotal >= 0) {
    savingsReserve = round2(contractTotal * (num(bs.reserve_pct, 0) / 100));
  }

  const settingsMissing = [...bs.missing];
  if (laborDirectMissing) {
    if (!settingsMissing.includes("direct_labor")) settingsMissing.push("direct_labor");
  }
  if (supervisorBonusNote) {
    if (!settingsMissing.includes("supervisor_bonus_rule")) {
      settingsMissing.push("supervisor_bonus_rule");
    }
  }

  const profitIncomplete =
    !bs.configured ||
    laborDirectMissing ||
    !bs.burden_ok ||
    !bs.overhead_ok ||
    !bs.reserve_ok ||
    loadedLabor == null ||
    (bs.commission_ok && sellerCommission == null) ||
    (bs.supervisor_bonus_ok && supervisorBonus == null);

  let ownerRemaining = null;
  if (!profitIncomplete) {
    ownerRemaining = round2(
      contractTotal -
        loadedLabor -
        unexpectedTotal -
        num(operatingAllocation, 0) -
        num(sellerCommission, 0) -
        num(supervisorBonus, 0) -
        num(savingsReserve, 0) -
        materialCost
    );
  }

  const marginPct =
    !profitIncomplete && contractTotal > 0
      ? round2((ownerRemaining / contractTotal) * 100)
      : null;

  const { risk_label, margin_risk } = deriveOwnerRiskLabel({
    profitIncomplete,
    marginPct,
    bs,
  });

  let incompleteMessage = null;
  if (profitIncomplete) {
    if (laborDirectMissing && laborSection.labor_rates_message) {
      incompleteMessage = laborSection.labor_rates_message;
    } else if (!bs.overhead_ok) {
      incompleteMessage = "Operating cost settings missing. Configure Business Settings.";
    } else if (!bs.burden_ok) {
      incompleteMessage = bs.missing_message;
    } else {
      incompleteMessage = bs.missing_message;
    }
  }

  const breakdown = {
    project_total: contractTotal,
    direct_labor_cost: directLabor,
    employer_burden: employerBurden,
    loaded_labor_cost: loadedLabor,
    unexpected_expenses: unexpectedTotal,
    operating_cost_allocation: operatingAllocation,
    seller_commission: sellerCommission,
    seller_commission_note: sellerCommissionNote,
    supervisor_bonus: supervisorBonus,
    supervisor_bonus_note: supervisorBonusNote,
    savings_reserve: savingsReserve,
    material_costs: materialCost > 0 ? materialCost : null,
    owner_remaining_profit: ownerRemaining,
    margin_pct: marginPct,
    target_margin_pct: bs.profit_pct,
    risk_label,
    burden_pct_total: bs.burden_pct_total,
    burden_breakdown: bs.burden_ok
      ? {
          fica_pct: bs.fica_pct,
          futa_pct: bs.futa_pct,
          casui_pct: bs.casui_pct,
          wc_pct: bs.wc_pct,
        }
      : null,
    overhead_per_hour: bs.overhead_per_hour,
    settings_missing: settingsMissing,
    lines: [
      ownerProfitLine("Project total", contractTotal, "calculated"),
      ownerProfitLine(
        "Direct labor cost",
        directLabor,
        laborDirectMissing ? "not_configured" : "calculated",
        laborDirectMissing ? laborSection.labor_rates_message : null
      ),
      ownerProfitLine(
        "Employer burden",
        employerBurden,
        !bs.burden_ok || laborDirectMissing ? "not_configured" : "calculated",
        bs.burden_ok && bs.burden_pct_total != null
          ? `${bs.burden_pct_total}% of direct labor (FICA, FUTA, CA SUI, Workers Comp)`
          : null
      ),
      ownerProfitLine(
        "Loaded labor cost",
        loadedLabor,
        loadedLabor == null ? "not_configured" : "calculated"
      ),
      ownerProfitLine("Unexpected expenses", unexpectedTotal, "calculated"),
      ownerProfitLine(
        "Operating cost allocation",
        operatingAllocation,
        !bs.overhead_ok ? "not_configured" : "calculated",
        !bs.overhead_ok
          ? "Operating cost settings missing. Configure Business Settings."
          : bs.overhead_per_hour != null
            ? `$${bs.overhead_per_hour}/hr × ${reportedHours} reported hrs`
            : null
      ),
      ownerProfitLine(
        "Seller commission",
        sellerCommission,
        !bs.commission_ok || sellerCommission == null ? "not_configured" : "calculated",
        sellerCommissionNote ||
          (bs.commission_ok
            ? `${bs.sales_commission_pct}% of labor cost`
            : null)
      ),
      ownerProfitLine(
        "Supervisor bonus",
        supervisorBonus,
        supervisorBonus == null ? "not_configured" : "calculated",
        supervisorBonusNote
      ),
      ownerProfitLine(
        "Savings reserve",
        savingsReserve,
        !bs.reserve_ok ? "not_configured" : "calculated",
        bs.reserve_ok ? `${bs.reserve_pct}% of contract` : null
      ),
      ownerProfitLine(
        "Owner remaining profit",
        ownerRemaining,
        profitIncomplete ? "not_configured" : "calculated"
      ),
    ],
  };

  const projectedProfit = round2(num(project?.estimated_profit, snap.projected_profit));

  return {
    owner_profit_breakdown: breakdown,
    projected_profit: projectedProfit,
    current_profit: ownerRemaining,
    profit_variance:
      ownerRemaining != null ? round2(ownerRemaining - projectedProfit) : null,
    margin_pct: marginPct,
    margin_risk,
    risk_label,
    profit_is_incomplete: profitIncomplete,
    profit_incomplete_message: profitIncomplete ? incompleteMessage : null,
    business_settings_keys_used: [
      "baseInstaller",
      "baseHelper",
      "ficaPct",
      "futaPct",
      "casuiPct",
      "wcPct",
      "overheadMonthly",
      "stdHours",
      "salesCommissionPct",
      "supervisorBonusPct",
      "reservePct",
      "profitPct",
      "minimumMarginPct",
      "hoursPerDay",
    ],
  };
}

function buildProfitSection(args) {
  const result = buildOwnerProfitBreakdown(args);
  return {
    projected_profit: result.projected_profit,
    current_profit: result.current_profit,
    profit_variance: result.profit_variance,
    margin_pct: result.margin_pct,
    margin_risk: result.margin_risk,
    risk_label: result.risk_label,
    profit_is_incomplete: result.profit_is_incomplete,
    profit_incomplete_message: result.profit_incomplete_message,
    owner_profit_breakdown: result.owner_profit_breakdown,
    business_settings_keys_used: result.business_settings_keys_used,
  };
}

function mapOperationalForDetail(op) {
  const o = op && typeof op === "object" ? op : {};
  const completed =
    o.completed_days != null
      ? o.completed_days
      : o.completed_days_from_progress != null
        ? o.completed_days_from_progress
        : 0;
  return {
    estimated_days: o.estimated_days,
    days_spent: o.actual_days,
    days_remaining: o.days_remaining,
    progress_pct: o.completion_pace_pct,
    completed_days: completed,
    over_scheduled_days: Boolean(o.over_scheduled_days),
    reports_count: o.report_count,
    expense_entries_count: o.expense_count,
    estimated_hours: o.estimated_hours,
    actual_hours: o.actual_hours,
    operational_risk: o.operational_risk,
    progress_source: o.progress_source || "field_reports",
  };
}

function mapExpenseRow(row) {
  if (!row || typeof row !== "object") return null;
  const note = str(row.note, 2000);
  const nl = note.indexOf("\n");
  const concept = (nl >= 0 ? note.slice(0, nl) : note).trim() || "Expense";
  return {
    id: row.id,
    expense_date: row.expense_date == null ? null : String(row.expense_date).slice(0, 10),
    amount: round2(num(row.amount, 0)),
    note,
    concept,
    day_number:
      row.day_number == null || row.day_number === ""
        ? null
        : Math.max(1, Math.floor(num(row.day_number, 0))) || null,
    phase: row.phase == null ? "" : str(row.phase, 200),
  };
}

/**
 * Assemble full financial detail payload for Project Control modal.
 */
function buildProjectFinancialDetail({
  project,
  reports,
  expenses,
  changeOrders,
  invoices,
  payments,
  dayProgressRows,
  tenantSnapshotPayload,
  supervisorBonusPct = 1,
  hoursPerDay = DEFAULT_HOURS_PER_DAY,
  migrationBaseline,
  ledgerPaidByInvoiceId,
  operationalPlanRaw,
}) {
  const mg = extractMgSettings(tenantSnapshotPayload);
  const labor = computeLaborCostSection({
    project,
    reports,
    mgSettings: mg,
    hoursPerDay,
    operationalPlanRaw,
    dayProgressRows,
  });
  const collection = buildCollectionSection({
    project,
    invoices,
    payments,
    changeOrders,
    ledgerPaidByInvoiceId,
  });
  const expenseRows = (expenses || []).map(mapExpenseRow).filter(Boolean);
  const expenseTotal = sumExpenseAmounts(expenseRows);

  const opRaw = computeFinancialOperationalState({
    project,
    reports,
    expenses: expenseRows,
    dayProgressRows,
    migrationBaseline,
    supervisorBonusPct,
    hoursPerDay,
    operationalPlanRaw,
  });
  const operational = mapOperationalForDetail(opRaw);

  const profit = buildProfitSection({
    project,
    collection,
    laborSection: labor,
    expenses: expenseRows,
    operational: opRaw,
    mgSettings: mg,
  });

  const progressPct = operational.progress_pct;
  const completionSuggestion = deriveCompletionStatusSuggestion({
    progressPct,
    completedDays: operational.completed_days,
    estimatedDays: operational.estimated_days,
    balanceDue: collection.balance_due,
  });

  let statusLabel = str(project.status, 64);
  let tone = "green";
  if (completionSuggestion) {
    statusLabel = completionSuggestion.label;
    tone = completionSuggestion.tone;
  } else if (num(operational.days_remaining, 0) <= 1 && progressPct >= 90) {
    statusLabel = "At risk";
    tone = "yellow";
  } else if (num(opRaw.labor_deviation_days, 0) > 0) {
    statusLabel = "Delayed";
    tone = "red";
  } else {
    statusLabel = "On track";
  }

  return {
    project: {
      id: project.id,
      project_name: str(project.project_name, 300),
      client_name: str(project.client_name, 300),
      status: str(project.status, 64),
    },
    header: {
      progress_pct: progressPct,
      over_scheduled_days: Boolean(operational.over_scheduled_days),
      status_label: statusLabel,
      margin_risk: profit.margin_risk,
      tone,
      completion_status: completionSuggestion?.label || null,
    },
    kpis: {
      contract_total: collection.current_contract_total,
      paid_to_date: collection.paid_to_date,
      balance_due: collection.balance_due,
      current_profit: profit.current_profit,
      margin_pct: profit.margin_pct,
      risk_status: profit.margin_risk,
      profit_is_incomplete: profit.profit_is_incomplete,
      profit_incomplete_message: profit.profit_incomplete_message,
    },
    contract_collection: collection,
    labor,
    expenses: {
      total: expenseTotal,
      count: expenseRows.length,
      last:
        expenseRows.length > 0
          ? {
              date: expenseRows[0].expense_date,
              concept: expenseRows[0].concept,
              amount: expenseRows[0].amount,
            }
          : null,
      entries: expenseRows,
    },
    profit,
    operational,
  };
}

module.exports = {
  buildProjectFinancialDetail,
  computeLaborCostSection,
  buildCollectionSection,
  buildProfitSection,
  buildOwnerProfitBreakdown,
  parseBusinessSettingsForOwnerProfit,
  computeFinancialOperationalState,
  loadInvoicesForProject,
  loadPaymentsForProject,
  sumLedgerPaidByInvoiceId,
  extractMgSettings,
  laborRatesFromSettings,
  mapExpenseRow,
};
