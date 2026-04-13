const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { pickFirst, loadTenantDisplayForTenantId } = require("./_lib/tenant-display");
const { makePublicToken } = require("./_lib/public-token");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function isValidEmail(value) {
  const s = String(value || "").trim();
  return s.includes("@") && s.includes(".") && s.length < 320;
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

    const tenantRows = await supabaseRequest(
      `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=id`
    );
    const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
    if (!tenant?.id) {
      return json(422, {
        error:
          "Cannot publish invoice: missing tenant_id for this account. Run bootstrap-tenant before publishing."
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_err) {
      return json(400, { error: "Invalid JSON body" });
    }

    const clientTenantId = body.tenant_id ?? body.tenantId;
    if (
      clientTenantId != null &&
      clientTenantId !== "" &&
      String(clientTenantId) !== String(tenant.id)
    ) {
      return json(403, { error: "tenant_id does not match the signed-in account." });
    }

    const tenantDisplay = await loadTenantDisplayForTenantId(tenant.id);

    let publicToken = pickFirst(body.public_token, body.publicToken);
    if (publicToken) {
      let existing = [];
      try {
        existing = await supabaseRequest(
          `invoices?public_token=eq.${encodeURIComponent(publicToken)}&select=id`
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
      publicToken = makePublicToken("inv");
    }

    const allowStandalone =
      body.standalone_invoice === true || body.standaloneInvoice === true;

    let resolvedQuoteId = "";
    let quoteRow = null;

    const rawQuoteId = pickFirst(body.quote_id, body.quoteId);
    const publicQuoteTok = pickFirst(
      body.public_quote_token,
      body.quote_public_token,
      body.quotePublicToken
    );

    if (rawQuoteId) {
      if (!UUID_RE.test(rawQuoteId)) {
        return json(400, { error: "Invalid quote_id (expected a UUID)." });
      }
      const quoteRows = await supabaseRequest(
        `quotes?id=eq.${encodeURIComponent(rawQuoteId)}&select=id,tenant_id,project_name,title,client_name,client_email`
      );
      quoteRow = Array.isArray(quoteRows) ? quoteRows[0] : null;
      if (!quoteRow?.id) {
        return json(400, { error: "quote_id not found — no matching published estimate." });
      }
      if (quoteRow.tenant_id == null || quoteRow.tenant_id === "") {
        return json(409, {
          error:
            "That estimate is missing tenant scope; republish the estimate from your account."
        });
      }
      if (String(quoteRow.tenant_id) !== String(tenant.id)) {
        return json(403, { error: "That estimate belongs to another account." });
      }
      resolvedQuoteId = String(quoteRow.id);
    } else if (publicQuoteTok) {
      const quoteRows = await supabaseRequest(
        `quotes?public_token=eq.${encodeURIComponent(publicQuoteTok)}&select=id,tenant_id,project_name,title,client_name,client_email`
      );
      quoteRow = Array.isArray(quoteRows) ? quoteRows[0] : null;
      if (!quoteRow?.id) {
        return json(400, {
          error:
            "public_quote_token does not match a published estimate. Check the estimate link."
        });
      }
      if (quoteRow.tenant_id == null || quoteRow.tenant_id === "") {
        return json(409, {
          error:
            "That estimate is missing tenant scope; republish the estimate from your account."
        });
      }
      if (String(quoteRow.tenant_id) !== String(tenant.id)) {
        return json(403, { error: "That estimate belongs to another account." });
      }
      resolvedQuoteId = String(quoteRow.id);
    }

    if (!resolvedQuoteId && !allowStandalone) {
      return json(400, {
        error:
          "Link this invoice to an estimate: send quote_id or public_quote_token, or set standalone_invoice to true with customer_name, customer_email, and project_name."
      });
    }

    let customerName = pickFirst(
      body.customer_name,
      body.customerName,
      quoteRow?.client_name
    );
    let customerEmail = pickFirst(
      body.customer_email,
      body.customerEmail,
      quoteRow?.client_email
    );
    let projectName = pickFirst(
      body.project_name,
      body.projectName,
      quoteRow?.project_name,
      quoteRow?.title
    );

    if (!pickFirst(customerName)) {
      return json(400, { error: "Missing customer_name (required for public invoice)." });
    }
    if (!pickFirst(projectName)) {
      return json(400, { error: "Missing project_name (required for public invoice)." });
    }
    if (!pickFirst(customerEmail) || !isValidEmail(customerEmail)) {
      return json(400, {
        error: "Missing or invalid customer_email (required for public invoice)."
      });
    }

    const payload = {
      tenant_id: tenant.id,
      public_token: publicToken,
      invoice_no: body.invoice_no || `INV-${Date.now()}`,
      customer_name: customerName,
      customer_email: customerEmail,
      project_name: projectName,
      amount: Number(body.amount || 0),
      paid_amount: Number(body.paid_amount || 0),
      balance_due: Number(body.balance_due || 0),
      issue_date: body.issue_date || new Date().toISOString().slice(0, 10),
      due_date: body.due_date || "",
      type: body.type || "service",
      notes: body.notes || "",
      payment_link: body.payment_link || "",
      business_name: pickFirst(body.business_name, body.businessName, tenantDisplay.business_name),
      logo_url: pickFirst(body.logo_url, tenantDisplay.logo_url),
      accent_color: body.accent_color || "",
      currency: body.currency || "USD",
      status: body.status || "OPEN"
    };

    if (resolvedQuoteId) {
      payload.quote_id = resolvedQuoteId;
    }

    let inserted;
    try {
      inserted = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: payload
      });
    } catch (err) {
      const msg = err.message || String(err);
      if (/quote_id|foreign key|violates/i.test(msg)) {
        return json(502, {
          error:
            "Database rejected invoice (check that invoices.quote_id exists and quotes.tenant_id is set). Details: " +
            msg
        });
      }
      return json(502, { error: msg || "Supabase write failed" });
    }

    const siteUrl = (
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.SITE_URL ||
      ""
    ).replace(/\/+$/, "");

    const publicUrl = siteUrl
      ? `${siteUrl}/invoice-public.html?token=${encodeURIComponent(publicToken)}`
      : `/invoice-public.html?token=${encodeURIComponent(publicToken)}`;

    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    if (row && String(row.tenant_id || "") !== String(tenant.id)) {
      return json(500, {
        error:
          "Invoice was stored without valid tenant scope (tenant_id mismatch). Refusing to return a public URL."
      });
    }

    return json(200, {
      ok: true,
      tenant_id: tenant.id,
      public_token: publicToken,
      public_url: publicUrl,
      quote_id: resolvedQuoteId || null,
      standalone: Boolean(allowStandalone && !resolvedQuoteId),
      row: row || null
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};
