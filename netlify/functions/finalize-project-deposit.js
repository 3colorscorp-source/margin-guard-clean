const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const { supabaseRequest } = require("./_lib/supabase-admin");
const { assertPublicDepositAllowed } = require("./_lib/quote-deposit-gate");
const { loadTenantDisplayForTenantId } = require("./_lib/tenant-display");
const { runDepositPostAutomation } = require("./_lib/deposit-post-automation");
const { logStripeSecretDiagnostics } = require("./_lib/stripe-env-log");
const { getStripeKey } = require("./_lib/stripe");
const {
  preservedPaidAt,
  publicDepositFields,
  readSchedulingDeposit,
  stripePaidAt,
  validatePaidCheckoutSession,
} = require("./_lib/verified-scheduling-deposit");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function failure(status, code, error) {
  return json(status, { ok: false, code, error });
}

function rpcResult(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === "object") return data;
  return null;
}

function recordedText(value) {
  return String(value || "").trim().toLowerCase();
}

function needsReviewRecord(recorded) {
  return (
    recordedText(recorded?.disposition) === "needs_review" ||
    recordedText(recorded?.outcome) === "needs_review"
  );
}

function appliedCreditRecord(recorded) {
  const outcome = recordedText(recorded?.outcome);
  return (
    recordedText(recorded?.disposition) === "applied" &&
    String(recorded?.payment_id || "").trim() !== "" &&
    (outcome === "applied_new" || outcome === "already_recorded")
  );
}

async function recordVerifiedSchedulingDeposit(args) {
  const data = await supabaseRequest("rpc/record_verified_scheduling_deposit", {
    method: "POST",
    body: {
      p_tenant_id: args.tenantId,
      p_quote_id: args.quoteId,
      p_project_id: args.projectId,
      p_checkout_session_id: args.sessionId,
      p_stripe_account_id: args.stripeAccountId,
      p_currency: args.currency,
      p_gross_amount: args.grossAmount,
      p_paid_at: args.paidAt,
    },
  });
  return rpcResult(data);
}

async function retrieveConnectSession(stripeSecretKey, connectAccountId, sessionId) {
  const sessionUrl =
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}` +
    "?expand[]=payment_intent.latest_charge.balance_transaction";
  const stripeRes = await fetch(sessionUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Stripe-Account": connectAccountId,
    },
  });
  const stripeText = await stripeRes.text();
  let session = {};
  try {
    session = stripeText ? JSON.parse(stripeText) : {};
  } catch {
    session = {};
  }
  if (!stripeRes.ok) {
    return {
      ok: false,
      error: session?.error?.message || stripeText || "Unable to retrieve Stripe session",
    };
  }
  return { ok: true, session };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    let stripeSecretKey;
    try {
      stripeSecretKey = getStripeKey();
    } catch (_e) {
      return json(500, { error: "Missing env STRIPE_SECRET_KEY or STRIPE_PLATFORM_SECRET_KEY" });
    }

    logStripeSecretDiagnostics(stripeSecretKey, "finalize-project-deposit");

    const body = parseBody(event.body);
    const sessionId = String(body.sessionId || body.session_id || "").trim();
    const suppliedToken = String(body.public_token || body.publicToken || "").trim();
    if (!sessionId || !suppliedToken) {
      return failure(400, "missing_session", "Missing sessionId or public token.");
    }

    let quoteRows;
    try {
      quoteRows = await supabaseRequest(
        `quotes?public_token=eq.${encodeURIComponent(suppliedToken)}&tenant_id=not.is.null&select=id,tenant_id,public_token,deposit_required,deposit_paid,deposit_paid_at,deposit_paid_amount,accepted_at,exclusions_initials,exclusions_acknowledged_at,change_order_acknowledged_at,client_name,client_email,project_name,title,currency,business_name,company_name&limit=2`,
        { method: "GET" }
      );
    } catch (err) {
      return json(502, { error: err.message || "Failed to read quote" });
    }

    if (!Array.isArray(quoteRows) || quoteRows.length === 0) {
      return json(404, { error: "Quote not found for this payment." });
    }
    if (quoteRows.length > 1) {
      return json(500, { error: "Invalid quote reference" });
    }

    const quoteRow = quoteRows[0];
    if (!quoteRow?.tenant_id || !quoteRow?.id) {
      return json(404, { error: "Quote not found for this payment." });
    }
    quoteRow.public_token = String(quoteRow.public_token || suppliedToken).trim();

    const gate = assertPublicDepositAllowed(quoteRow);
    if (!gate.ok) {
      return json(403, { error: gate.error });
    }

    let connectAccountId = "";
    try {
      const tenantRows = await supabaseRequest(
        `tenants?id=eq.${encodeURIComponent(String(quoteRow.tenant_id))}&select=stripe_account_id&limit=1`,
        { method: "GET" }
      );
      connectAccountId = String(
        Array.isArray(tenantRows) && tenantRows[0] ? tenantRows[0].stripe_account_id || "" : ""
      ).trim();
    } catch (err) {
      return json(502, { error: err.message || "Failed to read Stripe account" });
    }
    if (!connectAccountId) {
      return failure(
        403,
        "stripe_connect_required",
        "Stripe Connect account is required to verify this payment."
      );
    }

    const retrieved = await retrieveConnectSession(stripeSecretKey, connectAccountId, sessionId);
    if (!retrieved.ok) {
      return json(502, { error: retrieved.error || "Unable to retrieve Stripe session" });
    }

    const verified = validatePaidCheckoutSession(retrieved.session, quoteRow, suppliedToken);
    if (!verified.ok) {
      return failure(verified.status, verified.code, verified.error);
    }
    const stripePaid = stripePaidAt(retrieved.session);
    if (!stripePaid) {
      return failure(
        422,
        "stripe_paid_at_missing",
        "Stripe did not provide a payment timestamp. The deposit was not recorded."
      );
    }

    const view = await readSchedulingDeposit(supabaseRequest, quoteRow);
    if (view.state === "unavailable") {
      return failure(503, "deposit_verification_unavailable", view.copy);
    }
    if (!view.project?.id) {
      return failure(
        409,
        "deposit_project_unresolved",
        "This estimate does not have one matching project to receive the scheduling payment."
      );
    }

    const priorPaidAt = preservedPaidAt(quoteRow);
    const rpcArgs = {
      tenantId: quoteRow.tenant_id,
      quoteId: quoteRow.id,
      projectId: view.project.id,
      sessionId,
      stripeAccountId: connectAccountId,
      currency: "usd",
      grossAmount: verified.grossAmount,
      paidAt: stripePaid,
    };
    let recorded;
    try {
      recorded = await recordVerifiedSchedulingDeposit(rpcArgs);
    } catch (rpcErr) {
      const duplicate =
        Number(rpcErr?.status) === 409 ||
        /23505|duplicate key/i.test(String(rpcErr?.message || ""));
      if (!duplicate) {
        return failure(
          500,
          "deposit_ledger_failed",
          "Stripe payment was verified, but the scheduling deposit was not recorded. Do not pay again."
        );
      }
      try {
        recorded = await recordVerifiedSchedulingDeposit(rpcArgs);
      } catch (_retryErr) {
        return failure(
          500,
          "deposit_ledger_failed",
          "Stripe payment was verified, but the scheduling deposit was not recorded. Do not pay again."
        );
      }
    }
    if (!recorded || recorded.ok !== true) {
      return failure(
        409,
        recorded?.code || "deposit_conflict",
        "This scheduling payment could not be applied. Do not pay again."
      );
    }
    if (needsReviewRecord(recorded)) {
      return failure(
        409,
        "deposit_needs_review",
        "This additional scheduling payment was kept for owner review. It was not credited again. Do not pay again."
      );
    }
    if (!appliedCreditRecord(recorded)) {
      return failure(
        409,
        "deposit_conflict",
        "This scheduling payment could not be confirmed. Do not pay again."
      );
    }

    const siteUrl = (
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      ""
    ).replace(/\/+$/, "");

    if (recorded.outcome === "applied_new" && !priorPaidAt) {
      let tenant = { id: String(quoteRow.tenant_id) };
      try {
        const td = await loadTenantDisplayForTenantId(quoteRow.tenant_id);
        tenant = { id: String(quoteRow.tenant_id), ...td };
      } catch (tenantErr) {
        console.error(
          "[finalize-project-deposit] tenant branding load",
          tenantErr?.message || tenantErr
        );
      }
      try {
        await runDepositPostAutomation({
          quote: quoteRow,
          tenant,
          payment: {
            amount: verified.grossAmount,
            currency: "usd",
            paidAt: stripePaid,
            stripeCheckoutSessionId: retrieved.session.id,
            publicToken: suppliedToken,
          },
        });
      } catch (autoErr) {
        console.error(
          "[finalize-project-deposit] runDepositPostAutomation",
          autoErr?.message || autoErr
        );
      }
    }

    const synced = publicDepositFields({ state: "paid", copy: "" });
    return json(200, {
      ok: true,
      public_token: suppliedToken,
      paid_amount: verified.grossAmount,
      replay: recordedText(recorded.outcome) === "already_recorded",
      deposit_verification_state: synced.deposit_verification_state,
      redirect_url: `${siteUrl}/estimate-public.html?token=${encodeURIComponent(suppliedToken)}`,
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Server error" });
  }
};
