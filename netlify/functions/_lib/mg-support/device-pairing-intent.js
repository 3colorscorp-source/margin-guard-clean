/**
 * MG-SUPPORT-003D.D1 — explicit supervisor device pairing/auth trouble.
 * Does not route on bare "device", "tablet", or "supervisor".
 * Does not steal supervisor-portal visibility or invoice intents.
 */
"use strict";

function hasPairingAuthTrouble(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (/\bre-?pair(?:ing|ed)?\b/.test(t)) return true;
  if (/\bpair(?:ing|ed)?\b/.test(t)) return true;
  if (/\balready paired\b/.test(t)) return true;
  if (/\bpairing code\b/.test(t)) return true;
  if (/\btablet can(?:not|'t) sign in\b/.test(t)) return true;
  if (/\bstopped working\b/.test(t) && /\b(device|tablet)s?\b/.test(t)) return true;
  return false;
}

function hasDeviceOrSupervisorSubject(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (/\bsupervisor device\b/.test(t)) return true;
  if (/\bdevices?\b/.test(t)) return true;
  if (/\btablets?\b/.test(t)) return true;
  if (/\bsupervisor\b/.test(t)) return true;
  return false;
}

function isSupervisorVisibilityOverlap(text) {
  const t = String(text || "").toLowerCase();
  if (!/\bprojects?\b/.test(t)) return false;
  return /\b(see|sees|seeing|visible|visibility|appear|show|shown)\b/.test(t);
}

function isDevicePairingDiagnosticQuestion(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  if (/\binvoice(s)?\b/.test(text)) return false;
  if (isSupervisorVisibilityOverlap(text)) return false;
  if (!hasPairingAuthTrouble(text)) return false;
  if (!hasDeviceOrSupervisorSubject(text)) return false;
  return true;
}

module.exports = {
  hasPairingAuthTrouble,
  hasDeviceOrSupervisorSubject,
  isDevicePairingDiagnosticQuestion,
};
