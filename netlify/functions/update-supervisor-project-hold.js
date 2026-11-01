const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  loadTenantProjectForSupervisorAction,
  resolveOwnerOrSupervisorContext,
} = require("./_lib/tenant-device-guard");
const { loadMigrationBaseline } = require("./_lib/migration-baseline");
const hold = require("../../public/js/supervisor-project-hold.js");

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

function str(value, max) {
  return String(value == null ? "" : value)
    .trim()
    .slice(0, max || 128);
}

function normDate(value) {
  return hold.normDate(value);
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
    if (!projectId) {
      return json(400, { error: "project_id is required", code: "invalid_project_id" });
    }

    await loadTenantProjectForSupervisorAction(ctx, projectId);

    const tid = encodeURIComponent(tenant.id);
    const pid = encodeURIComponent(projectId);
    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,quote_id,due_date&limit=1`
    );
    const project = Array.isArray(projRows) ? projRows[0] : null;
    if (!project?.id) {
      return json(403, { error: "Project not found for this tenant", code: "project_not_found" });
    }

    const [snapRows, baseline] = await Promise.all([
      supabaseRequest(
        `tenant_project_operational_snapshots?tenant_id=eq.${tid}&project_id=eq.${pid}&select=id,operational_plan,commitment_date&limit=1`
      ),
      loadMigrationBaseline(tenant.id, projectId),
    ]);
    const snapshot = Array.isArray(snapRows) ? snapRows[0] : null;
    const existingRaw = snapshot ? snapshot.operational_plan : [];
    let holds = hold.extractProjectHolds(existingRaw);
    const action = str(body.action, 16).toLowerCase();

    if (action === "remove") {
      const removed = hold.removeProjectHold(holds, body.hold_id);
      if (!removed.ok) {
        return json(400, { error: removed.error, code: removed.code });
      }
      holds = removed.holds;
    } else if (action === "add" || !action) {
      const added = hold.addProjectHold(holds, {
        reason: body.reason,
        mode: body.mode,
        amount: body.amount,
        unit: body.unit,
        days: body.days,
        range_start: body.range_start,
        range_end: body.range_end,
      });
      if (!added.ok) {
        return json(400, { error: added.error, code: added.code });
      }
      holds = added.holds;
    } else {
      return json(400, { error: "Unknown hold action.", code: "invalid_action" });
    }

    const days = hold.planDaysFromRaw(existingRaw);
    const nextPlan = hold.planValueWithHolds(days, holds);
    const nowIso = new Date().toISOString();

    if (snapshot && snapshot.id) {
      await supabaseRequest(
        `tenant_project_operational_snapshots?id=eq.${encodeURIComponent(snapshot.id)}&tenant_id=eq.${tid}`,
        {
          method: "PATCH",
          body: {
            operational_plan: nextPlan,
            updated_at: nowIso,
          },
        }
      );
    } else {
      await supabaseRequest("tenant_project_operational_snapshots", {
        method: "POST",
        body: {
          tenant_id: tenant.id,
          project_id: projectId,
          quote_id: project.quote_id || null,
          operational_plan: nextPlan,
          estimated_days: 0,
          estimated_hours: 0,
          worker_count: 0,
          commitment_date: null,
          locked_at: nowIso,
          source: "project_hold",
          created_at: nowIso,
          updated_at: nowIso,
        },
      });
    }

    let quoteDue = "";
    if (!baseline && project.quote_id) {
      try {
        const quoteRows = await supabaseRequest(
          `quotes?id=eq.${encodeURIComponent(project.quote_id)}&tenant_id=eq.${tid}&select=due_date&limit=1`
        );
        const quote = Array.isArray(quoteRows) ? quoteRows[0] : null;
        quoteDue = normDate(quote && quote.due_date);
      } catch (_err) {
        quoteDue = "";
      }
    }

    const originalTarget =
      normDate(baseline && baseline.target_finish_date) ||
      normDate(snapshot && snapshot.commitment_date) ||
      normDate(project.due_date) ||
      quoteDue;
    const summary = hold.summarizeTarget(originalTarget, holds);

    return json(200, {
      ok: true,
      project_id: projectId,
      project_holds: summary.holds,
      hold_days: summary.holdDays,
      original_target_finish_date: summary.originalTarget,
      adjusted_target_finish_date: summary.adjustedTarget,
    });
  } catch (err) {
    if (err && err.isGuardError) {
      return json(err.statusCode || 403, {
        error: err.message,
        code: err.code || "guard_error",
      });
    }
    return json(500, { error: "Could not save the project hold.", code: "hold_update_failed" });
  }
};
