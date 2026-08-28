/**
 * Closed read-only supervisor device pairing diagnostic for Support AI.
 * GET only. Trusted tenant_id from the signed owner session.
 * Never select or return pairing_code_hash, device_fingerprint, session hashes,
 * raw pairing codes, cookies, HMAC, or credentials. Never return raw UUIDs in facts.
 */
"use strict";

const { supabaseRequest } = require("../supabase-admin");

const DEVICE_SELECT_FIELDS = [
  "id",
  "tenant_id",
  "portal_type",
  "assigned_membership_id",
  "display_name",
  "status",
  "last_seen_at",
  "revoked_at",
  "created_at",
  "updated_at",
  "pairing_expires_at",
];

const DEVICE_SELECT = DEVICE_SELECT_FIELDS.join(",");

/**
 * Product pairing window: owner Reset pairing writes the code hash and
 * pairing_expires_at together; successful pair clears both; device create
 * writes neither. pairing_expires_at is therefore the least-sensitive evidence
 * that a pairing code window exists. has_pairing_code means that timestamp is
 * present — not an inference from status alone. The hash is never selected.
 */

/** auth_user_id is converted to booleans only; never returned in model facts. */
const PROFILE_SELECT_FIELDS = ["id", "tenant_id", "role", "status", "display_name", "auth_user_id"];
const PROFILE_SELECT = PROFILE_SELECT_FIELDS.join(",");

const DEVICE_STATUSES = new Set(["pending_pair", "active", "revoked", "suspended"]);
const PORTAL_TYPES = new Set(["supervisor", "seller"]);
const REASONS = new Set([
  "no_supervisor",
  "no_device",
  "pending_pair",
  "already_paired",
  "pairing_code_expired",
  "revoked",
  "multiple_devices",
  "status_unverified",
]);

function isNonEmpty(value) {
  return String(value ?? "").trim() !== "";
}

function normId(value) {
  return String(value || "").trim();
}

function normStatus(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase();
  return DEVICE_STATUSES.has(s) ? s : null;
}

function normPortal(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase();
  return PORTAL_TYPES.has(s) ? s : null;
}

function safeTimestamp(value) {
  return isNonEmpty(value) ? String(value).trim() : null;
}

function safeDisplayName(value) {
  const name = String(value ?? "").trim();
  return name || null;
}

function isActiveMembership(row) {
  return (
    String(row?.status || "")
      .trim()
      .toLowerCase() === "active"
  );
}

function pairingUnexpired(expiresAt, nowMs) {
  const raw = String(expiresAt || "").trim();
  if (!raw) return false;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  return ms > nowMs;
}

function buildProfileQueryPath(tenantId) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("role", "eq.supervisor");
  params.set("select", PROFILE_SELECT);
  return `profiles?${params.toString()}`;
}

function buildDeviceQueryPath(tenantId) {
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("portal_type", "eq.supervisor");
  params.set("select", DEVICE_SELECT);
  params.set("order", "created_at.desc");
  return `tenant_devices?${params.toString()}`;
}

function buildProjectCountQueryPath(tenantId, authUserIds) {
  const ids = [...new Set((authUserIds || []).map(normId).filter(Boolean))];
  if (!ids.length) return "";
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "id");
  params.set("limit", "1");
  if (ids.length === 1) {
    params.set("supervisor_user_id", `eq.${ids[0]}`);
  } else {
    params.set("supervisor_user_id", `in.(${ids.join(",")})`);
  }
  return `tenant_projects?${params.toString()}`;
}

function sameTenantRows(rows, tenantId) {
  const tid = normId(tenantId);
  return (Array.isArray(rows) ? rows : []).filter((row) => normId(row?.tenant_id) === tid);
}

function quotedHandles(message) {
  const text = String(message || "");
  const out = [];
  const re = /["“”']([^"“”']{1,80})["“”']/g;
  let match;
  while ((match = re.exec(text))) {
    const value = String(match[1] || "").trim();
    if (value) out.push(value);
  }
  return out;
}

/**
 * Resolve exactly one supervisor device by an owner-visible display name.
 * Exact case-insensitive match only. No UUID selection. No fuzzy ranking.
 */
function resolveDeviceByDisplayName(devices, message) {
  const list = Array.isArray(devices) ? devices : [];
  const text = String(message || "").toLowerCase();
  if (!list.length || !text) return null;

  const quoted = quotedHandles(message).map((n) => n.toLowerCase());
  if (quoted.length) {
    const hits = list.filter((row) => quoted.includes(String(row?.display_name || "").trim().toLowerCase()));
    const uniqueIds = [...new Set(hits.map((row) => normId(row?.id)).filter(Boolean))];
    if (uniqueIds.length === 1) return hits[0];
    return null;
  }

  const named = list.filter((row) => {
    const name = String(row?.display_name || "").trim().toLowerCase();
    return name && text.includes(name);
  });
  const uniqueIds = [...new Set(named.map((row) => normId(row?.id)).filter(Boolean))];
  if (uniqueIds.length === 1) return named[0];
  return null;
}

function emptyFacts(overrides) {
  return {
    supervisor_membership_exists: false,
    supervisor_membership_active: false,
    supervisor_auth_linked: false,
    assigned_project_count_nonzero: false,
    device_record_exists: false,
    portal_type: null,
    device_status: null,
    has_pairing_code: false,
    pairing_code_unexpired: false,
    pairing_reset_allowed: false,
    active_supervisor_device_count: 0,
    last_seen_at: null,
    display_name: null,
    reason: "status_unverified",
    ...overrides,
  };
}

function toModelFacts({ memberships, device, devices, assignedProjectCountNonzero, nowMs, reason }) {
  const list = Array.isArray(memberships) ? memberships : [];
  const deviceList = Array.isArray(devices) ? devices : [];
  const exists = list.length > 0;
  const active = list.filter(isActiveMembership);
  const authLinked = active.some((row) => isNonEmpty(row?.auth_user_id));
  const activeDeviceCount = deviceList.filter((row) => normStatus(row?.status) === "active").length;
  const status = device ? normStatus(device.status) : null;
  const expiresAt = device ? device.pairing_expires_at : null;
  const pairingWindowPresent = isNonEmpty(expiresAt);
  const unexpired = pairingUnexpired(expiresAt, nowMs);
  const facts = {
    supervisor_membership_exists: exists,
    supervisor_membership_active: active.length > 0,
    supervisor_auth_linked: authLinked,
    assigned_project_count_nonzero: Boolean(assignedProjectCountNonzero),
    device_record_exists: Boolean(device) || deviceList.length > 0,
    portal_type: device ? normPortal(device.portal_type) : deviceList.length ? "supervisor" : null,
    device_status: status,
    has_pairing_code: pairingWindowPresent,
    pairing_code_unexpired: unexpired,
    pairing_reset_allowed: Boolean(device) && status !== "revoked",
    active_supervisor_device_count: activeDeviceCount,
    last_seen_at: device ? safeTimestamp(device.last_seen_at) : null,
    display_name: device ? safeDisplayName(device.display_name) : null,
    reason: REASONS.has(reason) ? reason : "status_unverified",
  };
  return facts;
}

function reasonForDevice(device, nowMs) {
  if (!device) return "no_device";
  const status = normStatus(device.status);
  if (status === "revoked") return "revoked";
  if (status === "active") return "already_paired";
  if (status === "pending_pair") {
    if (pairingUnexpired(device.pairing_expires_at, nowMs)) return "pending_pair";
    return "pairing_code_expired";
  }
  return "status_unverified";
}

async function defaultGet(path) {
  return supabaseRequest(path, { method: "GET" });
}

/**
 * @returns {Promise<{ outcome: "ok"|"status_unverified", facts?: object, queryPaths: string[] }>}
 */
async function readDevicePairingDiagnostic(tenantId, message, deps = {}) {
  const tid = normId(tenantId);
  const queryPaths = [];
  if (!tid) {
    return { outcome: "status_unverified", queryPaths, facts: emptyFacts({ reason: "status_unverified" }) };
  }

  const get = deps.supabaseGet || defaultGet;
  const nowMs = typeof deps.nowMs === "function" ? Number(deps.nowMs()) : Date.now();

  let profiles;
  const profilePath = buildProfileQueryPath(tid);
  queryPaths.push(profilePath);
  try {
    profiles = await get(profilePath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPaths, facts: emptyFacts({ reason: "status_unverified" }) };
  }
  if (!Array.isArray(profiles)) {
    return { outcome: "status_unverified", queryPaths, facts: emptyFacts({ reason: "status_unverified" }) };
  }

  const memberships = sameTenantRows(profiles, tid).filter(
    (row) =>
      String(row?.role || "")
        .trim()
        .toLowerCase() === "supervisor"
  );

  let devicesRaw;
  const devicePath = buildDeviceQueryPath(tid);
  queryPaths.push(devicePath);
  try {
    devicesRaw = await get(devicePath);
  } catch (_err) {
    return { outcome: "status_unverified", queryPaths, facts: emptyFacts({ reason: "status_unverified" }) };
  }
  if (!Array.isArray(devicesRaw)) {
    return { outcome: "status_unverified", queryPaths, facts: emptyFacts({ reason: "status_unverified" }) };
  }

  const devices = sameTenantRows(devicesRaw, tid).filter((row) => normPortal(row?.portal_type) === "supervisor");

  let assignedProjectCountNonzero = false;
  const authIds = memberships.map((row) => normId(row?.auth_user_id)).filter(Boolean);
  const projectPath = buildProjectCountQueryPath(tid, authIds);
  if (projectPath) {
    queryPaths.push(projectPath);
    try {
      const projectRows = await get(projectPath);
      assignedProjectCountNonzero = Array.isArray(projectRows) && projectRows.length > 0;
    } catch (_err) {
      assignedProjectCountNonzero = false;
    }
  }

  const activeMemberships = memberships.filter(isActiveMembership);
  if (activeMemberships.length === 0) {
    return {
      outcome: "ok",
      queryPaths,
      facts: toModelFacts({
        memberships,
        device: null,
        devices,
        assignedProjectCountNonzero,
        nowMs,
        reason: "no_supervisor",
      }),
    };
  }

  if (devices.length === 0) {
    return {
      outcome: "ok",
      queryPaths,
      facts: toModelFacts({
        memberships,
        device: null,
        devices,
        assignedProjectCountNonzero,
        nowMs,
        reason: "no_device",
      }),
    };
  }

  let device = null;
  if (devices.length === 1) {
    device = devices[0];
  } else {
    device = resolveDeviceByDisplayName(devices, message);
    if (!device) {
      return {
        outcome: "ok",
        queryPaths,
        facts: toModelFacts({
          memberships,
          device: null,
          devices,
          assignedProjectCountNonzero,
          nowMs,
          reason: "multiple_devices",
        }),
      };
    }
  }

  const reason = reasonForDevice(device, nowMs);
  return {
    outcome: "ok",
    queryPaths,
    facts: toModelFacts({
      memberships,
      device,
      devices,
      assignedProjectCountNonzero,
      nowMs,
      reason,
    }),
  };
}

module.exports = {
  DEVICE_SELECT_FIELDS,
  DEVICE_SELECT,
  PROFILE_SELECT_FIELDS,
  PROFILE_SELECT,
  buildProfileQueryPath,
  buildDeviceQueryPath,
  buildProjectCountQueryPath,
  resolveDeviceByDisplayName,
  toModelFacts,
  reasonForDevice,
  readDevicePairingDiagnostic,
};
