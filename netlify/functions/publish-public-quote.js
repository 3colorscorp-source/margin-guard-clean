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

function makeToken(prefix = "qt") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

    const supabaseUrl =
      process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceRoleKey) {
      return json(500, { error: "Missing env SUPABASE_SERVICE_ROLE_KEY" });
    }

    const body = parseBody(event.body);

    const total =
      Number(body.total ?? body.recommended_total ?? body.recommendedTotal ?? 0) || 0;

    const depositRequired =
      Number(body.deposit_required ?? body.depositRequired ?? 1000) || 0;

    const publicToken = pickFirst(body.public_token, body.publicToken) || makeToken("qt");

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

    const basePayload = {
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
      public_token: publicToken
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