/**
 * Cryptographically strong public link tokens (prefix_qt / prefix_inv).
 */
function randomSegment() {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

function makePublicToken(prefix) {
  const p = String(prefix || "tk").replace(/[^a-zA-Z0-9]/g, "") || "tk";
  return `${p}_${randomSegment()}`;
}

module.exports = { makePublicToken };
