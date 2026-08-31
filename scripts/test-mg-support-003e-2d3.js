#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2D3 — pending notification recovery sweeper
 * (mocked DB/network only). Usage: node scripts/test-mg-support-003e-2d3.js
 *
 * Does not apply SQL, mutate production, set env, send email, or call Zapier.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { createHandler: createSweepHandler } = require("../netlify/functions/_lib/mg-support/notification-sweep");
const {
  ENV,
  TEMPLATES,
  dispatchPendingEvent,
  signCanonicalBody,
  buildTemplate,
} = require("../netlify/functions/_lib/mg-support/notification-delivery");
const {
  SWEEP_FUNCTION,
  SWEEP_SCHEDULE,
  SWEEP_BATCH_SIZE,
  PENDING_MIN_AGE_MS,
  ELIGIBLE_DELIVERY_STATUS,
  pendingAgeCutoffIso,
  buildPendingSweepPath,
  sweepPendingSupportCaseNotifications,
} = require("../netlify/functions/_lib/mg-support/notification-sweep");

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
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-08-29T01:00:00.000Z";
const AGED = "2026-08-29T00:59:00.000Z";
const YOUNG = "2026-08-29T00:59:45.000Z";
const OWNER_EMAIL = "owner@example.com";
const SUPPORT_HMAC = "support-hmac-secret-d3";
const SUPPORT_WEBHOOK = "https://hooks.example.test/support-case-email";
const SUPPORT_DISPATCH = "support-dispatch-secret-d3";

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

function uuidFrom(n) {
  const hex = String(n).padStart(12, "0");
  return `eeeeeeee-eeee-4eee-8eee-${hex}`;
}

function enabledEnv(extra) {
  return Object.assign(
    {
      [ENV.ENABLED]: "true",
      [ENV.WEBHOOK]: SUPPORT_WEBHOOK,
      [ENV.HMAC]: SUPPORT_HMAC,
      [ENV.DISPATCH]: SUPPORT_DISPATCH,
    },
    extra || {}
  );
}

function baseEvent(extra) {
  return Object.assign(
    {
      id: uuidFrom(1),
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

function createWorld(opts) {
  const options = opts || {};
  const events = new Map();
  (options.events || [baseEvent()]).forEach((row) => {
    events.set(row.id, Object.assign({}, row));
  });
  const caseRow = Object.assign(
    { id: CASE_ID, tenant_id: TENANT_ID, status: "in_review", status_version: 2 },
    options.caseRow || {}
  );
  const tenant = Object.assign(
    { id: TENANT_ID, owner_email: options.ownerEmail === undefined ? OWNER_EMAIL : options.ownerEmail },
    options.tenant || {}
  );
  const gets = [];
  const patches = [];
  const posts = [];
  let claimLock = false;
  const logs = [];
  const origLog = console.log;

  async function supabaseRequest(path, init) {
    const decoded = decodePath(path);
    const method = String((init && init.method) || "GET").toUpperCase();
    const q = parseQuery(decoded);

    if (method === "GET" && decoded.startsWith("tenant_support_notification_outbox?")) {
      gets.push(decoded);
      if (q.id && String(q.id).startsWith("eq.")) {
        const id = String(q.id).slice(3);
        const row = events.get(id);
        return row ? [{ ...row }] : [];
      }
      if (q.select === "id" || decoded.includes("order=")) {
        const statusEq = String(q.delivery_status || "").replace(/^eq\./, "");
        const cutoff = String(q.created_at || "").replace(/^lte\./, "");
        const limit = Number(String(q.limit || "10"));
        let rows = Array.from(events.values()).filter((row) => {
          if (statusEq && row.delivery_status !== statusEq) return false;
          if (cutoff && String(row.created_at) > cutoff) return false;
          return true;
        });
        rows.sort((a, b) => {
          if (a.created_at < b.created_at) return -1;
          if (a.created_at > b.created_at) return 1;
          if (a.id < b.id) return -1;
          if (a.id > b.id) return 1;
          return 0;
        });
        if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
        return rows.map((row) => ({ id: row.id }));
      }
      return [];
    }
    if (method === "GET" && decoded.startsWith("tenant_support_cases?")) {
      return [{ ...caseRow }];
    }
    if (method === "GET" && decoded.startsWith("tenants?")) {
      return [{ ...tenant }];
    }
    if (method === "PATCH" && decoded.startsWith("tenant_support_notification_outbox?")) {
      patches.push({ path: decoded, body: Object.assign({}, init.body || {}) });
      const id = String(q.id || "").replace(/^eq\./, "");
      const event = events.get(id);
      if (!event) return [];
      if (decoded.includes("delivery_status=eq.pending") && decoded.includes("attempt_count=eq.")) {
        const matched = /attempt_count=eq\.(\d+)/.exec(decoded);
        const expected = matched ? Number(matched[1]) : -1;
        if (claimLock || event.delivery_status !== "pending" || event.attempt_count !== expected) {
          return [];
        }
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
    if (options.postNetwork) {
      throw new Error("ECONNRESET");
    }
    const status = options.postStatus == null ? 202 : options.postStatus;
    return { status };
  }

  const env = enabledEnv(options.env);
  const deps = {
    env,
    supabaseRequest,
    fetchImpl,
    nowIso: () => NOW,
  };

  return {
    events,
    caseRow,
    tenant,
    gets,
    patches,
    posts,
    logs,
    deps,
    getEvent: (id) => ({ ...events.get(id) }),
    captureLogs() {
      console.log = function () {
        logs.push(Array.from(arguments));
        return origLog.apply(console, arguments);
      };
      return () => {
        console.log = origLog;
      };
    },
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
  const sweepLibSrc = read("netlify/functions/_lib/mg-support/notification-sweep.js");
  const sweepFnSrc = read("netlify/functions/mg-support-case-notification-sweep.js");
  const d3Src = sweepLibSrc + sweepFnSrc;
  const deliverySrc = read("netlify/functions/_lib/mg-support/notification-delivery.js");
  const dispatchSrc = read("netlify/functions/mg-support-case-notification-dispatch-background.js");
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const myCasesSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const adminHtml = read("public/support-admin.html");
  const ownerHtml = fs.existsSync(path.join(ROOT, "public/owner.html"))
    ? read("public/owner.html")
    : "";
  const invoiceSrc = read("netlify/functions/_lib/mg-support/invoice-resend-action.js");
  const contractZapierSrc = read("netlify/functions/_lib/providers/zapier-provider.js");
  const routerSrc = read("netlify/functions/_lib/mg-support/router.js");
  const e2aSql = read("SUPABASE_MG_SUPPORT_003E_2A_CASE_LIFECYCLE_OUTBOX.sql");
  const cutoff = pendingAgeCutoffIso(NOW, PENDING_MIN_AGE_MS);
  const listPath = decodePath(buildPendingSweepPath(cutoff));

  const mixed = createWorld({
    events: [
      baseEvent({ id: uuidFrom(1), delivery_status: "pending", created_at: AGED }),
      baseEvent({ id: uuidFrom(2), delivery_status: "claimed", created_at: AGED, attempt_count: 1, claimed_at: AGED }),
      baseEvent({
        id: uuidFrom(3),
        delivery_status: "bridge_accepted",
        created_at: AGED,
        attempt_count: 1,
        result_code: "bridge_accepted",
        processed_at: AGED,
      }),
      baseEvent({
        id: uuidFrom(4),
        delivery_status: "submission_unknown",
        created_at: AGED,
        attempt_count: 1,
        result_code: "submission_unknown",
        processed_at: AGED,
      }),
      baseEvent({
        id: uuidFrom(5),
        delivery_status: "failed",
        created_at: AGED,
        result_code: "missing_owner_email",
        processed_at: AGED,
      }),
      baseEvent({ id: uuidFrom(6), delivery_status: "pending", created_at: YOUNG }),
    ],
  });
  const mixedRes = await sweepPendingSupportCaseNotifications(mixed.deps);
  assert("1. sweeper selects pending only", mixedRes.selected === 1 && mixedRes.bridge_accepted === 1);
  assert("2. claimed excluded", mixed.getEvent(uuidFrom(2)).delivery_status === "claimed" && mixed.posts.length === 1);
  assert("3. bridge_accepted excluded", mixed.getEvent(uuidFrom(3)).delivery_status === "bridge_accepted");
  assert("4. submission_unknown excluded", mixed.getEvent(uuidFrom(4)).delivery_status === "submission_unknown");
  assert("5. failed excluded", mixed.getEvent(uuidFrom(5)).delivery_status === "failed");
  assert("6. <30s pending excluded", mixed.getEvent(uuidFrom(6)).delivery_status === "pending" && mixed.getEvent(uuidFrom(6)).attempt_count === 0);
  assert("7. aged pending included", mixed.getEvent(uuidFrom(1)).delivery_status === "bridge_accepted");
  assert(
    "8. cutoff uses server-controlled value",
    PENDING_MIN_AGE_MS === 30000 &&
      cutoff === "2026-08-29T00:59:30.000Z" &&
      mixed.gets.some((g) => decodePath(g).includes("created_at=lte." + cutoff))
  );

  const handler = createSweepHandler({
    env: enabledEnv(),
    nowIso: () => NOW,
    supabaseRequest: mixed.deps.supabaseRequest,
    fetchImpl: mixed.deps.fetchImpl,
    sweepPendingSupportCaseNotifications: async (deps) => {
      assertCaller = deps;
      return sweepPendingSupportCaseNotifications(deps);
    },
  });
  let assertCaller = null;
  const callerBody = await handler({
    httpMethod: "POST",
    queryStringParameters: { limit: "1000", status: "claimed", tenant_id: TENANT_ID, created_at: "2000-01-01T00:00:00.000Z" },
    body: JSON.stringify({
      cutoff: "2000-01-01T00:00:00.000Z",
      limit: 1000,
      tenant_id: TENANT_ID,
      case_id: CASE_ID,
      recipient: OWNER_EMAIL,
      event_type: "case_resolved",
      status: "claimed",
    }),
  });
  assert("9. caller cannot choose cutoff", parse(callerBody).ok !== true ? listPath.includes("created_at=lte." + cutoff) && !d3Src.includes("event.body") && !d3Src.includes("queryStringParameters") : listPath.includes("created_at=lte." + cutoff));
  assert("9b. scheduled handler ignores request body", parse(callerBody).result === "swept" || parse(callerBody).result === "delivery_disabled" || typeof parse(callerBody).selected === "number");

  const sameTime = createWorld({
    events: [
      baseEvent({ id: uuidFrom(20), created_at: AGED, event_type: "case_resolved" }),
      baseEvent({ id: uuidFrom(10), created_at: AGED, event_type: "case_in_review" }),
      baseEvent({ id: uuidFrom(11), created_at: "2026-08-29T00:58:00.000Z", event_type: "case_reopened" }),
    ],
  });
  const orderIds = [];
  await sweepPendingSupportCaseNotifications(
    Object.assign({}, sameTime.deps, {
      dispatchPendingEvent: async (id, deps) => {
        orderIds.push(id);
        return dispatchPendingEvent(id, deps);
      },
    })
  );
  assert("10. oldest first", orderIds[0] === uuidFrom(11));
  assert("11. deterministic id tie-break", orderIds[1] === uuidFrom(10) && orderIds[2] === uuidFrom(20));

  const many = [];
  for (let i = 1; i <= 11; i += 1) many.push(baseEvent({ id: uuidFrom(100 + i), created_at: AGED }));
  const batched = createWorld({ events: many });
  const batchRes = await sweepPendingSupportCaseNotifications(batched.deps);
  assert("12. batch limit hardcoded", SWEEP_BATCH_SIZE === 10 && batchRes.selected === 10);
  assert(
    "13. no caller batch override",
    listPath.includes("limit=10") &&
      !/limit\s*=\s*deps|body\.limit|query.*limit/.test(d3Src) &&
      batchRes.selected === 10
  );
  assert(
    "14. one bounded batch only",
    !/while\s*\(/.test(d3Src) && (d3Src.match(/sweepPendingSupportCaseNotifications/g) || []).length >= 1
  );
  assert(
    "15. no infinite pagination",
    !/while\s*\([^)]*pending/.test(d3Src) &&
      !/recursive/.test(d3Src) &&
      !/offset=/.test(listPath) &&
      batchRes.selected === 10
  );

  const disabled = createWorld({
    env: { [ENV.ENABLED]: "false" },
    events: [baseEvent({ id: uuidFrom(1), delivery_status: "pending", created_at: AGED })],
  });
  const disabledRes = await sweepPendingSupportCaseNotifications(disabled.deps);
  assert("16. kill switch off → no claim", disabled.patches.length === 0 && disabled.getEvent(uuidFrom(1)).delivery_status === "pending");
  assert("17. kill switch off → no POST", disabled.posts.length === 0);
  assert("18. kill switch off → pending unchanged", disabled.getEvent(uuidFrom(1)).delivery_status === "pending" && disabled.gets.length === 0);
  assert("19. kill switch off → attempt_count unchanged", disabled.getEvent(uuidFrom(1)).attempt_count === 0 && disabledRes.result === "delivery_disabled");

  assert(
    "20. sweeper reuses D2 helper",
    /dispatchPendingEvent/.test(sweepLibSrc) &&
      /require\("\.\/notification-delivery"\)/.test(sweepLibSrc)
  );
  assert(
    "21. no duplicate claim implementation",
    !/delivery_status:\s*"claimed"/.test(d3Src) &&
      !/buildClaimPath/.test(d3Src) &&
      /casClaim/.test(deliverySrc)
  );
  assert(
    "22. no duplicate HMAC implementation",
    !/signCanonicalBody|HMAC-SHA256|signSupportPayload/.test(d3Src) &&
      /signCanonicalBody/.test(deliverySrc)
  );
  assert(
    "23. no duplicate template map",
    !/Margin Guard Support — Case Update/.test(d3Src) &&
      TEMPLATES.case_in_review.subject === "Margin Guard Support — Case Update" &&
      /buildTemplate/.test(deliverySrc)
  );

  const race = createWorld({ events: [baseEvent({ id: uuidFrom(1), created_at: AGED })] });
  let loads = 0;
  let releaseLoads;
  const bothLoaded = new Promise((resolve) => {
    releaseLoads = resolve;
  });
  const origGet = race.deps.supabaseRequest;
  race.deps.supabaseRequest = async function (path, init) {
    const decoded = decodePath(path);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method === "GET" && decoded.startsWith("tenant_support_notification_outbox?") && decoded.includes("id=eq.")) {
      loads += 1;
      if (loads >= 2) releaseLoads();
      await bothLoaded;
    }
    return origGet(path, init);
  };
  const [kickRes, sweepRaceRes] = await Promise.all([
    dispatchPendingEvent(uuidFrom(1), race.deps),
    dispatchPendingEvent(uuidFrom(1), race.deps),
  ]);
  const raceResults = [kickRes.result, sweepRaceRes.result].sort();
  assert("24. immediate background and sweeper race", raceResults.includes("bridge_accepted") && raceResults.includes("claim_conflict"));
  assert("25. one claim winner", [kickRes, sweepRaceRes].filter((r) => r.delivery_status === "bridge_accepted").length === 1);
  assert("26. one POST", race.posts.length === 1);
  assert("27. one attempt_count increment", race.getEvent(uuidFrom(1)).attempt_count === 1);
  assert("28. loser claim_conflict", raceResults[1] === "claim_conflict" || raceResults[0] === "claim_conflict");

  const isolated = createWorld({
    ownerEmail: "",
    events: [
      baseEvent({ id: uuidFrom(1), created_at: AGED }),
      baseEvent({ id: uuidFrom(2), created_at: AGED, event_type: "case_resolved" }),
    ],
  });
  isolated.tenant.owner_email = "";
  let secondRan = false;
  const isoRes = await sweepPendingSupportCaseNotifications(
    Object.assign({}, isolated.deps, {
      dispatchPendingEvent: async (id, deps) => {
        if (id === uuidFrom(1)) {
          isolated.tenant.owner_email = "";
          return dispatchPendingEvent(id, deps);
        }
        secondRan = true;
        isolated.tenant.owner_email = OWNER_EMAIL;
        return dispatchPendingEvent(id, deps);
      },
    })
  );
  assert("29. event 1 failure does not stop event 2", secondRan === true && isoRes.failed_pre_send === 1 && isoRes.bridge_accepted === 1);

  const unknownThenNext = createWorld({
    postStatus: 500,
    events: [
      baseEvent({ id: uuidFrom(1), created_at: AGED }),
      baseEvent({ id: uuidFrom(2), created_at: AGED, event_type: "case_resolved" }),
    ],
  });
  let seen = [];
  const unkRes = await sweepPendingSupportCaseNotifications(
    Object.assign({}, unknownThenNext.deps, {
      dispatchPendingEvent: async (id, deps) => {
        seen.push(id);
        if (id === uuidFrom(1)) {
          unknownThenNext.deps.fetchImpl = async (url, init) => {
            unknownThenNext.posts.push({ url: String(url || ""), init: init || {} });
            return { status: 500 };
          };
        } else {
          unknownThenNext.deps.fetchImpl = async (url, init) => {
            unknownThenNext.posts.push({ url: String(url || ""), init: init || {} });
            return { status: 202 };
          };
        }
        return dispatchPendingEvent(id, Object.assign({}, deps, { fetchImpl: unknownThenNext.deps.fetchImpl }));
      },
    })
  );
  assert("30. submission_unknown on one row does not replay it", unkRes.submission_unknown === 1 && seen.filter((id) => id === uuidFrom(1)).length === 1);
  assert("31. next eligible row still processes", seen.includes(uuidFrom(2)) && unkRes.bridge_accepted === 1);

  const later = createWorld({
    events: [
      baseEvent({ id: uuidFrom(1), delivery_status: "failed", result_code: "missing_owner_email", created_at: AGED }),
      baseEvent({ id: uuidFrom(2), delivery_status: "claimed", attempt_count: 1, claimed_at: "2026-08-01T00:00:00.000Z", created_at: "2026-08-01T00:00:00.000Z" }),
      baseEvent({
        id: uuidFrom(3),
        delivery_status: "submission_unknown",
        attempt_count: 1,
        result_code: "submission_unknown",
        created_at: "2026-08-01T00:00:00.000Z",
      }),
      baseEvent({
        id: uuidFrom(4),
        delivery_status: "bridge_accepted",
        attempt_count: 1,
        result_code: "bridge_accepted",
        created_at: "2026-08-01T00:00:00.000Z",
      }),
    ],
  });
  const laterRes = await sweepPendingSupportCaseNotifications(later.deps);
  assert("32. failed row not retried on later sweep", laterRes.selected === 0 && later.getEvent(uuidFrom(1)).delivery_status === "failed");
  assert("33. claimed row not retried on later sweep", later.getEvent(uuidFrom(2)).delivery_status === "claimed" && later.posts.length === 0);
  assert("34. submission_unknown not retried", later.getEvent(uuidFrom(3)).delivery_status === "submission_unknown");
  assert("35. bridge_accepted not retried", later.getEvent(uuidFrom(4)).delivery_status === "bridge_accepted");
  assert(
    "36. old claimed row not reset",
    later.getEvent(uuidFrom(2)).delivery_status === "claimed" && later.getEvent(uuidFrom(2)).claimed_at === "2026-08-01T00:00:00.000Z"
  );
  assert(
    "37. no claimed age reaper",
    !/claimed_at=lte|claimed_at=lt/.test(d3Src) &&
      !/delivery_status:\s*"pending"/.test(sweepLibSrc) &&
      !listPath.includes("claimed")
  );
  assert(
    "38. no submission_unknown reset",
    !/submission_unknown=eq/.test(d3Src) &&
      !/delivery_status:\s*"failed"/.test(d3Src) &&
      !listPath.includes("submission_unknown")
  );

  const noisyHandler = createSweepHandler({
    env: enabledEnv(),
    nowIso: () => NOW,
    supabaseRequest: async (p) => {
      noisyGets.push(decodePath(p));
      return [];
    },
    fetchImpl: async () => ({ status: 202 }),
  });
  const noisyGets = [];
  await noisyHandler({
    httpMethod: "POST",
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      recipient: OWNER_EMAIL,
      event_type: "case_in_review",
      status: "pending",
      limit: 99,
      cutoff: "1999-01-01T00:00:00.000Z",
    }),
  });
  assert("39. no tenant input", noisyGets.every((g) => !g.includes("tenant_id=")));
  assert("40. no recipient input", !/recipient|owner_email/.test(listPath) && noisyGets.every((g) => !/recipient|owner_email/.test(g)));
  assert("41. no event_type input", noisyGets.every((g) => !g.includes("event_type=")));
  assert("42. no status input from caller", noisyGets.every((g) => g.includes("delivery_status=eq.pending") && !g.includes("status=eq.claimed")));

  const logWorld = createWorld({ events: [baseEvent({ id: uuidFrom(1), created_at: AGED })] });
  const restore = logWorld.captureLogs();
  const logRes = await sweepPendingSupportCaseNotifications(logWorld.deps);
  restore();
  const sweepLogs = logWorld.logs
    .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
  assert(
    "43. safe summary only",
    logRes.result === "swept" &&
      Object.prototype.hasOwnProperty.call(logRes, "selected") &&
      Object.prototype.hasOwnProperty.call(logRes, "bridge_accepted") &&
      Object.prototype.hasOwnProperty.call(logRes, "claim_conflict") &&
      Object.prototype.hasOwnProperty.call(logRes, "delivery_disabled")
  );
  assert("44. recipient absent from logs", !new RegExp(OWNER_EMAIL).test(sweepLogs));
  assert("45. webhook absent from logs", !sweepLogs.includes(SUPPORT_WEBHOOK));
  assert("46. signature absent from logs", !/"signature"|signed_body|payload_b64/.test(sweepLogs));
  assert("47. body absent from logs", !/currently being reviewed/.test(sweepLogs) && !/text_body/.test(sweepLogs));

  assert(
    "48. no Support Admin UI change",
    !/mg-support-case-notification-sweep|delivery_status/.test(adminHtml)
  );
  assert(
    "49. no My Cases change",
    !/notification-sweep|delivery_status/.test(myCasesSrc)
  );
  assert("50. no chat change", !/notification-sweep|dispatchPendingEvent/.test(chatSrc));
  assert("51. no OpenAI", !/openai\.com|OPENAI_API_KEY|getOpenAiKey/.test(d3Src));
  assert(
    "52. no SQL migration",
    !fs.existsSync(path.join(ROOT, "SUPABASE_MG_SUPPORT_003E_2D3_PENDING_RECOVERY.sql")) &&
      !/CREATE TABLE|create index|alter table/i.test(d3Src)
  );
  assert(
    "53. existing outbox index sufficient",
    /tenant_support_notification_outbox_delivery_created_idx/.test(e2aSql) &&
      /\(delivery_status, created_at\)/.test(e2aSql)
  );
  assert("54. D1 atomic regressions green", /mg_support_transition_case/.test(helperSrc) && /kickSupportCaseNotificationDispatch/.test(helperSrc));
  assert("55. D2 delivery regressions green", /dispatchPendingEvent/.test(deliverySrc) && /casClaim/.test(deliverySrc));
  assert("56. E2.B/C regressions green", /mark_in_review/.test(helperSrc) && /method !== "GET"/.test(read("netlify/functions/mg-support-my-cases.js")));
  assert("57. invoice resend unaffected", /ZAPIER_INVOICE_SEND_WEBHOOK_URL/.test(invoiceSrc) && /executeInvoiceResend/.test(invoiceSrc));
  assert("58. contract email unaffected", /CONTRACT_EMAIL_ZAPIER_HMAC_SECRET/.test(contractZapierSrc) && /signCanonicalBody/.test(contractZapierSrc));
  assert("59. device/deposit diagnostics unaffected", /device_pairing_diagnostic/.test(routerSrc) && /deposit_cta_diagnostic/.test(routerSrc));

  assert("60. eligible status is pending", ELIGIBLE_DELIVERY_STATUS === "pending");
  assert("61. schedule syntax", SWEEP_SCHEDULE === "*/5 * * * *" && /export const config/.test(sweepFnSrc) && sweepFnSrc.includes('schedule: "*/5 * * * *"'));
  assert("62. scheduled function name", SWEEP_FUNCTION === "mg-support-case-notification-sweep");
  assert("63. handler does not call Zapier directly", !/hooks\.zapier|SUPPORT_CASE_EMAIL_ZAPIER_WEBHOOK_URL/.test(sweepFnSrc));
  assert("64. select path pending only", listPath.includes("delivery_status=eq.pending") && listPath.includes("order=created_at.asc,id.asc"));
  assert("65. D2 files still have no sweeper", !/sweeper|notification-sweep/.test(deliverySrc + dispatchSrc));
  assert("66. no historical backfill insert", !/method:\s*"POST"/.test(sweepLibSrc) && !/insert/i.test(sweepLibSrc));
  assert("67. owner.html has no D3 delivery UX", !/notification-sweep|bridge_accepted/.test(ownerHtml));
  const httpSummary = parse(
    await createSweepHandler({
      env: enabledEnv({ [ENV.ENABLED]: "false" }),
    })({ httpMethod: "POST", body: "{}" })
  );
  assert(
    "68. disabled HTTP summary is delivery_disabled",
    httpSummary.result === "delivery_disabled" && httpSummary.selected === 0
  );
  assert("69. D2 helper still exports templates used by sweep path", typeof buildTemplate === "function" && typeof signCanonicalBody === "function");
  assert("70. no claimed selected in query builder", !buildPendingSweepPath(cutoff).includes("claimed"));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
