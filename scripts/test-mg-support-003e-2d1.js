#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2D1 — atomic case transition + pending outbox enqueue
 * (mocked session/DB only). Usage: node scripts/test-mg-support-003e-2d1.js
 *
 * Does not apply SQL, mutate production, send email, or call Zapier.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createUpdateHandler } = require("../netlify/functions/mg-support-admin-update-case");
const {
  parseUpdateBody,
  updateAdminCase,
  TRANSITION_RPC,
  EVENT_TYPE_BY_ACTION,
  UPDATE_BODY_KEYS,
} = require("../netlify/functions/_lib/mg-support/admin-cases");
const { createTransactionalStore } = require("./_lib/mg-support-transition-rpc-sim");

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

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-28T23:45:00.000Z";
const ACTION_MSG = "Please send the signed photo.";
const RESOLUTION = "We restored the quote line.";

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function baseCase(extra) {
  return Object.assign(
    {
      id: CASE_ID,
      tenant_id: TENANT_ID,
      status: "open",
      status_version: 1,
      customer_resolution: null,
      tenant_action_message: null,
      resolved_at: null,
      updated_at: NOW,
    },
    extra || {}
  );
}

function makeStore(row, extra) {
  const store = createTransactionalStore(baseCase(row), Object.assign({ nowIso: () => NOW }, extra || {}));
  async function supabaseGet() {
    const current = store.getStored();
    return [
      {
        id: current.id,
        status: current.status,
        status_version: current.status_version,
        customer_resolution: current.customer_resolution,
        tenant_action_message: current.tenant_action_message,
        resolved_at: current.resolved_at,
      },
    ];
  }
  return {
    store,
    supabaseGet,
    supabaseRpc: store.supabaseRpc,
    getStored: store.getStored,
    getEvents: store.getEvents,
    rpcs: store.calls,
  };
}

async function runAction(db, action, bodyExtra) {
  const parsed = parseUpdateBody(Object.assign({ case_id: CASE_ID, action }, bodyExtra || {}));
  if (!parsed.ok) return { parsed, res: { ok: false, result: "invalid_request" } };
  const res = await updateAdminCase(parsed, {
    supabaseGet: db.supabaseGet,
    supabaseRpc: db.supabaseRpc,
  });
  return { parsed, res };
}

function eventKeys(event) {
  return Object.keys(event || {}).sort();
}

async function main() {
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const sqlSrc = read("SUPABASE_MG_SUPPORT_003E_2D1_ATOMIC_CASE_TRANSITION_OUTBOX.sql");
  const verifySrc = read("SUPABASE_MG_SUPPORT_003E_2D1_ATOMIC_CASE_TRANSITION_OUTBOX_VERIFY.sql");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const myCasesSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const myCasesEndpoint = read("netlify/functions/mg-support-my-cases.js");
  const uiSrc = read("public/js/support-admin.js");
  const htmlSrc = read("public/support-admin.html");
  const contractSrc = read("netlify/functions/_lib/mg-support/contract-diagnostic.js");

  async function expectEvent(label, fromStatus, action, extra, eventType, toStatus, rowExtra) {
    const db = makeStore(Object.assign({ status: fromStatus, status_version: 4 }, rowExtra || {}));
    const before = db.getStored();
    const { res } = await runAction(db, action, extra);
    const events = db.getEvents();
    const stored = db.getStored();
    assert(
      label,
      res.ok === true &&
        stored.status === toStatus &&
        stored.status_version === before.status_version + 1 &&
        events.length === 1 &&
        events[0].event_type === eventType &&
        events[0].delivery_status === "pending" &&
        events[0].attempt_count === 0 &&
        events[0].case_status_version === stored.status_version &&
        events[0].from_status === fromStatus &&
        events[0].to_status === toStatus &&
        events[0].tenant_id === TENANT_ID &&
        events[0].payload_version === 1
    );
    return { db, res, events, stored, before };
  }

  await expectEvent("1. open → in_review queues case_in_review", "open", "mark_in_review", null, "case_in_review", "in_review");
  await expectEvent(
    "2. waiting → in_review queues case_in_review",
    "waiting_on_customer",
    "mark_in_review",
    null,
    "case_in_review",
    "in_review",
    { tenant_action_message: ACTION_MSG }
  );
  await expectEvent(
    "3. resolved → in_review queues case_in_review",
    "resolved",
    "mark_in_review",
    null,
    "case_in_review",
    "in_review",
    { customer_resolution: RESOLUTION, resolved_at: NOW }
  );
  await expectEvent(
    "4. open → waiting queues case_waiting_on_customer",
    "open",
    "request_customer_action",
    { tenant_action_message: ACTION_MSG },
    "case_waiting_on_customer",
    "waiting_on_customer"
  );
  await expectEvent(
    "5. in_review → waiting queues case_waiting_on_customer",
    "in_review",
    "request_customer_action",
    { tenant_action_message: ACTION_MSG },
    "case_waiting_on_customer",
    "waiting_on_customer"
  );
  await expectEvent("6. open → resolved queues case_resolved", "open", "resolve", null, "case_resolved", "resolved");
  await expectEvent("7. in_review → resolved queues case_resolved", "in_review", "resolve", null, "case_resolved", "resolved");
  await expectEvent(
    "8. waiting → resolved queues case_resolved",
    "waiting_on_customer",
    "resolve",
    { customer_resolution: RESOLUTION },
    "case_resolved",
    "resolved",
    { tenant_action_message: ACTION_MSG }
  );
  await expectEvent(
    "9. resolved → reopen queues case_reopened",
    "resolved",
    "reopen",
    null,
    "case_reopened",
    "open",
    { customer_resolution: RESOLUTION, resolved_at: NOW }
  );

  const returnDb = makeStore({ status: "in_review", status_version: 4, tenant_action_message: ACTION_MSG });
  const returned = await runAction(returnDb, "return_to_open");
  assert(
    "10. return_to_open creates zero events",
    returned.res.result === "returned_to_open" &&
      returnDb.getStored().status === "open" &&
      returnDb.getStored().status_version === 5 &&
      returnDb.getEvents().length === 0
  );

  const alreadyDb = makeStore({ status: "in_review", status_version: 7 });
  const already = await runAction(alreadyDb, "mark_in_review");
  assert(
    "11. already_* is zero RPC and zero event",
    already.res.result === "already_in_review" &&
      alreadyDb.rpcs.length === 0 &&
      alreadyDb.getEvents().length === 0 &&
      alreadyDb.getStored().status_version === 7
  );

  const invalidDb = makeStore({ status: "waiting_on_customer", status_version: 3, tenant_action_message: ACTION_MSG });
  const invalid = await runAction(invalidDb, "reopen");
  assert(
    "12. invalid transition is zero update and zero event",
    invalid.res.result === "invalid_transition" &&
      invalidDb.rpcs.length === 0 &&
      invalidDb.getEvents().length === 0 &&
      invalidDb.getStored().status === "waiting_on_customer" &&
      invalidDb.getStored().status_version === 3
  );

  const blankDb = makeStore({ status: "open", status_version: 1 });
  const blank = await updateAdminCase(
    { case_id: CASE_ID, action: "request_customer_action", tenant_action_message: "   " },
    { supabaseGet: blankDb.supabaseGet, supabaseRpc: blankDb.supabaseRpc }
  );
  assert(
    "13. validation failure is zero update and zero event",
    blank.result === "invalid_request" && blankDb.rpcs.length === 0 && blankDb.getEvents().length === 0
  );

  const staleStore = makeStore({ status: "open", status_version: 1 });
  const staleSnap = staleStore.getStored();
  async function staleFrozenGet() {
    return [
      {
        id: staleSnap.id,
        status: staleSnap.status,
        status_version: staleSnap.status_version,
        customer_resolution: staleSnap.customer_resolution,
        tenant_action_message: staleSnap.tenant_action_message,
        resolved_at: staleSnap.resolved_at,
      },
    ];
  }
  await updateAdminCase(
    { case_id: CASE_ID, action: "mark_in_review" },
    { supabaseGet: staleFrozenGet, supabaseRpc: staleStore.supabaseRpc }
  );
  const stale = await updateAdminCase(
    parseUpdateBody({ case_id: CASE_ID, action: "resolve", customer_resolution: RESOLUTION }),
    { supabaseGet: staleFrozenGet, supabaseRpc: staleStore.supabaseRpc }
  );
  assert(
    "14. stale CAS is zero extra event",
    stale.result === "stale_state" &&
      staleStore.getStored().status === "in_review" &&
      staleStore.getStored().status_version === 2 &&
      staleStore.getEvents().length === 1
  );

  const raceA = makeStore({ status: "open", status_version: 1 });
  const frozen = raceA.getStored();
  async function frozenGet() {
    return [
      {
        id: frozen.id,
        status: frozen.status,
        status_version: frozen.status_version,
        customer_resolution: frozen.customer_resolution,
        tenant_action_message: frozen.tenant_action_message,
        resolved_at: frozen.resolved_at,
      },
    ];
  }
  const raceFirst = await updateAdminCase(
    { case_id: CASE_ID, action: "mark_in_review" },
    { supabaseGet: frozenGet, supabaseRpc: raceA.supabaseRpc }
  );
  const raceSecond = await updateAdminCase(
    parseUpdateBody({ case_id: CASE_ID, action: "request_customer_action", tenant_action_message: ACTION_MSG }),
    { supabaseGet: frozenGet, supabaseRpc: raceA.supabaseRpc }
  );
  assert(
    "15. concurrent same-version: first succeeds, second stale, one event",
    raceFirst.result === "in_review" &&
      raceSecond.result === "stale_state" &&
      raceA.getStored().status_version === 2 &&
      raceA.getEvents().length === 1
  );
  assert("16. status_version increments exactly once", raceA.getStored().status_version === 2);
  assert("17. event case_status_version equals NEW case version", raceA.getEvents()[0].case_status_version === 2);
  assert("18. from_status equals old state", raceA.getEvents()[0].from_status === "open");
  assert("19. to_status equals new state", raceA.getEvents()[0].to_status === "in_review");
  assert("20. tenant_id copied from case row", raceA.getEvents()[0].tenant_id === TENANT_ID);

  assert("21. browser tenant_id rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", tenant_id: TENANT_ID }).ok === false);
  assert("22. browser raw status rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", status: "resolved" }).ok === false);
  assert("23. browser status_version rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", status_version: 9 }).ok === false);
  assert("24. browser event_type rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", event_type: "case_resolved" }).ok === false);
  assert("25. browser recipient rejected", parseUpdateBody({ case_id: CASE_ID, action: "resolve", recipient_email: "a@b.com" }).ok === false);

  const waitEvt = makeStore({ status: "open", status_version: 1 });
  await runAction(waitEvt, "request_customer_action", { tenant_action_message: ACTION_MSG });
  const waitRow = waitEvt.getEvents()[0];
  assert("26. customer resolution not written to outbox", !("customer_resolution" in waitRow));
  assert("27. action message not written to outbox", !("tenant_action_message" in waitRow) && JSON.stringify(waitRow).indexOf(ACTION_MSG) === -1);
  assert("28. question excerpt not written to outbox", !("question_excerpt" in waitRow));
  assert(
    "29. financial data absent from outbox",
    !("amount" in waitRow) && !("invoice" in waitRow) && JSON.stringify(eventKeys(waitRow)).indexOf("price") === -1
  );
  assert("30. outbox delivery_status starts pending", waitRow.delivery_status === "pending");
  assert("31. attempt_count starts 0", waitRow.attempt_count === 0);

  const dup = makeStore({ status: "open", status_version: 1 });
  await runAction(dup, "mark_in_review");
  const existing = dup.getEvents()[0];
  dup.store.setStored(baseCase({ status: "open", status_version: 1 }));
  const dupSecond = await runAction(dup, "mark_in_review");
  assert(
    "32. unique conflict does not create second event",
    dupSecond.res.result === "in_review" &&
      dup.getEvents().length === 1 &&
      dup.getEvents()[0].id === existing.id
  );

  const rollback = makeStore({ status: "open", status_version: 1 }, { failOutbox: true });
  const rolled = await runAction(rollback, "mark_in_review");
  assert(
    "33. transition/outbox treated as one atomic unit",
    rolled.res.result === "write_failed" &&
      rollback.getStored().status === "open" &&
      rollback.getStored().status_version === 1 &&
      rollback.getEvents().length === 0
  );
  assert(
    "34. outbox insert failure rolls back case transition",
    rolled.res.ok === false &&
      rolled.res.result !== "in_review" &&
      rollback.getStored().status !== "in_review"
  );

  const nodeSrc = helperSrc + updateSrc;
  assert("35. no Zapier", !/zapier/i.test(nodeSrc + uiSrc + htmlSrc) && !/hooks\.zapier|zapier\.com/i.test(sqlSrc));
  assert("36. no email", !/nodemailer|sendgrid|gmail|mailto/i.test(nodeSrc) && !/nodemailer|sendgrid|gmail/i.test(sqlSrc));
  assert("37. no owner-email lookup", !/owner_email/.test(nodeSrc) && !/owner_email/.test(sqlSrc));
  assert("38. no OpenAI", !/openai\.com|OPENAI_API_KEY|getOpenAiKey/i.test(nodeSrc + sqlSrc));
  assert("39. E2.B admin actions remain", /mark_in_review/.test(uiSrc) && /request_customer_action/.test(uiSrc) && /return_to_open/.test(uiSrc));
  assert("40. E2.C tenant remains GET-only", /method !== "GET"/.test(myCasesEndpoint) && !/method:\s*"PATCH"/.test(myCasesSrc + myCasesEndpoint));
  assert("41. invoice resend unaffected", /maybeOfferInvoiceResend/.test(chatSrc));
  assert("42. contract email unaffected", fs.existsSync(path.join(ROOT, "netlify/functions/_lib/mg-support/contract-diagnostic.js")) && /contract/i.test(contractSrc.slice(0, 400)));

  assert("43. RPC name", TRANSITION_RPC === "mg_support_transition_case" && /mg_support_transition_case/.test(sqlSrc));
  assert("44. SECURITY INVOKER", /security invoker/.test(sqlSrc) && !/security definer/.test(sqlSrc));
  assert("45. PUBLIC execute revoked", /revoke execute[\s\S]*from public/i.test(sqlSrc) && /revoke all[\s\S]*from public/i.test(sqlSrc));
  assert("46. anon execute revoked", /revoke execute[\s\S]*from anon/i.test(sqlSrc));
  assert("47. authenticated execute revoked", /revoke execute[\s\S]*from authenticated/i.test(sqlSrc));
  assert("48. service_role execute granted", /grant execute[\s\S]*to service_role/i.test(sqlSrc));
  assert("49. tenant_id is not an RPC input", !/p_tenant_id/.test(sqlSrc) && !UPDATE_BODY_KEYS.has("tenant_id"));
  assert("50. recipient is not an RPC input", !/recipient_email|p_recipient/.test(sqlSrc));
  assert("51. raw target status is not an RPC input", !/p_to_status/.test(sqlSrc));
  assert("52. raw event_type is not an RPC input", !/p_event_type/.test(sqlSrc));
  assert("53. return_to_open maps to null event", /v_event_type := null/.test(sqlSrc) && EVENT_TYPE_BY_ACTION.return_to_open == null);
  assert("54. CAS predicates present", /c.status = p_expected_status/.test(sqlSrc) && /c.status_version = p_expected_status_version/.test(sqlSrc));
  assert("55. version increments in SQL", /status_version = c.status_version \+ 1/.test(sqlSrc));
  assert("56. Node does not PATCH+INSERT", !/tenant_support_notification_outbox/.test(nodeSrc) && (helperSrc.match(/await rpc\(/g) || []).length === 1);
  assert("57. browser API does not expose event_id", !/event_id/.test(updateSrc + uiSrc + htmlSrc));
  assert("58. no historical outbox backfill", !/insert into public\.tenant_support_notification_outbox/.test(sqlSrc.replace(/create or replace function[\s\S]*\$\$;/, "")));
  assert("59. verify SQL is conceptual/read-only", /VERIFY FAIL/.test(verifySrc) && !/\bupdate public\./i.test(verifySrc) && !/\binsert into\b/i.test(verifySrc));
  assert("60. no delivery/claim/sweeper/hmac", !/attempt_count = attempt_count \+ 1/.test(sqlSrc) && !/hmac\(/i.test(sqlSrc + nodeSrc) && !/pg_cron|net\.http|cron\.schedule/i.test(sqlSrc));
  assert("61. same-transaction outbox insert after UPDATE", sqlSrc.indexOf("returning * into v_updated") < sqlSrc.indexOf("insert into public.tenant_support_notification_outbox"));
  assert("62. ON CONFLICT DO NOTHING", /on conflict \(case_id, case_status_version, event_type\)/.test(sqlSrc) && /do nothing/.test(sqlSrc));
  assert("63. waiting validated in SQL before update", sqlSrc.indexOf("request_customer_action") < sqlSrc.indexOf("update public.tenant_support_cases") && /char_length\(v_msg\) > 400/.test(sqlSrc));
  assert("64. Node RPC args omit tenant and event_type", /p_expected_status: current/.test(helperSrc) && !/p_tenant_id/.test(helperSrc) && !/p_event_type/.test(helperSrc));

  const httpDb = makeStore({ status: "open", status_version: 1 });
  const handler = createUpdateHandler({
    readSessionFromEvent: () => ({ e: "admin@example.com", u: ADMIN }),
    isPlatformAdmin: async () => true,
    supabaseGet: httpDb.supabaseGet,
    supabaseRpc: httpDb.supabaseRpc,
  });
  const httpRes = await handler({
    httpMethod: "POST",
    headers: {},
    queryStringParameters: {},
    body: JSON.stringify({ case_id: CASE_ID, action: "mark_in_review" }),
  });
  const httpBody = parse(httpRes);
  assert(
    "65. existing admin HTTP response has no event_id",
    httpRes.statusCode === 200 &&
      httpBody.result === "in_review" &&
      !("event_id" in httpBody) &&
      !("tenant_id" in httpBody) &&
      !("event_queued" in httpBody)
  );

  const returnOk = makeStore({ status: "in_review", status_version: 2 }, { failOutbox: true });
  const returnWithFail = await runAction(returnOk, "return_to_open");
  assert(
    "66. return_to_open succeeds without outbox even if insert would fail",
    returnWithFail.res.result === "returned_to_open" &&
      returnOk.getStored().status === "open" &&
      returnOk.getEvents().length === 0
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
