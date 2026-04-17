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

    const clientTotalReported =
      Number(body.total ?? body.recommended_total ?? body.recommendedTotal ?? NaN) || 0;
    if (
      Number.isFinite(clientTotalReported) &&
      Math.abs(clientTotalReported - financials.total) > 0.009
    ) {
      console.log("[publish-public-quote] frontend total differs from server total", {
        tenant_id: tenant.id,
        client_total: clientTotalReported,
        server_total: financials.total
      });
    }

    const total = financials.total;
    const depositRequired = financials.deposit_required;

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

    const basePayload = {
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
      business_address: businessAddress || ""
    };

    const payloadVariants = [
      {
        ...basePayload,
        client_phone: clientPhone,
        project_address: projectAddress,
        job_site: projectAddress
      },
      {
        ...basePayload,
        client_phone: clientPhone,
        job_site: projectAddress
      },
      {
        ...basePayload,
        client_phone: clientPhone,
        project_address: projectAddress
      },
      {
        ...basePayload,
        job_site: projectAddress
      },
      {
        ...basePayload
      }
    ];

    let insertResult = null;
    let lastErrorText = "";

    for (const payload of payloadVariants) {
      const result = await insertQuote({
        supabaseUrl,
        serviceRoleKey,
        payload
      });

      if (result.ok) {
        insertResult = { ...result, payloadUsed: payload };
        break;
      }

      lastErrorText = result.text || `Supabase write failed with status ${result.status}`;
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

    return json(200, {
      ok: true,
      quote_id: quoteId,
      public_token: publicToken,
      public_url: publicUrl,
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
