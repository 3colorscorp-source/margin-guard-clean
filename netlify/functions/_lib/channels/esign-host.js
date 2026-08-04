/**
 * CH-013A.2.0 — Hosted e-sign channel stub (A.2.6).
 * Fail-closed. Not an active production adapter. No network. No credentials.
 * Cannot generate signing URLs.
 */

"use strict";

const CHANNEL = "esign_host";
const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";
const AVAILABLE = false;

function channel() {
  return CHANNEL;
}

function provider() {
  return null;
}

function isAvailable() {
  return AVAILABLE;
}

async function prepare() {
  return { ok: false, error: NOT_IMPLEMENTED, code: "not_implemented" };
}

async function deliver() {
  return { ok: false, error: NOT_IMPLEMENTED, code: "not_implemented" };
}

function health() {
  return { ok: false, channel: CHANNEL, available: false, error: NOT_IMPLEMENTED };
}

function supportsTracking() {
  return { delivered: true, opened: true, bounced: false, complained: false };
}

function verifyWebhook() {
  return { ok: false, error: NOT_IMPLEMENTED, code: "not_implemented" };
}

function parseWebhook() {
  return { ok: false, error: NOT_IMPLEMENTED, code: "not_implemented", events: [] };
}

module.exports = {
  CHANNEL,
  available: AVAILABLE,
  channel,
  provider,
  isAvailable,
  prepare,
  deliver,
  health,
  supportsTracking,
  verifyWebhook,
  parseWebhook,
};
