const { buildRefreshedSessionCookie } = require("./_lib/session");
const { requireFcOwnerTenant } = require("./_lib/fc-owner-context");
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

function normalizeFingerprintPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function accountFingerprint(meta) {
  const institution = normalizeFingerprintPart(meta?.institution_name);
  const last4 = normalizeFingerprintPart(meta?.account_last4);
  const category = normalizeFingerprintPart(meta?.account_category);
  if (!institution || !last4 || !category) {
    return "";
  }
  return institution + "|" + last4 + "|" + category;
}

function firstRow(data) {
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  if (data && typeof data === "object") {
    return data;
  }
  return null;
}

function fcaIdFromEntry(entry) {
  if (typeof entry === "string") {
    const s = entry.trim();
    return s.startsWith("fca_") ? s : "";
  }
  if (entry && typeof entry === "object" && typeof entry.id === "string") {
    const s = String(entry.id).trim();
    return s.startsWith("fca_") ? s : "";
  }
  return "";
}

/**
 * Session expand often returns a subset; list-by-session is authoritative. Merge by fca id.
 */
function mergeAccountLists(sessionAccounts, listedAccounts) {
  const map = new Map();
  for (const entry of sessionAccounts) {
    const id = fcaIdFromEntry(entry);
    if (id) {
      map.set(id, entry);
    }
  }
  for (const entry of listedAccounts) {
    const id = fcaIdFromEntry(entry);
    if (!id) {
      continue;
    }
    const prev = map.get(id);
    if (!prev) {
      map.set(id, entry);
      continue;
    }
    const prevMeta =
      prev && typeof prev === "object" && (prev.institution_name || prev.last4);
    const nextMeta =
      entry && typeof entry === "object" && (entry.institution_name || entry.last4);
    if (nextMeta && !prevMeta) {
      map.set(id, entry);
    }
  }
  return Array.from(map.values());
}

function createHandler(deps = {}) {
  const requireOwner = deps.requireFcOwnerTenant || requireFcOwnerTenant;
  const requestFn = deps.supabaseRequest || supabaseRequest;
  const refreshCookie = deps.buildRefreshedSessionCookie || buildRefreshedSessionCookie;
  const retrieveFcSession =
    deps.retrieveFinancialConnectionsSession || retrieveFinancialConnectionsSession;
  const listAccounts = deps.listAccountsForSession || listAccountsForSession;
  const retrieveAccount =
    deps.retrieveFinancialConnectionsAccount || retrieveFinancialConnectionsAccount;

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

    const fcSession = await retrieveFcSession(fcSessionId);
    const sessionCust = sessionCustomerId(fcSession);
    if (!sessionCust || sessionCust !== customerId) {
      return json(
        403,
        { error: "Financial Connections session does not belong to this tenant" },
        cookieHeaders
      );
    }

    const connRows = await requestFn(
      `tenant_bank_connections?tenant_id=eq.${encodeURIComponent(
        tenant.id
      )}&stripe_fc_session_id=eq.${encodeURIComponent(fcSessionId)}&select=id`
    );
    const connection = Array.isArray(connRows) ? connRows[0] : null;
    if (!connection?.id) {
      return json(404, { error: "Connection not found for this session" }, cookieHeaders);
    }

    const connectionId = connection.id;

    const fromSession = normalizeSessionAccounts(fcSession);
    const fromList = await listAccounts(fcSessionId);
    const accountList = mergeAccountLists(fromSession, fromList);

    const linked = [];
    const savedAccounts = [];
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
          acct = await retrieveAccount(rawId);
        } catch (_e) {
          acct = { id: rawId };
        }
      }

      const fcaId = String(acct.id || rawId).trim();
      if (!fcaId.startsWith("fca_")) {
        continue;
      }

      const meta = accountMetaFromStripe(acct);

      const existingRows = await requestFn(
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
        const updated = firstRow(
          await requestFn(`tenant_bank_accounts?id=eq.${encodeURIComponent(existing.id)}`, {
            method: "PATCH",
            prefer: "return=representation",
            body: {
              tenant_bank_connection_id: connectionId,
              status: "active",
              stripe_fc_account_id: fcaId,
              provider_account_id: fcaId,
              institution_name: meta.institution_name,
              account_last4: meta.account_last4,
              account_category: meta.account_category,
              tenant_label: meta.tenant_label,
              updated_at: new Date().toISOString(),
            },
          })
        );
        savedAccounts.push({
          id: updated?.id || existing.id,
          fcaId,
          fingerprint: accountFingerprint(meta),
        });
        linked.push(fcaId);
        continue;
      }

      const inserted = firstRow(
        await requestFn("tenant_bank_accounts", {
          method: "POST",
          prefer: "return=representation",
          body: {
            tenant_id: tenant.id,
            tenant_bank_connection_id: connectionId,
            stripe_fc_account_id: fcaId,
            provider_account_id: fcaId,
            status: "active",
            institution_name: meta.institution_name,
            account_last4: meta.account_last4,
            account_category: meta.account_category,
            tenant_label: meta.tenant_label,
          },
        })
      );
      if (inserted?.id) {
        savedAccounts.push({
          id: inserted.id,
          fcaId,
          fingerprint: accountFingerprint(meta),
        });
      }
      linked.push(fcaId);
    }

    const tid = encodeURIComponent(tenant.id);
    const mapRows = await requestFn(
      `tenant_financial_account_mapping?tenant_id=eq.${tid}&select=bucket,tenant_bank_account_id`
    );
    const mappings = Array.isArray(mapRows) ? mapRows : [];
    const assignedById = new Map();
    for (const mapping of mappings) {
      const assignedId = String(mapping?.tenant_bank_account_id || "").trim();
      if (!assignedId || assignedById.has(assignedId)) {
        continue;
      }
      const assigned = firstRow(
        await requestFn(
          `tenant_bank_accounts?id=eq.${encodeURIComponent(
            assignedId
          )}&tenant_id=eq.${tid}&select=id,tenant_id,stripe_fc_account_id,institution_name,account_last4,account_category,status`
        )
      );
      if (!assigned?.id) {
        continue;
      }
      if (assigned.tenant_id && String(assigned.tenant_id) !== String(tenant.id)) {
        continue;
      }
      assignedById.set(assigned.id, assigned);
    }

    const newByFingerprint = new Map();
    for (const saved of savedAccounts) {
      if (!saved.fingerprint || !saved.id) {
        continue;
      }
      const list = newByFingerprint.get(saved.fingerprint) || [];
      list.push(saved);
      newByFingerprint.set(saved.fingerprint, list);
    }
    const mappedByFingerprint = new Map();
    for (const mapping of mappings) {
      const assigned = assignedById.get(mapping?.tenant_bank_account_id);
      const fp = accountFingerprint(assigned);
      if (!fp) {
        continue;
      }
      const list = mappedByFingerprint.get(fp) || [];
      list.push(mapping);
      mappedByFingerprint.set(fp, list);
    }

    const currentFcas = new Set(savedAccounts.map((row) => row.fcaId));
    const remappedBuckets = [];
    for (const mapping of mappings) {
      const bucket = String(mapping?.bucket || "").trim();
      const oldId = String(mapping?.tenant_bank_account_id || "").trim();
      const assigned = oldId ? assignedById.get(oldId) : null;
      if (!bucket || !assigned) {
        continue;
      }
      if (currentFcas.has(String(assigned.stripe_fc_account_id || ""))) {
        continue;
      }
      const fp = accountFingerprint(assigned);
      const candidates = fp ? newByFingerprint.get(fp) || [] : [];
      const siblings = fp ? mappedByFingerprint.get(fp) || [] : [];
      if (!fp || candidates.length !== 1 || siblings.length !== 1) {
        continue;
      }
      const next = candidates[0];
      if (!next?.id || next.id === oldId) {
        continue;
      }
      await requestFn(
        `tenant_financial_account_mapping?tenant_id=eq.${tid}&bucket=eq.${encodeURIComponent(bucket)}`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: { tenant_bank_account_id: next.id },
        }
      );
      await requestFn(
        `tenant_bank_accounts?id=eq.${encodeURIComponent(oldId)}&tenant_id=eq.${tid}`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: { status: "inactive", updated_at: new Date().toISOString() },
        }
      );
      remappedBuckets.push(bucket);
    }

    await requestFn(`tenant_bank_connections?id=eq.${encodeURIComponent(connectionId)}`, {
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
        remapped_buckets: remappedBuckets,
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
exports.accountFingerprint = accountFingerprint;
