#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2D — integrated release freeze
 * (mocked DB/network only). Usage: node scripts/test-mg-support-003e-2d-freeze.js
 *
 * Does not apply SQL, mutate production, set env, send email, or call Zapier.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const { parseUpdateBody, updateAdminCase, ACTION_PLAN, EVENT_TYPE_BY_ACTION } = require("../netlify/functions/_lib/mg-support/admin-cases");
const { createHandler: createDispatchHandler } = require("../netlify/functions/mg-support-case-notification-dispatch-background");
const { createHandler: createSweepHandler } = require("../netlify/functions/_lib/mg-support/notification-sweep");
const {
  ENV,
  CTA_URL,
  SCHEMA_VERSION,
  POST_TIMEOUT_MS,
  DISPATCH_FUNCTION,
  CLAIM_PROCESS_DEATH_NOTE,
  TEMPLATES,
  buildTemplate,
  buildCanonicalPayload,
  signSupportPayload,
  signCanonicalBody,
  canonicalizeJson,
  dispatchPendingEvent,
  kickSupportCaseNotificationDispatch,
  assertDispatchAuth,
  parseDispatchBody,
  isDeliveryEnabled,
  buildClaimPath,
  buildFinalizePath,
} = require("../netlify/functions/_lib/mg-support/notification-delivery");
const {
  SWEEP_FUNCTION,
  SWEEP_SCHEDULE,
  SWEEP_BATCH_SIZE,
  PENDING_MIN_AGE_MS,
  buildPendingSweepPath,
  pendingAgeCutoffIso,
  sweepPendingSupportCaseNotifications,
} = require("../netlify/functions/_lib/mg-support/notification-sweep");
const { createTransactionalStore } = require("./_lib/mg-support-transition-rpc-sim");
const { timingSafeEqualString } = require("../netlify/functions/_lib/email-delivery-handoff");

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
const NOW = "2026-08-29T01:00:00.000Z";
const AGED = "2026-08-29T00:59:00.000Z";
const OWNER_EMAIL = "owner@example.com";
const SUPPORT_HMAC = "support-hmac-freeze-vector";
const SUPPORT_WEBHOOK = "https://hooks.example.test/support-case-email";
const SUPPORT_DISPATCH = "support-dispatch-secret-freeze";
const INVOICE_SECRET = "invoice-secret-must-not-be-used";
const CONTRACT_SECRET = "contract-secret-must-not-be-used";
const CASE_REF = "MG-SUP-" + CASE_ID;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function decodePath(p) {
  try {
    return decodeURIComponent(String(p || ""));
  } catch (_err) {
    return String(p || "");
  }
}

function enabledEnv(extra) {
  return Object.assign(
    {
      [ENV.ENABLED]: "true",
      [ENV.WEBHOOK]: SUPPORT_WEBHOOK,
      [ENV.HMAC]: SUPPORT_HMAC,
      [ENV.DISPATCH]: SUPPORT_DISPATCH,
      ZAPIER_WEBHOOK_SECRET: INVOICE_SECRET,
      CONTRACT_EMAIL_ZAPIER_HMAC_SECRET: CONTRACT_SECRET,
    },
    extra || {}
  );
}

function parseQuery(decoded) {
  const q = String(decoded).split("?")[1] || "";
  const out = {};
  q.split("&").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    out[part.slice(0, i)] = part.slice(i + 1);
  });
  return out;
}

function createDeliveryWorld(opts) {
  const options = opts || {};
  const events = new Map();
  (options.events || []).forEach((row) => events.set(row.id, Object.assign({}, row)));
  const caseRow = Object.assign(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "in_review", status_version: 2 },
    options.caseRow || {}
  );
  const tenant = Object.assign(
    { id: TENANT_ID, owner_email: options.ownerEmail === undefined ? OWNER_EMAIL : options.ownerEmail },
    options.tenant || {}
  );
  const posts = [];
  const patches = [];
  const gets = [];
  let claimLock = false;

  async function supabaseRequest(path, init) {
    const decoded = decodePath(path);
    const method = String((init && init.method) || "GET").toUpperCase();
    const q = parseQuery(decoded);
    if (method === "GET" && decoded.startsWith("tenant_support_notification_outbox?")) {
      gets.push(decoded);
      if (q.id && String(q.id).startsWith("eq.")) {
        const row = events.get(String(q.id).slice(3));
        return row ? [{ ...row }] : [];
      }
      const statusEq = String(q.delivery_status || "").replace(/^eq\./, "");
      const cutoff = String(q.created_at || "").replace(/^lte\./, "");
      const limit = Number(String(q.limit || "10"));
      let rows = Array.from(events.values()).filter((row) => {
        if (statusEq && row.delivery_status !== statusEq) return false;
        if (cutoff && String(row.created_at) > cutoff) return false;
        return true;
      });
      rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
      return rows.map((row) => ({ id: row.id }));
    }
    if (method === "GET" && decoded.startsWith("tenant_support_cases?")) return [{ ...caseRow }];
    if (method === "GET" && decoded.startsWith("tenants?")) return [{ ...tenant }];
    if (method === "PATCH" && decoded.startsWith("tenant_support_notification_outbox?")) {
      patches.push({ path: decoded, body: Object.assign({}, init.body || {}) });
      const id = String(q.id || "").replace(/^eq\./, "");
      const event = events.get(id);
      if (!event) return [];
      if (decoded.includes("delivery_status=eq.pending") && decoded.includes("attempt_count=eq.")) {
        const matched = /attempt_count=eq\.(\d+)/.exec(decoded);
        const expected = matched ? Number(matched[1]) : -1;
        if (claimLock || event.delivery_status !== "pending" || event.attempt_count !== expected) return [];
        claimLock = true;
        Object.assign(event, init.body || {});
        claimLock = false;
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
    if (options.postAbort) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (options.postNetwork) throw new Error("ECONNRESET");
    return { status: options.postStatus == null ? 202 : options.postStatus };
  }

  return {
    events,
    posts,
    patches,
    gets,
    tenant,
    deps: {
      env: enabledEnv(options.env),
      supabaseRequest,
      fetchImpl,
      nowIso: () => NOW,
    },
    getEvent: (id) => ({ ...events.get(id || EVENT_ID) }),
    putEvent: (row) => events.set(row.id, Object.assign({}, row)),
  };
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

async function main() {
  const sqlSrc = read("SUPABASE_MG_SUPPORT_003E_2D1_ATOMIC_CASE_TRANSITION_OUTBOX.sql");
  const verifySrc = read("SUPABASE_MG_SUPPORT_003E_2D1_ATOMIC_CASE_TRANSITION_OUTBOX_VERIFY.sql");
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const deliverySrc = read("netlify/functions/_lib/mg-support/notification-delivery.js");
  const dispatchSrc = read("netlify/functions/mg-support-case-notification-dispatch-background.js");
  const sweepLibSrc = read("netlify/functions/_lib/mg-support/notification-sweep.js");
  const sweepFnSrc = read("netlify/functions/mg-support-case-notification-sweep.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const myCasesSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const routerSrc = read("netlify/functions/_lib/mg-support/router.js");
  const adminHtml = read("public/support-admin.html");
  const adminJs = read("public/js/support-admin.js");
  const navSrc = read("public/js/mg-app-nav.js");
  const invoiceSrc = read("netlify/functions/_lib/mg-support/invoice-resend-action.js");

  assert("A1. RPC SECURITY INVOKER", /security invoker/i.test(sqlSrc) && !/security definer/i.test(sqlSrc));
  assert("A2. RPC search_path pinned", /set search_path = pg_catalog, public/.test(sqlSrc));
  assert("A3. no dynamic SQL", !/execute immediate|execute format|EXECUTE\s+'/i.test(sqlSrc));
  assert("A4. tables fully qualified", /public\.tenant_support_cases/.test(sqlSrc) && /public\.tenant_support_notification_outbox/.test(sqlSrc));
  assert("A5. PUBLIC/anon/authenticated execute revoked", /revoke execute[\s\S]*from public/i.test(sqlSrc) && /from anon/i.test(sqlSrc) && /from authenticated/i.test(sqlSrc));
  assert("A6. service_role execute granted", /grant execute[\s\S]*to service_role/i.test(sqlSrc));
  assert("A7. RPC does not accept tenant/email/raw status/event/webhook", !/\bp_tenant_id\b|\bp_event_type\b|\bp_to_status\b|\bp_recipient|\bp_owner_email|\bp_webhook|\bp_hmac\b/i.test(sqlSrc));
  assert("A8. CAS predicates", /c\.status = p_expected_status/.test(sqlSrc) && /c\.status_version = p_expected_status_version/.test(sqlSrc));
  assert("A9. one UPDATE + version +1", /status_version = c\.status_version \+ 1/.test(sqlSrc) && (sqlSrc.match(/update public\.tenant_support_cases/gi) || []).length === 1);
  assert("A10. outbox ON CONFLICT unique identity", /on conflict \(case_id, case_status_version, event_type\)/i.test(sqlSrc));
  assert("A11. return_to_open has no event", /p_action = 'return_to_open'[\s\S]*v_event_type := null/.test(sqlSrc));
  assert("A12. D1 does not rewrite existing rows/tables", !/alter table|drop table|insert into public\.tenant_support_cases/i.test(sqlSrc.split("create or replace function")[0] + sqlSrc.slice(sqlSrc.indexOf("$$;"))));
  assert("A13. migration filename immutable", fs.existsSync(path.join(ROOT, "SUPABASE_MG_SUPPORT_003E_2D1_ATOMIC_CASE_TRANSITION_OUTBOX.sql")));
  assert("A14. verify SQL performs no DML", !/\binsert into\b|\bdelete from\b|\bupdate public\./i.test(verifySrc));
  assert(
    "A15. verify checks invoker + grants + CAS",
    /prosecdef/.test(verifySrc) &&
      /v_definer is distinct from false/.test(verifySrc) &&
      !/v_src\s+!~\*\s+'security invoker'/.test(verifySrc) &&
      /pg_get_function_identity_arguments/.test(verifySrc) &&
      /service_role/.test(verifySrc) &&
      /search_path/.test(verifySrc)
  );

  const mapping = [
    ["mark_in_review", "in_review", "case_in_review", ["open", "waiting_on_customer", "resolved"]],
    ["request_customer_action", "waiting_on_customer", "case_waiting_on_customer", ["open", "in_review"]],
    ["resolve", "resolved", "case_resolved", ["open", "in_review", "waiting_on_customer"]],
    ["reopen", "open", "case_reopened", ["resolved"]],
    ["return_to_open", "open", null, ["in_review"]],
  ];
  let mappingOk = true;
  mapping.forEach(([action, to, eventType, from]) => {
    const plan = ACTION_PLAN[action];
    if (!plan || plan.to !== to) mappingOk = false;
    if (EVENT_TYPE_BY_ACTION[action] !== eventType) mappingOk = false;
    from.forEach((status) => {
      if (!plan.from.has(status)) mappingOk = false;
    });
    if (plan.from.size !== from.length) mappingOk = false;
  });
  assert("B1. Node ACTION_PLAN matches freeze table", mappingOk);
  assert("B2. SQL maps mark_in_review from open/waiting/resolved", /p_action = 'mark_in_review'[\s\S]*in \('open', 'waiting_on_customer', 'resolved'\)/.test(sqlSrc));
  assert("B3. SQL maps request_customer_action from open/in_review", /p_action = 'request_customer_action'[\s\S]*in \('open', 'in_review'\)/.test(sqlSrc));
  assert("B4. SQL maps resolve from open/in_review/waiting", /p_action = 'resolve'[\s\S]*in \('open', 'in_review', 'waiting_on_customer'\)/.test(sqlSrc));
  assert("B5. SQL maps reopen from resolved", /p_action = 'reopen'[\s\S]*p_expected_status = 'resolved'/.test(sqlSrc));
  assert("B6. SQL maps return_to_open from in_review", /p_action = 'return_to_open'[\s\S]*p_expected_status = 'in_review'/.test(sqlSrc));

  const storeSnap = createTransactionalStore(
    {
      id: CASE_ID,
      tenant_id: TENANT_ID,
      status: "open",
      status_version: 1,
      customer_resolution: "Keep this.",
      tenant_action_message: "old",
      resolved_at: "2026-01-01T00:00:00.000Z",
    },
    { nowIso: () => NOW, nextEventId: EVENT_ID }
  );
  const review = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [storeSnap.getStored()],
    supabaseRpc: storeSnap.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: false, result: "kick_skipped" }),
  });
  const afterReview = storeSnap.getStored();
  const evReview = storeSnap.getEvents()[0];
  assert("B7. in_review snapshot fields", review.ok && afterReview.status === "in_review" && afterReview.tenant_action_message === null && afterReview.resolved_at === null && afterReview.customer_resolution === "Keep this." && afterReview.status_version === 2);
  assert("B8. in_review enqueues pending event", evReview && evReview.event_type === "case_in_review" && evReview.delivery_status === "pending" && evReview.attempt_count === 0 && evReview.tenant_id === TENANT_ID);

  const waitStore = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "in_review", status_version: 2, customer_resolution: "Keep this.", tenant_action_message: null, resolved_at: null },
    { nowIso: () => NOW, nextEventId: EVENT_ID }
  );
  const waiting = await updateAdminCase(
    parseUpdateBody({ case_id: CASE_ID, action: "request_customer_action", tenant_action_message: "Upload the photo." }),
    { supabaseGet: async () => [waitStore.getStored()], supabaseRpc: waitStore.supabaseRpc, kickSupportCaseNotificationDispatch: async () => ({ ok: true }) }
  );
  const afterWait = waitStore.getStored();
  assert("B9. waiting snapshot fields", waiting.ok && afterWait.status === "waiting_on_customer" && afterWait.tenant_action_message === "Upload the photo." && afterWait.resolved_at === null && afterWait.customer_resolution === "Keep this.");

  const resolveStore = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "waiting_on_customer", status_version: 3, customer_resolution: "Old.", tenant_action_message: "Need photo.", resolved_at: null },
    { nowIso: () => NOW, nextEventId: EVENT_ID }
  );
  const resolvedOmit = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "resolve" }), {
    supabaseGet: async () => [resolveStore.getStored()],
    supabaseRpc: resolveStore.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: true }),
  });
  const afterResolve = resolveStore.getStored();
  assert("B10. resolve omitted resolution preserves existing", resolvedOmit.ok && afterResolve.status === "resolved" && afterResolve.tenant_action_message === null && afterResolve.resolved_at === NOW && afterResolve.customer_resolution === "Old.");

  const resolveReplace = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "open", status_version: 1, customer_resolution: "Old.", tenant_action_message: null, resolved_at: null },
    { nowIso: () => NOW }
  );
  await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "resolve", customer_resolution: "Fixed in settings." }), {
    supabaseGet: async () => [resolveReplace.getStored()],
    supabaseRpc: resolveReplace.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: true }),
  });
  assert("B11. resolve explicit resolution replaces", resolveReplace.getStored().customer_resolution === "Fixed in settings.");

  const reopenStore = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "resolved", status_version: 5, customer_resolution: "Keep.", tenant_action_message: null, resolved_at: NOW },
    { nowIso: () => NOW }
  );
  const reopened = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "reopen" }), {
    supabaseGet: async () => [reopenStore.getStored()],
    supabaseRpc: reopenStore.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: true }),
  });
  const afterReopen = reopenStore.getStored();
  assert("B12. reopen snapshot fields", reopened.ok && afterReopen.status === "open" && afterReopen.resolved_at === null && afterReopen.tenant_action_message === null && afterReopen.customer_resolution === "Keep." && afterReopen.status_version === 6);
  assert("B13. return_to_open has zero events", EVENT_TYPE_BY_ACTION.return_to_open == null);

  const returnStore = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "in_review", status_version: 2, customer_resolution: "Keep.", tenant_action_message: "x", resolved_at: null },
    { nowIso: () => NOW }
  );
  await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "return_to_open" }), {
    supabaseGet: async () => [returnStore.getStored()],
    supabaseRpc: returnStore.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => {
      throw new Error("kick must not run for return_to_open");
    },
  });
  assert("B14. return_to_open no outbox", returnStore.getEvents().length === 0 && returnStore.getStored().status === "open" && returnStore.getStored().status_version === 3);

  const staleA = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null },
    { nowIso: () => NOW, nextEventId: EVENT_ID }
  );
  const first = updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [{ id: CASE_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null }],
    supabaseRpc: staleA.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: true }),
  });
  const second = updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [{ id: CASE_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null }],
    supabaseRpc: staleA.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: true }),
  });
  const [win, lose] = await Promise.all([first, second]);
  const results = [win.result, lose.result].sort();
  assert("D1. concurrent same-version: one transition one stale", results.includes("in_review") && results.includes("stale_state"));
  assert("D2. no duplicate version/event", staleA.getStored().status_version === 2 && staleA.getEvents().length === 1);

  const rollback = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null },
    { nowIso: () => NOW, failOutbox: true }
  );
  const rolled = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [rollback.getStored()],
    supabaseRpc: rollback.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: true }),
  });
  assert("F1. outbox insert failure rolls back case", rolled.result === "write_failed" && rollback.getStored().status === "open" && rollback.getStored().status_version === 1 && rollback.getEvents().length === 0);

  const offStore = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null },
    { nowIso: () => NOW, nextEventId: EVENT_ID }
  );
  const offWorld = createDeliveryWorld({ env: { [ENV.ENABLED]: "false" } });
  const offKickPosts = [];
  const offAdmin = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [offStore.getStored()],
    supabaseRpc: offStore.supabaseRpc,
    env: { [ENV.ENABLED]: "false" },
    kickSupportCaseNotificationDispatch: async (id, deps) => {
      const row = offStore.getEvents()[0];
      offWorld.putEvent(Object.assign({ created_at: AGED, claimed_at: null, processed_at: null, result_code: null }, row));
      const res = await dispatchPendingEvent(id, Object.assign({}, offWorld.deps, deps || {}));
      return res;
    },
    fetchImpl: async (url, init) => {
      offKickPosts.push({ url, init });
      return { status: 202 };
    },
  });
  const offEvent = offStore.getEvents()[0];
  offWorld.putEvent(Object.assign({ created_at: AGED, claimed_at: null, processed_at: null, result_code: null }, offEvent));
  const offDispatch = await dispatchPendingEvent(EVENT_ID, offWorld.deps);
  const offSweep = await sweepPendingSupportCaseNotifications(offWorld.deps);
  assert("I1. delivery OFF still transitions case", offAdmin.ok && offAdmin.result === "in_review" && offStore.getStored().status === "in_review");
  assert("I2. delivery OFF still enqueues pending", offEvent && offEvent.delivery_status === "pending" && offStore.getEvents().length === 1);
  assert("I3. delivery OFF does not claim", offDispatch.result === "delivery_disabled" && offWorld.getEvent().delivery_status === "pending" && offWorld.getEvent().attempt_count === 0);
  assert("I4. delivery OFF does not POST", offWorld.posts.length === 0 && offKickPosts.length === 0);
  assert("I5. delivery OFF sweeper leaves pending", offSweep.result === "delivery_disabled" && offSweep.selected === 0);
  assert("I6. kill switch does not control enqueue", !/isDeliveryEnabled|SUPPORT_CASE_EMAIL_DELIVERY_ENABLED/.test(helperSrc));
  assert("I7. kill switch exact true only", isDeliveryEnabled({ env: { [ENV.ENABLED]: "true" } }) === true && isDeliveryEnabled({ env: { [ENV.ENABLED]: "TRUE" } }) === false && isDeliveryEnabled({ env: {} }) === false);

  assert("J1. dispatcher body event_id only", parseDispatchBody(JSON.stringify({ event_id: EVENT_ID })).ok === true);
  assert("J2. browser tenant rejected", parseDispatchBody(JSON.stringify({ event_id: EVENT_ID, tenant_id: TENANT_ID })).ok === false);
  assert("J3. browser recipient rejected", parseDispatchBody(JSON.stringify({ event_id: EVENT_ID, recipient_email: OWNER_EMAIL })).ok === false);
  assert("J4. missing dispatch secret fail-closed", assertDispatchAuth({ headers: {} }, { env: { [ENV.DISPATCH]: "" } }).ok === false);
  assert("J5. empty provided secret does not match", timingSafeEqualString("", SUPPORT_DISPATCH) === false);
  assert("J6. empty===empty is not an auth success path", assertDispatchAuth({ headers: { "x-mg-dispatch-key": "" } }, { env: { [ENV.DISPATCH]: "" } }).result === "dispatch_secret_missing");
  const missingKick = await kickSupportCaseNotificationDispatch(EVENT_ID, { env: enabledEnv({ [ENV.DISPATCH]: "" }) });
  assert("J7. missing secret skips kick", missingKick.result === "kick_skipped");

  assert("L1. background filename convention", DISPATCH_FUNCTION === "mg-support-case-notification-dispatch-background" && DISPATCH_FUNCTION.endsWith("-background"));
  assert(
    "L2. repository already uses *-background.js as Netlify background functions",
    fs.existsSync(path.join(ROOT, "netlify/functions/mg-support-case-notification-dispatch-background.js")) &&
      fs.existsSync(path.join(ROOT, "netlify/functions/contract-invitation-email-dispatch-background.js"))
  );
  assert("L3. admin kick timeout is far below Zapier 20s", /KICK_TIMEOUT_MS = 2500/.test(deliverySrc) && POST_TIMEOUT_MS === 20000);
  assert("L4. admin HTTP handler does not reference Zapier", !/zapier|gmail|SUPPORT_CASE_EMAIL_ZAPIER_WEBHOOK_URL/i.test(updateSrc));

  const claimPath = decodePath(buildClaimPath(EVENT_ID, 0));
  const finPath = decodePath(buildFinalizePath(EVENT_ID, 1));
  assert("M1. claim CAS id+pending+attempt_count", claimPath.includes("id=eq." + EVENT_ID) && claimPath.includes("delivery_status=eq.pending") && claimPath.includes("attempt_count=eq.0"));
  assert("T1. finalize CAS id+claimed+attempt_count", finPath.includes("delivery_status=eq.claimed") && finPath.includes("attempt_count=eq.1"));

  const prepSrc = deliverySrc.slice(deliverySrc.indexOf("async function dispatchPendingEvent"), deliverySrc.indexOf("function assertDispatchAuth"));
  const claimIdx = prepSrc.indexOf("casClaim(");
  const loadIdx = prepSrc.indexOf("loadEvent(");
  const caseIdx = prepSrc.indexOf("loadCase(");
  const tenantIdx = prepSrc.indexOf("loadTenant(");
  const validIdx = prepSrc.indexOf("isValidEmail(");
  const tmplIdx = prepSrc.indexOf("buildTemplate(");
  const cfgIdx = prepSrc.indexOf("getSupportZapierConfig(");
  const payIdx = prepSrc.indexOf("buildCanonicalPayload(");
  const signIdx = prepSrc.indexOf("signSupportPayload(");
  assert(
    "H1. local prep before claim",
    loadIdx >= 0 &&
      caseIdx > loadIdx &&
      tenantIdx > caseIdx &&
      validIdx > tenantIdx &&
      tmplIdx > validIdx &&
      cfgIdx > 0 &&
      payIdx > tmplIdx &&
      signIdx > payIdx &&
      claimIdx > signIdx
  );

  const tpl = buildTemplate("case_in_review", CASE_REF);
  const payload = buildCanonicalPayload({
    eventId: EVENT_ID,
    eventType: "case_in_review",
    caseRef: CASE_REF,
    recipientEmail: OWNER_EMAIL,
    subject: tpl.subject,
    textBody: tpl.text_body,
    timestamp: NOW,
    caseId: CASE_ID,
    caseStatusVersion: 2,
  });
  const sealed = signSupportPayload(payload, SUPPORT_HMAC, NOW);
  const expectedSig = signCanonicalBody(canonicalizeJson(payload), NOW, SUPPORT_HMAC).toLowerCase();
  assert("P1. HMAC algorithm timestamp.canonical_json", sealed.ok && sealed.signature === expectedSig && /^[0-9a-f]{64}$/.test(sealed.signature));
  assert("P2. invoice secret not used", signCanonicalBody(canonicalizeJson(payload), NOW, INVOICE_SECRET).toLowerCase() !== sealed.signature);
  assert("P3. contract secret not used", signCanonicalBody(canonicalizeJson(payload), NOW, CONTRACT_SECRET).toLowerCase() !== sealed.signature);
  assert(
    "Q1. payload exact keys",
    Object.keys(payload).sort().join(",") ===
      ["case_ref", "event_id", "event_type", "idempotency_key", "recipient_email", "schema_version", "subject", "text_body", "timestamp"].sort().join(",")
  );
  assert("Q2. schema + idempotency", payload.schema_version === SCHEMA_VERSION && payload.idempotency_key === CASE_ID + ":2:case_in_review");
  const payloadStr = JSON.stringify(payload);
  assert(
    "Q3. no sensitive extra payload fields",
    !/tenant_action_message|customer_resolution|question_excerpt|tenant_id|magic|token/.test(payloadStr.replace("recipient_email", ""))
  );
  assert("R1. closed subjects", TEMPLATES.case_in_review.subject === "Margin Guard Support — Case Update" && TEMPLATES.case_waiting_on_customer.subject === "Margin Guard Support — Action Needed" && TEMPLATES.case_resolved.subject === "Margin Guard Support — Case Resolved" && TEMPLATES.case_reopened.subject === "Margin Guard Support — Case Reopened");
  assert("R2. CTA exact", CTA_URL === "https://marginguardsystem.netlify.app/owner.html" && tpl.text_body.includes(CTA_URL) && tpl.text_body.includes("Ask Margin Guard → My Cases"));
  assert("R3. no action/resolution/financial in template", !/tenant_action_message|customer_resolution|invoice|deposit|\$/.test(JSON.stringify(TEMPLATES)));

  assert("U1. claimed is unsafe to auto-retry", /unsafe to automatically retry/.test(CLAIM_PROCESS_DEATH_NOTE));
  assert("U2. no claimed reset in D2/D3", !/claimed_at=lte/.test(sweepLibSrc) && !/delivery_status:\s*"pending"/.test(sweepLibSrc + sweepFnSrc) && !/delivery_status:\s*"pending"/.test(deliverySrc.slice(deliverySrc.indexOf("async function casClaim"), deliverySrc.indexOf("async function casFinalize"))));
  assert("V1. sweeper pending only + 30s + batch 10", ELIGIBLE_FROM_PATH());
  assert("V2. schedule syntax", SWEEP_SCHEDULE === "*/5 * * * *" && /export const config/.test(sweepFnSrc) && sweepFnSrc.includes('schedule: "*/5 * * * *"') && /export default/.test(sweepFnSrc) && !/exports\.handler/.test(sweepFnSrc));
  assert("Z1. pending accumulation rule documented", /inspect[\s\S]{0,40}every pending/.test(sweepLibSrc) && /inspect every pending/.test(sqlSrc));
  assert("Z2. no automatic pending delete/mark-delivered", !/delivery_status:\s*"bridge_accepted"/.test(sweepLibSrc) && !/delete from/.test(sweepLibSrc + deliverySrc));

  const sweepGet = await createSweepHandler({ env: enabledEnv() })({
    httpMethod: "GET",
    queryStringParameters: { limit: "999", status: "claimed" },
    body: JSON.stringify({ tenant_id: TENANT_ID }),
  });
  assert("W1. GET does not sweep", sweepGet.statusCode === 405 && parse(sweepGet).result === "invalid_request");
  const sweepPost = await createSweepHandler({
    env: enabledEnv({ [ENV.ENABLED]: "false" }),
  })({
    httpMethod: "POST",
    body: JSON.stringify({ tenant_id: TENANT_ID, limit: 99, status: "claimed", cutoff: "1999-01-01T00:00:00.000Z" }),
  });
  const sweepBody = parse(sweepPost);
  assert("W2. POST ignores caller scope and returns counts only", sweepPost.statusCode === 200 && sweepBody.result === "delivery_disabled" && sweepBody.selected === 0 && !("recipient_email" in sweepBody) && !("events" in sweepBody));
  assert("W3. no invented scheduler header", !/x-netlify-event|x-nf-event/.test(sweepFnSrc));

  const timeoutWorld = createDeliveryWorld({
    postAbort: true,
    events: [
      {
        id: EVENT_ID,
        tenant_id: TENANT_ID,
        case_id: CASE_ID,
        event_type: "case_in_review",
        from_status: "open",
        to_status: "in_review",
        case_status_version: 2,
        payload_version: 1,
        delivery_status: "pending",
        attempt_count: 0,
        result_code: null,
        created_at: AGED,
        claimed_at: null,
        processed_at: null,
      },
    ],
  });
  const e2eStore = createTransactionalStore(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "open", status_version: 1, customer_resolution: null, tenant_action_message: null, resolved_at: null },
    { nowIso: () => NOW, nextEventId: EVENT_ID }
  );
  const firstTransition = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [e2eStore.getStored()],
    supabaseRpc: e2eStore.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => ({ ok: true, result: "kicked" }),
  });
  const doubleClick = await updateAdminCase(parseUpdateBody({ case_id: CASE_ID, action: "mark_in_review" }), {
    supabaseGet: async () => [e2eStore.getStored()],
    supabaseRpc: e2eStore.supabaseRpc,
    kickSupportCaseNotificationDispatch: async () => {
      throw new Error("second event kick");
    },
  });
  assert("AA1. admin transition + one pending event", firstTransition.ok && e2eStore.getEvents().length === 1 && e2eStore.getEvents()[0].delivery_status === "pending");
  assert("AA2. double-click does not create second event", doubleClick.result === "already_in_review" && e2eStore.getEvents().length === 1 && e2eStore.getStored().status_version === 2);

  timeoutWorld.putEvent(Object.assign({ created_at: AGED, claimed_at: null, processed_at: null, result_code: null }, e2eStore.getEvents()[0]));
  let loads = 0;
  let releaseLoads;
  const bothLoaded = new Promise((resolve) => {
    releaseLoads = resolve;
  });
  const origReq = timeoutWorld.deps.supabaseRequest;
  timeoutWorld.deps.supabaseRequest = async function (p, init) {
    const decoded = decodePath(p);
    if (String((init && init.method) || "GET").toUpperCase() === "GET" && decoded.includes("id=eq.")) {
      loads += 1;
      if (loads >= 2) releaseLoads();
      await bothLoaded;
    }
    return origReq(p, init);
  };
  const [kickRes, sweepRes] = await Promise.all([
    dispatchPendingEvent(EVENT_ID, timeoutWorld.deps),
    dispatchPendingEvent(EVENT_ID, timeoutWorld.deps),
  ]);
  const raceCodes = [kickRes.result, sweepRes.result].sort();
  assert("AA3. kick/sweep race one POST", timeoutWorld.posts.length === 1);
  assert("AA4. one claim winner + loser conflict", raceCodes.includes("claim_conflict") && (raceCodes.includes("submission_unknown_timeout") || [kickRes, sweepRes].some((r) => r.delivery_status === "submission_unknown")));
  assert("AA5. timeout becomes submission_unknown", timeoutWorld.getEvent().delivery_status === "submission_unknown" && timeoutWorld.getEvent().attempt_count === 1);

  const laterSweep = await sweepPendingSupportCaseNotifications(Object.assign({}, timeoutWorld.deps, { env: enabledEnv() }));
  const laterDispatch = await dispatchPendingEvent(EVENT_ID, timeoutWorld.deps);
  assert("AA6. later sweep does not select unknown", laterSweep.selected === 0);
  assert("AA7. background re-invocation does not re-POST", laterDispatch.result === "not_pending" && timeoutWorld.posts.length === 1);

  const okWorld = createDeliveryWorld({
    events: [
      {
        id: EVENT_ID,
        tenant_id: TENANT_ID,
        case_id: CASE_ID,
        event_type: "case_resolved",
        from_status: "open",
        to_status: "resolved",
        case_status_version: 2,
        payload_version: 1,
        delivery_status: "pending",
        attempt_count: 0,
        result_code: null,
        created_at: AGED,
        claimed_at: null,
        processed_at: null,
      },
    ],
  });
  const okRes = await dispatchPendingEvent(EVENT_ID, okWorld.deps);
  const okLaterSweep = await sweepPendingSupportCaseNotifications(okWorld.deps);
  const okLaterDispatch = await dispatchPendingEvent(EVENT_ID, okWorld.deps);
  assert("AA8. 2xx becomes bridge_accepted", okRes.delivery_status === "bridge_accepted" && okWorld.getEvent().result_code === "bridge_accepted");
  assert("AA9. later sweep/background add zero POSTs", okWorld.posts.length === 1 && okLaterSweep.selected === 0 && okLaterDispatch.result === "not_pending");
  assert("AA10. max one POST per event identity", timeoutWorld.posts.length === 1 && okWorld.posts.length === 1);

  const notifySrc = deliverySrc + dispatchSrc + sweepLibSrc + sweepFnSrc + helperSrc;
  assert("AB1. zero OpenAI in notification path", !/openai\.com|OPENAI_API_KEY|getOpenAiKey/.test(notifySrc));
  assert("AC1. no recipient/webhook/signature logs", !/console\.(log|error|info)\([^\)]*recipient_email|console\.(log|error)\([^\)]*owner_email|console\.(log|error)\([^\)]*signature/.test(notifySrc));
  assert("AF1. Support Admin asset remains 003e-2", /support-admin\.js\?v=003e-2/.test(adminHtml) && !/notification|delivery_status|outbox/.test(adminJs));
  assert("AF2. chat asset remains 003e-2", /SUPPORT_CHAT_ASSET_VERSION = '003e-2'/.test(navSrc));
  assert("AF3. no tenant delivery UX", !/bridge_accepted|notification-sweep/.test(myCasesSrc));
  assert("AG1. no notification chat intent", !/notification_outbox|case_in_review/.test(routerSrc + chatSrc));
  assert("AG2. invoice resend still present", /executeInvoiceResend/.test(invoiceSrc));
  assert("AG3. my cases still GET-only at HTTP", /method !== "GET"/.test(read("netlify/functions/mg-support-my-cases.js")));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

function ELIGIBLE_FROM_PATH() {
  const cutoff = pendingAgeCutoffIso(NOW, PENDING_MIN_AGE_MS);
  const listPath = decodePath(buildPendingSweepPath(cutoff));
  return (
    PENDING_MIN_AGE_MS === 30000 &&
    SWEEP_BATCH_SIZE === 10 &&
    listPath.includes("delivery_status=eq.pending") &&
    listPath.includes("created_at=lte." + cutoff) &&
    listPath.includes("order=created_at.asc,id.asc") &&
    listPath.includes("limit=10") &&
    !listPath.includes("claimed")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
