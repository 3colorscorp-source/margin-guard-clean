/**
 * CH-001A — Universal Trade Module registry (metadata only).
 * Not a legal clause engine. No tenant data. No state rules.
 */

const TRADE_MODULES = Object.freeze([
  Object.freeze({ code: "general_remodeling", name: "General Remodeling", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "tile_installation", name: "Tile Installation", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "flooring", name: "Flooring", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "roofing", name: "Roofing", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "plumbing", name: "Plumbing", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "electrical", name: "Electrical", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "hvac", name: "HVAC", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "painting", name: "Painting", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "landscaping", name: "Landscaping", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "cleaning", name: "Cleaning", category: "services", version: 1, active: true }),
  Object.freeze({ code: "handyman", name: "Handyman", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "concrete", name: "Concrete", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "solar", name: "Solar", category: "construction", version: 1, active: true }),
  Object.freeze({ code: "pool_service", name: "Pool Service", category: "services", version: 1, active: true }),
  Object.freeze({ code: "custom", name: "Custom Trade", category: "other", version: 1, active: true }),
]);

const BY_CODE = Object.freeze(
  TRADE_MODULES.reduce((acc, mod) => {
    acc[mod.code] = mod;
    return acc;
  }, Object.create(null))
);

function listTradeModules({ activeOnly = true } = {}) {
  if (!activeOnly) return TRADE_MODULES.slice();
  return TRADE_MODULES.filter((m) => m.active);
}

function getTradeModule(code) {
  const key = String(code || "").trim().toLowerCase();
  if (!key) return null;
  return BY_CODE[key] || null;
}

function isValidTradeModule(code) {
  const mod = getTradeModule(code);
  return Boolean(mod && mod.active);
}

module.exports = {
  TRADE_MODULES,
  listTradeModules,
  getTradeModule,
  isValidTradeModule,
};
