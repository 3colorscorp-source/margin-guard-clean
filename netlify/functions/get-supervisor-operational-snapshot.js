const {
  resolveOwnerOrSupervisorContext,
  assertAssignedSupervisorProject,
} = require("./_lib/tenant-device-guard");
const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  computeProjectOperationalSnapshot,
  pickAllowlistedOperational,
} = require("./_lib/project-operational-snapshot");
const {
  loadMigrationBaseline,
  applyMigrationBaselineToMetrics,
  scheduleFromMigrationBaseline,
  migrationBaselineForSupervisor,
} = require("./_lib/migration-baseline");
const {
  loadDayProgressForProject,
  countCompletedDays,
} = require("./_lib/project-day-progress");
const {
  operationalPlanForSupervisorVisibility,
  parseOperationalPlanJsonb,
  resolveOperationalPlanForQuote,
  normalizeOperationalPlan,
  computeOperationalPlanMetrics,
  planHasDays,
  crewSummaryFromOperationalPlan,
} = require("./_lib/operational-plan");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(num(n, 0) * 100) / 100;
}

function normDate(d) {
  const t = String(d == null ? "" : d).trim();
  if (!t) return null;
  const datePrefix = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePrefix) return datePrefix[1];
  const parsed = new Date(t);
  if (Number.isNaN(parsed.getTime())) return null;
  const y = parsed.getFullYear();
  const mo = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function extractSupervisorBonusPctFromSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") return 1;
  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage.mg_settings_v2 && typeof storage.mg_settings_v2 === "object"
      ? storage.mg_settings_v2
      : {};
  return num(mg.supervisorBonusPct, 1);
}

async function loadLatestTenantSnapshotPayload(tenantId) {
  const tid = encodeURIComponent(tenantId);
  try {
    const rows = await supabaseRequest(
      `tenant_snapshots?tenant_id=eq.${tid}&select=payload&order=created_at.desc&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.payload && typeof row.payload === "object" ? row.payload : null;
  } catch (_e) {
    return null;
  }
}

async function loadSupervisorBonusPctForTenant(tenantId) {
  const tid = encodeURIComponent(tenantId);
  try {
    const rows = await supabaseRequest(
      `tenant_snapshots?tenant_id=eq.${tid}&select=payload&order=created_at.desc&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return extractSupervisorBonusPctFromSnapshotPayload(row?.payload);
  } catch (_e) {
    return 1;
  }
}

async function loadOperationalSnapshotRow(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  try {
    const rows = await supabaseRequest(
      `tenant_project_operational_snapshots?tenant_id=eq.${tid}&project_id=eq.${pid}&select=operational_plan,estimated_days,estimated_hours,worker_count,commitment_date,locked_at&limit=1`
    );
    return Array.isArray(rows) ? rows[0] : null;
  } catch (_e) {
    return null;
  }
}

function mergeMetricsWithStoredPlan(metrics, opRow, project) {
  const out = { ...metrics };
  if (opRow && typeof opRow === "object") {
    const storedDays = num(opRow.estimated_days, 0);
    const storedHours = num(opRow.estimated_hours, 0);
    if (storedDays > 0) {
      out.estimated_days = round2(storedDays);
      out.days_remaining = round2(Math.max(0, storedDays - num(out.actual_days, 0)));
      if (storedDays > 0) {
        out.completion_pace_pct = Math.round(
          (num(out.actual_days, 0) / storedDays) * 100
        );
      }
    }
    if (storedHours > 0) {
      out.estimated_hours = round2(storedHours);
    }
    const actual = num(out.actual_days, 0);
    const est = num(out.estimated_days, 0);
    out.labor_deviation_days = round2(actual - est);
    const dev = out.labor_deviation_days;
    if (Math.abs(dev) < 0.01) out.labor_deviation_label = "On budget";
    else if (dev > 0) out.labor_deviation_label = `${dev.toFixed(2)} day(s) over budget`;
    else out.labor_deviation_label = `${Math.abs(dev).toFixed(2)} day(s) under budget`;
  } else if (num(project?.estimated_days, 0) > 0 && num(out.estimated_days, 0) <= 0) {
    out.estimated_days = round2(num(project.estimated_days, 0));
    out.days_remaining = round2(
      Math.max(0, out.estimated_days - num(out.actual_days, 0))
    );
  }
  const estFinal = num(out.estimated_days, 0);
  const actFinal = num(out.actual_days, 0);
  if (estFinal > 0) {
    out.days_remaining = round2(Math.max(0, estFinal - actFinal));
    out.completion_pace_pct = Math.round((actFinal / estFinal) * 100);
  }
  return out;
}

/** Qualitative invoice label for migrated field view (no dollar amounts). */
async function loadSupervisorInvoiceStatusLabel(tenantId, projectId) {
  const tid = encodeURIComponent(tenantId);
  const pid = encodeURIComponent(projectId);
  try {
    const rows = await supabaseRequest(
      `invoices?tenant_id=eq.${tid}&project_id=eq.${pid}&select=status&order=created_at.desc&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.status) return "No invoice on file";
    const s = String(row.status || "")
      .trim()
      .toLowerCase();
    if (s === "paid") return "Invoice sent · paid";
    if (s === "partial" || s === "partially_paid") return "Invoice sent · partial";
    if (s === "draft" || s === "sent" || s === "open" || s === "unpaid") {
      return "Invoice sent · unpaid";
    }
    return `Invoice ${s.replace(/_/g, " ")}`;
  } catch (_e) {
    return "Invoice status unavailable";
  }
}

function buildScheduleFields(project, opRow, quoteRow) {
  const quoteStart = normDate(quoteRow?.start_date ?? quoteRow?.startDate);
  const signedAt = normDate(project?.signed_at);
  const due = normDate(
    opRow?.commitment_date || project?.due_date || quoteRow?.due_date || quoteRow?.dueDate
  );
  return {
    start_date: quoteStart || signedAt,
    commitment_date: due,
    target_finish_date: due,
  };
}

function strDayLabel(v, max = 500) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function enrichSupervisorPlanDayLabels(planRaw) {
  if (!Array.isArray(planRaw)) return [];
  return planRaw.map((day) => {
    if (!day || typeof day !== "object") return day;
    const title = strDayLabel(day.title, 240);
    const desc = strDayLabel(day.description, 500);
    const scope = strDayLabel(day.scope, 500);
    const phase = strDayLabel(day.phase, 240);
    const best = title || desc || scope;
    if (!best) return day;
    const generic =
      !phase ||
      /continue planned field work|project start\s*\/\s*site protection|final walkthrough\s*\/\s*cleanup/i.test(
        phase
      );
    if (generic) {
      return { ...day, phase: best };
    }
    return day;
  });
}

function planFromQuotedLaborDayObjects(quotedLaborPlan) {
  const raw = Array.isArray(quotedLaborPlan) ? quotedLaborPlan : [];
  if (!raw.length) return [];
  const first = raw[0];
  if (!first || typeof first !== "object") return [];
  if (!Array.isArray(first.workers) && !Array.isArray(first.crew)) return [];
  return raw
    .map((day, idx) => {
      const dn = Math.max(1, Math.floor(num(day?.day_number, idx + 1)));
      const title = strDayLabel(day.title, 240);
      const desc = strDayLabel(day.description, 500);
      const phase =
        title || desc || strDayLabel(day.phase, 240) || strDayLabel(day.scope, 500) || `Day ${dn}`;
      const workers = Array.isArray(day.workers)
        ? day.workers
        : Array.isArray(day.crew)
          ? day.crew
          : [];
      if (!workers.length && !phase) return null;
      return {
        day_number: dn,
        phase,
        workers,
        ...(title ? { title } : {}),
        ...(desc ? { description: desc } : {}),
      };
    })
    .filter(Boolean);
}

function planLooksGenericSupervisor(plan) {
  if (!Array.isArray(plan) || !plan.length) return true;
  let generic = 0;
  for (const day of plan) {
    const p = strDayLabel(day?.phase, 240).toLowerCase();
    if (
      !p ||
      p.includes("continue planned field work") ||
      p.includes("project start / site protection") ||
      p.includes("final walkthrough / cleanup")
    ) {
      generic += 1;
    }
  }
  return generic >= Math.ceil(plan.length * 0.5);
}

/** Blend labor reports with marked-complete plan days (supervisor-safe). */
function applyDayProgressToMetrics(metrics, dayProgressRows) {
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
  return out;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    const ctx = await resolveOwnerOrSupervisorContext(event);
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const isDevice = ctx.auth_mode === "device";

    const qs = event.queryStringParameters || {};
    const projectId = String(qs.project_id || "").trim();
    if (!projectId) {
      return json(400, { error: "project_id is required" });
    }

    const tid = encodeURIComponent(tenant.id);
    const pid = encodeURIComponent(projectId);

    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=*`
    );
    const project = Array.isArray(projRows) ? projRows[0] : null;
    if (!project?.id) {
      return json(403, { error: "Project not found for this tenant" });
    }

    assertAssignedSupervisorProject(ctx, project);

    const [reportRows, expenseRows, bonusPct, opRow, migrationBaseline, dayProgressRows] =
      await Promise.all([
        supabaseRequest(
          `tenant_project_reports?tenant_id=eq.${tid}&project_id=eq.${pid}&select=hours,days,created_at`
        ),
        supabaseRequest(
          `tenant_project_expenses?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id`
        ),
        loadSupervisorBonusPctForTenant(tenant.id),
        loadOperationalSnapshotRow(tenant.id, project.id),
        loadMigrationBaseline(tenant.id, project.id),
        loadDayProgressForProject(tenant.id, project.id),
      ]);

    let operational_snapshot = computeProjectOperationalSnapshot({
      project,
      reports: Array.isArray(reportRows) ? reportRows : [],
      expenses: Array.isArray(expenseRows) ? expenseRows : [],
      supervisorBonusPctPoints: bonusPct,
    });

    let quoteRow = null;
    if (project.quote_id) {
      try {
        const qRows = await supabaseRequest(
          `quotes?id=eq.${encodeURIComponent(project.quote_id)}&tenant_id=eq.${tid}&select=*&limit=1`
        );
        quoteRow = Array.isArray(qRows) ? qRows[0] : null;
      } catch (_e) {
        quoteRow = null;
      }
    }

    let planRaw = parseOperationalPlanJsonb(opRow?.operational_plan);
    if (!planRaw.length && quoteRow) {
      try {
        const resolved = await resolveOperationalPlanForQuote(
          quoteRow,
          () => loadLatestTenantSnapshotPayload(tenant.id)
        );
        if (resolved?.plan?.length) {
          planRaw = resolved.plan;
        }
      } catch (_e) {
        /* fallback optional */
      }
    }

    planRaw = enrichSupervisorPlanDayLabels(planRaw);
    const fromQuotedDays = planFromQuotedLaborDayObjects(project.quoted_labor_plan);
    if (fromQuotedDays.length && (!planRaw.length || planLooksGenericSupervisor(planRaw))) {
      planRaw = fromQuotedDays;
    }

    const operational_plan = operationalPlanForSupervisorVisibility(planRaw);
    const has_execution_plan = operational_plan.length > 0;

    let metricsRow = opRow;
    if (!metricsRow && planHasDays(planRaw)) {
      const normalized = normalizeOperationalPlan(planRaw);
      const metrics = computeOperationalPlanMetrics(normalized);
      metricsRow = {
        estimated_days: metrics.estimated_days,
        estimated_hours: metrics.estimated_hours,
        worker_count: metrics.worker_count,
        commitment_date: normDate(project.due_date),
      };
    }

    const migration_baseline = migrationBaselineForSupervisor(migrationBaseline);
    const has_migrated_baseline = Boolean(migration_baseline);

    if (has_migrated_baseline) {
      operational_snapshot = applyMigrationBaselineToMetrics(
        operational_snapshot,
        migrationBaseline,
        Array.isArray(reportRows) ? reportRows : []
      );
      operational_snapshot = applyDayProgressToMetrics(
        operational_snapshot,
        dayProgressRows
      );
      operational_snapshot = pickAllowlistedOperational(operational_snapshot);
    } else {
      operational_snapshot = mergeMetricsWithStoredPlan(
        operational_snapshot,
        metricsRow,
        project
      );
      operational_snapshot = applyDayProgressToMetrics(
        operational_snapshot,
        dayProgressRows
      );
      if (isDevice) {
        operational_snapshot = pickAllowlistedOperational(operational_snapshot);
      }
    }

    let schedule;
    if (has_migrated_baseline) {
      const phase = String(migrationBaseline.current_phase || "").trim();
      schedule = {
        ...scheduleFromMigrationBaseline(migrationBaseline),
        crew_summary: phase,
      };
    } else {
      schedule = {
        ...buildScheduleFields(project, metricsRow || opRow, quoteRow),
        crew_summary: crewSummaryFromOperationalPlan(operational_plan),
      };
    }

    const show_migrated_execution = has_migrated_baseline;
    const operational_plan_out = has_migrated_baseline ? [] : operational_plan;

    let migrated_field_context = null;
    if (show_migrated_execution) {
      const expenseCount = Array.isArray(expenseRows) ? expenseRows.length : 0;
      if (isDevice) {
        migrated_field_context = { expense_count: expenseCount };
      } else {
        migrated_field_context = {
          expense_count: expenseCount,
          invoice_status_label: await loadSupervisorInvoiceStatusLabel(
            tenant.id,
            project.id
          ),
        };
      }
    }

    const payload = {
      ok: true,
      project_id: project.id,
      operational_snapshot,
      operational_plan: operational_plan_out,
      schedule,
      day_progress: Array.isArray(dayProgressRows) ? dayProgressRows : [],
      has_execution_plan: has_migrated_baseline ? false : has_execution_plan,
      migration_baseline,
      has_migrated_baseline,
      show_migrated_execution,
      migrated_field_context,
    };

    return json(200, payload);
  } catch (err) {
    if (err.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: err.message || "Unexpected error" });
  }
};
