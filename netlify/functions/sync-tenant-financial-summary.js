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
const BUCKET_BALANCE_COLUMN = {
  operating: "operating_balance",
  savings: "savings_balance",
  profit: "profit_balance",
  tax_reserve: "tax_reserve_balance",
};

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
function currencyMinor(bag) {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    return null;
  }
  const v = bag.usd ?? bag.USD;
  if (v == null || !Number.isFinite(Number(v))) {
    return null;
  }
  return Number(v);
}

function usdMinorFromBalance(bal) {
  if (!bal || typeof bal !== "object" || Array.isArray(bal)) {
    return null;
  }

  // Cash accounts show spendable money. Zero is a real balance.
  if (bal.type === "cash") {
    const available = currencyMinor(bal.cash?.available);
    if (available != null) {
      return available;
    }
    return currencyMinor(bal.current);
  }

  // Legacy payloads omit balance.type. Keep current, then available.
  const posted = currencyMinor(bal.current);
  if (posted != null) {
    return posted;
  }

  const available = currencyMinor(bal.cash?.available);
  if (available != null) {
    return available;
  }

  if (bal.type === "credit") {
    const used = currencyMinor(bal.credit?.used);
    if (used != null) {
      return Math.abs(used);
    }
  }

  return null;
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

function assertAccountCustomer(account, expectedCustomerId) {
  const cust = accountHolderCustomerId(account);
  if (cust && expectedCustomerId && cust !== String(expectedCustomerId)) {
    throw new Error("Linked account does not belong to this tenant");
  }
}

function balanceAsOf(account) {
  const n = Number(account?.balance?.as_of);
  return Number.isFinite(n) ? n : 0;
}

function refreshAttemptedAt(account) {
  const n = Number(account?.balance_refresh?.last_attempted_at);
  return Number.isFinite(n) ? n : 0;
}

function nextRefreshAt(account) {
  const n = Number(account?.balance_refresh?.next_refresh_available_at);
  return Number.isFinite(n) ? n : 0;
}

function stillUpdatingError() {
  const err = new Error("Bank balance is still updating. Try Sync again in a minute.");
  err.retryable = true;
  return err;
}

function finiteBalance(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isRetryableRefreshError(err) {
  return err?.retryable === true;
}

function normalizeBalanceRead(result) {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.prototype.hasOwnProperty.call(result, "amount")
  ) {
    return {
      amount: result.amount,
      refresh_pending: result.refresh_pending === true,
    };
  }
  return { amount: result, refresh_pending: false };
}

async function readUsdBalanceForAccount(fcaId, expectedCustomerId, deps = {}) {
  const getAccount = deps.stripeGet || stripeGet;
  const refreshBalance = deps.stripeRefreshBalanceOnly || stripeRefreshBalanceOnly;
  const wait = deps.sleep || sleep;
  const nowUnix = typeof deps.nowUnix === "function"
    ? deps.nowUnix
    : () => Math.floor(Date.now() / 1000);

  const before = await getAccount(
    `/financial_connections/accounts/${encodeURIComponent(fcaId)}`
  );
  assertAccountCustomer(before, expectedCustomerId);
  const beforeAsOf = balanceAsOf(before);
  const beforeAttempt = refreshAttemptedAt(before);
  const beforeStatus = before?.balance_refresh?.status;
  const refreshNotDue = nextRefreshAt(before) > nowUnix();
  const alreadyPending = beforeStatus === "pending";
  let lastUsable = usdAvailableMajorUnits(before);
  let lastStatus = beforeStatus;

  // A second Sync must not start another refresh while Bank of America is
  // still answering the first one. Restarting keeps the status on pending.
  let started = false;
  let refreshError = null;
  if (!alreadyPending && !refreshNotDue) {
    try {
      await refreshBalance(fcaId);
      started = true;
    } catch (err) {
      refreshError = err;
    }
  }

  let sawPending = alreadyPending;
  const maxAttempts = 5;
  for (let i = 0; i < maxAttempts; i += 1) {
    if (i > 0) {
      await wait(800);
    }

    const account = await getAccount(
      `/financial_connections/accounts/${encodeURIComponent(fcaId)}`
    );
    assertAccountCustomer(account, expectedCustomerId);
    const status = account?.balance_refresh?.status;
    const asOf = balanceAsOf(account);
    const attempted = refreshAttemptedAt(account);
    const newer = asOf > beforeAsOf || attempted > beforeAttempt;
    lastStatus = status;
    if (status === "pending") {
      sawPending = true;
    }
    const posted = usdAvailableMajorUnits(account);
    if (posted != null) {
      lastUsable = posted;
    }
    const usable = status === "succeeded" && posted != null;
    const fromThisRefresh = newer || sawPending;
    const latestAlreadyThere = !started && (refreshNotDue || refreshError);
    if (usable && (fromThisRefresh || latestAlreadyThere)) {
      return { amount: posted, refresh_pending: false };
    }
    if (status === "failed" && newer) {
      throw new Error("Bank balance refresh failed. Try Sync again in a minute.");
    }
  }

  if (lastStatus === "pending" && lastUsable != null) {
    return { amount: lastUsable, refresh_pending: true };
  }
  if (refreshError && !sawPending) {
    const detail = refreshError.message || "Bank balance refresh failed";
    throw new Error(`Bank balance could not be refreshed. ${detail}`);
  }
  throw stillUpdatingError();
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
          `tenant_bank_connections?id=in.(${connIn})&tenant_id=eq.${tid}&select=id,status`
        );
        const usableStatus = new Set(["active", "pending", "requires_action"]);
        activeConnIds = new Set(
          (Array.isArray(connRows) ? connRows : [])
            .filter((c) => usableStatus.has(String(c?.status || "")))
            .map((c) => c?.id)
            .filter(Boolean)
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

    const mappedCount = mappings.filter(
      (row) => BUCKET_KEYS.includes(row?.bucket) && row?.tenant_bank_account_id
    ).length;
    if (mappedCount > 0 && !Object.keys(bucketToFca).length) {
      return json(
        409,
        {
          error:
            "Mapped bank accounts could not be synced. Reconnect the bank, then try Sync again.",
        },
        cookieHeaders
      );
    }

    const previousRows = await requestFn(
      `tenant_financial_summary?tenant_id=eq.${tid}&currency=eq.USD&select=operating_balance,savings_balance,profit_balance,tax_reserve_balance`
    );
    const previous = Array.isArray(previousRows) ? previousRows[0] : null;

    const amounts = {
      operating: 0,
      savings: 0,
      profit: 0,
      tax_reserve: 0,
    };

    const refreshState = {};
    const preservedState = {};
    const blockedBuckets = [];
    await Promise.all(
      BUCKET_KEYS.map(async (key) => {
        const fcaId = bucketToFca[key];
        if (!fcaId || !fcaId.startsWith("fca_")) {
          return;
        }
        const column = BUCKET_BALANCE_COLUMN[key];
        try {
          const read = normalizeBalanceRead(await readBalance(fcaId, customerId));
          const amount = finiteBalance(read.amount);
          if (amount == null) {
            if (!read.refresh_pending) {
              throw new Error("Stripe did not return a balance");
            }
            const prior = finiteBalance(previous?.[column]);
            if (prior == null) {
              blockedBuckets.push(key);
              return;
            }
            amounts[key] = prior;
            refreshState[key] = true;
            preservedState[key] = true;
            return;
          }
          amounts[key] = amount;
          refreshState[key] = read.refresh_pending;
        } catch (err) {
          if (!isRetryableRefreshError(err)) {
            throw err;
          }
          const prior = finiteBalance(previous?.[column]);
          if (prior == null) {
            blockedBuckets.push(key);
            return;
          }
          amounts[key] = prior;
          refreshState[key] = true;
          preservedState[key] = true;
        }
      })
    );
    if (blockedBuckets.length) {
      throw stillUpdatingError();
    }
    const pending_buckets = BUCKET_KEYS.filter((key) => refreshState[key] === true);
    const preserved_buckets = BUCKET_KEYS.filter((key) => preservedState[key] === true);
    const refresh_pending = pending_buckets.length > 0;

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
        computed_at: payload.computed_at,
        refresh_pending,
        pending_buckets,
        preserved_buckets,
      },
      cookieHeaders
    );
  } catch (err) {
    const retry = err?.retryable === true;
    return json(
      retry ? 409 : 500,
      { error: err.message || "Unexpected error", retry },
      cookieHeaders
    );
  }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
exports.usdMinorFromBalance = usdMinorFromBalance;
exports.usdAvailableMajorUnits = usdAvailableMajorUnits;
exports.readUsdBalanceForAccount = readUsdBalanceForAccount;
