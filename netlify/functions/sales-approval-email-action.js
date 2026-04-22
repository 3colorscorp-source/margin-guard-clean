// DEPRECATED: Sales approval flow removed from Seller UI. Kept for legacy email links only.
const crypto = require("crypto");
const { supabaseRequest } = require("./_lib/supabase-admin");
const { escapeHtml } = require("./_lib/resend-email");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function htmlPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; color: #111; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.25rem; }
    h1 { font-size: 1.25rem; margin-top: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function htmlResponse(statusCode, title, bodyLines) {
  const inner = bodyLines.map((line) => `<p>${line}</p>`).join("");
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: htmlPage(title, inner)
  };
}

function hashTokenPlain(plain) {
  return crypto.createHash("sha256").update(String(plain), "utf8").digest("hex");
}

function timingSafeEqualHex(storedHex, computedHex) {
  try {
    const a = Buffer.from(String(storedHex || ""), "hex");
    const b = Buffer.from(String(computedHex || ""), "hex");
    if (a.length !== b.length || a.length !== 32) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function normalizeAction(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s === "approve" || s === "approved") return "approved";
  if (s === "decline" || s === "reject" || s === "rejected") return "rejected";
  return "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Method Not Allowed"
    };
  }

  try {
    const qs = event.queryStringParameters || {};
    const approvalId = String(qs.approval_id || qs.id || "").trim();
    const token = String(qs.t || qs.token || "").trim();
    const action = normalizeAction(qs.action);

    if (!approvalId || !UUID_RE.test(approvalId) || !token || !action) {
      return htmlResponse(400, "Invalid link", [
        "This approval link is missing required parameters or has an invalid format."
      ]);
    }

    let rows;
    try {
      rows = await supabaseRequest(
        `sales_approvals?id=eq.${encodeURIComponent(approvalId)}&select=id,status,email_action_token_hash,project_name`
      );
    } catch (err) {
      return htmlResponse(503, "Temporarily unavailable", [
        "We could not reach the database. Try again in a few minutes."
      ]);
    }

    const row = Array.isArray(rows) ? rows[0] : null;
    const storedHash = String(row?.email_action_token_hash || "").trim();

    if (!row || !storedHash) {
      return htmlResponse(400, "Invalid or expired link", [
        "This link is not valid. If you still need to act on a discount request, open Margin Guard and use the Sales Admin queue."
      ]);
    }

    const computed = hashTokenPlain(token);
    if (!timingSafeEqualHex(storedHash, computed)) {
      return htmlResponse(400, "Invalid or expired link", [
        "This link is not valid. If you still need to act on a discount request, open Margin Guard and use the Sales Admin queue."
      ]);
    }

    const statusNow = String(row.status || "").toLowerCase();
    if (statusNow !== "requested") {
      const label = statusNow === "approved" ? "already approved" : "already updated";
      return htmlResponse(200, "Request closed", [
        `This discount request was ${label}. No further action is needed from this link.`
      ]);
    }

    const nowIso = new Date().toISOString();
    const patch = {
      status: action === "approved" ? "approved" : "rejected",
      updated_at: nowIso
    };
    if (action === "approved") {
      patch.approved_at = nowIso;
    }

    let updated;
    try {
      updated = await supabaseRequest(`sales_approvals?id=eq.${encodeURIComponent(approvalId)}`, {
        method: "PATCH",
        body: patch
      });
    } catch (err) {
      return htmlResponse(503, "Could not save", [
        "We could not record your decision. Try again or use the Sales Admin screen in Margin Guard."
      ]);
    }

    const okRow = Array.isArray(updated) ? updated[0] : null;
    if (!okRow) {
      return htmlResponse(404, "Not found", [
        "This approval request could not be found. It may have been removed."
      ]);
    }

    const pn = escapeHtml(String(row.project_name || "Project"));
    if (action === "approved") {
      return htmlResponse(200, "Approved", [
        `The discount for ${pn} has been approved.`,
        "The seller can proceed with this price."
      ]);
    }
    return htmlResponse(200, "Declined", [
      `The discount for ${pn} has been declined.`,
      "The seller should adjust pricing or discuss next steps with you."
    ]);
  } catch (err) {
    return htmlResponse(500, "Error", [escapeHtml(err?.message || "Something went wrong.")]);
  }
};
