#!/usr/bin/env node
/**
 * READ-ONLY diagnostic for premature Firmar occupancy.
 * Never INSERT/UPDATE/DELETE. Never send email or accept quotes.
 * Run: node scripts/diag-premature-firmar-occupancy.js
 */
"use strict";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    "SKIP live occupancy diagnostic: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in this environment."
  );
  console.log("Use SUPABASE_DIAG_PREMATURE_FIRMAR_OCCUPANCY.sql in the SQL editor (SELECT only). Do not run the commented UPDATE.");
  process.exit(0);
}

const fetchImpl = globalThis.fetch;
if (!fetchImpl) {
  console.log("SKIP live occupancy diagnostic: global fetch is unavailable.");
  process.exit(0);
}

const ACTIVE = "signed,deposit_paid,assigned,in_progress";

(async () => {
  const url = String(process.env.SUPABASE_URL).replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    apikey: key,
    Authorization: "Bearer " + key,
    Accept: "application/json",
  };
  const projectsRes = await fetchImpl(
    url +
      "/rest/v1/tenant_projects?status=in.(" +
      ACTIVE +
      ")&select=id,tenant_id,project_name,client_name,quote_id,status,signed_at,due_date,created_at&order=created_at.desc&limit=100",
    { headers }
  );
  const projects = await projectsRes.json();
  if (!Array.isArray(projects)) {
    console.log("READ failed (projects). HTTP " + projectsRes.status);
    process.exit(1);
  }

  const out = [];
  for (const tp of projects) {
    const tid = encodeURIComponent(tp.tenant_id || "");
    const pid = encodeURIComponent(tp.id || "");
    const qid = encodeURIComponent(tp.quote_id || "");
    let quote = null;
    if (tp.quote_id) {
      const qRes = await fetchImpl(
        url +
          "/rest/v1/quotes?id=eq." +
          qid +
          "&tenant_id=eq." +
          tid +
          "&select=id,status,accepted_at,project_name,public_token&limit=1",
        { headers }
      );
      const qRows = await qRes.json();
      quote = Array.isArray(qRows) ? qRows[0] : null;
    }
    const sRes = await fetchImpl(
      url +
        "/rest/v1/tenant_project_operational_snapshots?project_id=eq." +
        pid +
        "&tenant_id=eq." +
        tid +
        "&select=source,commitment_date,locked_at&limit=1",
      { headers }
    );
    const snaps = await sRes.json();
    const snap = Array.isArray(snaps) ? snaps[0] : null;
    const quoteStatus = String(quote?.status || "").trim().toLowerCase();
    const acceptedAt = String(quote?.accepted_at || "").trim();
    const source = String(snap?.source || "").trim();
    let classification = "needs_manual_review";
    if (source === "quote_accept" && (quoteStatus === "accepted" || quoteStatus === "approved") && acceptedAt) {
      classification = "likely_public_accept";
    } else if (source === "mark_sold") {
      classification = "likely_premature_firmar";
    } else if (quoteStatus !== "accepted" && quoteStatus !== "approved") {
      classification = "active_project_quote_not_accepted";
    } else if (!acceptedAt) {
      classification = "active_project_missing_accepted_at";
    }
    out.push({
      tenant_projects_id: tp.id,
      project_name: tp.project_name,
      quote_id: tp.quote_id,
      status: tp.status,
      start_date: String(tp.signed_at || "").slice(0, 10),
      due_date: tp.due_date,
      signed_at: tp.signed_at,
      quote_status: quote ? quote.status : null,
      quote_accepted_at: quote ? quote.accepted_at : null,
      snapshot_source: source || null,
      classification,
    });
  }

  const candidates = out.filter((row) => row.classification !== "likely_public_accept");
  console.log("Active occupancy rows scanned: " + out.length);
  console.log("Candidates that are not likely_public_accept: " + candidates.length);
  console.log(JSON.stringify(candidates, null, 2));
})().catch((err) => {
  console.error("READ-ONLY diagnostic failed", err && err.message ? err.message : err);
  process.exit(1);
});
