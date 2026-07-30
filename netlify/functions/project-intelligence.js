/**
 * MG-200B — Derived Project Intelligence Read API (GET only).
 * Tenant-scoped, side-effect-free. Creates zero business writes.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const {
  resolveMembershipByEmail,
  membershipRole,
  membershipIsActive,
} = require("./_lib/membership-resolve");
const { throwGuard } = require("./_lib/tenant-device-guard");
const { deriveProjectIntelligence } = require("./_lib/project-intelligence");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);
const ALLOWED_QUERY_KEYS = new Set(["project_id"]);
const INVOICE_SELECT =
  "id,amount,paid_amount,balance_due,status,payment_status,invoice_label,notes,type," +
  "due_date,created_at,paid_at,project_id,quote_id,project_name";

/** V1 is owner/admin only (intentional — no seller/supervisor access). */
const ROLE_POLICY = "owner_admin_only_v1";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function trimField(value) {
  return String(value ?? "").trim();
}

function unknownKeys(input, allowed) {
  return Object.keys(input || {}).filter((key) => !allowed.has(key));
}

function validUuid(value) {
  return UUID_RE.test(trimField(value));
}

async function requireOwnerOrAdmin(event) {
  const session = readSessionFromEvent(event);
  if (!session?.e || !session?.c) {
    throwGuard(401, "Unauthorized", "no_session");
  }
  const tenant = await resolveTenantFromSession(session);
  if (!tenant?.id) {
    throwGuard(422, "Tenant not found for this session.", "tenant_not_found");
  }
  const membership = await resolveMembershipByEmail(
    supabaseRequest,
    tenant.id,
    session.e
  );
  if (!membership?.id) {
    throwGuard(403, "Membership not found", "membership_not_found");
  }
  if (!membershipIsActive(membership)) {
    throwGuard(403, "Membership is not active", "membership_inactive");
  }
  const role = membershipRole(membership);
  if (!OWNER_ADMIN_ROLES.has(role)) {
    throwGuard(403, "Owner or admin membership required", "owner_required");
  }
  return { tenant };
}

async function safeLoad(label, fn, sourceErrors) {
  try {
    return await fn();
  } catch (_err) {
    sourceErrors[label] = true;
    return null;
  }
}

async function loadInvoices(tenantId, project) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(project.id));
  let rows = await supabaseRequest(
    `invoices?tenant_id=eq.${tid}&project_id=eq.${pid}&select=${INVOICE_SELECT}&order=created_at.desc`
  );
  let list = Array.isArray(rows) ? rows : [];
  if (!list.length && project.quote_id) {
    const qid = encodeURIComponent(String(project.quote_id));
    rows = await supabaseRequest(
      `invoices?tenant_id=eq.${tid}&quote_id=eq.${qid}&select=${INVOICE_SELECT}&order=created_at.desc`
    );
    list = Array.isArray(rows) ? rows : [];
  }
  return list;
}

async function loadPayments(tenantId, project, invoiceIds) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(project.id));
  const seen = new Set();
  const out = [];
  const pushRows = (rows) => {
    for (const p of Array.isArray(rows) ? rows : []) {
      const key = String(p?.id || `${p?.invoice_id}|${p?.paid_at}|${p?.amount}`);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  };

  pushRows(
    await supabaseRequest(
      `tenant_project_payments?tenant_id=eq.${tid}&project_id=eq.${pid}` +
        `&select=id,amount,paid_at,created_at,invoice_id,payment_type,payment_method&order=paid_at.desc`
    )
  );

  if (project.quote_id) {
    const qid = encodeURIComponent(String(project.quote_id));
    pushRows(
      await supabaseRequest(
        `tenant_project_payments?tenant_id=eq.${tid}&quote_id=eq.${qid}` +
          `&select=id,amount,paid_at,created_at,invoice_id,payment_type,payment_method&order=paid_at.desc`
      )
    );
  }

  const ids = Array.from(
    new Set((invoiceIds || []).map((id) => String(id || "").trim()).filter(Boolean))
  );
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const inList = chunk.map((id) => encodeURIComponent(id)).join(",");
    pushRows(
      await supabaseRequest(
        `tenant_project_payments?tenant_id=eq.${tid}&invoice_id=in.(${inList})` +
          `&select=id,amount,paid_at,created_at,invoice_id,payment_type,payment_method&order=paid_at.desc`
      )
    );
  }

  return out;
}

async function loadDayProgress(tenantId, projectId) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(projectId));
  const rows = await supabaseRequest(
    `tenant_project_day_progress?tenant_id=eq.${tid}&project_id=eq.${pid}` +
      `&select=id,day_number,status,completed_at,completion_note&order=day_number.asc`
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Auth-independent request gate checks (for unit tests).
 * Returns either { ok:true, projectId } or { ok:false, statusCode, body }.
 */
function validateGetQuery(query) {
  const q = query || {};
  if (q.tenant_id != null) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        ok: false,
        error: "tenant_id must not be sent by client",
        code: "tenant_id_forbidden",
      },
    };
  }
  const badQueryKeys = unknownKeys(q, ALLOWED_QUERY_KEYS);
  if (badQueryKeys.length) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        ok: false,
        error: "Unknown query fields rejected",
        code: "unknown_fields",
        fields: badQueryKeys,
      },
    };
  }
  const projectId = trimField(q.project_id).toLowerCase();
  if (!projectId) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        ok: false,
        error: "project_id is required",
        code: "project_id_required",
      },
    };
  }
  if (!validUuid(projectId)) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        ok: false,
        error: "Invalid project_id",
        code: "invalid_id",
      },
    };
  }
  return { ok: true, projectId };
}

exports.handler = async (event) => {
  try {
    // Repository convention: most MG functions reject non-GET/POST without CORS preflight.
    // OPTIONS is not implemented here (same as get-project-financial-detail).
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "Method not allowed", code: "method_not_allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = trimField(tenant.id);

    const gate = validateGetQuery(event.queryStringParameters || {});
    if (!gate.ok) {
      return json(gate.statusCode, gate.body);
    }
    const projectId = gate.projectId;

    const tid = encodeURIComponent(tenantId);
    const pid = encodeURIComponent(projectId);

    const projRows = await supabaseRequest(
      `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=*&limit=1`
    );
    const project = Array.isArray(projRows) ? projRows[0] : null;
    if (!project?.id) {
      // Same 404 for missing and cross-tenant — do not reveal foreign existence.
      return json(404, {
        ok: false,
        error: "Project not found for this tenant",
        code: "project_not_found",
      });
    }

    const sourceErrors = {};
    const quoteId = trimField(project.quote_id);

    const quote = quoteId
      ? await safeLoad(
          "quote",
          async () => {
            const rows = await supabaseRequest(
              `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${tid}` +
                `&select=id,status,total,currency,public_token,deposit_required,deposit_paid_at,deposit_paid_amount,` +
                `accepted_at,first_view_tracked_at,start_date,due_date,created_at,updated_at&limit=1`
            );
            return Array.isArray(rows) ? rows[0] : null;
          },
          sourceErrors
        )
      : null;

    const setup = await safeLoad(
      "setup",
      async () => {
        if (!quoteId) return null;
        const rows = await supabaseRequest(
          `project_contract_setups?tenant_id=eq.${tid}&project_id=eq.${pid}` +
            `&quote_id=eq.${encodeURIComponent(quoteId)}&select=*&limit=1`
        );
        return Array.isArray(rows) ? rows[0] : null;
      },
      sourceErrors
    );

    const scheduleBundle = await safeLoad(
      "schedule",
      async () => {
        if (!quoteId) return { schedule: null, items: [] };
        const schedules = await supabaseRequest(
          `project_contract_payment_schedules?tenant_id=eq.${tid}&project_id=eq.${pid}` +
            `&quote_id=eq.${encodeURIComponent(quoteId)}&select=*&limit=1`
        );
        const schedule = Array.isArray(schedules) ? schedules[0] : null;
        if (!schedule?.id) return { schedule: null, items: [] };
        const items = await supabaseRequest(
          `project_contract_payment_schedule_items?tenant_id=eq.${tid}` +
            `&schedule_id=eq.${encodeURIComponent(schedule.id)}` +
            `&select=id,sequence_number,label,payment_type,amount,percentage,due_rule,fixed_due_date,milestone_description` +
            `&order=sequence_number.asc`
        );
        return { schedule, items: Array.isArray(items) ? items : [] };
      },
      sourceErrors
    );

    const notices = await safeLoad(
      "notices",
      async () => {
        const rows = await supabaseRequest(
          `tenant_contract_legal_notices?tenant_id=eq.${tid}` +
            `&select=confirmed_at,confirmed_notices,confirmed_enabled,updated_at&limit=1`
        );
        return Array.isArray(rows) ? rows[0] : null;
      },
      sourceErrors
    );

    const invoices =
      (await safeLoad("invoices", async () => loadInvoices(tenantId, project), sourceErrors)) ||
      [];

    const payments =
      (await safeLoad(
        "payments",
        async () =>
          loadPayments(
            tenantId,
            project,
            invoices.map((i) => i.id).filter(Boolean)
          ),
        sourceErrors
      )) || [];

    const dayProgress =
      (await safeLoad(
        "dayProgress",
        async () => loadDayProgress(tenantId, projectId),
        sourceErrors
      )) || [];

    const noticesEffective =
      notices && notices.confirmed_notices && notices.confirmed_at
        ? {
            confirmed_at: notices.confirmed_at,
            confirmed_notices: notices.confirmed_notices,
            confirmed_enabled: notices.confirmed_enabled || null,
          }
        : null;

    const intelligence = deriveProjectIntelligence({
      tenantId,
      projectId,
      project,
      quote,
      setup,
      schedule: scheduleBundle?.schedule || null,
      scheduleItems: scheduleBundle?.items || [],
      notices,
      noticesEffective,
      invoices,
      payments,
      dayProgress,
      sourceErrors,
    });

    return json(200, {
      ok: true,
      ...intelligence,
      sources: {
        errors: Object.keys(sourceErrors),
        read_only: true,
        role_policy: ROLE_POLICY,
      },
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    return json(500, {
      ok: false,
      error: "Project intelligence is temporarily unavailable",
      code: "server_error",
    });
  }
};

exports._test = {
  validateGetQuery,
  validUuid,
  OWNER_ADMIN_ROLES,
  ROLE_POLICY,
  ALLOWED_QUERY_KEYS,
};
