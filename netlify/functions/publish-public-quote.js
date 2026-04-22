const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest, getSupabaseConfig } = require("./_lib/supabase-admin");
const { loadTenantDisplayForTenantId } = require("./_lib/tenant-display");
const { resolveTenantFromSession } = require("./_lib/tenant-for-session");
const { makePublicToken } = require("./_lib/public-token");
const { calculateQuotePublishFinancials } = require("./_lib/pricing-engine");

const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime.");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Atomic per-tenant annual quote number (UTC year). Requires RPC + migration.
 */
async function allocateNextQuoteNumberForTenant(tenantId) {
  const data = await supabaseRequest("rpc/allocate_next_quote_number", {
    method: "POST",
    body: { p_tenant_id: tenantId }
  });
  let obj = data;
  if (Array.isArray(data) && data.length && typeof data[0] === "object") {
    const row = data[0];
    obj = row.allocate_next_quote_number != null ? row.allocate_next_quote_number : row;
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Invalid response from allocate_next_quote_number");
  }
  const quote_year = Number(obj.quote_year);
  const quote_sequence = Number(obj.quote_sequence);
  const quote_number_display = String(obj.quote_number_display || "").trim();
  if (!Number.isFinite(quote_year) || !Number.isFinite(quote_sequence) || !quote_number_display) {
    throw new Error("allocate_next_quote_number returned incomplete data");
  }
  return { quote_year, quote_sequence, quote_number_display };
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function extractSettingsFromSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const storage =
    payload.storage && typeof payload.storage === "object" ? payload.storage : {};
  const mg =
    storage["mg_settings_v2"] && typeof storage["mg_settings_v2"] === "object"
      ? storage["mg_settings_v2"]
      : {};
  return mg;
}

async function loadTenantSettingsFromLatestSnapshot(tenantId) {
  const rows = await supabaseRequest(
    `tenant_snapshots?tenant_id=eq.${tenantId}&select=payload&order=created_at.desc&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return extractSettingsFromSnapshotPayload(row?.payload);
}

/**
 * Pricing inputs for server-side totals (same shapes as Sales / Owner sync).
 */
function parsePublishPricingInput(body) {
  const workersRaw = body.workers ?? body.sales_workers ?? body.salesWorkers;
  const workers = Array.isArray(workersRaw) ? workersRaw : null;
  const price =
    body.price !== undefined
      ? body.price
      : body.offeredPrice !== undefined
        ? body.offeredPrice
        : body.offered_price;
  const _manualPriceTouched = Boolean(
    body._manualPriceTouched ?? body.manual_price_touched ?? body.manualPriceTouched
  );
  return { workers, price, _manualPriceTouched };
}

function validateWorkersForPricing(workers) {
  if (!Array.isArray(workers) || workers.length === 0) {
    return { ok: false, error: "workers must be a non-empty array with labor lines." };
  }
  let sumDays = 0;
  for (const w of workers) {
    sumDays += Math.max(0, Number(w?.days || 0));
  }
  if (!Number.isFinite(sumDays) || sumDays <= 0) {
    return {
      ok: false,
      error: "workers must include at least one line with days greater than zero."
    };
  }
  return { ok: true };
}

/** Same notion as pricing-engine: manual only applies when flag is set and price string is non-empty. */
function isManualOfferActive(pricingIn) {
  const raw =
    pricingIn.price === null || pricingIn.price === undefined ? "" : String(pricingIn.price);
  return Boolean(pricingIn._manualPriceTouched) && String(raw).trim() !== "";
}

async function insertQuote({ supabaseUrl, serviceRoleKey, payload }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/quotes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  let rows = [];
  try {
    rows = JSON.parse(text);
  } catch {
    rows = [];
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    rows
  };
}

function buildPublicUrl(siteUrl, publicToken) {
  const cleanSite = String(siteUrl || "").replace(/\/+$/, "");
  return `${cleanSite}/estimate-public.html?token=${encodeURIComponent(publicToken)}`;
}

/**
 * Single resolver for persisted commercial amounts on publish.
 * @param {object} args
 * @param {number} args.clientTotalReported - NaN when absent
 * @param {number} args.clientDepositReported - NaN when absent
 * @param {{ total: number, deposit_required: number, minimum_price: number }} args.serverFinancials
 * @param {number} args.minimumPrice
 * @returns {object}
 */
function resolveCanonicalPublishAmounts({
  clientTotalReported,
  clientDepositReported,
  serverFinancials,
  minimumPrice
}) {
  const minPriceN = Number(minimumPrice);
  const serverTotal = Number(serverFinancials.total);
  const serverDeposit = Number(serverFinancials.deposit_required);

  const clientT = Number(clientTotalReported);
  const clientD = Number(clientDepositReported);

  const differsFromServer =
    Number.isFinite(clientT) && clientT > 0 && Math.abs(clientT - serverTotal) > 0.009;

  if (Number.isFinite(clientT) && clientT > 0 && clientT + 1e-6 < minPriceN && differsFromServer) {
    return {
      ok: false,
      statusCode: 400,
      error: `Published total must be at least the account minimum (${minPriceN.toFixed(2)}). Refresh the seller page and try again.`
    };
  }

  let total = round2(serverTotal);
  let depositRequired = round2(serverDeposit);
  let publish_amounts_source = "server_snapshot";
  let publish_amounts_reason = "default_server_financials";

  if (Number.isFinite(clientT) && clientT > 0 && clientT + 1e-6 >= minPriceN) {
    total = round2(clientT);
    publish_amounts_source = "client_session_minimum_floor";
    publish_amounts_reason = "client_total_meets_minimum_floor";
    const depFloor = round2(Math.max(1000, total * 0.1));
    if (Number.isFinite(clientD) && clientD > 0 && clientD <= total + 1e-6) {
      depositRequired = round2(Math.min(total, Math.max(depFloor, clientD)));
    } else {
      depositRequired = depFloor;
      publish_amounts_reason = "client_total_meets_minimum_floor_deposit_derived";
    }
  }

  const balance_after_deposit = round2(Math.max(0, total - depositRequired));

  return {
    ok: true,
    total,
    deposit_required: depositRequired,
    balance_after_deposit,
    final_price: total,
    minimum_price: minPriceN,
    publish_amounts_source,
    publish_amounts_reason
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    const tenant = await resolveTenantFromSession(session);
    if (!tenant?.id) {
      return json(422, {
        error:
          "Cannot publish quote: missing tenant for this account. Run bootstrap-tenant before publishing."
      });
    }

    let supabaseUrl;
    let serviceRoleKey;
    try {
      ({ url: supabaseUrl, key: serviceRoleKey } = getSupabaseConfig());
    } catch (_e) {
      return json(500, { error: "Missing server configuration" });
    }

    const body = parseBody(event.body);

    const clientTenantId = body.tenant_id ?? body.tenantId;
    if (
      clientTenantId != null &&
      clientTenantId !== "" &&
      String(clientTenantId) !== String(tenant.id)
    ) {
      return json(403, { error: "tenant_id does not match the signed-in account." });
    }

    const pricingIn = parsePublishPricingInput(body);
    const wCheck = validateWorkersForPricing(pricingIn.workers);
    if (!wCheck.ok) {
      return json(400, { error: wCheck.error });
    }

    const tenantSettings = await loadTenantSettingsFromLatestSnapshot(tenant.id);
    let financials;
    try {
      financials = calculateQuotePublishFinancials(
        {
          workers: pricingIn.workers,
          price: pricingIn.price,
          _manualPriceTouched: pricingIn._manualPriceTouched
        },
        tenantSettings
      );
    } catch (err) {
      return json(400, {
        error: err?.message || "Unable to compute quote pricing from inputs."
      });
    }

    const minPrice = financials.minimum_price;
    if (isManualOfferActive(pricingIn)) {
      const rawManual = String(pricingIn.price ?? "").trim();
      const manualRequested = Number(rawManual);
      if (!Number.isFinite(manualRequested)) {
        console.log("[publish-public-quote] manual price rejected (invalid number)", {
          tenant_id: tenant.id,
          manual_requested_raw: rawManual,
          minimum_price: minPrice,
          accepted: false
        });
        return json(400, {
          error: "Manual offered price must be a valid number."
        });
      }
      if (manualRequested + 1e-9 < Number(minPrice)) {
        console.log("[publish-public-quote] manual price rejected below minimum_price", {
          tenant_id: tenant.id,
          manual_requested: manualRequested,
          minimum_price: minPrice,
          accepted: false
        });
        return json(400, {
          error: `Manual offered price cannot be below the minimum allowed (${Number(minPrice).toFixed(2)}).`
        });
      }
      console.log("[publish-public-quote] manual price accepted vs minimum_price", {
        tenant_id: tenant.id,
        manual_requested: manualRequested,
        minimum_price: minPrice,
        accepted: true
      });
    }

    if (
      !Number.isFinite(financials.total) ||
      financials.total <= 0 ||
      !Number.isFinite(financials.deposit_required) ||
      financials.deposit_required <= 0
    ) {
      return json(400, { error: "Computed total or deposit is invalid." });
    }

    const rawClientTotal =
      body.total !== undefined && body.total !== null
        ? body.total
        : body.recommended_total !== undefined && body.recommended_total !== null
          ? body.recommended_total
          : body.recommendedTotal;
    const clientTotalReported =
      rawClientTotal === undefined || rawClientTotal === null || rawClientTotal === ""
        ? NaN
        : Number(rawClientTotal);

    const rawClientDep =
      body.deposit_required !== undefined && body.deposit_required !== null
        ? body.deposit_required
        : body.depositRequired !== undefined && body.depositRequired !== null
          ? body.depositRequired
          : body.deposit;
    const clientDepositReported =
      rawClientDep === undefined || rawClientDep === null || rawClientDep === "" ? NaN : Number(rawClientDep);

    const canonical = resolveCanonicalPublishAmounts({
      clientTotalReported,
      clientDepositReported,
      serverFinancials: {
        total: financials.total,
        deposit_required: financials.deposit_required,
        minimum_price: financials.minimum_price
      },
      minimumPrice: financials.minimum_price
    });

    if (!canonical.ok) {
      return json(canonical.statusCode, { error: canonical.error });
    }

    const total = canonical.total;
    const depositRequired = canonical.deposit_required;

    console.log("[MG Publish Financials]", {
      clientTotalReported,
      clientDepositReported,
      serverTotal: Number(financials.total),
      serverDeposit: Number(financials.deposit_required),
      chosenTotal: total,
      chosenDeposit: depositRequired,
      publish_amounts_source: canonical.publish_amounts_source,
      publish_amounts_reason: canonical.publish_amounts_reason
    });

    if (
      !Number.isFinite(total) ||
      total <= 0 ||
      !Number.isFinite(depositRequired) ||
      depositRequired <= 0
    ) {
      return json(400, { error: "Computed total or deposit is invalid." });
    }

    const tenantDisplay = await loadTenantDisplayForTenantId(tenant.id);

    let publicToken = pickFirst(body.public_token, body.publicToken);
    if (publicToken) {
      let existing = [];
      try {
        existing = await supabaseRequest(
          `quotes?public_token=eq.${encodeURIComponent(publicToken)}&select=id`
        );
      } catch (_e) {
        existing = [];
      }
      if (Array.isArray(existing) && existing.length > 0) {
        return json(409, {
          error:
            "This public_token is already in use. Omit public_token to generate a new secure token."
        });
      }
    } else {
      publicToken = makePublicToken("qt");
    }

    const projectName = pickFirst(
      body.project_name,
      body.projectName,
      body.project,
      body.job_name,
      body.jobName,
      body.project_title,
      body.projectTitle,
      "Project"
    );

    const title = pickFirst(
      body.title,
      body.estimate_title,
      body.estimateTitle,
      body.quote_title,
      body.quoteTitle,
      projectName,
      "Project"
    );

    const clientName = pickFirst(
      body.client_name,
      body.clientName,
      body.customer_name,
      body.customerName,
      body.owner_name,
      body.ownerName,
      body.name,
      body.full_name,
      body.fullName
    );

    const clientEmail = pickFirst(
      body.client_email,
      body.clientEmail,
      body.customer_email,
      body.customerEmail,
      body.email
    );

    const clientPhone = pickFirst(
      body.client_phone,
      body.clientPhone,
      body.customer_phone,
      body.customerPhone,
      body.phone_number,
      body.phoneNumber,
      body.phone,
      body.customer_mobile,
      body.customerMobile,
      body.mobile,
      body.mobile_phone,
      body.mobilePhone,
      body.tel,
      body.telephone
    );

    const projectAddress = pickFirst(
      body.project_address,
      body.projectAddress,
      body.job_site,
      body.jobSite,
      body.customer_address,
      body.customerAddress,
      body.job_address,
      body.jobAddress,
      body.address,
      body.site_address,
      body.siteAddress,
      body.project_location,
      body.projectLocation,
      body.job_location,
      body.jobLocation,
      body.service_address,
      body.serviceAddress
    );

    const notes = pickFirst(
      body.notes,
      body.messageText,
      body.message,
      body.public_message,
      body.publicMessage
    );

    const terms = pickFirst(
      body.terms,
      body.default_terms,
      body.defaultTerms
    );

    const status = pickFirst(body.status, "READY_TO_SEND");
    const currency = pickFirst(body.currency, "USD");
    const paymentLink = pickFirst(body.payment_link, body.paymentLink);

    const businessName = pickFirst(
      body.business_name,
      body.businessName,
      body.company_name,
      body.companyName,
      tenantDisplay.business_name
    );
    const businessEmail = pickFirst(
      body.business_email,
      body.businessEmail,
      tenantDisplay.business_email
    );
    const businessPhone = pickFirst(
      body.business_phone,
      body.businessPhone,
      body.company_phone,
      body.companyPhone,
      tenantDisplay.business_phone
    );
    const businessAddress = pickFirst(
      body.business_address,
      body.businessAddress,
      body.company_address,
      body.companyAddress,
      tenantDisplay.business_address
    );

    let quoteNumberAlloc;
    try {
      quoteNumberAlloc = await allocateNextQuoteNumberForTenant(tenant.id);
    } catch (allocErr) {
      console.error("[publish-public-quote] quote number allocation failed", {
        tenant_id: tenant.id,
        message: allocErr?.message
      });
      return json(503, {
        error:
          allocErr?.message ||
          "Quote numbering is unavailable. Apply database migration SUPABASE_QUOTE_ANNUAL_NUMBERING.sql and grant RPC to service_role."
      });
    }

    const quoteNumberFields = {
      quote_year: quoteNumberAlloc.quote_year,
      quote_sequence: quoteNumberAlloc.quote_sequence,
      quote_number_display: quoteNumberAlloc.quote_number_display
    };

    const amountAudit = {
      publish_amounts_source: canonical.publish_amounts_source,
      publish_amounts_reason: canonical.publish_amounts_reason,
      balance_after_deposit: canonical.balance_after_deposit
    };

    function buildBasePayload(withAudit) {
      return {
        tenant_id: tenant.id,
        project_name: projectName,
        title,
        client_name: clientName,
        client_email: clientEmail,
        status,
        currency,
        total,
        deposit_required: depositRequired,
        notes,
        terms,
        payment_link: paymentLink,
        public_token: publicToken,
        business_name: businessName || "",
        company_name: businessName || "",
        business_email: businessEmail || "",
        business_phone: businessPhone || "",
        business_address: businessAddress || "",
        ...quoteNumberFields,
        ...(withAudit ? amountAudit : {})
      };
    }

    function expandPayloadVariants(base) {
      return [
        {
          ...base,
          client_phone: clientPhone,
          project_address: projectAddress,
          job_site: projectAddress
        },
        {
          ...base,
          client_phone: clientPhone,
          job_site: projectAddress
        },
        {
          ...base,
          client_phone: clientPhone,
          project_address: projectAddress
        },
        {
          ...base,
          job_site: projectAddress
        },
        { ...base }
      ];
    }

    let insertResult = null;
    let lastErrorText = "";

    async function tryInsertAll(withAudit) {
      const bases = expandPayloadVariants(buildBasePayload(withAudit));
      for (const payload of bases) {
        const result = await insertQuote({
          supabaseUrl,
          serviceRoleKey,
          payload
        });
        if (result.ok) {
          return { ...result, payloadUsed: payload };
        }
        lastErrorText = result.text || `Supabase write failed with status ${result.status}`;
      }
      return null;
    }

    insertResult = await tryInsertAll(true);
    if (!insertResult) {
      insertResult = await tryInsertAll(false);
    }

    if (!insertResult) {
      return json(502, {
        error: lastErrorText || "Supabase write failed"
      });
    }

    const row = Array.isArray(insertResult.rows) ? insertResult.rows[0] : null;
    const quoteId = row?.id || null;

    if (!quoteId) {
      return json(500, {
        error: "Quote was created but no quote id was returned by Supabase."
      });
    }

    if (String(row?.tenant_id || "") !== String(tenant.id)) {
      return json(500, {
        error:
          "Quote was stored without valid tenant scope (tenant_id mismatch). Refusing to return a public URL."
      });
    }

    const siteUrl =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      "";

    const publicUrl = buildPublicUrl(siteUrl, publicToken);

    const financialsOut = {
      total: canonical.total,
      deposit_required: canonical.deposit_required,
      balance_after_deposit: canonical.balance_after_deposit,
      final_price: canonical.final_price,
      minimum_price: canonical.minimum_price
    };

    return json(200, {
      ok: true,
      quote_id: quoteId,
      public_token: publicToken,
      public_url: publicUrl,
      quote_year: quoteNumberAlloc.quote_year,
      quote_sequence: quoteNumberAlloc.quote_sequence,
      quote_number_display: quoteNumberAlloc.quote_number_display,
      publish_amounts_source: canonical.publish_amounts_source,
      publish_amounts_reason: canonical.publish_amounts_reason,
      financials: financialsOut,
      normalized_customer: {
        client_name: clientName,
        client_email: clientEmail,
        client_phone: clientPhone,
        project_address: projectAddress
      },
      payload_used: insertResult.payloadUsed,
      row
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
