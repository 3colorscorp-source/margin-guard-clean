const crypto = require("crypto");
const { supabaseRequest } = require("./_lib/supabase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function text(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: String(body || ""),
  };
}

function getRawBody(event) {
  if (typeof event.body !== "string") return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf8");
  }
  return event.body;
}

function parseStripeSignatureHeader(header) {
  const out = { t: "", v1: [] };
  const parts = String(header || "").split(",");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") out.t = value;
    else if (key === "v1" && value) out.v1.push(value);
  }
  return out;
}

function timingSafeHexEqual(a, b) {
  try {
    const ba = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");
    if (ba.length === 0 || bb.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const sig = parseStripeSignatureHeader(signatureHeader);
  if (!sig.t || !sig.v1.length) return false;
  const payload = `${sig.t}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  for (const candidate of sig.v1) {
    if (timingSafeHexEqual(expected, candidate)) return true;
  }
  return false;
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return text(405, "Method Not Allowed");
    }

    const secret = String(
      process.env.STRIPE_INVOICE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || ""
    ).trim();
    if (!secret) {
      return text(500, "Missing STRIPE_INVOICE_WEBHOOK_SECRET");
    }

    const signatureHeader =
      event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"] || "";
    const rawBody = getRawBody(event);
    if (!verifyStripeSignature(rawBody, signatureHeader, secret)) {
      return text(400, "Invalid signature");
    }

    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return text(400, "Invalid JSON");
    }

    if (String(payload?.type || "") !== "checkout.session.completed") {
      return json(200, { ok: true, ignored: true });
    }

    const session = payload?.data?.object || {};
    const metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
    const tenantId = String(metadata.tenant_id || "").trim();
    const invoiceId = String(metadata.invoice_id || "").trim();
    const publicToken = String(metadata.public_token || "").trim();
    if (!tenantId || !invoiceId || !publicToken) {
      return text(400, "Missing metadata");
    }

    const rows = await supabaseRequest(
      `invoices?id=eq.${encodeURIComponent(invoiceId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&public_token=eq.${encodeURIComponent(publicToken)}&select=id,tenant_id,amount,status,paid_amount,balance_due&limit=1`,
      { method: "GET" }
    );
    const inv = Array.isArray(rows) ? rows[0] : null;
    if (!inv?.id) {
      return json(200, { ok: true, ignored: true, reason: "invoice_not_found" });
    }

    const paidAt = new Date().toISOString();
    const paidFromStripe = money(Number(session.amount_total || 0) / 100);
    const invoiceAmount = money(inv.amount);
    const paidAmount = paidFromStripe > 0 ? paidFromStripe : invoiceAmount;
    const nextPaidAmount = money(Math.max(paidAmount, money(inv.paid_amount)));
    const nextBalance = money(Math.max(invoiceAmount - nextPaidAmount, 0));
    const sessionId = String(session.id || "").trim();
    const paymentIntentId = String(session.payment_intent || "").trim();

    const basePatch = {
      status: "paid",
      paid_at: paidAt,
      paid_amount: nextPaidAmount,
      balance_due: nextBalance,
      updated_at: paidAt,
    };
    const patchVariants = [
      {
        ...basePatch,
        stripe_checkout_session_id: sessionId || null,
        stripe_session_id: sessionId || null,
        stripe_payment_intent_id: paymentIntentId || null,
        amount_paid: nextPaidAmount,
      },
      {
        ...basePatch,
        stripe_checkout_session_id: sessionId || null,
        stripe_payment_intent_id: paymentIntentId || null,
      },
      {
        ...basePatch,
        stripe_payment_intent_id: paymentIntentId || null,
      },
      basePatch,
    ];

    let patched = false;
    let lastErr = "";
    for (const patch of patchVariants) {
      try {
        await supabaseRequest(
          `invoices?id=eq.${encodeURIComponent(invoiceId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`,
          { method: "PATCH", body: patch }
        );
        patched = true;
        break;
      } catch (err) {
        lastErr = String(err?.message || "");
      }
    }
    if (!patched) {
      throw new Error(lastErr || "Unable to update invoice paid state");
    }

    return json(200, { ok: true });
  } catch (err) {
    return text(500, err.message || "Server error");
  }
};
