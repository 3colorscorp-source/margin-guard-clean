#!/usr/bin/env node
/**
 * MG-SUPPORT-EMAIL-V2 — opaque base64url Zapier bridge (mocked DB/network only).
 * Usage: node scripts/test-mg-support-email-v2.js
 *
 * Does not apply SQL, mutate production, set env, send email, or call Zapier.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { verifySupportEmailBridgeV2 } = require("../docs/MG-SUPPORT-EMAIL-V2-ZAPIER-STEP2");
const {
  ENV,
  SCHEMA_VERSION,
  BRIDGE_SCHEMA_VERSION,
  buildTemplate,
  buildCanonicalPayload,
  encodePayloadB64,
  signSupportPayload,
  canonicalizeJson,
  dispatchPendingEvent,
} = require("../netlify/functions/_lib/mg-support/notification-delivery");

let failed = 0;
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name);
  }
}

const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = "2026-08-31T19:30:00.000Z";
const OWNER_EMAIL = "owner@example.com";
const CASE_REF = "MG-SUP-" + CASE_ID;
const TEST_SECRET = "mg-support-email-v2-test-only-secret";
const SUPPORT_WEBHOOK = "https://hooks.example.test/support-case-email-v2";
const SUPPORT_DISPATCH = "support-dispatch-secret-v2";

function enabledEnv(extra) {
  return Object.assign(
    {
      [ENV.ENABLED]: "true",
      [ENV.WEBHOOK]: SUPPORT_WEBHOOK,
      [ENV.HMAC]: TEST_SECRET,
      [ENV.DISPATCH]: SUPPORT_DISPATCH,
    },
    extra || {}
  );
}

function decodePath(p) {
  try {
    return decodeURIComponent(String(p || ""));
  } catch (_err) {
    return String(p || "");
  }
}

function samplePayload(extra) {
  const tpl = buildTemplate("case_reopened", CASE_REF);
  return Object.assign(
    buildCanonicalPayload({
      eventId: EVENT_ID,
      eventType: "case_reopened",
      caseRef: CASE_REF,
      recipientEmail: OWNER_EMAIL,
      subject: tpl.subject,
      textBody: tpl.text_body,
      timestamp: NOW,
      caseId: CASE_ID,
      caseStatusVersion: 1,
    }),
    extra || {}
  );
}

function signAndInput(payload, secret, timestamp) {
  const sealed = signSupportPayload(payload, secret, timestamp);
  return {
    sealed,
    input: {
      hmac_secret: secret,
      schema_version: BRIDGE_SCHEMA_VERSION,
      timestamp: sealed.timestamp,
      signature: sealed.signature,
      payload_b64: sealed.payload_b64,
    },
  };
}

function outputHasDebug(out) {
  const raw = JSON.stringify(out);
  return (
    /hmac_secret/.test(raw) ||
    /"computed"/.test(raw) ||
    /"expected"/.test(raw) ||
    /payload_b64/.test(raw) ||
    /signed_body/.test(raw) ||
    /schema_version/.test(raw) === true && out.verified === false && Object.keys(out).length > 1
  );
}

function createWorld(opts) {
  const options = opts || {};
  const event = Object.assign(
    {
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      case_id: CASE_ID,
      event_type: "case_reopened",
      from_status: "resolved",
      to_status: "reopened",
      case_status_version: 1,
      payload_version: 1,
      delivery_status: "pending",
      attempt_count: 0,
      result_code: null,
      created_at: NOW,
      claimed_at: null,
      processed_at: null,
    },
    options.event || {}
  );
  const caseRow = Object.assign(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "reopened", status_version: 1 },
    options.caseRow || {}
  );
  const tenant = { id: TENANT_ID, owner_email: options.ownerEmail === undefined ? OWNER_EMAIL : options.ownerEmail };
  const patches = [];
  const posts = [];
  let lock = false;

  async function supabaseRequest(p, init) {
    const decoded = decodePath(p);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method === "GET" && decoded.startsWith("tenant_support_notification_outbox?")) {
      return [{ ...event }];
    }
    if (method === "GET" && decoded.startsWith("tenant_support_cases?")) {
      return [{ ...caseRow }];
    }
    if (method === "GET" && decoded.startsWith("tenants?")) {
      return [{ ...tenant }];
    }
    if (method === "PATCH" && decoded.startsWith("tenant_support_notification_outbox?")) {
      patches.push({ path: decoded, body: Object.assign({}, init.body || {}) });
      if (decoded.includes("delivery_status=eq.pending") && decoded.includes("attempt_count=eq.")) {
        const matched = /attempt_count=eq\.(\d+)/.exec(decoded);
        const expected = matched ? Number(matched[1]) : -1;
        if (lock || event.delivery_status !== "pending" || event.attempt_count !== expected) {
          return [];
        }
        lock = true;
        Object.assign(event, init.body || {});
        lock = false;
        return [{ ...event }];
      }
      if (decoded.includes("delivery_status=eq.pending")) {
        if (event.delivery_status !== "pending") return [];
        Object.assign(event, init.body || {});
        return [{ ...event }];
      }
      if (decoded.includes("delivery_status=eq.claimed")) {
        const matched = /attempt_count=eq\.(\d+)/.exec(decoded);
        const expected = matched ? Number(matched[1]) : -1;
        if (event.delivery_status !== "claimed" || event.attempt_count !== expected) return [];
        Object.assign(event, init.body || {});
        return [{ ...event }];
      }
      return [];
    }
    throw new Error("unexpected path " + decoded);
  }

  async function fetchImpl(url, init) {
    posts.push({ url: String(url || ""), init: init || {} });
    return { status: 202 };
  }

  return {
    posts,
    patches,
    getEvent: () => ({ ...event }),
    deps: {
      env: enabledEnv(options.env),
      supabaseRequest,
      fetchImpl,
      nowIso: () => NOW,
    },
  };
}

async function main() {
  const fixtureSrc = fs.readFileSync(path.join(ROOT, "docs/MG-SUPPORT-EMAIL-V2-ZAPIER-STEP2.js"), "utf8");
  const deliverySrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/_lib/mg-support/notification-delivery.js"),
    "utf8"
  );
  const zapierSrc = fs.readFileSync(
    path.join(ROOT, "netlify/functions/_lib/providers/zapier-provider.js"),
    "utf8"
  );

  const payload = samplePayload();
  const canonicalPayload = canonicalizeJson(payload);
  const { sealed, input } = signAndInput(payload, TEST_SECRET, NOW);
  const ok = verifySupportEmailBridgeV2(input);

  assert("1. valid v2 message -> verified true", ok.verified === true && ok.event_id === EVENT_ID && ok.event_type === "case_reopened");

  const tamperedSig = Object.assign({}, input, {
    signature: input.signature.slice(0, -1) + (input.signature.slice(-1) === "a" ? "b" : "a"),
  });
  const sigFail = verifySupportEmailBridgeV2(tamperedSig);
  assert("2. signature tamper -> false", sigFail.verified === false && Object.keys(sigFail).join(",") === "verified");

  const flip = input.payload_b64.slice(-1) === "A" ? "B" : "A";
  const tamperedB64 = Object.assign({}, input, { payload_b64: input.payload_b64.slice(0, -1) + flip });
  const b64Fail = verifySupportEmailBridgeV2(tamperedB64);
  assert("3. payload_b64 one-character tamper -> false", b64Fail.verified === false && Object.keys(b64Fail).join(",") === "verified");

  const tsFail = verifySupportEmailBridgeV2(Object.assign({}, input, { timestamp: "2026-08-31T19:31:00.000Z" }));
  assert("4. timestamp tamper -> false", tsFail.verified === false && Object.keys(tsFail).join(",") === "verified");

  const schemaFail = verifySupportEmailBridgeV2(
    Object.assign({}, input, { schema_version: "support_case_notification_v1" })
  );
  assert("5. invalid outer schema -> false", schemaFail.verified === false);

  const paddedFail = verifySupportEmailBridgeV2(Object.assign({}, input, { payload_b64: input.payload_b64 + "=" }));
  const slashFail = verifySupportEmailBridgeV2(
    Object.assign({}, input, { payload_b64: input.payload_b64.replace(/[A-Za-z]/, "/") })
  );
  assert("6. invalid base64url characters -> false", paddedFail.verified === false && slashFail.verified === false);

  const badJsonB64 = Buffer.from("not-json", "utf8").toString("base64url");
  const badJsonSig = crypto
    .createHmac("sha256", TEST_SECRET)
    .update(NOW + "." + badJsonB64, "utf8")
    .digest("hex");
  const badJson = verifySupportEmailBridgeV2({
    hmac_secret: TEST_SECRET,
    schema_version: BRIDGE_SCHEMA_VERSION,
    timestamp: NOW,
    signature: badJsonSig,
    payload_b64: badJsonB64,
  });
  assert("7. valid HMAC but invalid JSON after decode -> false", badJson.verified === false);

  const innerTs = samplePayload({ timestamp: "2026-08-31T18:00:00.000Z" });
  const innerCanonical = canonicalizeJson(innerTs);
  const innerB64 = encodePayloadB64(innerCanonical);
  const outerTs = NOW;
  const mismatchSig = crypto
    .createHmac("sha256", TEST_SECRET)
    .update(outerTs + "." + innerB64, "utf8")
    .digest("hex");
  const mismatch = verifySupportEmailBridgeV2({
    hmac_secret: TEST_SECRET,
    schema_version: BRIDGE_SCHEMA_VERSION,
    timestamp: outerTs,
    signature: mismatchSig,
    payload_b64: innerB64,
  });
  assert("8. inner/outer timestamp mismatch -> false", mismatch.verified === false);

  const badEvent = samplePayload({ event_type: "case_closed" });
  const badEventSigned = signAndInput(badEvent, TEST_SECRET, NOW);
  const badEventOut = verifySupportEmailBridgeV2(badEventSigned.input);
  assert("9. unsupported event_type -> false", badEventOut.verified === false);

  const missingField = samplePayload();
  missingField.subject = "";
  const missingSigned = signAndInput(missingField, TEST_SECRET, NOW);
  const missingOut = verifySupportEmailBridgeV2(missingSigned.input);
  assert("10. missing required field -> false", missingOut.verified === false);

  const world = createWorld();
  const dispatched = await dispatchPendingEvent(EVENT_ID, world.deps);
  const httpBody = JSON.parse(world.posts[0].init.body);
  const httpKeys = Object.keys(httpBody).sort();
  assert(
    "11. HTTP body has exactly four top-level fields",
    dispatched.delivery_status === "bridge_accepted" &&
      httpKeys.join(",") === ["payload_b64", "schema_version", "signature", "timestamp"].sort().join(",") &&
      httpKeys.length === 4
  );
  assert("12. HTTP body contains no signed_body", !Object.prototype.hasOwnProperty.call(httpBody, "signed_body"));
  assert(
    "13. HTTP body contains no payload object",
    !Object.prototype.hasOwnProperty.call(httpBody, "payload") && typeof httpBody.payload_b64 === "string"
  );
  assert("14. payload_b64 contains no '=' padding", httpBody.payload_b64.indexOf("=") === -1 && /^[A-Za-z0-9_-]+$/.test(httpBody.payload_b64));

  const dispatchedCanonical = Buffer.from(httpBody.payload_b64, "base64url").toString("utf8");
  const expectedCanonical = canonicalizeJson(
    JSON.parse(dispatchedCanonical)
  );
  assert(
    "15. payload_b64 decodes byte-for-byte to canonicalPayload",
    dispatchedCanonical === expectedCanonical &&
      dispatchedCanonical === canonicalizeJson(JSON.parse(dispatchedCanonical)) &&
      httpBody.schema_version === BRIDGE_SCHEMA_VERSION &&
      JSON.parse(dispatchedCanonical).schema_version === SCHEMA_VERSION &&
      sealed.payload_b64 === encodePayloadB64(canonicalPayload) &&
      Buffer.from(sealed.payload_b64, "base64url").toString("utf8") === canonicalPayload
  );

  const failDump = JSON.stringify(sigFail) + JSON.stringify(b64Fail) + JSON.stringify(ok);
  assert(
    "16. no secret/debug material appears in verifier output",
    !/hmac_secret|mg-support-email-v2-test-only-secret/.test(failDump) &&
      !/"computed"|"expected"/.test(failDump) &&
      !outputHasDebug(sigFail) &&
      Object.keys(ok).sort().join(",") ===
        ["case_ref", "event_id", "event_type", "idempotency_key", "recipient_email", "subject", "text_body", "verified"].sort().join(",") &&
      !("payload" in ok) &&
      !("hmac_secret" in ok)
  );

  const disabled = createWorld({ env: { [ENV.ENABLED]: "false" } });
  const disabledRes = await dispatchPendingEvent(EVENT_ID, disabled.deps);
  assert(
    "17. delivery disabled preserves existing no-send behavior",
    disabledRes.result === "delivery_disabled" &&
      disabled.getEvent().delivery_status === "pending" &&
      disabled.getEvent().attempt_count === 0 &&
      disabled.posts.length === 0 &&
      disabled.patches.length === 0
  );

  assert(
    "wire. production uses Node base64url encoding",
    /toString\("base64url"\)/.test(deliverySrc) && /Buffer\.from\(canonicalPayload, "utf8"\)/.test(deliverySrc)
  );
  assert("wire. HMAC input is timestamp.payload_b64", /\$\{String\(timestamp\)\}\.\$\{String\(payloadB64\)\}/.test(deliverySrc));
  assert("wire. no signed_body in Support delivery POST", !/signed_body/.test(deliverySrc));
  assert(
    "wire. contract zapier envelope untouched",
    /buildSignedWireEnvelope/.test(zapierSrc) && /signed_body/.test(zapierSrc)
  );
  assert(
    "wire. verifier failure is only verified false",
    /return \{ verified: false \}/.test(fixtureSrc) && !/computed signature/.test(fixtureSrc)
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
