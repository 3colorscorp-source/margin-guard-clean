/**
 * Quote labor areas. Sell subtotals are a cent partition of the existing
 * publish total. They are not a second pricing engine.
 */

const crypto = require("crypto");
const { computePublishLaborComponents } = require("./pricing-engine");

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_AREAS = 30;
const NAME_MAX = 80;
const SCOPE_MAX = 4000;
const SCOPE_JOIN_MAX = 16000;

const AREA_MONEY_KEYS = new Set([
  "sell_subtotal",
  "sell_cents",
  "subtotal",
  "price",
  "total",
  "cost",
  "rate",
  "margin",
  "overhead",
  "profit",
  "reserve",
  "commission",
  "public_subtotals",
  "workers",
]);

function newAreaId() {
  return crypto.randomUUID();
}

function fail(code, error) {
  return { ok: false, code, error };
}

function isMissingLaborAreaColumn(text) {
  const t = String(text || "").toLowerCase();
  if (!/42703|column|schema cache|could not find/i.test(t)) return false;
  return /labor_area_breakdown/i.test(t);
}

function areasRequested(raw) {
  if (raw === undefined || raw === null) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  return true;
}

/**
 * @returns {{ ok: true, areas: null | object[] } | { ok: false, code: string, error: string }}
 * Empty / omitted input means the quote stays without an area breakdown.
 */
function normalizeLaborAreas(raw) {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, areas: null };
  }
  if (!Array.isArray(raw)) {
    return fail("invalid_labor_areas", "labor_areas must be an array.");
  }
  if (raw.length > MAX_AREAS) {
    return fail("invalid_labor_areas", "A quote can include at most 30 areas.");
  }

  const used = new Set();
  const staged = raw.map((item, index) => ({ item, index }));
  staged.sort((a, b) => {
    const as = Number(a.item && a.item.sort_order);
    const bs = Number(b.item && b.item.sort_order);
    const aOk = Number.isFinite(as);
    const bOk = Number.isFinite(bs);
    if (aOk && bOk && as !== bs) return as - bs;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    return a.index - b.index;
  });

  const areas = [];
  for (const entry of staged) {
    const item = entry.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return fail("invalid_labor_areas", "Each area must be an object.");
    }
    for (const key of Object.keys(item)) {
      if (AREA_MONEY_KEYS.has(key)) {
        return fail(
          "invalid_labor_areas",
          "Area subtotals are calculated by Margin Guard and cannot be submitted."
        );
      }
    }
    const name = String(item.name || "").trim();
    if (!name) return fail("invalid_labor_areas", "Each area needs a name.");
    if (name.length > NAME_MAX) {
      return fail("invalid_labor_areas", "Area names must be 80 characters or fewer.");
    }
    const scope = String(item.scope || "").trim();
    if (scope.length > SCOPE_MAX) {
      return fail("invalid_labor_areas", "Each area scope must be 4000 characters or fewer.");
    }
    let id = String(item.id || "").trim();
    if (!UUID_RE.test(id) || used.has(id)) id = newAreaId();
    used.add(id);
    areas.push({
      id,
      name,
      scope,
      sort_order: areas.length,
    });
  }
  return { ok: true, areas };
}

function joinClientScope(areas) {
  return areas
    .map((area) => {
      const scope = String(area.scope || "").trim();
      return scope ? `${area.name}\n${scope}` : area.name;
    })
    .join("\n\n");
}

function workerHasLabor(worker) {
  return Math.max(0, Number(worker?.days || 0)) > 0 || Math.max(0, Number(worker?.hours || 0)) > 0;
}

function persistedWorker(worker, areaId) {
  const row = {
    type: worker.type === "helper" ? "helper" : "installer",
    days: Math.max(0, Number(worker.days || 0)),
    area_id: areaId,
  };
  const name = String(worker.name || "").trim();
  if (name) row.name = name.slice(0, 120);
  const hours = Math.max(0, Number(worker.hours || 0));
  if (hours > 0 && !(Number(worker.days) > 0)) row.hours = hours;
  return row;
}

/**
 * Largest-remainder allocation in integer cents. Ties break by sort_order, then id.
 * @param {object[]} areas
 * @param {number[]} weights
 * @param {number} totalCents
 */
function allocateSellCents(areas, weights, totalCents) {
  const n = areas.length;
  const cents = Math.max(0, Math.round(Number(totalCents) || 0));
  if (!n) return [];
  if (cents === 0) return areas.map(() => 0);
  const safeWeights = weights.map((w) => {
    const nW = Math.round(Number(w) || 0);
    return nW > 0 ? nW : 0;
  });
  const sumW = safeWeights.reduce((sum, w) => sum + w, 0);
  if (sumW <= 0) {
    const out = areas.map(() => 0);
    out[0] = cents;
    return out;
  }
  const biTotal = BigInt(cents);
  const biSum = BigInt(sumW);
  const floors = [];
  const remainders = [];
  for (let i = 0; i < n; i += 1) {
    const num = biTotal * BigInt(safeWeights[i]);
    floors.push(Number(num / biSum));
    remainders.push(num % biSum);
  }
  let used = floors.reduce((sum, value) => sum + value, 0);
  let left = cents - used;
  const order = areas.map((area, index) => ({
    index,
    rem: remainders[index],
    sort: area.sort_order,
    id: area.id,
  }));
  order.sort((a, b) => {
    if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1;
    if (a.sort !== b.sort) return a.sort - b.sort;
    return String(a.id).localeCompare(String(b.id));
  });
  let cursor = 0;
  while (left > 0) {
    floors[order[cursor % n].index] += 1;
    left -= 1;
    cursor += 1;
  }
  return floors;
}

function asBreakdown(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_err) {
      return null;
    }
  }
  return value;
}

function publicAreasFromBreakdown(breakdown) {
  const parsed = asBreakdown(breakdown);
  if (!parsed || !Array.isArray(parsed.areas)) return [];
  breakdown = parsed;
  const centsById = new Map(
    (Array.isArray(breakdown.public_subtotals) ? breakdown.public_subtotals : []).map((row) => [
      row.area_id,
      Math.max(0, Math.round(Number(row.sell_cents) || 0)),
    ])
  );
  return breakdown.areas
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((area) => ({
      name: area.name,
      scope: area.scope || "",
      sort_order: area.sort_order,
      sell_subtotal: round2((centsById.get(area.id) || 0) / 100),
    }));
}

/**
 * Build the stored breakdown from tenant-priced workers and the already chosen contract total.
 * Client subtotals are ignored because normalizeLaborAreas rejects them.
 */
function buildLaborAreaBreakdown({ areasInput, workers, tenantSettings, total }) {
  const normalized = normalizeLaborAreas(areasInput);
  if (!normalized.ok) return normalized;
  if (!normalized.areas) {
    return { ok: true, breakdown: null, scopeText: null, publicAreas: [] };
  }

  const areas = normalized.areas;
  const areaIds = new Set(areas.map((area) => area.id));
  const storedWorkers = [];
  for (const worker of Array.isArray(workers) ? workers : []) {
    if (!workerHasLabor(worker)) continue;
    const areaId = String(worker.area_id || "").trim();
    if (!areaIds.has(areaId)) {
      return fail(
        "labor_area_required",
        "Each labor line must belong to an area on this quote."
      );
    }
    storedWorkers.push(persistedWorker(worker, areaId));
  }
  if (!storedWorkers.length) {
    return fail("labor_area_required", "Add labor to at least one area.");
  }

  const components = computePublishLaborComponents(storedWorkers, tenantSettings);
  const weightById = new Map(areas.map((area) => [area.id, 0]));
  for (const row of components.laborByWorker) {
    const prev = weightById.get(row.area_id) || 0;
    weightById.set(row.area_id, prev + Math.max(0, row.beforeProfit));
  }
  const weights = areas.map((area) => Math.round((weightById.get(area.id) || 0) * 1e6));
  const totalCents = Math.round(round2(total) * 100);
  const cents = allocateSellCents(areas, weights, totalCents);
  const sumCents = cents.reduce((sum, value) => sum + value, 0);
  if (sumCents !== totalCents) {
    return fail("labor_area_allocation", "Area subtotals did not match the quote total.");
  }

  const breakdown = {
    version: 1,
    areas,
    workers: storedWorkers,
    public_subtotals: areas.map((area, index) => ({
      area_id: area.id,
      sell_cents: cents[index],
    })),
  };
  const scopeText = joinClientScope(areas);
  if (scopeText.length > SCOPE_JOIN_MAX) {
    return fail("scope_too_long", "Combined area scope is too long to store.");
  }
  return {
    ok: true,
    breakdown,
    scopeText,
    publicAreas: publicAreasFromBreakdown(breakdown),
  };
}

function editorAreasFromBreakdown(breakdown) {
  const parsed = asBreakdown(breakdown);
  if (!parsed || !Array.isArray(parsed.areas)) return [];
  breakdown = parsed;
  return breakdown.areas
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((area) => ({
      id: area.id,
      name: area.name,
      scope: area.scope || "",
      sort_order: area.sort_order,
    }));
}

module.exports = {
  UUID_RE,
  isMissingLaborAreaColumn,
  areasRequested,
  normalizeLaborAreas,
  allocateSellCents,
  buildLaborAreaBreakdown,
  publicAreasFromBreakdown,
  editorAreasFromBreakdown,
  joinClientScope,
};
