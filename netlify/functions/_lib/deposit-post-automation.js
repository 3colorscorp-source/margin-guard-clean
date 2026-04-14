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
  const key = process.env.RESEND_API_KEY;
  const from =
    pickFirst(
      process.env.RESEND_FROM_EMAIL,
      process.env.DEPOSIT_EMAIL_FROM,
      process.env.RESEND_FROM
    ) || "";
  if (!key || !from || !to) {
    return;
  }
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
    if (!r.ok) {
      const t = await r.text();
      logAutomation(`resend-${label}`, new Error(t));
    }
  } catch (err) {
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
    }

    const internalHook = process.env.DEPOSIT_INTERNAL_WEBHOOK_URL;
    if (internalHook) {
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
