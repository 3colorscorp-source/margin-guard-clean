/**
 * TEMPORARY: creates a platform Customer for debugging. Remove after use.
 */

const { stripeRequest } = require("./_lib/stripe");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const EMAIL = "3colorscorp@gmail.com";
const NAME = "Three Colors Corp";

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const customer = await stripeRequest("/customers", {
      method: "POST",
      body: {
        email: EMAIL,
        name: NAME,
      },
    });

    console.log("Created customer:", customer.id);

    const updated = await supabaseRequest(
      `tenants?owner_email=eq.${encodeURIComponent(EMAIL)}`,
      {
        method: "PATCH",
        body: { stripe_customer_id: customer.id },
      }
    );

    const patchRows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    const tenant_updated = patchRows.length > 0;

    const fetched = await supabaseRequest(
      `tenants?owner_email=eq.${encodeURIComponent(EMAIL)}&select=owner_email,stripe_customer_id`
    );
    const getRows = Array.isArray(fetched) ? fetched : fetched ? [fetched] : [];
    const row = getRows[0];
    const tenant_row = {
      owner_email: row?.owner_email ?? "",
      stripe_customer_id: row?.stripe_customer_id ?? "",
    };

    return json(200, {
      ok: true,
      customer_id: customer.id,
      tenant_updated,
      tenant_row,
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Unexpected error" });
  }
};
