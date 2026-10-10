/**
 * Pure area identity contract. Does not price, persist, or read a quote.
 * area_ref exists only until resolveTemporaryAreaRefs remaps it to a UUID.
 */

const crypto = require("crypto");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA_REF_RE = /^area_[1-9][0-9]*$/;

const MAX_AREAS = 30;
const NAME_MAX = 80;
const SCOPE_MAX = 4000;

const MONEY_KEYS = [
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
];

function fail(code, error) {
  return { ok: false, code, error };
}

function newAreaId() {
  return crypto.randomUUID();
}

function rawDaysOf(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    if (Array.isArray(input.days)) return input.days;
    if (Array.isArray(input.operational_plan)) return input.operational_plan;
    if (Array.isArray(input.plan)) return input.plan;
  }
  return null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const DAY_MONEY_KEYS = MONEY_KEYS.filter((key) => key !== "workers");

function moneyKey(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys || MONEY_KEYS) {
    if (hasOwn(obj, key)) return key;
  }
  return "";
}

function moneyFailure(obj, keys, label) {
  const blocked = moneyKey(obj, keys);
  if (!blocked) return null;
  return fail("invalid_area_contract", label + " cannot carry " + blocked + ".");
}

function crewRows(day) {
  if (Array.isArray(day.workers)) return day.workers;
  if (Array.isArray(day.crew)) return day.crew;
  return [];
}

function dayMoneyFailure(day) {
  const dayMoney = moneyFailure(day, DAY_MONEY_KEYS, "Day");
  if (dayMoney) return dayMoney;
  for (const worker of crewRows(day)) {
    const workerMoney = moneyFailure(worker, DAY_MONEY_KEYS, "Worker");
    if (workerMoney) return workerMoney;
  }
  return null;
}

/**
 * Remap area_ref to UUID in one step.
 * An existing area_id is kept. A missing one is minted. area_ref is not returned.
 * Any broken reference fails the whole call.
 */
function resolveTemporaryAreaRefs(input, options) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("invalid_area_contract", "Area contract must be an object with areas and days.");
  }
  if (!Array.isArray(input.areas) || !Array.isArray(input.days)) {
    return fail("invalid_area_contract", "areas and days must be arrays.");
  }
  if (input.areas.length > MAX_AREAS) {
    return fail("invalid_area_contract", "A plan can include at most 30 areas.");
  }

  const createId =
    options && typeof options.createId === "function" ? options.createId : newAreaId;
  const refs = new Map();
  const usedIds = new Set();
  const areas = [];

  for (let index = 0; index < input.areas.length; index += 1) {
    const row = input.areas[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return fail("invalid_area_contract", "Each area must be an object.");
    }
    const blocked = moneyFailure(row, MONEY_KEYS, "Area catalog");
    if (blocked) return blocked;
    const areaRef = String(row.area_ref == null ? "" : row.area_ref).trim();
    if (!AREA_REF_RE.test(areaRef)) {
      return fail("invalid_area_ref", "area_ref must look like area_1.");
    }
    if (refs.has(areaRef)) {
      return fail("duplicate_area_ref", "area_ref " + areaRef + " is used more than once.");
    }
    const name = String(row.name == null ? "" : row.name).trim();
    if (!name || name.length > NAME_MAX) {
      return fail("invalid_area_contract", "Each area needs a name of at most 80 characters.");
    }
    const scope = String(row.scope == null ? "" : row.scope).trim();
    if (scope.length > SCOPE_MAX) {
      return fail("invalid_area_contract", "Area scope is too long.");
    }
    let id = String(row.area_id == null ? "" : row.area_id).trim();
    if (id) {
      if (!UUID_RE.test(id)) {
        return fail("invalid_area_id", "area_id must be a UUID when it is supplied.");
      }
      if (usedIds.has(id)) {
        return fail("duplicate_area_id", "area_id " + id + " is used more than once.");
      }
    } else {
      id = createId();
      if (!UUID_RE.test(id)) {
        return fail("invalid_area_id", "Minted area_id is not a UUID.");
      }
      if (usedIds.has(id)) {
        return fail("duplicate_area_id", "Minted area_id collided.");
      }
    }
    usedIds.add(id);
    refs.set(areaRef, id);
    const sortOrder = Number.isInteger(row.sort_order) ? row.sort_order : index;
    if (sortOrder < 0) {
      return fail("invalid_area_contract", "sort_order cannot be negative.");
    }
    areas.push({
      id,
      name,
      scope,
      sort_order: sortOrder,
      area_ref: areaRef,
    });
  }

  const sortValues = areas.map((area) => area.sort_order);
  if (new Set(sortValues).size !== sortValues.length) {
    return fail("invalid_area_contract", "sort_order values must be unique.");
  }

  if (areas.length === 0) {
    const plainDays = [];
    for (const day of input.days) {
      if (day && typeof day === "object" && (hasOwn(day, "area_ref") || hasOwn(day, "area_id"))) {
        return fail("orphan_day_area", "A day points at an area, but the catalog is empty.");
      }
      if (day && typeof day === "object") {
        const blocked = dayMoneyFailure(day);
        if (blocked) return blocked;
      }
      plainDays.push(day);
    }
    return {
      ok: true,
      areas: [],
      days: plainDays,
    };
  }

  const days = [];
  for (const day of input.days) {
    if (!day || typeof day !== "object" || Array.isArray(day)) {
      return fail("invalid_area_contract", "Each day must be an object.");
    }
    const blockedDay = dayMoneyFailure(day);
    if (blockedDay) return blockedDay;
    const areaRef = String(day.area_ref == null ? "" : day.area_ref).trim();
    if (!AREA_REF_RE.test(areaRef) || !refs.has(areaRef)) {
      return fail("orphan_day_area", "Every day must use an area_ref from the catalog.");
    }
    const areaId = refs.get(areaRef);
    if (hasOwn(day, "area_id") && String(day.area_id || "").trim() && String(day.area_id).trim() !== areaId) {
      return fail("orphan_day_area", "Day area_id does not match its area_ref.");
    }
    const next = {};
    for (const key of Object.keys(day)) {
      if (key === "area_ref" || key === "area_id") continue;
      next[key] = day[key];
    }
    next.area_id = areaId;
    days.push(next);
  }

  return {
    ok: true,
    areas: areas
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((area) => ({
        id: area.id,
        name: area.name,
        scope: area.scope,
        sort_order: area.sort_order,
      })),
    days,
  };
}

/**
 * Keep a day area_id only when it is a UUID in the authorized catalog.
 * area_ref is not accepted here. The whole plan fails if any day does not match.
 */
function applyAuthorizedAreaCatalog(days, areaCatalog) {
  if (!Array.isArray(days)) {
    return fail("invalid_area_contract", "Days must be an array.");
  }
  if (!Array.isArray(areaCatalog)) {
    return fail("area_catalog_required", "An authorized area catalog is required.");
  }
  const ids = new Set();
  for (const area of areaCatalog) {
    if (!area || typeof area !== "object") {
      return fail("invalid_area_catalog", "Each catalog area must be an object.");
    }
    const id = String(area.id == null ? "" : area.id).trim();
    if (!UUID_RE.test(id)) {
      return fail("invalid_area_id", "Catalog area id must be a UUID.");
    }
    if (ids.has(id)) {
      return fail("duplicate_area_id", "Catalog area id " + id + " is duplicated.");
    }
    ids.add(id);
  }

  const seenDayNumbers = new Set();
  const nextDays = [];
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    if (!day || typeof day !== "object" || Array.isArray(day)) {
      return fail("invalid_area_contract", "Each day must be an object.");
    }
    if (hasOwn(day, "area_ref")) {
      return fail("unresolved_area_ref", "area_ref must be resolved before the catalog is applied.");
    }
    const blockedDay = dayMoneyFailure(day);
    if (blockedDay) return blockedDay;
    const dayNumber = Number.isInteger(day.day_number) ? day.day_number : index + 1;
    if (seenDayNumbers.has(dayNumber)) {
      return fail("duplicate_day_number", "Day number " + dayNumber + " is duplicated.");
    }
    seenDayNumbers.add(dayNumber);
    if (ids.size === 0) {
      if (hasOwn(day, "area_id") && String(day.area_id || "").trim()) {
        return fail("area_not_in_catalog", "A day has an area_id, but the catalog is empty.");
      }
      const plain = {};
      for (const key of Object.keys(day)) {
        if (key === "area_id" || key === "area_ref") continue;
        plain[key] = day[key];
      }
      nextDays.push(plain);
      continue;
    }
    const areaId = String(day.area_id == null ? "" : day.area_id).trim();
    if (!UUID_RE.test(areaId) || !ids.has(areaId)) {
      return fail("area_not_in_catalog", "Day area_id is missing or is not in the authorized catalog.");
    }
    const next = {};
    for (const key of Object.keys(day)) {
      if (key === "area_ref") continue;
      next[key] = day[key];
    }
    next.area_id = areaId;
    nextDays.push(next);
  }

  return { ok: true, days: nextDays };
}

module.exports = {
  UUID_RE,
  AREA_REF_RE,
  resolveTemporaryAreaRefs,
  applyAuthorizedAreaCatalog,
  rawDaysOf,
};
