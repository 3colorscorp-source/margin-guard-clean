/**
 * Post-deposit automation runs only after Stripe payment is verified and the quote PATCH succeeded.
 * Entry: runDepositPostAutomation({ quote, tenant, payment })
 * Must never throw — failures are logged only so deposit confirmation is never blocked.
 */

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available.");
}

function logAutomation(stage, err) {
  const msg = err && (err.message || String(err));
  console.error(`[deposit-post-automation:${stage}]`, msg || err);
}

function logInfo(...args) {
  console.log("[deposit-post-automation]", ...args);
}

function logWarn(...args) {
  console.warn("[deposit-post-automation]", ...args);
}

function maskEmailForLog(email) {
  const s = String(email || "").trim();
  if (!s.includes("@")) return "(no-email)";
  const [local, dom] = s.split("@");
  if (!dom) return "(invalid)";
  const maskLocal = !local ? "*" : local.length <= 2 ? "**" : `${local[0]}***`;
  return `${maskLocal}@${dom}`;
}

function getResendApiKey() {
  return String(process.env.RESEND_API_KEY || "").trim();
}

/** Resolved From address (verified domain in Resend). */
function getResendFromAddress() {
  return pickFirst(
    process.env.RESEND_FROM_EMAIL,
    process.env.DEPOSIT_EMAIL_FROM,
    process.env.RESEND_FROM
  );
}

/**
 * One-line observability: whether Netlify env is set up for Resend (does not log secrets).
 */
function logResendEnvironmentSummary() {
  const keyPresent = Boolean(getResendApiKey());
  const fromAddr = getResendFromAddress();
  const fromPresent = Boolean(fromAddr);

  logInfo("Resend config check:", {
    RESEND_API_KEY: keyPresent ? "present" : "MISSING",
    RESEND_FROM_EMAIL:
      pickFirst(process.env.RESEND_FROM_EMAIL) || "(not set)",
    DEPOSIT_EMAIL_FROM:
      pickFirst(process.env.DEPOSIT_EMAIL_FROM) || "(not set)",
    RESEND_FROM: pickFirst(process.env.RESEND_FROM) || "(not set)",
    resolvedFrom: fromPresent ? fromAddr : "MISSING — set RESEND_FROM_EMAIL (or DEPOSIT_EMAIL_FROM / RESEND_FROM)"
  });

  if (!keyPresent || !fromPresent) {
    logWarn(
      "Resend is not fully configured; direct emails will not send until RESEND_API_KEY and a verified RESEND_FROM_EMAIL (or fallback) are set.",
      "Fallbacks: use DEPOSIT_CLIENT_CONFIRM_WEBHOOK_URL and/or DEPOSIT_INTERNAL_WEBHOOK_URL for Zapier/Make, or configure Resend in Netlify environment variables."
    );
  }
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function postJsonWebhook(url, payload, label) {
  const u = String(url || "").trim();
  if (!u.startsWith("http://") && !u.startsWith("https://")) {
    return;
  }
  try {
    const r = await fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text();
      logAutomation(`${label}-response`, new Error(`${r.status} ${t}`));
    }
  } catch (err) {
    logAutomation(`${label}-fetch`, err);
  }
}

async function tryResendEmail({ to, subject, html, replyTo, label }) {
  const key = getResendApiKey();
  const from = getResendFromAddress();

  if (!to) {
    logWarn(`email [${label}] skipped: no recipient address`);
    return;
  }
  if (!key) {
    logWarn(
      `email [${label}] skipped: RESEND_API_KEY is not set — cannot send to ${maskEmailForLog(to)}`
    );
    return;
  }
  if (!from) {
    logWarn(
      `email [${label}] skipped: no From address — set RESEND_FROM_EMAIL (or DEPOSIT_EMAIL_FROM / RESEND_FROM) in Netlify env`
    );
    return;
  }

  logInfo(`email [${label}] send attempt start`, {
    to: maskEmailForLog(to),
    subject: String(subject || "").slice(0, 80),
    from
  });

  try {
    const body = {
      from,
      to: [to],
      subject,
      html
    };
    const rt = pickFirst(replyTo);
    if (rt) {
      body.reply_to = rt;
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const rawText = await r.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!r.ok) {
      logWarn(`email [${label}] send failure`, {
        status: r.status,
        body: rawText?.slice(0, 500) || ""
      });
      logAutomation(`resend-${label}`, new Error(rawText || String(r.status)));
      return;
    }

    logInfo(`email [${label}] send success`, {
      id: parsed?.id || null,
      to: maskEmailForLog(to)
    });
  } catch (err) {
    logWarn(`email [${label}] send failure (network/exception)`, err?.message || err);
    logAutomation(`resend-${label}`, err);
  }
}

async function tryOptionalQuoteFieldPatch({ supabaseUrl, serviceRoleKey, publicToken, tenantId }) {
  const rawKey = String(process.env.DEPOSIT_AUTOMATION_QUOTE_FIELD_KEY || "").trim();
  if (!rawKey || !/^[a-z_][a-z0-9_]*$/i.test(rawKey)) {
    return;
  }
  if (!("DEPOSIT_AUTOMATION_QUOTE_FIELD_VALUE" in process.env)) {
    return;
  }
  const val = process.env.DEPOSIT_AUTOMATION_QUOTE_FIELD_VALUE;
  const tenantPart = `&tenant_id=eq.${encodeURIComponent(String(tenantId))}`;
  const nowIso = new Date().toISOString();
  const body = { [rawKey]: val, updated_at: nowIso };
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/quotes?public_token=eq.${encodeURIComponent(publicToken)}${tenantPart}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          Prefer: "return=minimal"
        },
        body: JSON.stringify(body)
      }
    );
    if (!r.ok) {
      const t = await r.text();
      logAutomation("optional-quote-patch", new Error(`${r.status} ${t}`));
    }
  } catch (err) {
    logAutomation("optional-quote-patch", err);
  }
}

/**
 * @param {object} params
 * @param {object} params.quote - Quote row (scoped to this payment)
 * @param {object} params.tenant - Tenant branding (must include id; from loadTenantDisplayForTenantId + id)
 * @param {object} params.payment - { amount, currency, paidAt, stripeCheckoutSessionId, publicToken }
 */
async function runDepositPostAutomation(params) {
  try {
    const { quote, tenant, payment } = params || {};
    if (!quote || !tenant || !payment) {
      logAutomation("missing-args", new Error("quote, tenant, and payment are required"));
      return;
    }

    logResendEnvironmentSummary();

    const quoteId = quote.id;
    const tenantId = tenant.id;
    const publicToken = String(payment.publicToken || "").trim();

    const clientEmail = pickFirst(quote.client_email);
    const clientName = pickFirst(quote.client_name, "Customer");
    const projectName = pickFirst(quote.title, quote.project_name, "Project");
    const currency = String(quote.currency || payment.currency || "usd").toUpperCase();
    const paidAmount = Number(payment.amount);
    const paidAtIso = String(payment.paidAt || "");
    const stripeCheckoutSessionId = String(payment.stripeCheckoutSessionId || "");

    const businessName = pickFirst(
      tenant.branding_business_name,
      tenant.business_name,
      quote.business_name,
      quote.company_name,
      tenant.fallback_name,
      tenant.branding_company_name
    );
    const displayBusiness = businessName || "Your contractor";

    const tenantNotifyEmail = pickFirst(
      tenant.business_email,
      process.env.DEPOSIT_INTERNAL_NOTIFY_EMAIL,
      process.env.TENANT_NOTIFY_EMAIL
    );

    const baseWebhookPayload = {
      event: "deposit_received",
      quote: {
        id: quoteId,
        client_name: clientName,
        client_email: clientEmail,
        project_name: projectName,
        currency
      },
      tenant: {
        id: tenantId,
        business_name: displayBusiness,
        business_email: tenantNotifyEmail || ""
      },
      payment: {
        amount: paidAmount,
        currency,
        paid_at: paidAtIso,
        stripe_checkout_session_id: stripeCheckoutSessionId,
        public_token: publicToken
      }
    };

    const clientHook = process.env.DEPOSIT_CLIENT_CONFIRM_WEBHOOK_URL;
    if (clientHook) {
      logInfo(
        "client confirmation: using DEPOSIT_CLIENT_CONFIRM_WEBHOOK_URL (Resend not used for this channel when webhook is set)"
      );
      await postJsonWebhook(
        clientHook,
        { ...baseWebhookPayload, channel: "client_confirmation" },
        "client-webhook"
      );
    } else if (clientEmail) {
      const subj = "Deposit received — your project is secured";
      const html = `<p>Hi ${escapeHtml(clientName)},</p>
<p>Your deposit has been received successfully. <strong>Your project is secured.</strong></p>
<p>We will contact you within <strong>24 hours</strong> with next steps.</p>
<p style="margin-top:16px;color:#666;font-size:13px;">${escapeHtml(displayBusiness)}</p>`;
      await tryResendEmail({
        to: clientEmail,
        subject: subj,
        html,
        replyTo: tenantNotifyEmail,
        label: "client"
      });
    } else {
      logInfo(
        "client confirmation: skipped (no client email on quote and no DEPOSIT_CLIENT_CONFIRM_WEBHOOK_URL)"
      );
    }

    const internalHook = process.env.DEPOSIT_INTERNAL_WEBHOOK_URL;
    if (internalHook) {
      logInfo(
        "internal notification: using DEPOSIT_INTERNAL_WEBHOOK_URL (Resend not used for this channel when webhook is set)"
      );
      await postJsonWebhook(
        internalHook,
        { ...baseWebhookPayload, channel: "internal_notification" },
        "internal-webhook"
      );
    } else if (tenantNotifyEmail) {
      const internalSubj = `Deposit received — ${projectName}`;
      const html = `<p><strong>Deposit received</strong></p>
<ul>
<li><strong>Client:</strong> ${escapeHtml(clientName)}</li>
<li><strong>Project:</strong> ${escapeHtml(projectName)}</li>
<li><strong>Deposit amount:</strong> ${escapeHtml(String(paidAmount))} ${escapeHtml(currency)}</li>
<li><strong>Timestamp:</strong> ${escapeHtml(paidAtIso)}</li>
</ul>`;
      await tryResendEmail({
        to: tenantNotifyEmail,
        subject: internalSubj,
        html,
        label: "internal"
      });
    } else {
      logInfo(
        "internal notification: skipped (no tenant/business notify email and no DEPOSIT_INTERNAL_WEBHOOK_URL)"
      );
    }

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (supabaseUrl && serviceRoleKey && publicToken && tenantId) {
      await tryOptionalQuoteFieldPatch({
        supabaseUrl,
        serviceRoleKey,
        publicToken,
        tenantId
      });
    }
  } catch (err) {
    logAutomation("runDepositPostAutomation", err);
  }
}

module.exports = { runDepositPostAutomation };
