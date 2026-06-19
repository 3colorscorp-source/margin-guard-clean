/**
 * Step 3E-C19-H — read-only quote reprice preview (owner/admin). No writes.
 */

const {
  UUID_RE,
  evaluateQuoteEditGuard,
} = require("./_lib/quote-edit-guard");
const {
  json,
  pickFirst,
  requireOwnerOrAdmin,
  fetchQuoteRepriceRow,
  serializeRepriceState,
} = require("./_lib/quote-reprice-helpers");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { ok: false, error: "Method Not Allowed" });
    }

    const { tenant } = await requireOwnerOrAdmin(event);
    const tenantId = String(tenant.id);
    const qs = event.queryStringParameters || {};

    const quoteId = pickFirst(qs.quote_id, qs.quoteId);
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

    const guard = await evaluateQuoteEditGuard(tenantId, quoteId);

    if (guard.notFound) {
      return json(404, {
        ok: false,
        error: "Quote not found",
        code: "quote_not_found",
      });
    }

    if (guard.invalidQuoteId) {
      return json(400, {
        ok: false,
        error: "Invalid quote_id",
        code: "invalid_quote_id",
      });
    }

    const repriceRow = await fetchQuoteRepriceRow(tenantId, quoteId);

    return json(200, {
      ok: true,
      quote: guard.quote,
      edit: {
        is_editable: guard.edit?.is_editable === true,
        locked: guard.edit?.locked === true,
        lock_reasons: guard.edit?.lock_reasons || [],
        warnings: guard.edit?.warnings || [],
      },
      reprice: serializeRepriceState(repriceRow),
    });
  } catch (err) {
    if (err?.isGuardError) {
      return json(err.statusCode || 403, {
        ok: false,
        error: err.message,
        code: err.code,
      });
    }
    console.error("[get-tenant-quote-reprice]", err);
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
