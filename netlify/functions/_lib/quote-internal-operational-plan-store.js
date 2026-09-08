const INTERNAL_PLAN_RPC = "mg_confirm_quote_operational_plan";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function textOf(err) {
  return String((err && (err.message || err.text || err.supabaseRaw)) || err || "");
}

function isMissingInternalPlanStorage(err) {
  const text = textOf(err).toLowerCase();
  const namesStorage =
    text.includes("quote_internal_operational_plans") || text.includes(INTERNAL_PLAN_RPC);
  return namesStorage && /42p01|42883|pgrst202|does not exist|schema cache|could not find/.test(text);
}

function membershipIdForRpc(raw) {
  const id = String(raw || "").trim();
  return UUID_RE.test(id) ? id : null;
}

function assignDefinedRpcParam(body, key, value) {
  if (value === undefined || value === null || value === "") return;
  body[key] = value;
}

/**
 * PostgREST matches RPC overloads from JSON keys and inferred types.
 * JSON null has no type, so Owner (no membership) used to send
 * p_membership_id: null and get PGRST202 even though the 11-arg RPC exists.
 * Omit optional nulls so SQL defaults apply.
 */
function buildConfirmRpcBody(args) {
  const patch = (args && args.quotePatch) || {};
  const body = {
    p_tenant_id: args && args.tenantId,
    p_quote_id: args && args.quoteId,
    p_document: args && args.document,
    p_schema_version: Number(args && args.document && args.document.schema_version) || 1,
    p_operational_plan: Array.isArray(patch.operational_plan) ? patch.operational_plan : [],
  };
  assignDefinedRpcParam(body, "p_membership_id", membershipIdForRpc(args && args.membershipId));
  if (patch.estimated_days != null && Number.isFinite(Number(patch.estimated_days))) {
    body.p_estimated_days = Number(patch.estimated_days);
  }
  if (patch.estimated_hours != null && Number.isFinite(Number(patch.estimated_hours))) {
    body.p_estimated_hours = Number(patch.estimated_hours);
  }
  assignDefinedRpcParam(body, "p_start_date", patch.start_date);
  assignDefinedRpcParam(body, "p_due_date", patch.due_date);
  assignDefinedRpcParam(
    body,
    "p_scope_of_work",
    patch.scope_of_work != null && String(patch.scope_of_work).trim()
      ? String(patch.scope_of_work).trim()
      : null
  );
  return body;
}

function normalizeRpcResult(data) {
  let value = data;
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === "object" && value[INTERNAL_PLAN_RPC] != null) {
    value = value[INTERNAL_PLAN_RPC];
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (_e) {
      value = null;
    }
  }
  return value && typeof value === "object" ? value : null;
}

function safePersistLogFields(persistError) {
  const raw = textOf(persistError)
    .slice(0, 400)
    .replace(/https?:\/\/[^\s"'\\]+/gi, "[redacted]");
  return {
    persist_code: persistError && persistError.code ? String(persistError.code).slice(0, 80) : "",
    persist_message: raw,
  };
}

async function confirmOperationalPlanAtomic(supabaseReq, args) {
  const data = await supabaseReq(`rpc/${INTERNAL_PLAN_RPC}`, {
    method: "POST",
    body: buildConfirmRpcBody(args),
  });
  const result = normalizeRpcResult(data);
  if (!result || result.ok !== true || String(result.quote_id || "") !== String(args.quoteId)) {
    const err = new Error("Operational plan transaction did not confirm the quote update.");
    err.code = "internal_plan_transaction_failed";
    throw err;
  }
  return result;
}

async function rollbackNewlyPublishedQuote(supabaseReq, tenantId, quoteId) {
  const rows = await supabaseReq(
    `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
    { method: "DELETE", headers: { Prefer: "return=representation" } }
  );
  return Array.isArray(rows) && rows.some((row) => String(row && row.id) === String(quoteId));
}

async function persistPublishedInternalPlan(supabaseReq, args) {
  try {
    const result = await confirmOperationalPlanAtomic(supabaseReq, args);
    return { ok: true, result };
  } catch (persistError) {
    let rollbackOk = false;
    let rollbackError = null;
    try {
      rollbackOk = await rollbackNewlyPublishedQuote(
        supabaseReq,
        args.tenantId,
        args.quoteId
      );
    } catch (err) {
      rollbackError = err;
    }
    return {
      ok: false,
      persistError,
      rollbackOk,
      rollbackError,
      retrySafe: rollbackOk,
      needsManualRepair: !rollbackOk,
    };
  }
}

module.exports = {
  INTERNAL_PLAN_RPC,
  UUID_RE,
  textOf,
  isMissingInternalPlanStorage,
  membershipIdForRpc,
  buildConfirmRpcBody,
  normalizeRpcResult,
  safePersistLogFields,
  confirmOperationalPlanAtomic,
  rollbackNewlyPublishedQuote,
  persistPublishedInternalPlan,
};
