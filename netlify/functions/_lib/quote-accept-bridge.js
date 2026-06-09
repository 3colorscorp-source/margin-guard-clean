/**
 * Idempotent bridge: accepted quote → tenant_projects row + invoices draft.
 * Used by public estimate accept and Invoice Hub manual accept.
 * tenant_id / quote_id must come only from the quote row passed in (never from untrusted client-only paths without prior quote fetch).
 */

const { supabaseRequest } = require("./supabase-admin");
const { makePublicToken } = require("./public-token");
const {
  buildEstimateEconomics,
  extractWorkersFromQuoteRow,
  extractWorkersFromSnapshotPayload,
  extractSettingsFromSnapshotPayload,
  isPlanEffectivelyEmpty,
  mayWriteLaborPlan,
  shouldLockLaborPlan,
} = require("./project-labor-plan");
const {
  normalizeOperationalPlan,
  computeOperationalPlanMetrics,
  planHasDays,
  resolveOperationalPlanForQuote,
  scheduleFieldsFromQuoteRow,
  laborCostFromOperationalPlan,
  quotedLaborPlanRowsFromOperationalPlan,
} = require("./operational-plan");
const { persistOperationalSnapshot } = require("./persist-operational-snapshot");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pickStr(v, maxLen) {
  const s = v == null || v === undefined ? "" : String(v).trim();
  if (!maxLen || maxLen < 1) return s;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function finiteMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 100) / 100;
}

async function loadLatestTenantSnapshotPayload(tenantId) {
  const tidEnc = encodeURIComponent(tenantId);
  try {
    const rows = await supabaseRequest(
      `tenant_snapshots?tenant_id=eq.${tidEnc}&select=payload&order=created_at.desc&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.payload && typeof row.payload === "object" ? row.payload : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve workers + settings for labor plan from quote row and optional tenant snapshot.
 */
async function resolveLaborContextForQuote(quoteRow) {
  if (!quoteRow || typeof quoteRow !== "object") {
    return { workers: [], settings: {} };
  }

  let workers = extractWorkersFromQuoteRow(quoteRow);
  let settings = {};

  const tenantId = String(quoteRow.tenant_id || "").trim();
  const quoteId = String(quoteRow.id || "").trim();

  if ((!workers || !workers.length) && UUID_RE.test(tenantId)) {
    const payload = await loadLatestTenantSnapshotPayload(tenantId);
    if (payload) {
      const hit = extractWorkersFromSnapshotPayload(payload, quoteId);
      if (hit?.workers?.length) {
        workers = hit.workers;
        settings = hit.settings || extractSettingsFromSnapshotPayload(payload);
      } else {
        settings = extractSettingsFromSnapshotPayload(payload);
      }
    }
  }

  return {
    workers: Array.isArray(workers) ? workers : [],
    settings,
  };
}

/**
 * Build PATCH fields for quoted labor plan + estimate economics (never overwrites locked plan).
 */
async function buildLaborSnapshotFields(quoteRow, existingProject) {
  const locked = Boolean(existingProject?.quoted_labor_plan_locked_at);
  if (locked) return null;

  const currentPlan = existingProject?.quoted_labor_plan;
  const currentEmpty = isPlanEffectivelyEmpty(currentPlan);

  const { workers, settings } = await resolveLaborContextForQuote(quoteRow);
  const hoursPerDay = Number(settings.hoursPerDay) || 8;

  const resolved = await resolveOperationalPlanForQuote(
    quoteRow,
    loadLatestTenantSnapshotPayload
  );
  const opNormalized = resolved?.plan?.length
    ? normalizeOperationalPlan(resolved.plan, resolved.override, hoursPerDay)
    : null;

  if (!workers.length && currentEmpty && !planHasDays(opNormalized)) return null;

  const salePrice = Math.max(finiteMoney(quoteRow.total, 0), 0);
  const economics = buildEstimateEconomics({
    workers,
    settings,
    salePrice,
    hoursPerDay,
    operationalPlan: resolved?.plan,
    operationalPlanNormalized: opNormalized,
  });

  if (!mayWriteLaborPlan(existingProject, economics.quotedLaborPlan)) {
    if (currentEmpty) return null;
    return {
      estimated_labor_cost: economics.estimatedLaborCost,
      estimated_material_cost: economics.estimatedMaterialCost,
      estimated_profit: economics.estimatedProfit,
      estimated_profit_margin: economics.estimatedProfitMargin,
      labor_budget: economics.estimatedLaborCost,
    };
  }

  const nowIso = new Date().toISOString();
  const patch = {
    quoted_labor_plan: economics.quotedLaborPlan,
    estimated_labor_cost: economics.estimatedLaborCost,
    estimated_material_cost: economics.estimatedMaterialCost,
    estimated_profit: economics.estimatedProfit,
    estimated_profit_margin: economics.estimatedProfitMargin,
    labor_budget: economics.estimatedLaborCost,
  };

  if (shouldLockLaborPlan(existingProject, economics.quotedLaborPlan)) {
    patch.quoted_labor_plan_locked_at = nowIso;
  }

  return patch;
}

async function applyOperationalSnapshotForProject(quoteRow, projectId) {
  const pid = String(projectId || "").trim();
  const tenantId = String(quoteRow?.tenant_id || "").trim();
  if (!pid || !tenantId) return;

  const resolved = await resolveOperationalPlanForQuote(
    quoteRow,
    loadLatestTenantSnapshotPayload
  );
  if (!resolved?.plan?.length) return;

  const payload = await loadLatestTenantSnapshotPayload(tenantId);
  const settings = extractSettingsFromSnapshotPayload(payload) || {};
  const hoursPerDay = Math.max(Number(settings.hoursPerDay) || 8, 0.25);

  const normalized = normalizeOperationalPlan(
    resolved.plan,
    resolved.override,
    hoursPerDay
  );
  if (!planHasDays(normalized)) return;

  const metrics = computeOperationalPlanMetrics(
    normalized,
    resolved.override,
    resolved.hoursOverride,
    hoursPerDay
  );
  const laborBudget = laborCostFromOperationalPlan(normalized, settings);
  const quotedPlan = quotedLaborPlanRowsFromOperationalPlan(
    normalized,
    settings,
    hoursPerDay
  );

  const tidEnc = encodeURIComponent(tenantId);
  const pidEnc = encodeURIComponent(pid);
  const nowIso = new Date().toISOString();

  const tpRows = await supabaseRequest(
    `tenant_projects?id=eq.${pidEnc}&tenant_id=eq.${tidEnc}&select=quoted_labor_plan_locked_at`,
    { method: "GET" }
  );
  const tpHit = Array.isArray(tpRows) ? tpRows[0] : null;
  const laborLocked = Boolean(tpHit?.quoted_labor_plan_locked_at);

  const projectPatch = {
    estimated_days: metrics.estimated_days,
    labor_budget: laborBudget,
    estimated_labor_cost: laborBudget,
    updated_at: nowIso,
  };
  if (!laborLocked && quotedPlan.length && mayWriteLaborPlan(tpHit, quotedPlan)) {
    projectPatch.quoted_labor_plan = quotedPlan;
    if (shouldLockLaborPlan(tpHit, quotedPlan)) {
      projectPatch.quoted_labor_plan_locked_at = nowIso;
    }
  }

  await supabaseRequest(`tenant_projects?id=eq.${pidEnc}&tenant_id=eq.${tidEnc}`, {
    method: "PATCH",
    body: projectPatch,
  });

  let commitmentDate =
    resolved?.due_date ||
    scheduleFieldsFromQuoteRow(quoteRow).due_date ||
    null;
  if (!commitmentDate) {
    const payload = await loadLatestTenantSnapshotPayload(tenantId);
    if (payload?.storage?.mg_sales_v2?.dueDate) {
      commitmentDate = String(payload.storage.mg_sales_v2.dueDate).trim();
    }
  }

  await persistOperationalSnapshot({
    tenantId,
    projectId: pid,
    quoteId: String(quoteRow.id || "").trim(),
    operationalPlan: normalized,
    estimatedDaysOverride: resolved.override,
    estimatedHoursOverride: resolved.hoursOverride,
    due_date: commitmentDate,
    source: "quote_accept",
  });
}

async function bridgeAcceptedQuoteToProjectAndInvoice(quoteRow) {
  if (!quoteRow || typeof quoteRow !== "object") return;

  const tenantId = String(quoteRow.tenant_id || "").trim();
  const quoteId = String(quoteRow.id || "").trim();
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(quoteId)) {
    console.warn("[accept-bridge] skip: invalid tenant_id or quote id on row");
    return;
  }

  const tidEnc = encodeURIComponent(tenantId);
  const qidEnc = encodeURIComponent(quoteId);
  const nowIso = new Date().toISOString();

  const projectName = pickStr(quoteRow.project_name || quoteRow.title, 2000).trim() || "Project";
  const clientName = pickStr(quoteRow.client_name, 500);
  const clientEmail = pickStr(quoteRow.client_email, 320);
  const salePrice = Math.max(finiteMoney(quoteRow.total, 0), 0);
  const signedAt = pickStr(quoteRow.accepted_at, 64) || nowIso;
  const currency = pickStr(quoteRow.currency, 8) || "USD";
  const quoteSchedule = scheduleFieldsFromQuoteRow(quoteRow);
  const quoteDueDate = quoteSchedule.due_date;
  const quoteStartDate = quoteSchedule.start_date;

  const laborContext = await resolveLaborContextForQuote(quoteRow);
  const hoursPerDay = Number(laborContext.settings?.hoursPerDay) || 8;
  const opResolved = await resolveOperationalPlanForQuote(
    quoteRow,
    loadLatestTenantSnapshotPayload
  );
  const opNormalized = opResolved?.plan?.length
    ? normalizeOperationalPlan(opResolved.plan, opResolved.override, hoursPerDay)
    : null;

  const insertEconomics = buildEstimateEconomics({
    workers: laborContext.workers,
    settings: laborContext.settings,
    salePrice,
    hoursPerDay,
    operationalPlan: opResolved?.plan,
    operationalPlanNormalized: opNormalized,
  });

  const insertLaborFields = {};
  const hasLaborPlan =
    (laborContext.workers.length && !isPlanEffectivelyEmpty(insertEconomics.quotedLaborPlan)) ||
    planHasDays(opNormalized);
  if (hasLaborPlan) {
    insertLaborFields.quoted_labor_plan = insertEconomics.quotedLaborPlan;
    insertLaborFields.estimated_labor_cost = insertEconomics.estimatedLaborCost;
    insertLaborFields.estimated_material_cost = insertEconomics.estimatedMaterialCost;
    insertLaborFields.estimated_profit = insertEconomics.estimatedProfit;
    insertLaborFields.estimated_profit_margin = insertEconomics.estimatedProfitMargin;
    insertLaborFields.labor_budget = insertEconomics.estimatedLaborCost;
    if (shouldLockLaborPlan(null, insertEconomics.quotedLaborPlan)) {
      insertLaborFields.quoted_labor_plan_locked_at = nowIso;
    }
  } else {
    insertLaborFields.quoted_labor_plan = [];
  }

  let resolvedProjectId = null;

  function resolveInvoiceProjectIdLink(existingInvoiceProjectId) {
    if (!resolvedProjectId || !UUID_RE.test(resolvedProjectId)) return null;
    const existing = String(existingInvoiceProjectId == null ? "" : existingInvoiceProjectId).trim();
    if (!existing) return resolvedProjectId;
    const same =
      existing.replace(/-/g, "").toLowerCase() ===
      resolvedProjectId.replace(/-/g, "").toLowerCase();
    if (same) return resolvedProjectId;
    console.warn("[accept-bridge] invoice project_id mismatch; skip overwrite", {
      invoice_project_id: existing,
      resolved_project_id: resolvedProjectId,
      quote_id: quoteId,
    });
    return null;
  }

  try {
    const tpRows = await supabaseRequest(
      `tenant_projects?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id,quote_id,quoted_labor_plan,quoted_labor_plan_locked_at`,
      { method: "GET" }
    );
    const tpHit = Array.isArray(tpRows) ? tpRows[0] : null;

    const basePatch = {
      project_name: projectName,
      client_name: clientName,
      client_email: clientEmail,
      sale_price: salePrice,
      recommended_price: salePrice,
      minimum_price: salePrice,
      status: "signed",
      quote_id: quoteId,
      updated_at: nowIso,
    };
    if (quoteDueDate) basePatch.due_date = quoteDueDate;
    if (quoteStartDate) basePatch.signed_at = `${quoteStartDate}T12:00:00.000Z`;

    if (tpHit?.id && UUID_RE.test(String(tpHit.id))) {
      resolvedProjectId = String(tpHit.id);
      const pidEnc = encodeURIComponent(resolvedProjectId);
      await supabaseRequest(`tenant_projects?id=eq.${pidEnc}&tenant_id=eq.${tidEnc}`, {
        method: "PATCH",
        body: basePatch,
      });

      const laborPatch = await buildLaborSnapshotFields(quoteRow, tpHit);
      if (laborPatch && Object.keys(laborPatch).length) {
        await supabaseRequest(`tenant_projects?id=eq.${pidEnc}&tenant_id=eq.${tidEnc}`, {
          method: "PATCH",
          body: { ...laborPatch, updated_at: nowIso },
        });
      }
      await applyOperationalSnapshotForProject(quoteRow, tpHit.id);
    } else {
      let newProjectId = null;
      try {
        const inserted = await supabaseRequest("tenant_projects", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: {
            tenant_id: tenantId,
            quote_id: quoteId,
            project_name: projectName,
            client_name: clientName,
            client_email: clientEmail,
            status: "signed",
            signed_at: quoteStartDate ? `${quoteStartDate}T12:00:00.000Z` : signedAt,
            deposit_paid: false,
            estimated_days: Math.max(0, Number(quoteRow.estimated_days) || 0),
            ...(quoteDueDate ? { due_date: quoteDueDate } : {}),
            sale_price: salePrice,
            recommended_price: salePrice,
            minimum_price: salePrice,
            notes: "",
            created_at: nowIso,
            updated_at: nowIso,
            ...insertLaborFields,
          },
        });
        const ins = Array.isArray(inserted) ? inserted[0] : inserted;
        if (ins?.id && UUID_RE.test(String(ins.id))) {
          newProjectId = String(ins.id);
        }
      } catch (e) {
        const raw = String(e?.supabaseRaw || e?.message || "");
        if (!/23505|duplicate key/i.test(raw)) throw e;
        const again = await supabaseRequest(
          `tenant_projects?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id,quoted_labor_plan,quoted_labor_plan_locked_at`,
          { method: "GET" }
        );
        const againHit = Array.isArray(again) ? again[0] : null;
        if (!againHit?.id || !UUID_RE.test(String(againHit.id))) throw e;
        newProjectId = String(againHit.id);
        const pidEnc2 = encodeURIComponent(newProjectId);
        await supabaseRequest(`tenant_projects?id=eq.${pidEnc2}&tenant_id=eq.${tidEnc}`, {
          method: "PATCH",
          body: basePatch,
        });
        const laborPatch = await buildLaborSnapshotFields(quoteRow, againHit);
        if (laborPatch && Object.keys(laborPatch).length) {
          await supabaseRequest(`tenant_projects?id=eq.${pidEnc2}&tenant_id=eq.${tidEnc}`, {
            method: "PATCH",
            body: { ...laborPatch, updated_at: nowIso },
          });
        }
      }

      if (!newProjectId) {
        const created = await supabaseRequest(
          `tenant_projects?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id&limit=1`,
          { method: "GET" }
        );
        const createdHit = Array.isArray(created) ? created[0] : null;
        if (createdHit?.id && UUID_RE.test(String(createdHit.id))) {
          newProjectId = String(createdHit.id);
        }
      }

      if (newProjectId) {
        resolvedProjectId = newProjectId;
        await applyOperationalSnapshotForProject(quoteRow, newProjectId);
      }
    }
  } catch (tpErr) {
    console.error("[accept-bridge] tenant_projects step failed (invoice step will still run)", tpErr);
  }

  if (!resolvedProjectId) {
    try {
      const fallbackRows = await supabaseRequest(
        `tenant_projects?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id&limit=1`,
        { method: "GET" }
      );
      const fallbackHit = Array.isArray(fallbackRows) ? fallbackRows[0] : null;
      if (fallbackHit?.id && UUID_RE.test(String(fallbackHit.id))) {
        resolvedProjectId = String(fallbackHit.id);
      }
    } catch (_fallbackErr) {
      /* non-blocking */
    }
  }

  console.log("[accept-bridge] project bridge done, starting invoice", {
    resolved_project_id: resolvedProjectId || null,
  });

  const existingInvoices = await supabaseRequest(
    `invoices?tenant_id=eq.${tidEnc}&quote_id=eq.${qidEnc}&select=id,public_token,quote_id,project_id`,
    { method: "GET" }
  );
  console.log("[accept-bridge] existing invoices", existingInvoices);

  const invList = Array.isArray(existingInvoices)
    ? existingInvoices
    : existingInvoices && typeof existingInvoices === "object"
      ? [existingInvoices]
      : [];
  const invHit =
    invList.find(
      (r) =>
        r &&
        r.id &&
        UUID_RE.test(String(r.id)) &&
        String(r.quote_id || "").replace(/-/g, "").toLowerCase() ===
          String(quoteId).replace(/-/g, "").toLowerCase()
    ) || null;

  if (invHit?.id && UUID_RE.test(String(invHit.id))) {
    const invoiceProjectId = resolveInvoiceProjectIdLink(invHit.project_id);
    console.log("[accept-bridge] invoice path: PATCH existing", {
      id: invHit.id,
      quote_id: quoteId,
      project_id: invoiceProjectId || invHit.project_id || null,
    });
    const iidEnc = encodeURIComponent(String(invHit.id));
    const invoicePatch = {
      quote_id: quoteId,
      customer_name: clientName,
      customer_email: clientEmail,
      project_name: projectName,
      amount: salePrice,
      paid_amount: 0,
      balance_due: salePrice,
      currency,
    };
    if (invoiceProjectId) invoicePatch.project_id = invoiceProjectId;
    await supabaseRequest(`invoices?id=eq.${iidEnc}&tenant_id=eq.${tidEnc}`, {
      method: "PATCH",
      body: invoicePatch,
    });
  } else {
    const rawTotal = Number(quoteRow.total || 0);
    const insertAmount = Number.isFinite(rawTotal) ? rawTotal : 0;
    const invoiceInsertPayload = {
      tenant_id: tenantId,
      quote_id: quoteId,
      public_token: makePublicToken("inv"),
      invoice_no: `INV-${Date.now()}`,
      customer_name: quoteRow.client_name || "",
      customer_email: quoteRow.client_email || "",
      project_name: quoteRow.project_name || "",
      amount: insertAmount,
      paid_amount: 0,
      balance_due: insertAmount,
      currency: pickStr(quoteRow.currency, 8) || "USD",
      status: "DRAFT",
      type: "FINAL",
    };
    const insertProjectId = resolveInvoiceProjectIdLink(null);
    if (insertProjectId) invoiceInsertPayload.project_id = insertProjectId;

    console.log("[accept-bridge] inserting invoice", invoiceInsertPayload);

    try {
      const created = await supabaseRequest("invoices", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: invoiceInsertPayload,
      });
      const invoiceRow = Array.isArray(created) ? created[0] : created;
      console.log("[accept-bridge] invoice created", invoiceRow);
    } catch (err) {
      console.error("[accept-bridge] invoice insert failed", err);
      if (err?.supabaseRaw) {
        console.error("[accept-bridge] invoice insert supabaseRaw", err.supabaseRaw);
      }
      throw err;
    }
  }
}

module.exports = {
  bridgeAcceptedQuoteToProjectAndInvoice,
  UUID_RE,
  resolveLaborContextForQuote,
  buildLaborSnapshotFields,
};
