/**
 * Step 3E-C19-H — owner/admin safe quote reprice (pricing engine only; audit append).
 * No auto-resend, no publish, no project/invoice/payment side effects.
 */

const { supabaseRequest } = require("./_lib/supabase-admin");
const {
  UUID_RE,
  evaluateQuoteEditGuard,
} = require("./_lib/quote-edit-guard");
const {
  json,
  pickFirst,
  parseBody,
  findUnknownBodyKeys,
  loadTenantSettingsFromLatestSnapshot,
  normalizeWorkersLaborDays,
  validateRepriceWorkers,
  validateWorkersForPricing,
  parsePricingStage,
  normalizeReason,
  buildSettingsSnapshotForAudit,
  buildEngineResultForAudit,
  computeRepriceFinancials,
  parseManualRepriceInput,
  applyOwnerManualPrice,
  requireOwnerOrAdmin,
  sanitizeWorkersForTenantPricing,
} = require("./_lib/quote-reprice-helpers");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const { tenant, membership } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);

    const body = parseBody(event.body);
    if (body == null) {
      return json(400, { ok: false, error: "Invalid JSON", code: "invalid_json" });
    }

    const unknownKeys = findUnknownBodyKeys(body);
    if (unknownKeys.length > 0) {
      return json(400, {
        ok: false,
        error: "Unknown or disallowed fields in request body.",
        code: "unknown_fields",
        fields: unknownKeys,
      });
    }

    const quoteId = pickFirst(body.quote_id);
    if (!quoteId) {
      return json(400, {
        ok: false,
        error: "quote_id is required",
        code: "quote_id_required",
      });
    }
    if (!UUID_RE.test(quoteId)) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    const workersCheck = validateRepriceWorkers(body.workers);
    if (!workersCheck.ok) {
      return json(400, {
        ok: false,
        error: workersCheck.error,
        code: workersCheck.code,
      });
    }

    const stageParsed = parsePricingStage(body.pricing_stage);
    if (!stageParsed.ok) {
      return json(400, {
        ok: false,
        error: stageParsed.error,
        code: stageParsed.code,
      });
    }
    const pricingStage = stageParsed.stage;

    const reasonRaw = normalizeReason(body.reason);
    if (reasonRaw && typeof reasonRaw === "object" && reasonRaw.error === "reason_too_long") {
      return json(400, {
        ok: false,
        error: `reason must be at most ${reasonRaw.max} characters`,
        code: "reason_too_long",
      });
    }
    const reason = typeof reasonRaw === "string" ? reasonRaw : null;

    const guardBefore = await evaluateQuoteEditGuard(tenantId, quoteId);

    if (guardBefore.notFound) {
      return json(404, {
        ok: false,
        error: "Quote not found",
        code: "quote_not_found",
      });
    }

    if (guardBefore.invalidQuoteId) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    if (guardBefore.edit?.locked || !guardBefore.edit?.is_editable) {
      return json(422, {
        ok: false,
        error: "Quote is locked and cannot be repriced.",
        code: "quote_locked",
        lock_reasons: guardBefore.edit?.lock_reasons || [],
      });
    }

    const warnings = guardBefore.edit?.warnings || [];
    if (warnings.includes("quote_viewed_or_sent") && body.confirm_sent_update !== true) {
      return json(409, {
        ok: false,
        error:
          "This quote was already sent or viewed. Set confirm_sent_update to true to proceed.",
        code: "sent_quote_confirmation_required",
        warnings,
      });
    }

    const previousTotal = Number(guardBefore.quote?.total);
    const previousDeposit = Number(guardBefore.quote?.deposit_required);

    const tenantSettings = await loadTenantSettingsFromLatestSnapshot(tenantId);
    const workersNormalized = normalizeWorkersLaborDays(body.workers, tenantSettings);
    const workersSanitized = sanitizeWorkersForTenantPricing(workersNormalized);
    const wCheck = validateWorkersForPricing(workersSanitized);
    if (!wCheck.ok) {
      return json(400, {
        ok: false,
        error: wCheck.error,
        code: wCheck.code,
      });
    }

    let financials;
    try {
      financials = computeRepriceFinancials(workersSanitized, pricingStage, tenantSettings);
    } catch (err) {
      return json(500, {
        ok: false,
        error: err?.message || "Unable to compute quote pricing from inputs.",
        code: "pricing_engine_error",
      });
    }

    const manualInput = parseManualRepriceInput(body);
    if (manualInput.active) {
      if (manualInput.ok === false) {
        return json(400, {
          ok: false,
          error: manualInput.error,
          code: manualInput.code,
        });
      }
      const manualApplied = applyOwnerManualPrice(financials, manualInput.price);
      if (!manualApplied.ok) {
        const statusCode = manualApplied.code === "price_below_minimum" ? 422 : 500;
        return json(statusCode, {
          ok: false,
          error: manualApplied.error,
          code: manualApplied.code,
          minimum_price: manualApplied.minimum_price,
        });
      }
      financials = manualApplied.financials;
    }

    const minPrice = Number(financials.minimum_price);
    const newTotal = Number(financials.total);
    const newDeposit = Number(financials.deposit_required);

    if (newTotal + 1e-9 < minPrice) {
      return json(422, {
        ok: false,
        error: `Offered price cannot be below the minimum allowed (${minPrice.toFixed(2)}).`,
        code: "price_below_minimum",
        minimum_price: minPrice,
      });
    }

    if (
      !Number.isFinite(newTotal) ||
      newTotal <= 0 ||
      !Number.isFinite(newDeposit) ||
      newDeposit <= 0
    ) {
      return json(500, {
        ok: false,
        error: "Computed total or deposit is invalid.",
        code: "pricing_engine_error",
      });
    }

    const workersPersisted = workersNormalized.map((w) => {
      const row = {
        type: w.type === "helper" ? "helper" : "installer",
        days: Math.max(0, Number(w.days || 0)),
      };
      if (w.name) row.name = w.name;
      if (w.hours != null && Number(w.hours) > 0) row.hours = Number(w.hours);
      return row;
    });

    const nowIso = new Date().toISOString();
    const tidEnc = encodeURIComponent(tenantId);
    const qidEnc = encodeURIComponent(quoteId);

    const quotePatch = {
      total: newTotal,
      deposit_required: newDeposit,
      pricing_workers: workersPersisted,
      pricing_stage: pricingStage,
      last_repriced_at: nowIso,
      last_repriced_by: membership.id,
      last_reprice_reason: reason,
      last_minimum_price: financials.minimum_price,
      last_negotiation_price: financials.negotiation,
      last_recommended_price: financials.recommended_price,
      updated_at: nowIso,
    };

    await supabaseRequest(`quotes?id=eq.${qidEnc}&tenant_id=eq.${tidEnc}`, {
      method: "PATCH",
      body: quotePatch,
    });

    const auditRow = {
      tenant_id: tenantId,
      quote_id: quoteId,
      edited_by: membership.id,
      edited_at: nowIso,
      previous_total: Number.isFinite(previousTotal) ? previousTotal : null,
      new_total: newTotal,
      previous_deposit_required: Number.isFinite(previousDeposit) ? previousDeposit : null,
      new_deposit_required: newDeposit,
      minimum_price: financials.minimum_price,
      negotiation_price: financials.negotiation,
      recommended_price: financials.recommended_price,
      pricing_stage: pricingStage,
      workers_snapshot: workersPersisted,
      settings_snapshot: buildSettingsSnapshotForAudit(tenantSettings),
      engine_result: buildEngineResultForAudit(financials),
      reason,
      source: "owner_reprice",
    };

    try {
      await supabaseRequest("quote_price_edits", {
        method: "POST",
        body: auditRow,
      });
    } catch (auditErr) {
      console.error("[reprice-tenant-quote] audit insert failed after quote patch", {
        quote_id: quoteId,
        tenant_id: tenantId,
        message: auditErr?.message || String(auditErr),
      });
      return json(500, {
        ok: false,
        error:
          "Quote was repriced but audit history could not be saved. Contact support before repricing again.",
        code: "audit_insert_failed",
        quote_id: quoteId,
        reprice: {
          previous_total: Number.isFinite(previousTotal) ? previousTotal : null,
          new_total: newTotal,
          previous_deposit_required: Number.isFinite(previousDeposit) ? previousDeposit : null,
          new_deposit_required: newDeposit,
        },
      });
    }

    const guardAfter = await evaluateQuoteEditGuard(tenantId, quoteId);

    return json(200, {
      ok: true,
      quote: guardAfter.quote,
      reprice: {
        previous_total: Number.isFinite(previousTotal) ? previousTotal : null,
        new_total: newTotal,
        previous_deposit_required: Number.isFinite(previousDeposit) ? previousDeposit : null,
        new_deposit_required: newDeposit,
        minimum_price: financials.minimum_price,
        negotiation_price: financials.negotiation,
        recommended_price: financials.recommended_price,
        pricing_stage: pricingStage,
        workers: workersPersisted,
        reason,
      },
      audit: { inserted: true },
      message: "Quote price updated safely.",
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("[reprice-tenant-quote]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
