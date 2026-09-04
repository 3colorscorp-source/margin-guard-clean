const { buildRefreshedSessionCookie } = require("./_lib/session");
const { requireFcOwnerTenant } = require("./_lib/fc-owner-context");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { getStripeKeyForPlatform } = require("./_lib/stripe");
const { persistTenantFinancialSummary } = require("./_lib/persist-tenant-financial-summary");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const STRIPE_API = "https://api.stripe.com/v1";

const BUCKET_KEYS = ["operating", "savings", "profit", "tax_reserve"];

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stripeGet(path) {
  const response = await fetch(`${STRIPE_API}${path}`, {
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
    const msg = data?.error?.message || "Stripe request failed";
    throw new Error(msg);
  }
  return data;
}

/**
 * Stripe documents balance on the Account object; some API versions expose /balance or /balances.
 */
async function tryGetAccountBalanceSubresource(fcaId) {
  const headers = { Authorization: `Bearer ${getStripeKeyForPlatform()}` };
  for (const suffix of ["/balances", "/balance"]) {
    const response = await fetch(
      `${STRIPE_API}/financial_connections/accounts/${encodeURIComponent(fcaId)}${suffix}`,
      { method: "GET", headers }
    );
    if (!response.ok) {
      continue;
    }
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_e) {
      data = {};
    }
    if (data?.error) {
      continue;
    }
    if (data?.object === "financial_connections.account" && data.balance) {
      return data;
    }
    if (data && typeof data === "object" && (data.cash || data.current || data.type)) {
      return { balance: data };
    }
  }
  return null;
}

/**
 * Balance refresh only (features[]=balance). No transactions, ownership, or money movement.
 */
async function stripeRefreshBalanceOnly(fcaId) {
  const form = new URLSearchParams();
  form.append("features[]", "balance");

  const response = await fetch(
    `${STRIPE_API}/financial_connections/accounts/${encodeURIComponent(fcaId)}/refresh`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getStripeKeyForPlatform()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    data = { raw: text };
  }
  if (!response.ok) {
    const msg = data?.error?.message || "Stripe balance refresh failed";
    throw new Error(msg);
  }
  return data;
}

function accountHolderCustomerId(account) {
  const h = account?.account_holder;
  if (h?.type === "customer" && h?.customer) {
    return String(h.customer);
  }
  return "";
}

/**
 * Amounts from balance hash: smallest currency unit (e.g. cents for USD).
 */
function usdMinorFromBalance(bal) {
  if (!bal || typeof bal !== "object") {
    return null;
  }

  let minor = null;
  const cashAvail = bal.cash?.available;
  if (cashAvail && typeof cashAvail === "object") {
    const v = cashAvail.usd ?? cashAvail.USD;
    if (v != null && Number.isFinite(Number(v))) {
      minor = Number(v);
    }
  }

  if (minor == null && bal.type === "credit" && bal.credit?.used) {
    const used = bal.credit.used;
    if (typeof used === "object") {
      const v = used.usd ?? used.USD;
      if (v != null && Number.isFinite(Number(v))) {
        minor = Math.abs(Number(v));
      }
    }
  }

  if (minor == null && bal.current && typeof bal.current === "object") {
    const v = bal.current.usd ?? bal.current.USD;
    if (v != null && Number.isFinite(Number(v))) {
      minor = Number(v);
    }
  }

  return minor;
}

/**
 * Uses balance on Financial Connections Account (or embedded balance object). Values in major units.
 */
function usdAvailableMajorUnits(accountOrWrapper) {
  const bal = accountOrWrapper?.balance;
  const minor = usdMinorFromBalance(bal);
  if (minor == null) {
    return null;
  }
  return minor / 100;
}

async function readUsdBalanceForAccount(fcaId, expectedCustomerId) {
  await stripeRefreshBalanceOnly(fcaId);

  const maxAttempts = 12;
  for (let i = 0; i < maxAttempts; i += 1) {
    if (i > 0) {
      await sleep(400 + i * 200);
    }

    const subRes = await tryGetAccountBalanceSubresource(fcaId);
    if (subRes) {
      const usdSub = usdAvailableMajorUnits(subRes);
      if (usdSub != null) {
        return usdSub;
      }
    }

    const account = await stripeGet(
      `/financial_connections/accounts/${encodeURIComponent(fcaId)}`
    );

    const cust = accountHolderCustomerId(account);
    if (cust && cust !== String(expectedCustomerId)) {
      throw new Error("Linked account does not belong to this tenant");
    }

    const refresh = account?.balance_refresh;
    if (refresh?.status === "failed") {
      return 0;
    }

    const usd = usdAvailableMajorUnits(account);
    if (usd != null) {
      return usd;
    }
  }

  return 0;
}

function createHandler(deps = {}) {
  const requireOwner = deps.requireFcOwnerTenant || requireFcOwnerTenant;
  const requestFn = deps.supabaseRequest || supabaseRequest;
  const refreshCookie = deps.buildRefreshedSessionCookie || buildRefreshedSessionCookie;
  const readBalance = deps.readUsdBalanceForAccount || readUsdBalanceForAccount;
  const persistSummary = deps.persistTenantFinancialSummary || persistTenantFinancialSummary;

  return async function handler(event) {
  let cookieHeaders = {};
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const gate = await requireOwner(event, deps);
    if (!gate.ok) {
      return gate.response;
    }
    const { session, tenant } = gate;

    const refreshedCookie = refreshCookie(session, tenant);
    if (refreshedCookie) {
      cookieHeaders = { "Set-Cookie": refreshedCookie };
    }

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId) {
      return json(403, { error: "Tenant has no Stripe customer" }, cookieHeaders);
    }

    const tid = encodeURIComponent(tenant.id);
    const mapRows = await requestFn(
      `tenant_financial_account_mapping?tenant_id=eq.${tid}&select=bucket,tenant_bank_account_id`
    );
    const mappings = Array.isArray(mapRows) ? mapRows : [];
    const accountIds = [
      ...new Set(
        mappings.map((r) => r?.tenant_bank_account_id).filter(Boolean)
      ),
    ];

    let accountsById = {};
    if (accountIds.length) {
      const inList = accountIds.map(encodeURIComponent).join(",");
      const accRows = await requestFn(
        `tenant_bank_accounts?id=in.(${inList})&tenant_id=eq.${tid}&status=eq.active&select=id,stripe_fc_account_id,status,tenant_bank_connection_id`
      );
      const accs = Array.isArray(accRows) ? accRows : [];
      const connIds = [
        ...new Set(accs.map((a) => a?.tenant_bank_connection_id).filter(Boolean)),
      ];
      let activeConnIds = new Set();
      if (connIds.length) {
        const connIn = connIds.map(encodeURIComponent).join(",");
        const connRows = await requestFn(
          `tenant_bank_connections?id=in.(${connIn})&tenant_id=eq.${tid}&status=eq.active&select=id`
        );
        activeConnIds = new Set(
          (Array.isArray(connRows) ? connRows : []).map((c) => c?.id).filter(Boolean)
        );
      }
      accountsById = Object.fromEntries(
        accs
          .filter((a) => {
            const connId = a?.tenant_bank_connection_id;
            if (!connId) {
              return true;
            }
            return activeConnIds.has(connId);
          })
          .map((a) => [a.id, a])
      );
    }

    const bucketToFca = {};
    for (const row of mappings) {
      const b = row?.bucket;
      const aid = row?.tenant_bank_account_id;
      const acc = aid ? accountsById[aid] : null;
      const fca = acc?.stripe_fc_account_id;
      const st = acc?.status;
      if (!fca || typeof fca !== "string" || st !== "active") {
        continue;
      }
      if (BUCKET_KEYS.includes(b)) {
        bucketToFca[b] = fca.trim();
      }
    }

    const amounts = {
      operating: 0,
      savings: 0,
      profit: 0,
      tax_reserve: 0,
    };

    for (const key of BUCKET_KEYS) {
      const fcaId = bucketToFca[key];
      if (!fcaId) {
        continue;
      }
      if (!fcaId.startsWith("fca_")) {
        continue;
      }
      amounts[key] = await readBalance(fcaId, customerId);
    }

    const operating_balance = amounts.operating;
    const savings_balance = amounts.savings;
    const profit_balance = amounts.profit;
    const tax_reserve_balance = amounts.tax_reserve;
    const cash_on_hand =
      operating_balance + savings_balance + profit_balance + tax_reserve_balance;

    const periodDate = new Date().toISOString().slice(0, 10);
    const currency = "USD";
    const nowIso = new Date().toISOString();

    const payload = {
      period_start: periodDate,
      period_end: periodDate,
      currency,
      total_inflow: 0,
      total_outflow: 0,
      net_change: 0,
      source: "stripe",
      operating_balance,
      savings_balance,
      profit_balance,
      tax_reserve_balance,
      cash_on_hand,
      last_sync_at: nowIso,
      computed_at: nowIso,
      updated_at: nowIso,
    };

    const saved = await persistSummary({
      tenantId: tenant.id,
      payload,
      supabaseRequest: requestFn,
    });
    if (!saved || saved.persisted !== true) {
      return json(500, { error: "summary_persist_failed" }, cookieHeaders);
    }

    return json(
      200,
      {
        ok: true,
        persisted: true,
        period_start: periodDate,
        period_end: periodDate,
        currency,
        operating_balance,
        savings_balance,
        profit_balance,
        tax_reserve_balance,
        cash_on_hand,
        last_sync_at: payload.last_sync_at,
      },
      cookieHeaders
    );
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" }, cookieHeaders);
  }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
