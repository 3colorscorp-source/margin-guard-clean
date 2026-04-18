const { readSessionFromEvent } = require("./_lib/session");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { getStripeKeyForPlatform } = require("./_lib/stripe");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

const STRIPE_API = "https://api.stripe.com/v1";

const BUCKET_KEYS = ["operating", "savings", "profit", "tax_reserve"];

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
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
 * Uses only balance.* numeric fields. Amounts are in the smallest currency unit (e.g. cents for USD).
 */
function usdAvailableMajorUnits(account) {
  const bal = account?.balance;
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
  if (minor == null && bal.current && typeof bal.current === "object") {
    const v = bal.current.usd ?? bal.current.USD;
    if (v != null && Number.isFinite(Number(v))) {
      minor = Number(v);
    }
  }

  if (minor == null) {
    return null;
  }

  return minor / 100;
}

async function readUsdBalanceForAccount(fcaId, expectedCustomerId) {
  await stripeRefreshBalanceOnly(fcaId);

  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i += 1) {
    if (i > 0) {
      await sleep(500 + i * 150);
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

    const customerId = String(tenant.stripe_customer_id || "").trim();
    if (!customerId || String(customerId) !== String(session.c)) {
      return json(403, { error: "Session does not match tenant billing profile" });
    }

    const tid = encodeURIComponent(tenant.id);
    const mapRows = await supabaseRequest(
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
      const accRows = await supabaseRequest(
        `tenant_bank_accounts?id=in.(${inList})&tenant_id=eq.${tid}&select=id,stripe_fc_account_id,status`
      );
      const accs = Array.isArray(accRows) ? accRows : [];
      accountsById = Object.fromEntries(accs.map((a) => [a.id, a]));
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
      amounts[key] = await readUsdBalanceForAccount(fcaId, customerId);
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

    const existingRows = await supabaseRequest(
      `tenant_financial_summary?tenant_id=eq.${tid}&period_start=eq.${periodDate}&period_end=eq.${periodDate}&currency=eq.${currency}&select=id`
    );
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;

    const payload = {
      total_inflow: 0,
      total_outflow: 0,
      net_change: 0,
      source: "stripe",
      operating_balance,
      savings_balance,
      profit_balance,
      tax_reserve_balance,
      cash_on_hand,
      computed_at: nowIso,
      updated_at: nowIso,
    };

    if (existing?.id) {
      await supabaseRequest(`tenant_financial_summary?id=eq.${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        body: payload,
      });
    } else {
      await supabaseRequest("tenant_financial_summary", {
        method: "POST",
        body: {
          tenant_id: tenant.id,
          period_start: periodDate,
          period_end: periodDate,
          currency,
          ...payload,
        },
      });
    }

    return json(200, {
      ok: true,
      period_start: periodDate,
      period_end: periodDate,
      currency,
      operating_balance,
      savings_balance,
      profit_balance,
      tax_reserve_balance,
      cash_on_hand,
    });
  } catch (err) {
    return json(500, { error: err.message || "Unexpected error" });
  }
};
