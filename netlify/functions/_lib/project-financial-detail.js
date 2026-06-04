/**
 * Owner Project Financial Detail — server-side read model (Project Control modal).
 * Pure calculations + assembly; no financial fields in Supervisor responses.
 */

const { computeProjectSnapshot, round2, num } = require("./project-snapshot");
const { computeProjectOperationalSnapshot } = require("./project-operational-snapshot");
const { normalizeQuotedLaborPlan } = require("./project-labor-plan");
const { countCompletedDays } = require("./project-day-progress");

const DEFAULT_HOURS_PER_DAY = 8;

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
  const missing = !(proRate > 0 && assistantRate > 0);
  return {
    pro_rate: round2(proRate),
    assistant_rate: round2(assistantRate),
    missing,
    missing_message:
      "Labor cost settings missing. Configure Operating Costs first.",
  };
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
}) {
  const hpd = Math.max(num(hoursPerDay, DEFAULT_HOURS_PER_DAY), 0.25);
  const rates = laborRatesFromSettings(mgSettings);
  const rolePlan = planRoleBudgetHours(project?.quoted_labor_plan, hpd, mgSettings || {});
  const reportedHours = sumReportHours(reports);
  const reportedDays = sumReportDays(reports);

  const estimatedDays = round2(
    rolePlan.plan.length
      ? Math.max(...rolePlan.plan.map((w) => num(w.budget_days, 0)), 0)
      : num(project?.estimated_days, 0)
  );
  const estimatedHours =
    rolePlan.pro_hours + rolePlan.assistant_hours > 0
      ? round2(rolePlan.pro_hours + rolePlan.assistant_hours)
      : round2(estimatedDays * hpd);
  const estimatedLaborCost = round2(
    Math.max(num(project?.estimated_labor_cost, 0), num(project?.labor_budget, 0)) ||
      rolePlan.plan.reduce((s, w) => s + num(w.estimated_cost, 0), 0)
  );

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
    labor_rates_missing: rates.missing,
    labor_rates_message: rates.missing ? rates.missing_message : null,
    pro_rate: rates.missing ? null : rates.pro_rate,
    assistant_rate: rates.missing ? null : rates.assistant_rate,
    blended_rate: null,
  };

  if (rates.missing) {
    return base;
  }

  let actualCost = 0;
  let proH = 0;
  let asstH = 0;
  let method = "blended_rate";

  if (rolePlan.has_role_breakdown) {
    method = "role_breakdown";
    const planTotal = rolePlan.pro_hours + rolePlan.assistant_hours;
    if (reportedHours > 0 && planTotal > 0) {
      proH = reportedHours * (rolePlan.pro_hours / planTotal);
      asstH = reportedHours * (rolePlan.assistant_hours / planTotal);
    } else {
      proH = rolePlan.pro_hours;
      asstH = rolePlan.assistant_hours;
    }
    actualCost = proH * rates.pro_rate + asstH * rates.assistant_rate;
  } else {
    const blended = blendedHourlyRate(project, hpd);
    base.blended_rate = blended > 0 ? blended : null;
    if (blended <= 0) {
      base.cost_method = "no_rate";
      base.labor_rates_message =
        "No labor plan role breakdown and no blended rate (set labor budget and estimated days).";
      return base;
    }
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

function buildCollectionSection({ project, invoices, payments, changeOrders }) {
  const originalContract = round2(Math.max(0, num(project?.sale_price, 0)));
  const approvedChangeOrders = sumAppliedChangeOrders(changeOrders);
  const storedRev = num(project?.projected_revenue_total, NaN);
  const currentContractTotal =
    Number.isFinite(storedRev) && storedRev > 0
      ? round2(storedRev)
      : round2(originalContract + approvedChangeOrders);

  let totalInvoiced = 0;
  let paidToDate = 0;
  let balanceDue = 0;
  for (const inv of invoices || []) {
    const amt = num(inv.amount, 0);
    const paid = num(inv.paid_amount, 0);
    const bal = num(inv.balance_due, Math.max(0, amt - paid));
    totalInvoiced += amt;
    paidToDate += paid;
    balanceDue += bal;
  }
  totalInvoiced = round2(totalInvoiced);
  paidToDate = round2(paidToDate);
  balanceDue = round2(balanceDue);

  const ledgerPaid = round2(
    (payments || []).reduce((s, p) => s + num(p.amount, 0), 0)
  );
  if (ledgerPaid > paidToDate) paidToDate = ledgerPaid;

  const lastPay = (payments || [])
    .map((p) => p.paid_at || p.created_at)
    .filter(Boolean)
    .sort()
    .pop();

  const invStatus = invoiceStatusSummary(invoices);

  return {
    original_contract: originalContract,
    approved_change_orders: approvedChangeOrders,
    current_contract_total: currentContractTotal,
    total_invoiced: totalInvoiced,
    paid_to_date: paidToDate,
    balance_due: balanceDue > 0 ? balanceDue : round2(Math.max(0, currentContractTotal - paidToDate)),
    invoice_status: invStatus.label,
    last_payment_date: lastPay ? String(lastPay).slice(0, 10) : null,
  };
}

function buildProfitSection({
  project,
  collection,
  laborSection,
  expenses,
  operational,
  mgSettings,
}) {
  const snap = computeProjectSnapshot({
    project,
    reports: [],
    expenses,
    changeOrders: [],
  });

  const assumptions = [];

  const contractTotal = collection.current_contract_total;
  const unexpectedTotal = sumExpenseAmounts(expenses);

  let actualLabor = laborSection.actual.labor_cost;
  if (actualLabor == null) {
    if (laborSection.labor_rates_missing || laborSection.cost_method === "no_rate") {
      actualLabor = 0;
      assumptions.push({
        key: "actual_labor",
        label: "Actual labor cost",
        status: "missing_settings",
        amount: 0,
        note:
          laborSection.labor_rates_message ||
          "Labor cost not included in profit until rates are configured.",
      });
    } else {
      actualLabor = snap.actual_labor;
      assumptions.push({
        key: "actual_labor",
        label: "Actual labor cost",
        status: "stored_fallback",
        amount: actualLabor,
        note: "Using stored labor consumed on project record.",
      });
    }
  }

  const materialBudget = round2(Math.max(0, num(project?.estimated_material_cost, 0)));
  let materialCost = 0;
  if (materialBudget > 0) {
    materialCost = materialBudget;
    assumptions.push({
      key: "material_costs",
      label: "Material costs",
      status: "budget_estimate",
      amount: materialCost,
      note: "Using estimated material budget from project.",
    });
  } else {
    assumptions.push({
      key: "material_costs",
      label: "Material costs",
      status: "not_configured",
      amount: 0,
    });
  }

  const om = num(mgSettings?.overheadMonthly, 0);
  const stdHours = num(mgSettings?.stdHours, 0);
  let overheadAllocation = 0;
  if (om > 0 && stdHours > 0 && laborSection.actual.hours > 0) {
    overheadAllocation = round2((om / stdHours) * laborSection.actual.hours);
    assumptions.push({
      key: "overhead_allocation",
      label: "Overhead allocation",
      status: "calculated",
      amount: overheadAllocation,
      note: "Monthly overhead ÷ standard hours × reported hours.",
    });
  } else {
    assumptions.push({
      key: "overhead_allocation",
      label: "Overhead allocation",
      status: "not_configured",
      amount: 0,
    });
  }

  const commPct = num(mgSettings?.salesCommissionPct, 0);
  let sellerCommission = 0;
  if (commPct > 0 && contractTotal > 0) {
    sellerCommission = round2(contractTotal * (commPct / 100));
    assumptions.push({
      key: "seller_commission",
      label: "Seller commission",
      status: "calculated",
      amount: sellerCommission,
      note: `${commPct}% of current contract total.`,
    });
  } else {
    assumptions.push({
      key: "seller_commission",
      label: "Seller commission",
      status: "not_configured",
      amount: 0,
    });
  }

  const bonusAmount = round2(num(operational?.supervisor_bonus_amount, 0));
  if (bonusAmount > 0) {
    assumptions.push({
      key: "supervisor_bonus",
      label: "Supervisor bonus",
      status: "included",
      amount: bonusAmount,
    });
  } else {
    assumptions.push({
      key: "supervisor_bonus",
      label: "Supervisor bonus",
      status: "not_applicable",
      amount: 0,
    });
  }

  const projectedProfit = round2(num(project?.estimated_profit, snap.projected_profit));

  const currentProfit = round2(
    contractTotal -
      num(actualLabor, 0) -
      unexpectedTotal -
      materialCost -
      overheadAllocation -
      sellerCommission -
      bonusAmount
  );

  const currentMarginPct =
    contractTotal > 0 ? round2((currentProfit / contractTotal) * 100) : 0;

  const profitVariance = round2(currentProfit - projectedProfit);

  const profitIncomplete =
    Boolean(laborSection.labor_rates_missing) ||
    laborSection.cost_method === "no_rate" ||
    laborSection.actual.labor_cost == null;

  const marginRisk = profitIncomplete ? "incomplete" : snap.margin_risk || "low";

  return {
    projected_profit: projectedProfit,
    current_profit: currentProfit,
    profit_variance: profitVariance,
    margin_pct: currentMarginPct,
    margin_risk: marginRisk,
    profit_is_incomplete: profitIncomplete,
    profit_incomplete_message: profitIncomplete
      ? laborSection.labor_rates_message ||
        "Profit and margin are preliminary — actual labor cost was not calculated."
      : null,
    assumptions,
  };
}

function buildOperationalSection({
  project,
  reports,
  expenses,
  dayProgressRows,
  supervisorBonusPct,
  hoursPerDay,
  migrationMetrics,
}) {
  let op = computeProjectOperationalSnapshot({
    project,
    reports,
    expenses,
    supervisorBonusPctPoints: supervisorBonusPct,
    hoursPerDay,
  });

  if (migrationMetrics && typeof migrationMetrics === "object") {
    if (migrationMetrics.estimatedDays > 0) {
      op.estimated_days = round2(migrationMetrics.estimatedDays);
      op.days_remaining = round2(
        Math.max(0, op.estimated_days - num(op.actual_days, 0))
      );
      if (op.estimated_days > 0) {
        op.completion_pace_pct = Math.round(
          (num(op.actual_days, 0) / op.estimated_days) * 100
        );
      }
    }
    if (migrationMetrics.progressPct != null) {
      op.completion_pace_pct = Math.round(num(migrationMetrics.progressPct, 0));
    }
  }

  const completedDays = countCompletedDays(dayProgressRows);

  return {
    estimated_days: op.estimated_days,
    days_spent: op.actual_days,
    days_remaining: op.days_remaining,
    progress_pct: op.completion_pace_pct,
    completed_days: completedDays,
    reports_count: op.report_count,
    expense_entries_count: op.expense_count,
    estimated_hours: op.estimated_hours,
    actual_hours: op.actual_hours,
    operational_risk: op.operational_risk,
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
  tableMetrics,
}) {
  const mg = extractMgSettings(tenantSnapshotPayload);
  const labor = computeLaborCostSection({
    project,
    reports,
    mgSettings: mg,
    hoursPerDay,
  });
  const collection = buildCollectionSection({
    project,
    invoices,
    payments,
    changeOrders,
  });
  const expenseRows = (expenses || []).map(mapExpenseRow).filter(Boolean);
  const expenseTotal = sumExpenseAmounts(expenseRows);

  const operational = buildOperationalSection({
    project,
    reports,
    expenses: expenseRows,
    dayProgressRows,
    supervisorBonusPct,
    hoursPerDay,
    migrationMetrics: tableMetrics,
  });

  const profit = buildProfitSection({
    project,
    collection,
    laborSection: labor,
    expenses: expenseRows,
    operational,
    mgSettings: mg,
  });

  const progressPct =
    tableMetrics?.progressPct != null
      ? Math.round(num(tableMetrics.progressPct, 0))
      : operational.progress_pct;

  return {
    project: {
      id: project.id,
      project_name: str(project.project_name, 300),
      client_name: str(project.client_name, 300),
      status: str(project.status, 64),
    },
    header: {
      progress_pct: progressPct,
      status_label: tableMetrics?.statusLabel || str(project.status, 64),
      margin_risk: profit.margin_risk,
      tone: tableMetrics?.tone || "green",
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
  extractMgSettings,
  laborRatesFromSettings,
  mapExpenseRow,
};
