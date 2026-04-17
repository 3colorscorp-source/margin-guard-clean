const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const STRIPE_API = "https://api.stripe.com/v1";

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
    return {};
  }
}

function getStripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }
  return key;
}

async function retrieveFinancialConnectionsSession(sessionId) {
  const url = `${STRIPE_API}/financial_connections/sessions/${encodeURIComponent(
    sessionId
  )}?expand[]=accounts`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getStripeSecretKey()}`,
    },
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    data = { raw: text };
  }

  if (!response.ok) {
    const msg = data?.error?.message || "Stripe session retrieve failed";
    throw new Error(msg);
  }

  return data;
}

function sessionCustomerId(fcSession) {
  const holder = fcSession?.account_holder;
  if (holder?.type === "customer" && holder?.customer) {
    return String(holder.customer);
  }
  return "";
}

exports.handler = async (event) => {
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

    const body = parseBody(event.body);
    const fcSessionId = String(
      body.financial_connections_session_id || body.session_id || ""
    ).trim();
    if (!fcSessionId) {
      return json(400, { error: "financial_connections_session_id is required" });
    }

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId || String(customerId) !== String(session.c)) {
      return json(403, { error: "Session does not match tenant billing profile" });
    }

    const fcSession = await retrieveFinancialConnectionsSession(fcSessionId);
    const sessionCust = sessionCustomerId(fcSession);
    if (!sessionCust || sessionCust !== customerId) {
      return json(403, { error: "Financial Connections session does not belong to this tenant" });
    }

    const connRows = await supabaseRequest(
      `tenant_bank_connections?tenant_id=eq.${encodeURIComponent(
        tenant.id
      )}&stripe_fc_session_id=eq.${encodeURIComponent(fcSessionId)}&select=id`
    );
    const connection = Array.isArray(connRows) ? connRows[0] : null;
    if (!connection?.id) {
      return json(404, { error: "Connection not found for this session" });
    }

    const connectionId = connection.id;
    const accountsObj = fcSession?.accounts;
    const accountList = Array.isArray(accountsObj?.data)
      ? accountsObj.data
      : Array.isArray(accountsObj)
        ? accountsObj
        : [];

    const linked = [];
    for (const acct of accountList) {
      const fcaId = acct && typeof acct.id === "string" ? acct.id.trim() : "";
      if (!fcaId || !fcaId.startsWith("fca_")) {
        continue;
      }

      const existingRows = await supabaseRequest(
        `tenant_bank_accounts?stripe_fc_account_id=eq.${encodeURIComponent(
          fcaId
        )}&select=id,tenant_id`
      );
      const existing = Array.isArray(existingRows) ? existingRows[0] : null;

      if (existing?.id) {
        if (String(existing.tenant_id) !== String(tenant.id)) {
          return json(403, { error: "Linked account is already associated with another workspace" });
        }
        await supabaseRequest(`tenant_bank_accounts?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          body: {
            tenant_bank_connection_id: connectionId,
            status: "active",
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

    return json(200, {
      ok: true,
      connection_id: connectionId,
      linked_account_ids: linked,
      count: linked.length,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
