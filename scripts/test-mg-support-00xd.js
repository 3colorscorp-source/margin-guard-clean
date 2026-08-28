#!/usr/bin/env node
/**
 * MG-SUPPORT-003D.D1 — read-only device pairing + deposit CTA diagnostics
 * (mocked OpenAI and Supabase). Usage: node scripts/test-mg-support-00xd.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { classifySupportIntent } = require("../netlify/functions/_lib/mg-support/router");
const { createHandler } = require("../netlify/functions/mg-support-chat");
const { determineEscalationEligibility, bindRelatedEntity } = require("../netlify/functions/_lib/mg-support/case-intake");
const { isDevicePairingDiagnosticQuestion } = require("../netlify/functions/_lib/mg-support/device-pairing-intent");
const {
  DEVICE_SELECT,
  readDevicePairingDiagnostic,
} = require("../netlify/functions/_lib/mg-support/device-pairing-diagnostic");
const {
  NO_SUPERVISOR,
  NO_DEVICE,
  PENDING_VALID,
  PENDING_EXPIRED,
  ALREADY_PAIRED,
  REVOKED,
  MULTIPLE,
  UNVERIFIED,
  devicePairingAnswer,
} = require("../netlify/functions/_lib/mg-support/device-pairing-conclusion");
const { isDepositCtaDiagnosticQuestion } = require("../netlify/functions/_lib/mg-support/deposit-cta-intent");
const {
  QUOTE_SELECT,
  toModelFacts: toDepositFacts,
  readDepositCtaDiagnostic,
} = require("../netlify/functions/_lib/mg-support/deposit-cta-diagnostic");
const {
  NOT_PUBLISHED,
  NOT_ACCEPTED,
  WORKFLOW_INCOMPLETE,
  DEPOSIT_NOT_REQUIRED,
  ALREADY_RECORDED,
  PAYMENT_UNAVAILABLE,
  CTA_EXPECTED,
  UNVERIFIED: DEPOSIT_UNVERIFIED,
  depositCtaAnswer,
} = require("../netlify/functions/_lib/mg-support/deposit-cta-conclusion");

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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function fakeEvent(method, bodyObj) {
  return {
    httpMethod: method,
    headers: {},
    body: bodyObj == null ? "" : JSON.stringify(bodyObj),
  };
}

function openaiOkFetch(capture) {
  return async (url, opts) => {
    if (capture) {
      capture.url = url;
      capture.payload = JSON.parse(opts.body || "{}");
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          output_text: "Docs answer.",
          usage: { input_tokens: 5, output_tokens: 4 },
        }),
    };
  };
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

const OWN_TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const SUPERVISOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTH_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const QUOTE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROJECT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW_MS = Date.parse("2026-08-25T18:00:00.000Z");

const PAIR_Q = "The supervisor tablet will not pair.";
const DEPOSIT_Q = "The deposit button is missing on public estimate 2026-0141.";

const sessionOk = () => ({ e: "owner@example.com", c: "cus_test" });

function supervisorProfile(overrides) {
  return {
    id: SUPERVISOR_ID,
    tenant_id: OWN_TENANT,
    role: "supervisor",
    status: "active",
    display_name: "Site Supervisor",
    auth_user_id: AUTH_USER,
    ...overrides,
  };
}

function deviceRow(overrides) {
  return {
    id: DEVICE_A,
    tenant_id: OWN_TENANT,
    portal_type: "supervisor",
    assigned_membership_id: SUPERVISOR_ID,
    display_name: "Kitchen iPad",
    status: "active",
    last_seen_at: "2026-08-24T12:00:00.000Z",
    revoked_at: null,
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-24T12:00:00.000Z",
    pairing_expires_at: null,
    pairing_code_hash: "SHOULD_NEVER_BE_SELECTED",
    device_fingerprint: "SHOULD_NEVER_BE_SELECTED",
    session_token_hash: "SHOULD_NEVER_BE_SELECTED",
    ...overrides,
  };
}

function eligibleQuote(overrides) {
  return {
    id: QUOTE_ID,
    tenant_id: OWN_TENANT,
    quote_number_display: "2026-0141",
    status: "accepted",
    accepted_at: "2026-08-01T00:00:00.000Z",
    public_token: "pubtok_abcdefghij",
    exclusions_initials: "AB",
    exclusions_acknowledged_at: "2026-08-01T00:01:00.000Z",
    change_order_acknowledged_at: "2026-08-01T00:02:00.000Z",
    deposit_paid_at: null,
    deposit_required: 1500,
    ...overrides,
  };
}

function jsonHasForbidden(obj, needles) {
  const blob = JSON.stringify(obj || {});
  return needles.some((n) => blob.includes(String(n)));
}

function deviceDb(cfg = {}) {
  const gets = [];
  return {
    gets,
    supabaseGet: async (rawPath) => {
      const p = String(rawPath || "");
      gets.push(p);
      if (typeof cfg.onGet === "function") return cfg.onGet(p);
      if (p.startsWith("profiles?")) return cfg.profiles === undefined ? [supervisorProfile()] : cfg.profiles;
      if (p.startsWith("tenant_devices?")) return cfg.devices === undefined ? [deviceRow()] : cfg.devices;
      if (p.startsWith("tenant_projects?")) return cfg.projects === undefined ? [{ id: PROJECT_ID }] : cfg.projects;
      if (p.startsWith("quotes?")) return cfg.quotes === undefined ? [] : cfg.quotes;
      if (p.startsWith("owner_settings?")) return cfg.settings === undefined ? [] : cfg.settings;
      if (p.startsWith("tenants?")) return cfg.tenants === undefined ? [] : cfg.tenants;
      return [];
    },
  };
}

function depositDb(cfg = {}) {
  const gets = [];
  return {
    gets,
    supabaseGet: async (rawPath) => {
      const p = String(rawPath || "");
      gets.push(p);
      if (typeof cfg.onGet === "function") return cfg.onGet(p);
      if (p.startsWith("quotes?")) return cfg.quotes === undefined ? [eligibleQuote()] : cfg.quotes;
      if (p.startsWith("owner_settings?")) {
        return cfg.settings === undefined ? [{ deposit_payment_link: "https://buy.stripe.com/secret_link" }] : cfg.settings;
      }
      if (p.startsWith("tenants?")) {
        return cfg.tenants === undefined
          ? [{ id: OWN_TENANT, stripe_account_id: "acct_secret", stripe_charges_enabled: true }]
          : cfg.tenants;
      }
      if (p.startsWith("profiles?")) return cfg.profiles || [];
      if (p.startsWith("tenant_devices?")) return cfg.devices || [];
      if (p.startsWith("tenant_projects?")) return cfg.projects || [];
      return [];
    },
  };
}

async function runChat(message, db, extra = {}) {
  const capture = extra.capture || {};
  const writes = { patch: 0, post: 0, insert: 0 };
  const res = await createHandler({
    readSessionFromEvent: extra.session || sessionOk,
    resolveTenantFromSession: extra.resolveTenant || (async () => ({ id: OWN_TENANT })),
    getOpenAiKey: extra.getOpenAiKey || (() => "test-key"),
    getSessionSecret: extra.getSessionSecret || (() => "test-secret-value-32chars-minimum!!"),
    nowMs: extra.nowMs || (() => NOW_MS),
    supabaseGet: async (p) => db.supabaseGet(p),
    supabaseRequest: async (p, opts) => {
      const method = String(opts?.method || "GET").toUpperCase();
      if (method === "PATCH") writes.patch += 1;
      if (method === "POST") writes.post += 1;
      if (method === "INSERT" || method === "PUT") writes.insert += 1;
      if (method !== "GET") throw new Error("unexpected write " + method);
      return db.supabaseGet(p);
    },
    fetch: openaiOkFetch(capture),
    ...extra.deps,
  })(
    fakeEvent("POST", {
      message,
      page: extra.page || "/team-devices",
      tenant_id: extra.bodyTenant,
      business_id: extra.businessId,
      localStorage: extra.localStorage,
      ...extra.body,
    })
  );
  return { res, body: parse(res), capture, writes, gets: db.gets };
}

async function main() {
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const deviceDiagSrc = read("netlify/functions/_lib/mg-support/device-pairing-diagnostic.js");
  const depositDiagSrc = read("netlify/functions/_lib/mg-support/deposit-cta-diagnostic.js");
  const deviceIntentSrc = read("netlify/functions/_lib/mg-support/device-pairing-intent.js");
  const depositIntentSrc = read("netlify/functions/_lib/mg-support/deposit-cta-intent.js");
  const routerSrc = read("netlify/functions/_lib/mg-support/router.js");

  assert(
    "15. bare device does not misroute",
    classifySupportIntent("device") === "docs_only" &&
      classifySupportIntent("tablet") === "docs_only" &&
      classifySupportIntent("supervisor") === "docs_only" &&
      isDevicePairingDiagnosticQuestion("device") === false
  );
  assert(
    "30. bare deposit does not misroute",
    classifySupportIntent("deposit") === "docs_only" &&
      isDepositCtaDiagnosticQuestion("deposit") === false &&
      classifySupportIntent("How much deposit is required on the contract?") === "docs_only"
  );
  assert(
    "device pairing intent requires pairing + device context",
    classifySupportIntent(PAIR_Q) === "device_pairing_diagnostic" &&
      classifySupportIntent("Need to pair the supervisor device") === "device_pairing_diagnostic" &&
      classifySupportIntent("This device is already paired") === "device_pairing_diagnostic" &&
      classifySupportIntent("The pairing code expired on the supervisor tablet") ===
        "device_pairing_diagnostic" &&
      classifySupportIntent("The supervisor device stopped working") === "device_pairing_diagnostic"
  );
  assert(
    "deposit CTA intent requires CTA wording + quote or public estimate",
    classifySupportIntent(DEPOSIT_Q) === "deposit_cta_diagnostic" &&
      classifySupportIntent("Why cannot the customer pay the deposit on estimate 2026-0141?") ===
        "deposit_cta_diagnostic" &&
      classifySupportIntent("The public estimate has no deposit button") === "deposit_cta_diagnostic" &&
      classifySupportIntent("Initial scheduling payment is not showing on estimate 2026-0141") ===
        "deposit_cta_diagnostic"
  );
  assert(
    "Q. existing intents are not broadened",
    classifySupportIntent("What status is invoice INV-TEST-100?") === "invoice_diagnostic" &&
      classifySupportIntent("Resend invoice INV-TEST-100") === "invoice_diagnostic" &&
      classifySupportIntent("What status is estimate 2026-0001?") === "quote_diagnostic" &&
      classifySupportIntent("What status is project " + PROJECT_ID + "?") === "project_diagnostic" &&
      classifySupportIntent("Why can't my supervisor see project " + PROJECT_ID + "?") ===
        "project_diagnostic" &&
      classifySupportIntent("Does the public estimate link work for quote 2026-0141?") ===
        "quote_diagnostic" &&
      classifySupportIntent("What status is contract " + PROJECT_ID + "?") === "contract_diagnostic" &&
      classifySupportIntent("Is invoice INV-TEST-100 overdue?") === "invoice_diagnostic"
  );

  const activeDb = deviceDb({
    devices: [deviceRow({ status: "active" })],
  });
  const active = await runChat(PAIR_Q, activeDb);
  assert(
    "1. supervisor active + device active",
    active.res.statusCode === 200 &&
      active.body.answer === ALREADY_PAIRED &&
      active.body.sources[0] === "Team & Devices" &&
      !active.capture.url &&
      active.body.action == null
  );

  const noDeviceDb = deviceDb({ devices: [] });
  const noDevice = await runChat(PAIR_Q, noDeviceDb);
  assert("2. supervisor active + no device", noDevice.body.answer === NO_DEVICE && !noDevice.capture.url);

  const pendingValidDb = deviceDb({
    devices: [
      deviceRow({
        status: "pending_pair",
        pairing_expires_at: new Date(NOW_MS + 120000).toISOString(),
      }),
    ],
  });
  const pendingValid = await runChat(PAIR_Q, pendingValidDb);
  assert(
    "3. pending_pair + valid pairing window",
    pendingValid.body.answer === PENDING_VALID && !pendingValid.capture.url
  );

  const pendingExpiredDb = deviceDb({
    devices: [
      deviceRow({
        status: "pending_pair",
        pairing_expires_at: new Date(NOW_MS - 120000).toISOString(),
      }),
    ],
  });
  const pendingExpired = await runChat(PAIR_Q, pendingExpiredDb);
  assert(
    "4. pending_pair + expired window",
    pendingExpired.body.answer === PENDING_EXPIRED &&
      /Team & Devices/.test(pendingExpired.body.answer) &&
      /Reset pairing/.test(pendingExpired.body.answer) &&
      pendingExpired.body.action == null
  );

  const revokedDb = deviceDb({
    devices: [deviceRow({ status: "revoked", revoked_at: "2026-08-20T00:00:00.000Z" })],
  });
  const revoked = await runChat(PAIR_Q, revokedDb);
  assert("5. revoked device", revoked.body.answer === REVOKED && !revoked.capture.url);

  const noSupDb = deviceDb({ profiles: [] });
  const noSup = await runChat(PAIR_Q, noSupDb);
  assert("6. no supervisor", noSup.body.answer === NO_SUPERVISOR && !noSup.capture.url);

  const multiDb = deviceDb({
    devices: [
      deviceRow({ id: DEVICE_A, display_name: "Kitchen iPad" }),
      deviceRow({ id: DEVICE_B, display_name: "Yard tablet" }),
    ],
  });
  const multi = await runChat(PAIR_Q, multiDb);
  assert(
    "7. multiple devices",
    multi.body.answer === MULTIPLE && /display name/.test(multi.body.answer) && !multi.capture.url
  );

  const otherDeviceDb = deviceDb({
    devices: [deviceRow({ tenant_id: OTHER_TENANT })],
  });
  const otherDevice = await runChat(PAIR_Q, otherDeviceDb);
  assert(
    "8/36. other-tenant device ignored",
    otherDevice.body.answer === NO_DEVICE &&
      otherDeviceDb.gets.some((p) => p.includes("tenant_id=eq." + OWN_TENANT)) &&
      !otherDeviceDb.gets.some((p) => p.includes(OTHER_TENANT))
  );

  const failDeviceDb = deviceDb({
    onGet: async (p) => {
      if (String(p).startsWith("tenant_devices?")) throw new Error("boom");
      if (String(p).startsWith("profiles?")) return [supervisorProfile()];
      return [];
    },
  });
  const failDevice = await runChat(PAIR_Q, failDeviceDb);
  assert(
    "9. device read failure",
    failDevice.body.answer === UNVERIFIED &&
      !failDevice.capture.url &&
      failDevice.body.escalation &&
      failDevice.body.escalation.eligible === true
  );

  const secretLook = await readDevicePairingDiagnostic(OWN_TENANT, PAIR_Q, {
    nowMs: () => NOW_MS,
    supabaseGet: deviceDb({
      devices: [
        deviceRow({
          pairing_code_hash: "hash_secret_value",
          device_fingerprint: "fp_secret_value",
          session_token_hash: "session_secret_value",
        }),
      ],
    }).supabaseGet,
  });
  assert(
    "10. pairing code/hash never exposed",
    secretLook.outcome === "ok" &&
      !jsonHasForbidden(secretLook.facts, [
        "pairing_code_hash",
        "hash_secret_value",
      ]) &&
      secretLook.facts.has_pairing_code === false &&
      !DEVICE_SELECT.includes("pairing_code_hash")
  );
  assert(
    "11. device fingerprint never exposed",
    !jsonHasForbidden(secretLook.facts, ["device_fingerprint", "fp_secret_value", "session_token_hash"]) &&
      !DEVICE_SELECT.includes("device_fingerprint") &&
      !DEVICE_SELECT.includes("session_token_hash")
  );
  assert(
    "E. no raw UUID in device facts",
    !jsonHasForbidden(secretLook.facts, [DEVICE_A, SUPERVISOR_ID, AUTH_USER, OWN_TENANT])
  );

  assert("12. no reset action object", active.body.action == null && pendingExpired.body.action == null);
  assert(
    "13/20. no device writes",
    active.writes.patch === 0 &&
      active.writes.post === 0 &&
      !/reset-tenant-device-pairing/.test(chatSrc) &&
      !/reset-tenant-device-pairing/.test(deviceDiagSrc) &&
      !/\bPOST\b/.test(deviceDiagSrc) &&
      !/\bPATCH\b/.test(deviceDiagSrc)
  );
  assert(
    "14. deterministic known device reasons",
    devicePairingAnswer("device_pairing_diagnostic", {
      outcome: "ok",
      facts: { reason: "already_paired" },
    }) === ALREADY_PAIRED &&
      devicePairingAnswer("device_pairing_diagnostic", {
        outcome: "ok",
        facts: { reason: "pending_pair" },
      }) === PENDING_VALID &&
      devicePairingAnswer("device_pairing_diagnostic", {
        outcome: "ok",
        facts: { reason: "pairing_code_expired" },
      }) === PENDING_EXPIRED &&
      devicePairingAnswer("device_pairing_diagnostic", {
        outcome: "ok",
        facts: { reason: "revoked" },
      }) === REVOKED &&
      devicePairingAnswer("device_pairing_diagnostic", {
        outcome: "ok",
        facts: { reason: "no_device" },
      }) === NO_DEVICE &&
      devicePairingAnswer("device_pairing_diagnostic", {
        outcome: "ok",
        facts: { reason: "no_supervisor" },
      }) === NO_SUPERVISOR &&
      devicePairingAnswer("device_pairing_diagnostic", {
        outcome: "ok",
        facts: { reason: "multiple_devices" },
      }) === MULTIPLE &&
      devicePairingAnswer("device_pairing_diagnostic", { outcome: "status_unverified" }) === UNVERIFIED
  );
  assert("19. device OpenAI calls for known reason", !active.capture.url && !pendingValid.capture.url);

  const eligibleDepositDb = depositDb();
  const eligibleDeposit = await runChat(DEPOSIT_Q, eligibleDepositDb, { page: "/owner" });
  assert(
    "16. configured + eligible → cta_expected_visible",
    eligibleDeposit.body.answer === CTA_EXPECTED &&
      eligibleDeposit.body.sources[0] === "Public Estimate" &&
      !eligibleDeposit.capture.url &&
      eligibleDeposit.body.action == null
  );

  const unpublished = await runChat(
    DEPOSIT_Q,
    depositDb({ quotes: [eligibleQuote({ public_token: null })] })
  );
  assert("17. not published", unpublished.body.answer === NOT_PUBLISHED && !unpublished.capture.url);

  const notAccepted = await runChat(
    DEPOSIT_Q,
    depositDb({
      quotes: [
        eligibleQuote({
          status: "sent",
          accepted_at: null,
          exclusions_initials: null,
          exclusions_acknowledged_at: null,
          change_order_acknowledged_at: null,
        }),
      ],
    })
  );
  assert("18. not accepted", notAccepted.body.answer === NOT_ACCEPTED && !notAccepted.capture.url);

  const incomplete = await runChat(
    DEPOSIT_Q,
    depositDb({
      quotes: [
        eligibleQuote({
          exclusions_initials: null,
          exclusions_acknowledged_at: null,
          change_order_acknowledged_at: null,
        }),
      ],
    })
  );
  assert(
    "19. workflow incomplete",
    incomplete.body.answer === WORKFLOW_INCOMPLETE && !incomplete.capture.url
  );

  const noDeposit = await runChat(
    DEPOSIT_Q,
    depositDb({ quotes: [eligibleQuote({ deposit_required: 0 })] })
  );
  assert("20. deposit not required", noDeposit.body.answer === DEPOSIT_NOT_REQUIRED && !noDeposit.capture.url);

  const recorded = await runChat(
    DEPOSIT_Q,
    depositDb({ quotes: [eligibleQuote({ deposit_paid_at: "2026-08-10T00:00:00.000Z" })] })
  );
  assert("21. deposit already recorded", recorded.body.answer === ALREADY_RECORDED && !recorded.capture.url);

  const noPay = await runChat(
    DEPOSIT_Q,
    depositDb({
      settings: [{ deposit_payment_link: null }],
      tenants: [{ id: OWN_TENANT, stripe_account_id: null, stripe_charges_enabled: false }],
    })
  );
  assert(
    "22. payment path unavailable",
    noPay.body.answer === PAYMENT_UNAVAILABLE && !noPay.capture.url
  );

  const otherQuoteDb = depositDb({
    quotes: [eligibleQuote({ tenant_id: OTHER_TENANT })],
  });
  const otherQuote = await runChat(DEPOSIT_Q, otherQuoteDb);
  assert(
    "23/37. other-tenant quote ignored",
    otherQuote.body.answer.indexOf("No matching estimate") === 0 &&
      otherQuoteDb.gets.some((p) => p.includes("tenant_id=eq." + OWN_TENANT)) &&
      !otherQuoteDb.gets.some((p) => /public_token=eq\./.test(p))
  );

  const failQuote = await runChat(
    DEPOSIT_Q,
    depositDb({
      onGet: async (p) => {
        if (String(p).startsWith("quotes?")) throw new Error("boom");
        return [];
      },
    })
  );
  assert(
    "24. deposit read failure",
    failQuote.body.answer === DEPOSIT_UNVERIFIED && !failQuote.capture.url
  );

  const depositFacts = toDepositFacts(eligibleQuote(), {
    payment_link_configured: true,
    stripe_connect_configured: true,
    stripe_connect_charges_enabled: true,
  });
  const factBlob = JSON.stringify(depositFacts);
  assert("25. amount never model-visible", !factBlob.includes("1500") && !("deposit_required" in depositFacts));
  assert(
    "26. payment URL never model-visible",
    !factBlob.includes("https://") && !factBlob.includes("buy.stripe.com")
  );
  assert(
    "27. Stripe account id never model-visible",
    !factBlob.includes("acct_") && !("stripe_account_id" in depositFacts)
  );
  assert(
    "28. public token never model-visible",
    !factBlob.includes("pubtok_") && !("public_token" in depositFacts)
  );
  assert(
    "live deposit payload never leaks secrets",
    !jsonHasForbidden(eligibleDeposit.body, [
      "1500",
      "https://buy.stripe.com/secret_link",
      "acct_secret",
      "pubtok_abcdefghij",
    ])
  );

  const browserPaid = await runChat(DEPOSIT_Q, depositDb(), {
    localStorage: { depositPaid: "true", "mg.deposit.paid": true },
    body: { deposit: "paid", query: { deposit: "paid" } },
  });
  assert(
    "29. localStorage/browser paid flag ignored",
    browserPaid.body.answer === CTA_EXPECTED && !browserPaid.capture.url
  );

  assert(
    "31/32. no deposit writes or checkout",
    eligibleDeposit.writes.patch === 0 &&
      eligibleDeposit.writes.post === 0 &&
      !/create-project-deposit-session/.test(depositDiagSrc) &&
      !/project-payment-intent/.test(depositDiagSrc) &&
      !/create-project-deposit-session/.test(chatSrc) &&
      !/\bPATCH\b/.test(depositDiagSrc) &&
      !/localStorage\.|sessionStorage/.test(depositDiagSrc)
  );

  const bodyTenantDb = deviceDb();
  const bodyTenant = await runChat(PAIR_Q, bodyTenantDb, { bodyTenant: OTHER_TENANT });
  assert(
    "33. body tenant ignored",
    bodyTenant.body.answer === ALREADY_PAIRED &&
      bodyTenantDb.gets.every((p) => !p.includes(OTHER_TENANT)) &&
      bodyTenantDb.gets.some((p) => p.includes("tenant_id=eq." + OWN_TENANT))
  );

  assert(
    "34. model cannot choose tenant",
    !/"tools"\s*:/.test(chatSrc) &&
      !/tool_choice/.test(chatSrc) &&
      /Does not trust browser tenant_id/.test(chatSrc) &&
      !active.capture.url
  );
  assert(
    "35. business_id not used",
    !/business_id/.test(deviceDiagSrc) &&
      !/business_id/.test(depositDiagSrc) &&
      !/business_id/.test(deviceIntentSrc) &&
      !/business_id/.test(depositIntentSrc)
  );

  const namedMultiDb = deviceDb({
    devices: [
      deviceRow({ id: DEVICE_A, display_name: "Kitchen iPad", status: "pending_pair", pairing_expires_at: null }),
      deviceRow({ id: DEVICE_B, display_name: "Yard tablet", status: "active" }),
    ],
  });
  const named = await runChat('The supervisor device named "Kitchen iPad" will not pair.', namedMultiDb);
  assert(
    "E. exact display name uniquely resolves one of multiple devices",
    named.body.answer === PENDING_EXPIRED && !named.capture.url
  );

  const noIdDeposit = await runChat("The public estimate has no deposit button", depositDb());
  assert(
    "deposit without quote identifier stays diagnostic and does not inspect a token globally",
    noIdDeposit.body.answer.indexOf("Share the estimate number") === 0 &&
      noIdDeposit.gets.length === 0 &&
      !noIdDeposit.capture.url
  );

  const knownDeviceOk = determineEscalationEligibility({
    intent: "device_pairing_diagnostic",
    diagnostic: { outcome: "ok", facts: { reason: "already_paired" } },
    message: PAIR_Q,
    hasOwnerTenant: true,
  });
  const knownDepositOk = determineEscalationEligibility({
    intent: "deposit_cta_diagnostic",
    diagnostic: { outcome: "ok", facts: { reason: "cta_expected_visible" } },
    message: DEPOSIT_Q,
    hasOwnerTenant: true,
  });
  assert(
    "P. existing case flow unchanged for known reasons",
    knownDeviceOk === null && knownDepositOk === null && active.body.escalation == null
  );

  assert(
    "G. D1 does not wrap device reset",
    !/Reset device pairing/.test(String(pendingExpired.body.answer)) &&
      pendingExpired.body.action == null &&
      !/confirmation_token/.test(JSON.stringify(pendingExpired.body))
  );
  assert(
    "select lists stay closed",
    DEVICE_SELECT ===
      "id,tenant_id,portal_type,assigned_membership_id,display_name,status,last_seen_at,revoked_at,created_at,updated_at,pairing_expires_at" &&
      QUOTE_SELECT.includes("deposit_required") &&
      QUOTE_SELECT.includes("public_token")
  );
  assert(
    "router still does not invent B4 intent families",
    !/supervisor_visibility|public_estimate/.test(routerSrc)
  );

  const pendingNullLook = await readDevicePairingDiagnostic(OWN_TENANT, PAIR_Q, {
    nowMs: () => NOW_MS,
    supabaseGet: deviceDb({
      devices: [deviceRow({ status: "pending_pair", pairing_expires_at: null })],
    }).supabaseGet,
  });
  const pendingNullChat = await runChat(
    PAIR_Q,
    deviceDb({ devices: [deviceRow({ status: "pending_pair", pairing_expires_at: null })] })
  );
  assert(
    "B. pending_pair + pairing_expires_at null → needs reset/new code",
    pendingNullLook.facts.reason === "pairing_code_expired" &&
      pendingNullLook.facts.has_pairing_code === false &&
      pendingNullLook.facts.pairing_code_unexpired === false &&
      pendingNullChat.body.answer === PENDING_EXPIRED &&
      !pendingNullChat.capture.url
  );
  assert(
    "B. pending_pair + future pairing_expires_at → pairing window active",
    pendingValid.body.answer === PENDING_VALID &&
      !DEVICE_SELECT.includes("pairing_code_hash")
  );

  const chargesWithoutAccount = await runChat(
    DEPOSIT_Q,
    depositDb({
      settings: [{ deposit_payment_link: null }],
      tenants: [{ id: OWN_TENANT, stripe_account_id: null, stripe_charges_enabled: true }],
    })
  );
  assert(
    "C. Stripe account missing + charges true + no link → payment path unavailable",
    chargesWithoutAccount.body.answer === PAYMENT_UNAVAILABLE && !chargesWithoutAccount.capture.url
  );
  const accountChargesOff = await runChat(
    DEPOSIT_Q,
    depositDb({
      settings: [{ deposit_payment_link: null }],
      tenants: [{ id: OWN_TENANT, stripe_account_id: "acct_secret", stripe_charges_enabled: false }],
    })
  );
  assert(
    "C. Stripe account present + charges false + no link → payment path unavailable",
    accountChargesOff.body.answer === PAYMENT_UNAVAILABLE &&
      !jsonHasForbidden(accountChargesOff.body, ["acct_secret"]) &&
      !accountChargesOff.capture.url
  );
  const connectReady = await runChat(
    DEPOSIT_Q,
    depositDb({
      settings: [{ deposit_payment_link: null }],
      tenants: [{ id: OWN_TENANT, stripe_account_id: "acct_secret", stripe_charges_enabled: true }],
    })
  );
  assert(
    "C. Stripe account present + charges true → payment path ready",
    connectReady.body.answer === CTA_EXPECTED &&
      !jsonHasForbidden(connectReady.body, ["acct_secret"]) &&
      !connectReady.capture.url
  );
  const linkOnly = await runChat(
    DEPOSIT_Q,
    depositDb({
      settings: [{ deposit_payment_link: "https://buy.stripe.com/secret_link" }],
      tenants: [{ id: OWN_TENANT, stripe_account_id: null, stripe_charges_enabled: false }],
    })
  );
  assert(
    "C. valid payment link configured → payment path ready regardless of Connect",
    linkOnly.body.answer === CTA_EXPECTED &&
      !jsonHasForbidden(linkOnly.body, ["https://buy.stripe.com/secret_link"]) &&
      !linkOnly.capture.url
  );

  const browserFlags = await runChat(DEPOSIT_Q, depositDb(), {
    localStorage: { depositPaid: "true" },
    body: {
      sessionStorage: { "mg.deposit.paid": true },
      query: { deposit: "paid" },
      deposit: "paid",
    },
  });
  assert(
    "D. sessionStorage and ?deposit=paid are not paid truth",
    browserFlags.body.answer === CTA_EXPECTED && !browserFlags.capture.url
  );

  function envelopeHasInternalIds(body) {
    const blob = JSON.stringify(body || {});
    return (
      blob.includes("auth_user_id") ||
      blob.includes("assigned_membership_id") ||
      blob.includes(AUTH_USER) ||
      blob.includes(DEVICE_A) ||
      blob.includes(DEVICE_B) ||
      blob.includes(SUPERVISOR_ID) ||
      blob.includes(OWN_TENANT)
    );
  }
  assert(
    "A. known-reason chat envelope does not leak auth/device/tenant/membership ids",
    !envelopeHasInternalIds(active.body) &&
      !envelopeHasInternalIds(pendingValid.body) &&
      !envelopeHasInternalIds(eligibleDeposit.body) &&
      !envelopeHasInternalIds(connectReady.body)
  );
  assert(
    "A. auth_user_id is selected only to derive booleans and is not in facts",
    /auth_user_id/.test(deviceDiagSrc) &&
      !("auth_user_id" in (secretLook.facts || {})) &&
      !jsonHasForbidden(secretLook.facts, [AUTH_USER])
  );

  const caseIntakeSrc = read("netlify/functions/_lib/mg-support/case-intake.js");
  const unverifiedBind = bindRelatedEntity(
    "deposit_cta_diagnostic",
    { outcome: "status_unverified" },
    { type: "quote_number_display", value: "2026-0141" }
  );
  const knownBind = bindRelatedEntity(
    "deposit_cta_diagnostic",
    { outcome: "ok", facts: { reason: "cta_expected_visible" } },
    { type: "quote_number_display", value: "2026-0141" }
  );
  const deviceBind = bindRelatedEntity(
    "device_pairing_diagnostic",
    { outcome: "status_unverified" },
    null
  );
  const unverifiedElig = determineEscalationEligibility({
    intent: "deposit_cta_diagnostic",
    diagnostic: { outcome: "status_unverified" },
    message: DEPOSIT_Q,
    hasOwnerTenant: true,
  });
  assert(
    "E. case-intake only binds deposit quote ref on status_unverified; known reasons do not auto-case",
    unverifiedBind.type === "quote" &&
      unverifiedBind.ref === "2026-0141" &&
      knownBind.type === "none" &&
      deviceBind.type === "none" &&
      unverifiedElig &&
      unverifiedElig.category === "diagnostic_unavailable" &&
      eligibleDeposit.body.escalation == null &&
      /deposit_cta_diagnostic/.test(caseIntakeSrc)
  );

  assert(
    "F. freeze routing collisions stay distinct",
    classifySupportIntent("device") === "docs_only" &&
      classifySupportIntent("supervisor cannot see project") === "project_diagnostic" &&
      classifySupportIntent("supervisor tablet cannot pair") === "device_pairing_diagnostic" &&
      classifySupportIntent("deposit") === "docs_only" &&
      classifySupportIntent("deposit button missing on public estimate") === "deposit_cta_diagnostic" &&
      classifySupportIntent("does public estimate link work for quote 2026-0141") ===
        "quote_diagnostic" &&
      classifySupportIntent("resend invoice INV-X") === "invoice_diagnostic"
  );

  const d1ProdSrc = [
    chatSrc,
    routerSrc,
    deviceDiagSrc,
    depositDiagSrc,
    deviceIntentSrc,
    depositIntentSrc,
    read("netlify/functions/_lib/mg-support/device-pairing-conclusion.js"),
    read("netlify/functions/_lib/mg-support/deposit-cta-conclusion.js"),
  ].join("\n");
  assert(
    "G. D1 production files do not invoke mutation endpoints",
    !/reset-tenant-device-pairing/.test(d1ProdSrc) &&
      !/pair-device/.test(d1ProdSrc) &&
      !/revoke-tenant-device/.test(d1ProdSrc) &&
      !/create-tenant-device/.test(d1ProdSrc) &&
      !/create-project-deposit-session/.test(d1ProdSrc) &&
      !/project-payment-intent/.test(d1ProdSrc) &&
      !/owner-settings-deposit-link/.test(d1ProdSrc) &&
      !/tenant_support_actions/.test(d1ProdSrc) &&
      /method: "GET"/.test(deviceDiagSrc) &&
      /method: "GET"/.test(depositDiagSrc)
  );
  assert(
    "H. known device and deposit reasons stay 0 OpenAI",
    !active.capture.url &&
      !noDevice.capture.url &&
      !pendingValid.capture.url &&
      !pendingExpired.capture.url &&
      !revoked.capture.url &&
      !noSup.capture.url &&
      !multi.capture.url &&
      !failDevice.capture.url &&
      !unpublished.capture.url &&
      !notAccepted.capture.url &&
      !incomplete.capture.url &&
      !noDeposit.capture.url &&
      !recorded.capture.url &&
      !noPay.capture.url &&
      !eligibleDeposit.capture.url
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
