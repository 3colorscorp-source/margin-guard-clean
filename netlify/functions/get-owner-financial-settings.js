/**
 * Read persisted owner_settings financial fields for the authenticated owner tenant.
 * Does not write, merge, or delete rows. Does not trust localStorage or request body.
 */
"use strict";

const { requireFcOwnerTenant, json } = require("./_lib/fc-owner-context");
const { supabaseRequest } = require("./_lib/supabase-admin");

function asRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function createHandler(deps = {}) {
  const requireOwner = deps.requireFcOwnerTenant || requireFcOwnerTenant;
  const requestFn = deps.supabaseRequest || supabaseRequest;

  return async function handler(event) {
    try {
      if (event.httpMethod !== "GET") {
        return json(405, { error: "Method not allowed" });
      }

      const gate = await requireOwner(event, deps);
      if (!gate.ok) {
        return gate.response;
      }
      const { tenant } = gate;
      const tid = encodeURIComponent(tenant.id);

      const rows = asRows(
        await requestFn(
          `owner_settings?tenant_id=eq.${tid}&select=overhead_monthly,savings_target_months,runway_green_days,runway_yellow_days&limit=1`
        )
      );
      const row = rows[0] || null;

      return json(200, {
        ok: true,
        loaded: true,
        present: Boolean(row),
        tenant_id: tenant.id,
        overhead_monthly: row ? numOrNull(row.overhead_monthly) : null,
        savings_target_months: row ? numOrNull(row.savings_target_months) : null,
        runway_green_days: row ? numOrNull(row.runway_green_days) : null,
        runway_yellow_days: row ? numOrNull(row.runway_yellow_days) : null,
      });
    } catch (err) {
      return json(500, { error: err.message || "Unable to load owner settings" });
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
