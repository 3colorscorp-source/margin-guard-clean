const INTERNAL_PLAN_RPC = "mg_confirm_quote_operational_plan";

function textOf(err) {
  return String((err && (err.message || err.text || err.supabaseRaw)) || err || "");
}

function isMissingInternalPlanStorage(err) {
  const text = textOf(err).toLowerCase();
  const namesStorage =
    text.includes("quote_internal_operational_plans") || text.includes(INTERNAL_PLAN_RPC);
  return namesStorage && /42p01|42883|pgrst202|does not exist|schema cache|could not find/.test(text);
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

async function confirmOperationalPlanAtomic(supabaseReq, args) {
  const data = await supabaseReq(`rpc/${INTERNAL_PLAN_RPC}`, {
    method: "POST",
    body: {
      p_tenant_id: args.tenantId,
      p_quote_id: args.quoteId,
      p_document: args.document,
      p_schema_version: Number(args.document && args.document.schema_version) || 1,
      p_membership_id: args.membershipId || null,
      p_operational_plan: args.quotePatch.operational_plan || [],
      p_estimated_days: args.quotePatch.estimated_days,
      p_estimated_hours: args.quotePatch.estimated_hours,
      p_start_date: args.quotePatch.start_date || null,
      p_due_date: args.quotePatch.due_date || null,
      p_scope_of_work: args.quotePatch.scope_of_work || null,
    },
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
  isMissingInternalPlanStorage,
  normalizeRpcResult,
  confirmOperationalPlanAtomic,
  rollbackNewlyPublishedQuote,
  persistPublishedInternalPlan,
};
