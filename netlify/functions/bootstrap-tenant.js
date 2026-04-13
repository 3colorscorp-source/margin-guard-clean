const { readSessionFromEvent } = require("./_lib/session");
const { supabaseRequest, toSlug } = require("./_lib/supabase-admin");

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
}

async function fetchTenantById(id) {
  const rows = await supabaseRequest(`tenants?id=eq.${encodeURIComponent(id)}&select=*`);
  return Array.isArray(rows) ? rows[0] : null;
}

function buildResponse(tenant, profile, email) {
  return {
    ok: true,
    tenant_id: tenant.id,
    user_id: profile.id,
    email: profile.email || email,
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

    const email = String(session.e || "").trim().toLowerCase();
    if (!email) {
      return json(401, { error: "Unauthorized" });
    }

    // 1) Existing profile → resolve tenant (idempotent fast path; no duplicate tenants)
    let profileRows = await supabaseRequest(
      `profiles?email=eq.${encodeURIComponent(email)}&select=*&limit=2`
    );
    let profile = Array.isArray(profileRows) && profileRows.length ? profileRows[0] : null;

    let tenant = null;
    if (profile?.tenant_id) {
      tenant = await fetchTenantById(profile.tenant_id);
    }

    // 2) Tenant by Stripe customer id
    if (!tenant?.id) {
      let tenantRows = await supabaseRequest(
        `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=*`
      );
      tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
    }

    // 3) Tenant by owner email (single row; avoid creating a second tenant)
    if (!tenant?.id) {
      let tenantRows = await supabaseRequest(
        `tenants?owner_email=eq.${encodeURIComponent(email)}&select=*&limit=2`
      );
      tenant = Array.isArray(tenantRows) ? tenantRows[0] : null;
    }

    // 4) Link Stripe + owner_email on existing tenant when needed (no throw on success path)
    if (tenant?.id) {
      const body = {};
      if (!tenant.stripe_customer_id || String(tenant.stripe_customer_id) !== String(session.c)) {
        body.stripe_customer_id = session.c;
      }
      if (!tenant.owner_email || String(tenant.owner_email).toLowerCase() !== email) {
        body.owner_email = email;
      }
      if (Object.keys(body).length) {
        try {
          await supabaseRequest(`tenants?id=eq.${encodeURIComponent(tenant.id)}`, {
            method: "PATCH",
            body
          });
          tenant = await fetchTenantById(tenant.id);
        } catch (_err) {
          const again = await supabaseRequest(
            `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=*`
          );
          tenant = Array.isArray(again) ? again[0] : tenant;
        }
      }
    }

    // 5) Create tenant only when none exists for this user / Stripe id
    if (!tenant?.id) {
      const domainKey = email.split("@")[1]?.split(".")[0]?.replace(/[-_]/g, " ").trim() || "";
      const localKey = email.split("@")[0]?.replace(/[._+-]/g, " ").trim() || "";
      const guessedName = (domainKey || localKey || "business").replace(/\s+/g, " ");
      const slugBase = `${guessedName}-${String(session.c).slice(-8)}`;
      try {
        const createdRows = await supabaseRequest("tenants", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: {
            slug: toSlug(slugBase),
            name: guessedName.replace(/\b\w/g, (m) => m.toUpperCase()),
            stripe_customer_id: session.c,
            owner_email: email,
            plan_status: "active"
          }
        });
        tenant = Array.isArray(createdRows) ? createdRows[0] : createdRows;
      } catch (_err) {
        const again = await supabaseRequest(
          `tenants?stripe_customer_id=eq.${encodeURIComponent(session.c)}&select=*`
        );
        tenant = Array.isArray(again) ? again[0] : null;
        if (!tenant?.id) {
          const againEmail = await supabaseRequest(
            `tenants?owner_email=eq.${encodeURIComponent(email)}&select=*&limit=1`
          );
          tenant = Array.isArray(againEmail) ? againEmail[0] : null;
        }
      }
    }

    if (!tenant?.id) {
      return json(500, { error: "Unable to resolve tenant" });
    }

    // 6) Create profile if missing; link profile.tenant_id to tenant.id
    profileRows = await supabaseRequest(
      `profiles?tenant_id=eq.${encodeURIComponent(tenant.id)}&email=eq.${encodeURIComponent(email)}&select=*`
    );
    profile = Array.isArray(profileRows) ? profileRows[0] : null;

    if (!profile) {
      try {
        const createdProfiles = await supabaseRequest("profiles", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: {
            tenant_id: tenant.id,
            email,
            role: "owner",
            status: "active"
          }
        });
        profile = Array.isArray(createdProfiles) ? createdProfiles[0] : createdProfiles;
      } catch (_err) {
        profileRows = await supabaseRequest(
          `profiles?tenant_id=eq.${encodeURIComponent(tenant.id)}&email=eq.${encodeURIComponent(email)}&select=*`
        );
        profile = Array.isArray(profileRows) ? profileRows[0] : null;
      }
    }

    if (!profile?.id) {
      return json(500, { error: "Unable to resolve profile" });
    }

    return json(200, buildResponse(tenant, profile, email));
  } catch (err) {
    return json(500, { error: err.message || "Bootstrap failed" });
  }
};
