#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const depositLib = require("../netlify/functions/_lib/verified-scheduling-deposit");

const QUOTE_ID = "08130740-3e22-47d8-9388-2dc65bf3cf00";
const PROJECT_ID = "1e6ac6bd-5cbe-4dec-8b98-363ecc81e58f";
const TENANT_ID = "tenant-erin";
const TOKEN = "erinpublictoken1";
const SESSION_ID = "cs_test_erin_scheduling_1000";
const CONNECT = "acct_erin_connect";
const CONFIRMED_AT = 1760724000;
const INTENT_CREATED_AT = 1760637600;

function paymentEvidence(options) {
  const settings = options || {};
  const confirmed = settings.confirmed == null ? CONFIRMED_AT : settings.confirmed;
  const charge = {
    id: settings.chargeId || "ch_test_scheduling",
    object: "charge",
    status: settings.chargeStatus || "succeeded",
    created: settings.chargeCreated == null ? confirmed : settings.chargeCreated,
  };
  if (!settings.omitBalance) {
    charge.balance_transaction =
      typeof settings.balanceIdString === "string"
        ? settings.balanceIdString
        : {
            id: "txn_test_scheduling",
            object: "balance_transaction",
            created: confirmed,
          };
  }
  return {
    id: settings.intentId || "pi_test_scheduling",
    object: "payment_intent",
    status: settings.intentStatus || "succeeded",
    created: settings.intentCreated == null ? INTENT_CREATED_AT : settings.intentCreated,
    latest_charge: settings.omitCharge ? undefined : charge,
  };
}

function appliedEvent(overrides) {
  return Object.assign(
    {
      id: "evt-applied",
      tenant_id: TENANT_ID,
      quote_id: QUOTE_ID,
      project_id: PROJECT_ID,
      disposition: "applied",
      checkout_session_id: SESSION_ID,
      gross_amount: 1000,
      applied_payment_id: "pay-erin-1",
    },
    overrides || {}
  );
}

function quote(overrides) {
  return Object.assign(
    {
      id: QUOTE_ID,
      tenant_id: TENANT_ID,
      public_token: TOKEN,
      deposit_required: 1000,
      deposit_paid: false,
      deposit_paid_at: null,
      deposit_paid_amount: null,
      accepted_at: "2026-10-01T00:00:00.000Z",
      exclusions_initials: "ET",
      exclusions_acknowledged_at: "2026-10-01T00:00:00.000Z",
      change_order_acknowledged_at: "2026-10-01T00:00:00.000Z",
      client_name: "Erin",
      client_email: "erin@example.com",
      project_name: "Erin's Master bathroom",
      currency: "usd",
      total: 9114.61,
    },
    overrides || {}
  );
}

function project(overrides) {
  return Object.assign(
    {
      id: PROJECT_ID,
      tenant_id: TENANT_ID,
      quote_id: QUOTE_ID,
      status: "assigned",
      deposit_paid: false,
    },
    overrides || {}
  );
}

function session(overrides) {
  const base = {
    id: SESSION_ID,
    payment_status: "paid",
    status: "complete",
    currency: "usd",
    amount_total: 100000,
    client_reference_id: TOKEN,
    payment_intent: paymentEvidence(),
    metadata: {
      purpose: "project_deposit",
      tenant_id: TENANT_ID,
      quote_id: QUOTE_ID,
      public_token: TOKEN,
    },
  };
  const next = Object.assign({}, base, overrides || {});
  if (overrides && overrides.metadata) {
    next.metadata = Object.assign({}, base.metadata, overrides.metadata);
  }
  return next;
}

function depositRow(overrides) {
  return Object.assign(
    {
      id: "pay-erin-1",
      tenant_id: TENANT_ID,
      quote_id: QUOTE_ID,
      project_id: PROJECT_ID,
      payment_type: "deposit",
      payment_method: "stripe",
      amount: 1000,
      paid_at: "2026-10-17",
      idempotency_key: SESSION_ID,
    },
    overrides || {}
  );
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function paidView() {
  return depositLib.classifySchedulingDeposit({
    quote: quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000 }),
    projects: [project({ deposit_paid: true })],
    payments: [depositRow()],
    readError: false,
  });
}

ok("ledger gross 1000 is paid", paidView().state === "paid");
ok(
  "flags without a ledger row stay pending",
  depositLib.classifySchedulingDeposit({
    quote: quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000, deposit_paid: false }),
    projects: [project()],
    payments: [],
    readError: false,
  }).state === "pending"
);
ok(
  "read failure is unavailable",
  depositLib.classifySchedulingDeposit({
    quote: quote(),
    projects: [],
    payments: [],
    readError: true,
  }).state === "unavailable"
);
ok(
  "step 4 completed only from verified paid",
  depositLib.publicStep4Presentation("paid", true).status === "Completed" &&
    depositLib.publicStep4Presentation("paid", true).showPaid === true &&
    depositLib.publicStep4Presentation("paid", true).offerCheckout === false
);
ok(
  "forged client state is not a presentation input",
  depositLib.publicStep4Presentation("unpaid", true).showPaid === false &&
    depositLib.publicStep4Presentation("pending", true).offerCheckout === false &&
    depositLib.publicStep4Presentation("unavailable", true).status === "Verification pending"
);
ok(
  "unavailable does not open checkout or show paid",
  depositLib.publicStep4Presentation("unavailable", true).offerCheckout === false &&
    depositLib.publicStep4Presentation("unavailable", true).showPaid === false &&
    depositLib.publicStep4Presentation("", true).offerCheckout === false &&
    depositLib.publicStep4Presentation("", true).showPaid === false
);
ok(
  "unpaid is the only checkout state",
  depositLib.classifySchedulingDeposit({
    quote: quote(),
    projects: [project()],
    payments: [],
    readError: false,
  }).state === "unpaid" && depositLib.publicStep4Presentation("unpaid", true).offerCheckout === true
);
ok(
  "two qualifying deposits stay pending for reconciliation",
  depositLib.classifySchedulingDeposit({
    quote: quote(),
    projects: [project()],
    payments: [
      depositRow({ id: "pay-a", idempotency_key: "cs_test_race_a" }),
      depositRow({ id: "pay-b", idempotency_key: "cs_test_race_b" }),
    ],
    readError: false,
  }).state === "pending"
);
const ownerAdditional = depositRow({
  id: "pay-owner-additional",
  payment_method: "check",
  idempotency_key: "owner-deposit-2",
  amount: 250,
  paid_at: "2026-10-18",
  created_by: "owner",
});
const completedWithOwner = depositLib.classifySchedulingDeposit({
  quote: quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000 }),
  projects: [project({ deposit_paid: true })],
  payments: [depositRow(), ownerAdditional],
  events: [
    appliedEvent(),
    {
      tenant_id: TENANT_ID,
      quote_id: QUOTE_ID,
      project_id: PROJECT_ID,
      disposition: "needs_review",
      checkout_session_id: "cs_test_extra_review",
      gross_amount: 1000,
      applied_payment_id: null,
    },
  ],
});
ok(
  "owner additional deposit stays completed",
  completedWithOwner.state === "paid" &&
    depositLib.publicStep4Presentation(completedWithOwner.state, true).status === "Completed" &&
    depositLib.publicStep4Presentation(completedWithOwner.state, true).offerCheckout === false
);
ok(
  "manual stripe entry is not a second scheduling credit",
  depositLib.classifySchedulingDeposit({
    quote: quote(),
    projects: [project()],
    payments: [
      depositRow(),
      depositRow({
        id: "pay-owner-same",
        payment_method: "stripe",
        idempotency_key: "owner-manual-stripe",
        amount: 1000,
        paid_at: "2026-10-19",
        created_by: "owner",
      }),
    ],
    events: [appliedEvent()],
  }).state === "paid"
);
const secondScheduling = depositLib.classifySchedulingDeposit({
  quote: quote(),
  projects: [project()],
  payments: [
    depositRow(),
    depositRow({ id: "pay-second-cs", idempotency_key: "cs_test_second_credit", amount: 1000 }),
  ],
  events: [appliedEvent()],
});
ok(
  "second stripe scheduling credit stays pending",
  secondScheduling.state === "pending" &&
    depositLib.publicStep4Presentation(secondScheduling.state, true).offerCheckout === false
);
ok(
  "applied event without matching ledger stays pending",
  depositLib.classifySchedulingDeposit({
    quote: quote(),
    projects: [project()],
    payments: [depositRow()],
    events: [appliedEvent({ applied_payment_id: "pay-missing" })],
  }).state === "pending"
);
ok(
  "additional deposit without an applied event stays pending",
  depositLib.classifySchedulingDeposit({
    quote: quote(),
    projects: [project()],
    payments: [depositRow(), ownerAdditional],
    events: [],
  }).state === "pending"
);
ok(
  "null-quote deposit beside a scheduling credit stays pending",
  depositLib.classifySchedulingDeposit({
    quote: quote(),
    projects: [project()],
    payments: [
      depositRow(),
      depositRow({
        id: "pay-legacy-mix",
        quote_id: null,
        idempotency_key: null,
        payment_method: "cash",
        amount: 500,
        paid_at: "2026-10-01",
      }),
    ],
    events: [appliedEvent()],
  }).state === "pending"
);
ok(
  "intent creation time is not a confirmed payment time",
  depositLib.stripePaidAt(
    session({
      payment_intent: {
        id: "pi_created_only",
        object: "payment_intent",
        status: "succeeded",
        created: INTENT_CREATED_AT,
      },
    })
  ) === ""
);
ok(
  "pending charge is not a confirmed payment time",
  depositLib.stripePaidAt(session({ payment_intent: paymentEvidence({ chargeStatus: "pending", omitBalance: true }) })) === ""
);
ok(
  "unexpanded balance transaction is not a confirmed payment time",
  depositLib.stripePaidAt(session({ payment_intent: paymentEvidence({ balanceIdString: "txn_unexpanded" }) })) === ""
);
const immediateIso = "2026-10-17T18:00:05.000Z";
const immediateSeconds = Date.parse(immediateIso) / 1000;
ok(
  "immediate card uses the shared confirmed time",
  depositLib.stripePaidAt(
    session({
      payment_intent: paymentEvidence({
        confirmed: immediateSeconds,
        intentCreated: immediateSeconds,
        chargeCreated: immediateSeconds,
      }),
    })
  ) === immediateIso
);
const delayedIso = "2026-10-21T16:30:00.000Z";
ok(
  "delayed payment uses the balance transaction time",
  depositLib.stripePaidAt(
    session({
      payment_intent: paymentEvidence({
        intentCreated: Date.parse("2026-10-13T18:00:00.000Z") / 1000,
        chargeCreated: Date.parse("2026-10-14T18:00:00.000Z") / 1000,
        confirmed: Date.parse(delayedIso) / 1000,
      }),
    })
  ) === delayedIso &&
    depositLib.stripePaidAt(session()) === new Date(CONFIRMED_AT * 1000).toISOString() &&
    depositLib.stripePaidAt(session()) !== new Date(INTENT_CREATED_AT * 1000).toISOString()
);

const html = fs.readFileSync(path.join(ROOT, "public/estimate-public.html"), "utf8");
const builder = fs.readFileSync(path.join(ROOT, "public/js/estimate-builder.js"), "utf8");
ok("public page does not trust deposit=paid", !html.includes('get("deposit")') && !html.includes("mg_deposit_paid_"));
ok("workflow does not trust localStorage payment flag", !builder.includes("mg_deposit_paid_"));
ok(
  "workflow step 4 reads server verification",
  builder.includes('verificationState === "paid"') && html.includes("deposit_verification_state")
);

function installHandler(rel, mocks) {
  const adminPath = require.resolve("../netlify/functions/_lib/supabase-admin");
  const autoPath = require.resolve("../netlify/functions/_lib/deposit-post-automation");
  const handlerPath = require.resolve(rel);
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: {
      supabaseRequest: mocks.supabaseRequest,
      getSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "service" }),
    },
  };
  require.cache[autoPath] = {
    id: autoPath,
    filename: autoPath,
    loaded: true,
    exports: { runDepositPostAutomation: mocks.runDepositPostAutomation },
  };
  delete require.cache[handlerPath];
  delete require.cache[require.resolve("../netlify/functions/_lib/tenant-display")];
  return require(handlerPath).handler;
}

function restore(rel) {
  const handlerPath = require.resolve(rel);
  delete require.cache[handlerPath];
  delete require.cache[require.resolve("../netlify/functions/_lib/supabase-admin")];
  delete require.cache[require.resolve("../netlify/functions/_lib/deposit-post-automation")];
  delete require.cache[require.resolve("../netlify/functions/_lib/tenant-display")];
}

async function main() {
  const db = {
    quote: quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000 }),
    project: project(),
    payments: [],
    quotePatchError: null,
    projectPatchError: null,
    inserts: [],
    quotePatches: [],
    projectPatches: [],
    emails: [],
    events: [],
    rpcThrowRemaining: 0,
    stripeCalls: [],
    invoiceWrites: 0,
    projectInserts: 0,
    automationThrows: false,
    paymentsReadError: null,
    holdPaymentReads: 0,
    paymentReadTarget: 0,
    paymentReadWaiters: 0,
    paymentReadGate: null,
    releasePaymentReads: null,
    holdPaymentInserts: 0,
    paymentInsertTarget: 0,
    paymentInsertWaiters: 0,
    paymentInsertGate: null,
    releasePaymentInserts: null,
    waitForBothInserts: false,
    insertsCompleted: 0,
    insertsDoneGate: null,
    releaseInsertsDone: null,
  };

  function armConcurrentReadsAndInserts(count, waitForBothInserts) {
    db.holdPaymentReads = count;
    db.paymentReadTarget = count;
    db.paymentReadWaiters = 0;
    db.paymentReadGate = new Promise((resolve) => {
      db.releasePaymentReads = resolve;
    });
    db.holdPaymentInserts = count;
    db.paymentInsertTarget = count;
    db.paymentInsertWaiters = 0;
    db.paymentInsertGate = new Promise((resolve) => {
      db.releasePaymentInserts = resolve;
    });
    db.waitForBothInserts = waitForBothInserts === true;
    db.insertsCompleted = 0;
    db.releaseInsertsDone = null;
    db.insertsDoneGate = waitForBothInserts
      ? new Promise((resolve) => {
          db.releaseInsertsDone = resolve;
        })
      : null;
  }

  function resetLedger(quoteOverrides, projectOverrides) {
    db.payments = [];
    db.inserts = [];
    db.emails = [];
    db.events = [];
    db.rpcThrowRemaining = 0;
    db.quotePatches = [];
    db.projectPatches = [];
    db.quotePatchError = null;
    db.projectPatchError = null;
    db.automationThrows = false;
    db.paymentsReadError = null;
    db.holdPaymentReads = 0;
    db.holdPaymentInserts = 0;
    db.waitForBothInserts = false;
    db.quote = quote(quoteOverrides);
    db.project = project(projectOverrides);
  }

  let quoteLock = Promise.resolve();
  function withQuoteLock(work) {
    const run = quoteLock.then(work, work);
    quoteLock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async function supabaseRequest(pathQuery, options) {
    const method = (options && options.method) || "GET";
    const query = String(pathQuery || "");
    if (query.startsWith("invoices") || query.includes("/invoices")) {
      db.invoiceWrites += 1;
      throw new Error("invoice write is out of scope");
    }
    if (method === "GET" && query.startsWith("quotes?public_token=")) return [db.quote];
    if (method === "GET" && query.startsWith("quotes?id=")) return [db.quote];
    if (method === "GET" && query.startsWith("tenants?")) {
      return [{ id: TENANT_ID, stripe_account_id: CONNECT, stripe_charges_enabled: true, name: "Three Colors" }];
    }
    if (method === "GET" && query.startsWith("tenant_projects?")) return [db.project];
    if (method === "GET" && query.startsWith("tenant_project_payments?") && query.includes("idempotency_key=")) {
      return db.payments.filter((row) => query.includes(encodeURIComponent(row.idempotency_key)));
    }
    if (method === "GET" && query.startsWith("tenant_project_payments?")) {
      if (db.paymentsReadError) throw new Error(db.paymentsReadError);
      if (db.holdPaymentReads > 0) {
        db.holdPaymentReads -= 1;
        db.paymentReadWaiters += 1;
        if (db.paymentReadWaiters >= db.paymentReadTarget && db.releasePaymentReads) db.releasePaymentReads();
        await db.paymentReadGate;
        return db.payments.slice();
      }
      if (db.waitForBothInserts) await db.insertsDoneGate;
      return db.payments.slice();
    }
    if (method === "GET" && query.startsWith("stripe_scheduling_deposit_events?")) {
      return db.events.filter((row) => query.includes("quote_id=eq." + encodeURIComponent(row.quote_id)));
    }
    if (method === "GET" && query.startsWith("tenant_snapshots")) return [];
    if (method === "GET" && query.startsWith("tenant_branding")) return [];
    if (method === "GET" && query.startsWith("owner_settings")) return [];
    if (method === "GET" && query.startsWith("tenant_legal_profiles")) return [];
    if (method === "POST" && query === "rpc/record_verified_scheduling_deposit") {
      if (db.rpcThrowRemaining > 0) {
        db.rpcThrowRemaining -= 1;
        throw new Error("rpc crashed before commit");
      }
      const body = options.body || {};
      return withQuoteLock(async () => {
        const sessionId = String(body.p_checkout_session_id || "");
        const gross = Number(body.p_gross_amount);
        const existingEvent = db.events.find((row) => row.checkout_session_id === sessionId);
        if (existingEvent) {
          return {
            ok: true,
            outcome: "already_recorded",
            disposition: existingEvent.disposition,
            event_id: existingEvent.id,
            payment_id: existingEvent.applied_payment_id,
            gross_amount: existingEvent.gross_amount,
            paid_at: body.p_paid_at,
          };
        }
        const blocking = db.payments.some(
          (row) =>
            row.payment_type === "deposit" &&
            Number(row.amount) > 0 &&
            String(row.idempotency_key || "") !== sessionId &&
            (row.quote_id === body.p_quote_id || (row.project_id === body.p_project_id && row.quote_id == null))
        );
        const applied = db.events.find((row) => row.disposition === "applied" && row.quote_id === body.p_quote_id);
        const samePayment = db.payments.find((row) => row.idempotency_key === sessionId);
        if (applied || blocking || (samePayment && applied)) {
          const event = {
            id: "evt-" + (db.events.length + 1),
            tenant_id: body.p_tenant_id,
            quote_id: body.p_quote_id,
            project_id: body.p_project_id,
            checkout_session_id: sessionId,
            disposition: "needs_review",
            gross_amount: gross,
            applied_payment_id: null,
          };
          db.events.push(event);
          return {
            ok: true,
            outcome: "needs_review",
            disposition: "needs_review",
            event_id: event.id,
            payment_id: null,
            gross_amount: gross,
            paid_at: body.p_paid_at,
          };
        }
        const payment = {
          id: "pay-" + (db.payments.length + 1),
          tenant_id: body.p_tenant_id,
          quote_id: body.p_quote_id,
          project_id: body.p_project_id,
          payment_type: "deposit",
          payment_method: "stripe",
          amount: gross,
          paid_at: body.p_paid_at,
          idempotency_key: sessionId,
          invoice_id: null,
        };
        db.payments.push(payment);
        db.inserts.push(payment);
        const event = {
          id: "evt-" + (db.events.length + 1),
          tenant_id: body.p_tenant_id,
          quote_id: body.p_quote_id,
          project_id: body.p_project_id,
          checkout_session_id: sessionId,
          disposition: "applied",
          gross_amount: gross,
          applied_payment_id: payment.id,
        };
        db.events.push(event);
        db.quote = Object.assign({}, db.quote, {
          deposit_paid: true,
          deposit_paid_amount: gross,
          deposit_paid_at: db.quote.deposit_paid_at || body.p_paid_at,
        });
        const signed = String(db.project.status || "").toLowerCase() === "signed";
        db.project = Object.assign({}, db.project, {
          deposit_paid: true,
          status: signed ? "deposit_paid" : db.project.status,
        });
        db.quotePatches.push({ deposit_paid_at: db.quote.deposit_paid_at });
        db.projectPatches.push(
          signed ? { status: "deposit_paid", deposit_paid: true } : { deposit_paid: true }
        );
        return {
          ok: true,
          outcome: "applied_new",
          disposition: "applied",
          event_id: event.id,
          payment_id: payment.id,
          gross_amount: gross,
          paid_at: body.p_paid_at,
        };
      });
    }
    if (method === "POST" && query === "tenant_project_payments") {
      if (db.holdPaymentInserts > 0) {
        db.holdPaymentInserts -= 1;
        db.paymentInsertWaiters += 1;
        if (db.paymentInsertWaiters >= db.paymentInsertTarget && db.releasePaymentInserts) {
          db.releasePaymentInserts();
        }
        await db.paymentInsertGate;
      }
      const body = options.body || {};
      if (db.payments.some((row) => row.idempotency_key === body.idempotency_key)) {
        const err = new Error("duplicate key value violates unique constraint");
        err.status = 409;
        throw err;
      }
      const row = Object.assign({ id: "pay-" + (db.payments.length + 1) }, body);
      db.payments.push(row);
      db.inserts.push(body);
      db.insertsCompleted += 1;
      if (db.releaseInsertsDone && db.insertsCompleted >= 2) db.releaseInsertsDone();
      return [row];
    }
    if (method === "POST" && query === "tenant_projects") {
      db.projectInserts += 1;
      throw new Error("project insert is out of scope");
    }
    if (method === "PATCH" && query.startsWith("quotes?")) {
      db.quotePatches.push(options.body);
      if (db.quotePatchError) throw new Error(db.quotePatchError);
      db.quote = Object.assign({}, db.quote, options.body);
      return [db.quote];
    }
    if (method === "PATCH" && query.startsWith("tenant_projects?")) {
      db.projectPatches.push(options.body);
      if (db.projectPatchError) throw new Error(db.projectPatchError);
      db.project = Object.assign({}, db.project, options.body);
      return [db.project];
    }
    return [];
  }

  function stripeFetch(sessionBody, options) {
    return async function fetchImpl(url, init) {
      db.stripeCalls.push({ url: String(url), headers: (init && init.headers) || {} });
      const headers = (init && init.headers) || {};
      if (headers["Stripe-Account"] !== CONNECT) {
        return { ok: false, status: 404, text: async () => "{\"error\":{\"message\":\"No such checkout.session\"}}" };
      }
      if (options && options.failConnect) {
        return { ok: false, status: 404, text: async () => "{\"error\":{\"message\":\"No such checkout.session\"}}" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(sessionBody),
      };
    };
  }

  const finalizePath = "../netlify/functions/finalize-project-deposit.js";
  const createPath = "../netlify/functions/create-project-deposit-session.js";
  const publicPath = "../netlify/functions/get-public-estimate.js";
  const originalFetch = global.fetch;
  process.env.STRIPE_SECRET_KEY = "sk_test_deposit_sync";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.URL = "https://example.test";

  function finalizeHandler() {
    return installHandler(finalizePath, {
      supabaseRequest,
      runDepositPostAutomation: async (payload) => {
        db.emails.push(payload);
        if (db.automationThrows) throw new Error("smtp down");
      },
    });
  }

  async function postFinalize(sessionBody, token) {
    global.fetch = stripeFetch(sessionBody);
    const handler = finalizeHandler();
    const res = await handler({
      httpMethod: "POST",
      body: JSON.stringify({ sessionId: sessionBody.id, public_token: token == null ? TOKEN : token }),
    });
    restore(finalizePath);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  let result = await postFinalize(session({ payment_status: "unpaid", status: "complete" }));
  ok("complete but unpaid is rejected", result.status === 400 && result.body.code === "stripe_not_paid");
  ok("unpaid session writes nothing", db.inserts.length === 0 && db.emails.length === 0);

  result = await postFinalize(session({ metadata: { tenant_id: "other-tenant" } }));
  ok("wrong tenant is rejected", result.status === 403 && result.body.code === "stripe_quote_mismatch");

  result = await postFinalize(session({ metadata: { quote_id: "other-quote" } }));
  ok("wrong quote is rejected", result.status === 403);

  result = await postFinalize(session(), "different-token");
  ok("supplied token must match the session", result.status === 403 && result.body.code === "stripe_token_mismatch");

  result = await postFinalize(session({ metadata: { purpose: "invoice" } }));
  ok("wrong purpose is rejected", result.status === 403 && result.body.code === "stripe_purpose_mismatch");

  result = await postFinalize(session({ currency: "eur" }));
  ok("non-usd currency is rejected", result.status === 400 && result.body.code === "stripe_currency_mismatch");

  result = await postFinalize(session({ amount_total: 97070 }));
  ok("net amount is rejected", result.status === 400 && result.body.code === "stripe_amount_mismatch");
  ok("still one project and no ledger", db.projectInserts === 0 && db.inserts.length === 0 && db.invoiceWrites === 0);

  result = await postFinalize(
    session({
      id: "cs_test_intent_created_only",
      payment_intent: {
        id: "pi_created_only",
        object: "payment_intent",
        status: "succeeded",
        created: INTENT_CREATED_AT,
      },
    })
  );
  ok(
    "intent creation time does not record a deposit",
    result.status === 422 &&
      result.body.code === "stripe_paid_at_missing" &&
      db.payments.length === 0 &&
      db.events.length === 0 &&
      db.emails.length === 0
  );

  global.fetch = stripeFetch(session(), { failConnect: true });
  let handler = finalizeHandler();
  result = JSON.parse(
    (
      await handler({
        httpMethod: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, public_token: TOKEN }),
      })
    ).body
  );
  restore(finalizePath);
  ok("connect failure does not fall back to the platform", result.ok !== true && db.stripeCalls.every((call) => call.headers["Stripe-Account"] === CONNECT));

  db.stripeCalls = [];
  result = await postFinalize(session());
  ok("verified deposit returns paid", result.status === 200 && result.body.ok === true && result.body.paid_amount === 1000);
  ok("ledger credits gross 1000 once", db.inserts.length === 1 && db.inserts[0].amount === 1000 && db.inserts[0].idempotency_key === SESSION_ID);
  ok("ledger is deposit stripe on the existing project", db.inserts[0].payment_type === "deposit" && db.inserts[0].payment_method === "stripe" && db.inserts[0].project_id === PROJECT_ID && db.inserts[0].quote_id === QUOTE_ID && db.inserts[0].tenant_id === TENANT_ID);
  ok("assigned project stays assigned", db.project.status === "assigned" && db.project.deposit_paid === true && !Object.prototype.hasOwnProperty.call(db.projectPatches[0], "status"));
  ok("quote paid flag is set and the original timestamp stays", db.quote.deposit_paid === true && db.quote.deposit_paid_at === "2026-10-17" && db.quote.deposit_paid_amount === 1000 && db.quote.total === 9114.61);
  ok("ledger credits the confirmed charge time", db.payments[0].paid_at === new Date(CONFIRMED_AT * 1000).toISOString());
  ok("ledger does not use payment intent creation", db.payments[0].paid_at !== new Date(INTENT_CREATED_AT * 1000).toISOString());
  ok(
    "stripe retrieve expands the confirmed charge",
    db.stripeCalls[0].url.includes("expand[]=payment_intent.latest_charge.balance_transaction")
  );
  ok("Erin reconciliation does not email", db.emails.length === 0);
  ok("stripe retrieve used the connect account", db.stripeCalls.length === 1 && db.stripeCalls[0].headers["Stripe-Account"] === CONNECT);

  const insertsAfterFirst = db.inserts.length;
  const patchesAfterFirst = db.quotePatches.length;
  result = await postFinalize(session());
  ok(
    "same-session applied replay succeeds",
    result.status === 200 &&
      result.body.ok === true &&
      result.body.replay === true &&
      result.body.deposit_verification_state === "paid" &&
      result.body.code !== "deposit_needs_review"
  );
  ok("replay does not insert another ledger row or email", db.inserts.length === insertsAfterFirst && db.emails.length === 0 && db.payments.length === 1);
  ok("replay does not create a project or invoice", db.projectInserts === 0 && db.invoiceWrites === 0);
  ok("replay keeps the quote timestamp", db.quote.deposit_paid_at === "2026-10-17");
  void patchesAfterFirst;

  result = await postFinalize(session({ id: "cs_test_second_session" }));
  ok(
    "a second session is kept for review without a second credit",
    result.status === 409 &&
      result.body.ok === false &&
      result.body.code === "deposit_needs_review" &&
      result.body.paid_amount == null &&
      result.body.deposit_verification_state !== "paid" &&
      db.payments.length === 1 &&
      db.emails.length === 0 &&
      db.events.filter((row) => row.disposition === "needs_review").length === 1
  );
  result = await postFinalize(session({ id: "cs_test_second_session" }));
  ok(
    "replay of a needs_review session is not reported as credited",
    result.status === 409 &&
      result.body.ok === false &&
      result.body.code === "deposit_needs_review" &&
      result.body.paid_amount == null &&
      result.body.deposit_verification_state !== "paid" &&
      db.payments.length === 1 &&
      db.emails.length === 0 &&
      db.events.filter((row) => row.disposition === "needs_review").length === 1
  );
  db.events.push({
    id: "evt-applied-without-payment",
    tenant_id: TENANT_ID,
    quote_id: QUOTE_ID,
    project_id: PROJECT_ID,
    checkout_session_id: "cs_test_applied_without_payment",
    disposition: "applied",
    gross_amount: 1000,
    applied_payment_id: null,
  });
  result = await postFinalize(session({ id: "cs_test_applied_without_payment" }));
  ok(
    "applied result without a payment reference is not credited",
    result.status === 409 &&
      result.body.ok === false &&
      result.body.code === "deposit_conflict" &&
      result.body.deposit_verification_state !== "paid" &&
      db.payments.length === 1 &&
      db.emails.length === 0
  );

  db.payments = [];
  db.inserts = [];
  db.events = [];
  db.emails = [];
  db.quote = quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000, deposit_paid: false });
  db.project = project();
  db.rpcThrowRemaining = 1;
  result = await postFinalize(session());
  ok(
    "crash before the atomic commit is not complete",
    result.status === 500 && result.body.code === "deposit_ledger_failed" && db.payments.length === 0 && db.emails.length === 0
  );
  result = await postFinalize(session());
  ok(
    "retry after a pre-commit crash applies one credit and does not email",
    result.status === 200 &&
      db.payments.length === 1 &&
      db.emails.length === 0 &&
      db.quote.deposit_paid === true &&
      db.quote.deposit_paid_at === "2026-10-17" &&
      db.project.status === "assigned"
  );

  db.payments = [];
  db.inserts = [];
  db.emails = [];
  db.events = [];
  db.quote = quote();
  db.project = project({ status: "signed", deposit_paid: false });
  db.quotePatches = [];
  db.projectPatches = [];
  result = await postFinalize(session({ id: "cs_test_new_signed" }));
  ok("new payment emails once", result.status === 200 && db.emails.length === 1 && db.emails[0].payment.amount === 1000);
  ok("signed project uses the deposit_paid transition", db.project.status === "deposit_paid" && db.project.deposit_paid === true);
  const emailCount = db.emails.length;
  result = await postFinalize(session({ id: "cs_test_new_signed" }));
  ok("replay of a new payment does not email again", result.body.replay === true && result.body.ok === true && db.emails.length === emailCount && db.inserts.length === 1);
  result = await postFinalize(session({ id: "cs_test_review_after_applied" }));
  ok(
    "applied credit plus a new review session does not credit or email again",
    result.status === 409 &&
      result.body.code === "deposit_needs_review" &&
      result.body.ok === false &&
      db.payments.length === 1 &&
      db.emails.length === emailCount
  );
  result = await postFinalize(session({ id: "cs_test_review_after_applied" }));
  ok(
    "replay after an applied credit does not repeat the review email or credit",
    result.status === 409 &&
      result.body.code === "deposit_needs_review" &&
      result.body.ok === false &&
      result.body.paid_amount == null &&
      db.payments.length === 1 &&
      db.emails.length === emailCount &&
      db.events.filter((row) => row.disposition === "applied").length === 1 &&
      db.events.filter((row) => row.disposition === "needs_review").length === 1
  );

  resetLedger({ deposit_paid_at: null }, { status: "assigned", deposit_paid: false });
  db.payments = [
    depositRow({
      id: "pay-manual",
      payment_method: "check",
      idempotency_key: "manual-key-1",
      amount: 1000,
      paid_at: "2026-10-01",
    }),
  ];
  result = await postFinalize(session({ id: "cs_test_after_manual" }));
  ok(
    "existing manual deposit blocks a second credit and keeps the Stripe charge for review",
    result.status === 409 &&
      result.body.code === "deposit_needs_review" &&
      db.payments.length === 1 &&
      db.payments[0].id === "pay-manual" &&
      db.events.length === 1 &&
      db.events[0].disposition === "needs_review" &&
      db.emails.length === 0
  );

  resetLedger(null, { status: "assigned", deposit_paid: false });
  db.payments = [
    depositRow({
      id: "pay-legacy",
      quote_id: null,
      idempotency_key: null,
      payment_method: "cash",
      amount: 500,
    }),
  ];
  result = await postFinalize(session({ id: "cs_test_after_legacy" }));
  ok(
    "legacy null-quote deposit is not double credited",
    result.status === 409 &&
      result.body.code === "deposit_needs_review" &&
      db.payments.length === 1 &&
      db.payments[0].id === "pay-legacy" &&
      db.events[0].disposition === "needs_review" &&
      db.emails.length === 0
  );

  ok(
    "applied credit plus needs_review stays completed",
    depositLib.classifySchedulingDeposit({
      quote: quote(),
      projects: [project()],
      payments: [depositRow(), ownerAdditional],
      events: [
        appliedEvent(),
        {
          tenant_id: TENANT_ID,
          quote_id: QUOTE_ID,
          disposition: "needs_review",
          checkout_session_id: "cs_test_extra",
          gross_amount: 1000,
        },
      ],
    }).state === "paid" &&
      depositLib.publicStep4Presentation("paid", true).status === "Completed" &&
      depositLib.publicStep4Presentation("paid", true).offerCheckout === false
  );
  ok(
    "review evidence without a credit stays pending",
    depositLib.classifySchedulingDeposit({
      quote: quote(),
      projects: [project()],
      payments: [],
      events: [
        {
          tenant_id: TENANT_ID,
          quote_id: QUOTE_ID,
          disposition: "needs_review",
          checkout_session_id: "cs_test_unapplied",
        },
      ],
    }).state === "pending" && depositLib.publicStep4Presentation("pending", true).offerCheckout === false
  );

  resetLedger(null, { status: "signed", deposit_paid: false });
  db.automationThrows = true;
  result = await postFinalize(session({ id: "cs_test_email_failure" }));
  ok(
    "email failure still confirms the single credit",
    result.status === 200 && db.payments.length === 1 && db.emails.length === 1
  );
  db.automationThrows = false;
  result = await postFinalize(session({ id: "cs_test_email_failure" }));
  ok(
    "retry after email failure does not send another email",
    result.body.replay === true && db.emails.length === 1 && db.payments.length === 1
  );

  async function finalizePair(sessionIds) {
    const sessionsById = {};
    sessionIds.forEach((id) => {
      sessionsById[id] = session({ id });
    });
    global.fetch = async function concurrentFetch(url, init) {
      const headers = (init && init.headers) || {};
      const rawId = decodeURIComponent(String(url).split("/").pop());
      const id = rawId.split("?")[0];
      db.stripeCalls.push({ url: String(url), headers });
      if (headers["Stripe-Account"] !== CONNECT || !sessionsById[id]) {
        return { ok: false, status: 404, text: async () => "{}" };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(sessionsById[id]) };
    };
    const pairedHandler = finalizeHandler();
    const responses = await Promise.all(
      sessionIds.map((id) =>
        pairedHandler({
          httpMethod: "POST",
          body: JSON.stringify({ sessionId: id, public_token: TOKEN }),
        })
      )
    );
    restore(finalizePath);
    return responses.map((res) => ({ status: res.statusCode, body: JSON.parse(res.body) }));
  }

  resetLedger({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000 }, { status: "assigned" });
  let pair = await finalizePair(["cs_test_erin_parallel", "cs_test_erin_parallel"]);
  ok("simultaneous Erin finalize keeps one ledger row", db.payments.length === 1 && db.inserts.length === 1);
  ok(
    "already recorded Erin payment sends no confirmation",
    db.emails.length === 0 && pair.every((item) => item.status === 200 && item.body.ok === true)
  );
  ok(
    "Erin parallel retry preserves assigned and original timestamp",
    db.project.status === "assigned" && db.quote.deposit_paid_at === "2026-10-17" && db.quote.total === 9114.61
  );

  resetLedger(null, { status: "assigned", deposit_paid: false });
  pair = await finalizePair(["cs_test_same_parallel", "cs_test_same_parallel"]);
  ok(
    "simultaneous same-session finalize sends one confirmation",
    db.emails.length === 1 && db.payments.length === 1 && pair.filter((item) => item.body.replay === true).length === 1
  );
  ok(
    "simultaneous same-session finalize does not create a second credit",
    db.inserts.length === 1 && pair.every((item) => item.status === 200 && item.body.ok === true)
  );

  resetLedger(null, { status: "assigned", deposit_paid: false });
  pair = await finalizePair(["cs_test_race_a", "cs_test_race_b"]);
  ok(
    "two different paid sessions produce one credit and one review event",
    db.payments.length === 1 &&
      db.events.filter((row) => row.disposition === "applied").length === 1 &&
      db.events.filter((row) => row.disposition === "needs_review").length === 1
  );
  ok(
    "different-session race credits once and sends one confirmation",
    pair.filter((item) => item.status === 200 && item.body.ok === true).length === 1 &&
      pair.filter((item) => item.status === 409 && item.body.code === "deposit_needs_review").length === 1 &&
      db.emails.length === 1 &&
      db.quote.deposit_paid === true &&
      db.project.status === "assigned"
  );

  resetLedger({ deposit_paid_at: null }, { status: "signed", deposit_paid: false });
  const immediatePay = "2026-10-17T18:00:05.000Z";
  const immediateUnix = Date.parse(immediatePay) / 1000;
  result = await postFinalize(
    session({
      id: "cs_test_immediate_card",
      payment_intent: paymentEvidence({
        confirmed: immediateUnix,
        intentCreated: immediateUnix,
        chargeCreated: immediateUnix,
      }),
    })
  );
  ok(
    "immediate payment records the confirmed time",
    result.status === 200 &&
      db.payments.length === 1 &&
      db.payments[0].paid_at === immediatePay &&
      db.quote.deposit_paid_at === immediatePay
  );

  resetLedger(
    { deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000, deposit_paid: false },
    { status: "assigned" }
  );
  result = await postFinalize(
    session({
      id: "cs_test_delayed_bank",
      payment_intent: paymentEvidence({
        intentCreated: Date.parse("2026-10-13T18:00:00.000Z") / 1000,
        chargeCreated: Date.parse("2026-10-14T18:00:00.000Z") / 1000,
        confirmed: Date.parse(delayedIso) / 1000,
      }),
    })
  );
  ok(
    "delayed payment keeps Erin's quote timestamp and credits the confirmed time",
    result.status === 200 &&
      db.payments.length === 1 &&
      db.payments[0].paid_at === delayedIso &&
      db.payments[0].paid_at !== new Date(Date.parse("2026-10-13T18:00:00.000Z")).toISOString() &&
      db.quote.deposit_paid_at === "2026-10-17" &&
      db.emails.length === 0 &&
      db.project.status === "assigned" &&
      db.quote.total === 9114.61
  );

  process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED = "false";
  resetLedger({ deposit_paid_at: "2026-10-17" }, { status: "assigned" });
  result = await postFinalize(session({ id: "cs_test_inflight_while_closed" }));
  ok(
    "closing checkout does not block an already paid session",
    result.status === 200 && db.payments.length === 1 && db.quote.deposit_paid_at === "2026-10-17"
  );
  delete process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED;

  db.payments = [
    depositRow({ id: "pay-new", idempotency_key: "cs_test_new_signed" }),
    depositRow({
      id: "pay-owner-later",
      payment_method: "check",
      idempotency_key: "owner-later",
      amount: 400,
      paid_at: "2026-10-19",
      created_by: "owner",
    }),
  ];
  db.events = [
    appliedEvent({
      applied_payment_id: "pay-new",
      checkout_session_id: "cs_test_new_signed",
    }),
  ];
  db.quote = quote({ deposit_paid: true, deposit_paid_at: "2026-10-18T00:00:00.000Z", deposit_paid_amount: 1000 });
  db.project = project({ status: "deposit_paid", deposit_paid: true });
  db.holdPaymentReads = 0;
  db.holdPaymentInserts = 0;

  global.fetch = async function failIfStripe() {
    throw new Error("checkout must not be created");
  };
  handler = installHandler(createPath, {
    supabaseRequest,
    runDepositPostAutomation: async () => {
      throw new Error("create session must not email");
    },
  });
  let created = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ public_token: TOKEN }),
  });
  let createdBody = JSON.parse(created.body);
  ok("paid deposit blocks a new checkout", created.statusCode === 409 && createdBody.code === "deposit_already_paid");

  db.payments = [];
  db.quote = quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000 });
  created = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ public_token: TOKEN }),
  });
  createdBody = JSON.parse(created.body);
  ok("partial deposit blocks a new checkout", created.statusCode === 409 && createdBody.code === "deposit_verification_pending");

  db.payments = [];
  db.quote = quote();
  db.project = project();
  db.paymentsReadError = "ledger down";
  db.stripeCalls = [];
  global.fetch = async function unavailableMustNotCreateCheckout() {
    db.stripeCalls.push("blocked");
    throw new Error("stripe must not be called");
  };
  created = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ public_token: TOKEN }),
  });
  createdBody = JSON.parse(created.body);
  ok(
    "unavailable verification does not open checkout",
    created.statusCode === 409 &&
      createdBody.code === "deposit_verification_pending" &&
      createdBody.error.indexOf("could not be verified") !== -1 &&
      db.stripeCalls.length === 0
  );
  db.paymentsReadError = null;

  process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED = "false";
  db.quote = quote();
  db.project = project();
  db.payments = [];
  db.stripeCalls = [];
  global.fetch = async function closedMustNotCreateCheckout() {
    db.stripeCalls.push("stripe");
    throw new Error("stripe must not be called");
  };
  created = await handler({
    httpMethod: "POST",
    body: JSON.stringify({ public_token: TOKEN }),
  });
  createdBody = JSON.parse(created.body);
  ok(
    "closed checkout does not create a session",
    created.statusCode === 503 &&
      createdBody.code === "scheduling_checkout_closed" &&
      db.stripeCalls.length === 0
  );
  delete process.env.SCHEDULING_DEPOSIT_CHECKOUT_ENABLED;
  restore(createPath);

  db.quote = quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000, deposit_paid: true });
  db.project = project({ deposit_paid: true });
  db.payments = [
    depositRow(),
    depositRow({
      id: "pay-owner-additional",
      payment_method: "check",
      idempotency_key: "owner-deposit-2",
      amount: 250,
      paid_at: "2026-10-18",
      created_by: "owner",
    }),
  ];
  db.events = [
    appliedEvent(),
    {
      id: "evt-review",
      tenant_id: TENANT_ID,
      quote_id: QUOTE_ID,
      project_id: PROJECT_ID,
      disposition: "needs_review",
      checkout_session_id: "cs_test_hidden_review",
      gross_amount: 1000,
    },
  ];
  global.fetch = originalFetch;
  handler = installHandler(publicPath, {
    supabaseRequest,
    runDepositPostAutomation: async () => {
      throw new Error("public estimate must not email");
    },
  });
  let pub = await handler({
    httpMethod: "GET",
    queryStringParameters: { token: TOKEN },
  });
  let pubBody = JSON.parse(pub.body);
  ok("public estimate reports verified paid", pub.statusCode === 200 && pubBody.estimate.deposit_verification_state === "paid");
  ok(
    "public completed state hides the internal review event",
    !JSON.stringify(pubBody).includes("cs_test_hidden_review") &&
      !JSON.stringify(pubBody).includes("needs_review") &&
      pubBody.estimate.deposit_verification_message === ""
  );
  ok(
    "public payload hides ledger identifiers",
    !JSON.stringify(pubBody).includes(SESSION_ID) &&
      !JSON.stringify(pubBody).includes(PROJECT_ID) &&
      !JSON.stringify(pubBody).includes("idempotency_key") &&
      pubBody.estimate.tenant_id == null
  );

  db.payments = [];
  db.quote = quote({ deposit_paid_at: "2026-10-17", deposit_paid_amount: 1000 });
  pub = await handler({ httpMethod: "GET", queryStringParameters: { token: TOKEN } });
  pubBody = JSON.parse(pub.body);
  ok(
    "public partial deposit is pending and not paid",
    pubBody.estimate.deposit_verification_state === "pending" &&
      pubBody.estimate.deposit_verification_message.length > 0
  );

  db.paymentsReadError = "ledger down";
  db.payments = [];
  db.quote = quote();
  db.project = project();
  pub = await handler({ httpMethod: "GET", queryStringParameters: { token: TOKEN } });
  pubBody = JSON.parse(pub.body);
  ok(
    "public unavailable is not paid and does not confirm payment",
    pubBody.estimate.deposit_verification_state === "unavailable" &&
      pubBody.estimate.deposit_verification_message.indexOf("could not be verified") !== -1 &&
      pubBody.estimate.deposit_paid !== true
  );
  db.paymentsReadError = null;
  restore(publicPath);

  const calls = db.supabaseRequestCalls;
  void calls;
  ok("safety review did not write an invoice or create a project", db.invoiceWrites === 0 && db.projectInserts === 0);
  console.log("PASS stripe verified deposit sync (" + passed + ")");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
