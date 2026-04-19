const { buildRefreshedSessionCookie, readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { getStripeKeyForPlatform } = require("./_lib/stripe");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const STRIPE_API = "https://api.stripe.com/v1";

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function stripeGet(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${getStripeKeyForPlatform()}` },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    data = { raw: text };
  }
  if (!response.ok) {
    const msg = data?.error?.message || `Stripe GET failed (${response.status})`;
    throw new Error(msg);
  }
  return data;
}

async function retrieveFinancialConnectionsSession(sessionId) {
  const url = `${STRIPE_API}/financial_connections/sessions/${encodeURIComponent(
    sessionId
  )}?expand[]=accounts`;
  return stripeGet(url);
}

async function listAccountsForSession(sessionId) {
  const out = [];
  let startingAfter = "";
  for (let page = 0; page < 20; page += 1) {
    const qs = new URLSearchParams();
    qs.set("session", sessionId);
    qs.set("limit", "100");
    if (startingAfter) {
      qs.set("starting_after", startingAfter);
    }
    const data = await stripeGet(`${STRIPE_API}/financial_connections/accounts?${qs.toString()}`);
    const batch = Array.isArray(data?.data) ? data.data : [];
    out.push(...batch);
    if (!data?.has_more || !batch.length) {
      break;
    }
    startingAfter = batch[batch.length - 1]?.id || "";
    if (!startingAfter) {
      break;
    }
  }
  return out;
}

async function retrieveFinancialConnectionsAccount(accountId) {
  return stripeGet(
    `${STRIPE_API}/financial_connections/accounts/${encodeURIComponent(accountId)}`
  );
}

function sessionCustomerId(fcSession) {
  const holder = fcSession?.account_holder;
  if (holder?.type === "customer" && holder?.customer) {
    return String(holder.customer);
  }
  return "";
}

function accountMetaFromStripe(acct) {
  if (!acct || typeof acct !== "object") {
    return { institution_name: "", account_last4: "", account_category: "", tenant_label: "" };
  }
  const institution_name = String(acct.institution_name || "").trim();
  const account_last4 = String(acct.last4 || "").trim();
  const sub = String(acct.subcategory || "").trim();
  const cat = String(acct.category || "").trim();
  const account_category = sub || cat || "";
  const tenant_label =
    institution_name && account_last4
      ? `${institution_name} *${account_last4}`
      : institution_name || "";
  return { institution_name, account_last4, account_category, tenant_label };
}

function normalizeSessionAccounts(fcSession) {
  const accountsObj = fcSession?.accounts;
  const fromData = Array.isArray(accountsObj?.data) ? accountsObj.data : [];
  if (fromData.length) {
    return fromData;
  }
  return [];
}

exports.handler = async (event) => {
  let cookieHeaders = {};
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(404, { error: "Tenant not found" });
    }

    const refreshedCookie = buildRefreshedSessionCookie(session, tenant);
    if (refreshedCookie) {
      cookieHeaders = { "Set-Cookie": refreshedCookie };
    }

    const body = parseBody(event.body);
    const fcSessionId = String(
      body.financial_connections_session_id || body.session_id || ""
    ).trim();
    if (!fcSessionId) {
      return json(400, { error: "financial_connections_session_id is required" }, cookieHeaders);
    }

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId) {
      return json(403, { error: "Tenant has no Stripe customer" }, cookieHeaders);
    }

    const fcSession = await retrieveFinancialConnectionsSession(fcSessionId);
    const sessionCust = sessionCustomerId(fcSession);
    if (!sessionCust || sessionCust !== customerId) {
      return json(
        403,
        { error: "Financial Connections session does not belong to this tenant" },
        cookieHeaders
      );
    }

    const connRows = await supabaseRequest(
      `tenant_bank_connections?tenant_id=eq.${encodeURIComponent(
        tenant.id
      )}&stripe_fc_session_id=eq.${encodeURIComponent(fcSessionId)}&select=id`
    );
    const connection = Array.isArray(connRows) ? connRows[0] : null;
    if (!connection?.id) {
      return json(404, { error: "Connection not found for this session" }, cookieHeaders);
    }

    const connectionId = connection.id;

    let accountList = normalizeSessionAccounts(fcSession);
    if (!accountList.length) {
      accountList = await listAccountsForSession(fcSessionId);
    }

    const linked = [];
    for (const raw of accountList) {
      let acct = raw;
      const rawId =
        typeof raw === "string"
          ? raw.trim()
          : raw && typeof raw.id === "string"
            ? raw.id.trim()
            : "";
      if (!rawId || !rawId.startsWith("fca_")) {
        continue;
      }
      if (!acct?.institution_name && !acct?.last4) {
        try {
          acct = await retrieveFinancialConnectionsAccount(rawId);
        } catch (_e) {
          acct = { id: rawId };
        }
      }

      const fcaId = String(acct.id || rawId).trim();
      if (!fcaId.startsWith("fca_")) {
        continue;
      }

      const meta = accountMetaFromStripe(acct);

      const existingRows = await supabaseRequest(
        `tenant_bank_accounts?stripe_fc_account_id=eq.${encodeURIComponent(
          fcaId
        )}&select=id,tenant_id`
      );
      const existing = Array.isArray(existingRows) ? existingRows[0] : null;

      if (existing?.id) {
        if (String(existing.tenant_id) !== String(tenant.id)) {
          return json(
            403,
            { error: "Linked account is already associated with another workspace" },
            cookieHeaders
          );
        }
        await supabaseRequest(`tenant_bank_accounts?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          body: {
            tenant_bank_connection_id: connectionId,
            status: "active",
            institution_name: meta.institution_name,
            account_last4: meta.account_last4,
            account_category: meta.account_category,
            tenant_label: meta.tenant_label,
            updated_at: new Date().toISOString(),
          },
        });
        linked.push(fcaId);
        continue;
      }

      await supabaseRequest("tenant_bank_accounts", {
        method: "POST",
        body: {
          tenant_id: tenant.id,
          tenant_bank_connection_id: connectionId,
          stripe_fc_account_id: fcaId,
          status: "active",
          institution_name: meta.institution_name,
          account_last4: meta.account_last4,
          account_category: meta.account_category,
          tenant_label: meta.tenant_label,
        },
      });
      linked.push(fcaId);
    }

    await supabaseRequest(`tenant_bank_connections?id=eq.${encodeURIComponent(connectionId)}`, {
      method: "PATCH",
      body: {
        status: "active",
        updated_at: new Date().toISOString(),
      },
    });

    return json(
      200,
      {
        ok: true,
        connection_id: connectionId,
        linked_account_ids: linked,
        count: linked.length,
      },
      cookieHeaders
    );
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" }, cookieHeaders);
  }
};
