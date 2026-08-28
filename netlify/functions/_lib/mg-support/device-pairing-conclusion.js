/**
 * Closed Team & Devices pairing answers for Support AI.
 * OpenAI must not generate these conclusions.
 */
"use strict";

const NO_SUPERVISOR =
  "No active supervisor membership is currently available for device pairing.";

const NO_DEVICE = "No supervisor device record is currently set up for pairing.";

const PENDING_VALID =
  "This supervisor device is waiting to be paired and its current pairing window is still active.";

const PENDING_EXPIRED =
  "This supervisor device is waiting to be paired, but it needs a new pairing code. Open Team & Devices and use Reset pairing.";

const ALREADY_PAIRED = "This supervisor device is already paired and active.";

const REVOKED =
  "This supervisor device has been revoked and cannot be paired again from its current record.";

const MULTIPLE =
  "More than one supervisor device matches this request. Open Team & Devices and identify the device by its display name.";

const UNVERIFIED = "Margin Guard could not verify the current supervisor device state.";

const NEEDS_OWNER_TENANT =
  "Device pairing can be checked only for the signed-in owner's Team & Devices.";

const REASON_COPY = {
  no_supervisor: NO_SUPERVISOR,
  no_device: NO_DEVICE,
  pending_pair: PENDING_VALID,
  pairing_code_expired: PENDING_EXPIRED,
  already_paired: ALREADY_PAIRED,
  revoked: REVOKED,
  multiple_devices: MULTIPLE,
  status_unverified: UNVERIFIED,
};

function copyForDeviceReason(reason) {
  return REASON_COPY[String(reason || "")] || null;
}

function devicePairingAnswer(intent, diagnostic) {
  if (intent !== "device_pairing_diagnostic") return null;
  if (!diagnostic) return null;
  const outcome = diagnostic.outcome;
  if (outcome === "no_tenant_context") return NEEDS_OWNER_TENANT;
  if (outcome === "status_unverified") return UNVERIFIED;
  if (outcome === "ok") {
    return copyForDeviceReason(diagnostic.facts && diagnostic.facts.reason);
  }
  return UNVERIFIED;
}

module.exports = {
  NO_SUPERVISOR,
  NO_DEVICE,
  PENDING_VALID,
  PENDING_EXPIRED,
  ALREADY_PAIRED,
  REVOKED,
  MULTIPLE,
  UNVERIFIED,
  NEEDS_OWNER_TENANT,
  copyForDeviceReason,
  devicePairingAnswer,
};
