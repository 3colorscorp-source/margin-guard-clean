#!/usr/bin/env node
/**
 * Optional backfill: quoted_labor_plan + estimate economics on tenant_projects.
 *
 * NEVER run against production without review. Default is dry-run (no writes).
 *
 * Usage:
 *   node scripts/backfill-quoted-labor-plan.js --dry-run
 *   node scripts/backfill-quoted-labor-plan.js --tenant-id=<uuid> --dry-run
 *   node scripts/backfill-quoted-labor-plan.js --tenant-id=<uuid> --apply
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.
 */

const {
  buildEstimateEconomics,
  extractWorkersFromQuoteRow,
  extractWorkersFromSnapshotPayload,
  extractSettingsFromSnapshotPayload,
  isPlanEffectivelyEmpty,
} = require("../netlify/functions/_lib/project-labor-plan");

function parseArgs(argv) {
  const out = { dryRun: true, tenantId: "", apply: false, limit: 50 };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") {
      out.apply = true;
      out.dryRun = false;
    }
    if (arg === "--dry-run") out.dryRun = true;
    if (arg.startsWith("--tenant-id=")) out.tenantId = arg.slice("--tenant-id=".length).trim();
    if (arg.startsWith("--limit=")) out.limit = Math.max(1, parseInt(arg.slice("--limit=".length), 10) || 50);
  }
  if (out.apply) out.dryRun = false;
  return out;
}

function getConfig() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return { url, key };
}

async function supabaseGet(path, { key }) {
  const res = await fetch(`${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let data = [];
  try {
    data = JSON.parse(text);
  } catch {
    data = [];
  }
  if (!res.ok) {
    throw new Error(`GET ${path} failed ${res.status}: ${text.slice(0, 400)}`);
  }
  return data;
}

async function supabasePatch(path, body, { key }) {
  const res = await fetch(path, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH failed ${res.status}: ${text.slice(0, 400)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const { url, key } = getConfig();

  let q =
    `${url}/rest/v1/tenant_projects?select=id,tenant_id,quote_id,quoted_labor_plan,quoted_labor_plan_locked_at,sale_price` +
    `&quoted_labor_plan_locked_at=is.null&limit=${args.limit}`;
  if (args.tenantId) {
    q += `&tenant_id=eq.${encodeURIComponent(args.tenantId)}`;
  }

  const projects = await supabaseGet(q, { key });
  if (!Array.isArray(projects)) {
    console.error("Unexpected response");
    process.exit(1);
  }

  console.log(
    `[backfill] mode=${args.dryRun ? "dry-run" : "apply"} candidates=${projects.length} tenant=${args.tenantId || "all"}`
  );

  let wouldUpdate = 0;
  let skipped = 0;

  for (const proj of projects) {
    if (!proj?.id || !proj?.tenant_id) {
      skipped += 1;
      continue;
    }
    if (proj.quoted_labor_plan_locked_at) {
      skipped += 1;
      continue;
    }
    if (!isPlanEffectivelyEmpty(proj.quoted_labor_plan)) {
      skipped += 1;
      continue;
    }

    const tid = encodeURIComponent(proj.tenant_id);
    const qid = proj.quote_id ? encodeURIComponent(proj.quote_id) : "";
    let workers = [];
    let settings = {};

    if (qid) {
      const quotes = await supabaseGet(
        `${url}/rest/v1/quotes?id=eq.${qid}&tenant_id=eq.${tid}&select=*&limit=1`,
        { key }
      );
      const quote = Array.isArray(quotes) ? quotes[0] : null;
      if (quote) {
        workers = extractWorkersFromQuoteRow(quote) || [];
      }
    }

    if (!workers.length) {
      const snaps = await supabaseGet(
        `${url}/rest/v1/tenant_snapshots?tenant_id=eq.${tid}&select=payload&order=created_at.desc&limit=1`,
        { key }
      );
      const snap = Array.isArray(snaps) ? snaps[0] : null;
      if (snap?.payload) {
        const hit = extractWorkersFromSnapshotPayload(snap.payload, proj.quote_id);
        if (hit?.workers?.length) {
          workers = hit.workers;
          settings = hit.settings || extractSettingsFromSnapshotPayload(snap.payload);
        }
      }
    }

    if (!workers.length) {
      skipped += 1;
      continue;
    }

    const economics = buildEstimateEconomics({
      workers,
      settings,
      salePrice: Number(proj.sale_price) || 0,
    });

    if (isPlanEffectivelyEmpty(economics.quotedLaborPlan)) {
      skipped += 1;
      continue;
    }

    wouldUpdate += 1;
    console.log(`[backfill] project=${proj.id} quote=${proj.quote_id || "—"} rows=${economics.quotedLaborPlan.length}`);

    if (!args.dryRun) {
      const pid = encodeURIComponent(proj.id);
      await supabasePatch(
        `${url}/rest/v1/tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}`,
        {
          quoted_labor_plan: economics.quotedLaborPlan,
          estimated_labor_cost: economics.estimatedLaborCost,
          estimated_material_cost: economics.estimatedMaterialCost,
          estimated_profit: economics.estimatedProfit,
          estimated_profit_margin: economics.estimatedProfitMargin,
          labor_budget: economics.estimatedLaborCost,
          quoted_labor_plan_locked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { key }
      );
    }
  }

  console.log(`[backfill] done would_update=${wouldUpdate} skipped=${skipped}`);
}

main().catch((err) => {
  console.error("[backfill] fatal", err.message || err);
  process.exit(1);
});
