const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest, toSlug } = require("./_lib/supabase-admin");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  try {
    if (!["GET", "POST"].includes(event.httpMethod)) {
      return json(405, { error: "Method not allowed" });
    }

    const session = readSessionFromEvent(event);
    if (!session?.e || !session?.c) {
      return json(401, { error: "Unauthorized" });
    }

    let tenantRows = await supabaseRequest(`tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=*`);
    let tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;

    if (!tenant) {
      const ownerEmail = String(session.e || "").trim().toLowerCase();
      const guessedName = ownerEmail.split("@")[1]?.split(".")[0]?.replace(/[-_]/g, " ") || "Margin Guard Tenant";
      const createdRows = await supabaseRequest("tenants", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: {
          slug: toSlug(guessedName),
          name: guessedName.replace(/\b\w/g, (m) => m.toUpperCase()),
          stripe_customer_id: session.c,
          owner_email: ownerEmail,
          plan_status: "active"
        }
      });
      tenant = Array.isArray(createdRows) ? createdRows[0] : createdRows;
    }

    let profileRows = await supabaseRequest(`profiles?tenant_id=eq.${tenant.id}&email=eq.${encodeURIComponent(session.e)}&select=*`);
    let profile = Array.isArray(profileRows) ? profileRows[0] : null;

    if (!profile) {
      const createdProfiles = await supabaseRequest("profiles", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: {
          tenant_id: tenant.id,
          email: String(session.e || "").trim().toLowerCase(),
          role: "owner",
          status: "active"
        }
      });
      profile = Array.isArray(createdProfiles) ? createdProfiles[0] : createdProfiles;
    }

    return json(200, {
      ok: true,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        owner_email: tenant.owner_email,
        plan_status: tenant.plan_status
      },
      profile: {
        id: profile.id,
        email: profile.email,
        role: profile.role,
        status: profile.status
      }
    });
  } catch (err) {
    return json(500, { error: err.message || "Bootstrap failed" });
  }
};
