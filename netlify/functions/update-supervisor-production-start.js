const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  loadTenantProjectForSupervisorAction,
  resolveOwnerOrSupervisorContext,
} = require("./_lib/tenant-device-guard");
const { parseOperationalPlanJsonb } = require("./_lib/operational-plan");
const { loadMigrationBaseline } = require("./_lib/migration-baseline");
const { normDate, productionTargetFromStart } = require("./_lib/sales-capacity-calendar");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function str(v, max = 128) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function positiveDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n);
}

function estimatedDaysForProject(plan, snapshot, project, baseline) {
  let maxDay = 0;
  const days = Array.isArray(plan) ? plan : [];
  for (const day of days) {
    const n = Math.floor(Number(day && day.day_number) || 0);
    if (n > maxDay) maxDay = n;
  }
  const fromPlan = Math.max(days.length, maxDay);
  if (fromPlan > 0) return fromPlan;
  return (
    positiveDays(snapshot && snapshot.estimated_days) ||
    positiveDays(project && project.estimated_days) ||
    positiveDays(baseline && baseline.estimated_total_days) ||
    0
  );
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { error: "Invalid JSON", code: "invalid_json" });
    }

    const ctx = await resolveOwnerOrSupervisorContext(event);
    const tenant = ctx.tenant;
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const projectId = str(body.project_id, 128);
    const startDate = normDate(body.start_date);
    if (!projectId) {
      return json(400, { error: "project_id is required", code: "invalid_project_id" });
    }
    if (!startDate) {
      return json(400, { error: "Enter a valid start date.", code: "invalid_start_date" });
    }

    await loadTenantProjectForSupervisorAction(ctx, projectId);

    const tid = encodeURIComponent(tenant.id);
    const pid = encodeURIComponent(projectId);
    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,quote_id,estimated_days,signed_at&limit=1`
    );
    const project = Array.isArray(projRows) ? projRows[0] : null;
    if (!project?.id) {
      return json(403, { error: "Project not found for this tenant", code: "project_not_found" });
    }

    const [snapRows, baseline] = await Promise.all([
      supabaseRequest(
        `tenant_project_operational_snapshots?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id,operational_plan,estimated_days,commitment_date&limit=1`
      ),
      loadMigrationBaseline(tenant.id, projectId),
    ]);
    const snapshot = Array.isArray(snapRows) ? snapRows[0] : null;
    const plan = parseOperationalPlanJsonb(snapshot && snapshot.operational_plan);
    const estimatedDays = estimatedDaysForProject(plan, snapshot, project, baseline);
    if (estimatedDays <= 0) {
      return json(400, {
        error: "This project has no plan length yet, so the start date cannot move the schedule.",
        code: "missing_plan_length",
      });
    }

    const targetFinish = productionTargetFromStart(startDate, estimatedDays);
    if (!targetFinish) {
      return json(400, { error: "Enter a valid start date.", code: "invalid_start_date" });
    }

    const nowIso = new Date().toISOString();
    if (baseline && baseline.id) {
      await supabaseRequest(
        `tenant_project_migration_baselines?id=eq.${encodeURIComponent(baseline.id)}&tenant_id=eq.${tid}`,
        {
          method: "PATCH",
          body: {
            actual_start_date: startDate,
            target_finish_date: targetFinish,
            updated_at: nowIso,
          },
        }
      );
    } else if (project.quote_id) {
      await supabaseRequest(
        `quotes?id=eq.${encodeURIComponent(project.quote_id)}&tenant_id=eq.${tid}`,
        {
          method: "PATCH",
          body: {
            start_date: startDate,
            due_date: targetFinish,
            updated_at: nowIso,
          },
        }
      );
    } else {
      await supabaseRequest(`tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`, {
        method: "PATCH",
        body: {
          signed_at: `${startDate}T12:00:00.000Z`,
          updated_at: nowIso,
        },
      });
    }

    await supabaseRequest(`tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`, {
      method: "PATCH",
      body: {
        due_date: targetFinish,
        updated_at: nowIso,
      },
    });

    if (snapshot && snapshot.id) {
      await supabaseRequest(
        `tenant_project_operational_snapshots?id=eq.${encodeURIComponent(snapshot.id)}&tenant_id=eq.${tid}`,
        {
          method: "PATCH",
          body: {
            commitment_date: targetFinish,
            updated_at: nowIso,
          },
        }
      );
    }

    return json(200, {
      ok: true,
      project_id: projectId,
      start_date: startDate,
      target_finish_date: targetFinish,
      estimated_days: estimatedDays,
    });
  } catch (err) {
    if (err && err.isGuardError) {
      return json(err.statusCode || 403, {
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: "Could not update the start date.", code: "start_update_failed" });
  }
};
