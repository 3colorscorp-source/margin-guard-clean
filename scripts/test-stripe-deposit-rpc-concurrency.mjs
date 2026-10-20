#!/usr/bin/env node
/**
 * Disposable PostgreSQL proof for record_verified_scheduling_deposit.
 * Does not connect to production. Starts an embedded cluster and deletes it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleRoot = process.env.MG_PG_MODULES || path.join(os.tmpdir(), "mg-deposit-pg", "node_modules");
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(path.join(moduleRoot, "embedded-postgres", "dist", "index.js")).href
);

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const QUOTE = "08130740-3e22-47d8-9388-2dc65bf3cf00";
const PROJECT = "1e6ac6bd-5cbe-4dec-8b98-363ecc81e58f";
const QUOTE_B = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";
const QUOTE_C = "55555555-5555-4555-8555-555555555555";
const PROJECT_C = "66666666-6666-4666-8666-666666666666";
const QUOTE_D = "77777777-7777-4777-8777-777777777777";
const PROJECT_D = "88888888-8888-4888-8888-888888888888";
const QUOTE_E = "99999999-9999-4999-8999-999999999999";
const PROJECT_E = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRIPE_PAID = "2026-10-17T18:00:00.000Z";

let passed = 0;
function ok(label, cond) {
  if (!cond) throw new Error(label);
  passed += 1;
  console.log("PASS " + label);
}

function clientQuery(client, text, params) {
  return client.query(text, params);
}

async function callRpc(client, args) {
  const result = await clientQuery(
    client,
    `SELECT public.record_verified_scheduling_deposit(
      $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::numeric, $8::timestamptz
    ) AS result`,
    [
      args.tenant,
      args.quote,
      args.project,
      args.session,
      "acct_test_connect",
      args.currency || "usd",
      args.gross == null ? 1000 : args.gross,
      args.paidAt || STRIPE_PAID,
    ]
  );
  return result.rows[0].result;
}

async function main() {
  const rollback = fs.readFileSync(
    path.join(root, "SUPABASE_STRIPE_SCHEDULING_DEPOSIT_EVENTS_ROLLBACK.sql"),
    "utf8"
  );
  const rollbackSql = rollback.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
  ok("rollback does not drop the evidence table", !/drop\s+table/i.test(rollbackSql));
  ok("rollback does not delete ledger or event rows", !/delete\s+from/i.test(rollbackSql));
  ok(
    "rollback closes checkout before removing the function",
    rollback.includes("SCHEDULING_DEPOSIT_CHECKOUT_ENABLED=false") &&
      rollback.indexOf("SCHEDULING_DEPOSIT_CHECKOUT_ENABLED=false") < rollback.search(/drop\s+function/i)
  );
  const migration = fs.readFileSync(
    path.join(root, "SUPABASE_STRIPE_SCHEDULING_DEPOSIT_EVENTS.sql"),
    "utf8"
  );
  ok(
    "migration does not create a balance_effect column",
    !/add\s+column[^;]*balance_effect/i.test(migration)
  );
  ok(
    "migration does not rewrite tenant_project_payments",
    !/alter\s+table\s+public\.tenant_project_payments/i.test(migration)
  );

  const dataDir = path.join(os.tmpdir(), "mg-stripe-deposit-cluster-" + process.pid);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: 55432,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  let admin;
  let left;
  let right;
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("deposit_rpc_test");
    admin = pg.getPgClient("deposit_rpc_test");
    await admin.connect();
    await admin.query(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE TABLE public.tenants (id uuid PRIMARY KEY);
      CREATE TABLE public.quotes (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES public.tenants (id),
        deposit_required numeric,
        deposit_paid boolean,
        deposit_paid_at timestamptz,
        deposit_paid_amount numeric,
        total numeric
      );
      CREATE TABLE public.tenant_projects (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES public.tenants (id),
        quote_id uuid REFERENCES public.quotes (id),
        status text,
        deposit_paid boolean,
        updated_at timestamptz
      );
      CREATE TABLE public.tenant_project_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenants (id),
        quote_id uuid NULL REFERENCES public.quotes (id),
        invoice_id uuid NULL,
        project_id uuid NULL REFERENCES public.tenant_projects (id),
        payment_type text NOT NULL CHECK (payment_type IN ('deposit', 'progress', 'final', 'adjustment')),
        payment_method text NOT NULL CHECK (payment_method IN ('check', 'cash', 'zelle', 'stripe', 'bank_transfer', 'other')),
        amount numeric(14, 2) NOT NULL CHECK (amount <> 0),
        paid_at timestamptz NOT NULL DEFAULT now(),
        notes text NOT NULL DEFAULT '',
        created_by text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        idempotency_key text
      );
      CREATE UNIQUE INDEX tenant_project_payments_tenant_idempotency_uidx
        ON public.tenant_project_payments (tenant_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      INSERT INTO public.tenants (id) VALUES ('${TENANT}'), ('${OTHER}');
      INSERT INTO public.quotes (id, tenant_id, deposit_required, deposit_paid, deposit_paid_at, deposit_paid_amount, total)
      VALUES
        ('${QUOTE}', '${TENANT}', 1000, false, '2026-10-17', 1000, 9114.61),
        ('${QUOTE_B}', '${TENANT}', 1000, false, NULL, NULL, 9114.61),
        ('${QUOTE_C}', '${TENANT}', 1000, false, NULL, NULL, 9114.61),
        ('${QUOTE_D}', '${TENANT}', 1000, false, NULL, NULL, 9114.61),
        ('${QUOTE_E}', '${OTHER}', 1000, false, NULL, NULL, 1000);
      INSERT INTO public.tenant_projects (id, tenant_id, quote_id, status, deposit_paid)
      VALUES
        ('${PROJECT}', '${TENANT}', '${QUOTE}', 'assigned', false),
        ('${PROJECT_B}', '${TENANT}', '${QUOTE_B}', 'signed', false),
        ('${PROJECT_C}', '${TENANT}', '${QUOTE_C}', 'assigned', false),
        ('${PROJECT_D}', '${TENANT}', '${QUOTE_D}', 'assigned', false),
        ('${PROJECT_E}', '${OTHER}', '${QUOTE_E}', 'assigned', false);
    `);
    await admin.query(migration);

    const proc = await admin.query(`
      SELECT prosecdef, proconfig, proargnames
      FROM pg_proc
      WHERE proname = 'record_verified_scheduling_deposit'
    `);
    ok("function is not security definer", proc.rows[0].prosecdef === false);
    ok(
      "function search_path is public and pg_temp",
      (proc.rows[0].proconfig || []).some((item) => String(item).includes("search_path=public, pg_temp"))
    );
    ok(
      "function does not accept a client payment status",
      !(proc.rows[0].proargnames || []).some((name) => /status/i.test(name))
    );
    const priv = await admin.query(`
      SELECT
        has_function_privilege('anon', 'public.record_verified_scheduling_deposit(uuid,uuid,uuid,text,text,text,numeric,timestamptz)', 'execute') AS anon_exec,
        has_function_privilege('authenticated', 'public.record_verified_scheduling_deposit(uuid,uuid,uuid,text,text,text,numeric,timestamptz)', 'execute') AS auth_exec,
        has_function_privilege('public', 'public.record_verified_scheduling_deposit(uuid,uuid,uuid,text,text,text,numeric,timestamptz)', 'execute') AS public_exec,
        has_function_privilege('service_role', 'public.record_verified_scheduling_deposit(uuid,uuid,uuid,text,text,text,numeric,timestamptz)', 'execute') AS service_exec
    `);
    ok("anon cannot execute the RPC", priv.rows[0].anon_exec === false);
    ok("authenticated cannot execute the RPC", priv.rows[0].auth_exec === false);
    ok("public cannot execute the RPC", priv.rows[0].public_exec === false);
    ok("service_role can execute the RPC", priv.rows[0].service_exec === true);

    await admin.query(`
      GRANT USAGE ON SCHEMA public TO service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);
    await admin.query("SET ROLE service_role");
    const asService = await callRpc(admin, {
      tenant: TENANT,
      quote: QUOTE_B,
      project: PROJECT_B,
      session: "cs_test_service_role_once",
    });
    ok("service_role call applies one credit", asService.ok === true && asService.outcome === "applied_new");
    await admin.query("RESET ROLE");

    let anonDenied = false;
    try {
      await admin.query("SET ROLE anon");
      await callRpc(admin, {
        tenant: TENANT,
        quote: QUOTE_B,
        project: PROJECT_B,
        session: "cs_test_anon_denied",
      });
    } catch (err) {
      anonDenied = /permission denied/i.test(String(err.message || err));
    } finally {
      await admin.query("RESET ROLE");
    }
    ok("anon execution is denied", anonDenied);

    left = pg.getPgClient("deposit_rpc_test");
    right = pg.getPgClient("deposit_rpc_test");
    await left.connect();
    await right.connect();
    const [first, second] = await Promise.all([
      callRpc(left, { tenant: TENANT, quote: QUOTE, project: PROJECT, session: "cs_test_parallel_a" }),
      callRpc(right, { tenant: TENANT, quote: QUOTE, project: PROJECT, session: "cs_test_parallel_b" }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    ok("concurrent sessions return applied_new and needs_review", outcomes.join(",") === "applied_new,needs_review");
    const counts = await admin.query(`
      SELECT
        (SELECT count(*) FROM tenant_project_payments WHERE quote_id = '${QUOTE}' AND payment_type = 'deposit') AS credits,
        (SELECT count(*) FROM stripe_scheduling_deposit_events WHERE quote_id = '${QUOTE}' AND disposition = 'applied') AS applied,
        (SELECT count(*) FROM stripe_scheduling_deposit_events WHERE quote_id = '${QUOTE}' AND disposition = 'needs_review') AS review,
        (SELECT coalesce(sum(amount), 0) FROM tenant_project_payments WHERE quote_id = '${QUOTE}') AS credited,
        (SELECT status FROM tenant_projects WHERE id = '${PROJECT}') AS status,
        (SELECT deposit_paid_at FROM quotes WHERE id = '${QUOTE}') AS paid_at,
        (SELECT total FROM quotes WHERE id = '${QUOTE}') AS total
    `);
    ok("concurrent sessions leave one ledger credit", Number(counts.rows[0].credits) === 1);
    ok("concurrent sessions leave one applied event", Number(counts.rows[0].applied) === 1);
    ok("concurrent sessions leave one review event", Number(counts.rows[0].review) === 1);
    ok("credited gross is 1000", Number(counts.rows[0].credited) === 1000);
    ok("assigned status stays assigned", counts.rows[0].status === "assigned");
    const quotePaidAt = new Date(counts.rows[0].paid_at).toISOString();
    ok(
      "original paid timestamp stays on the quote",
      quotePaidAt !== STRIPE_PAID && quotePaidAt.startsWith("2026-10-17")
    );
    ok("contract total stays unchanged", Number(counts.rows[0].total) === 9114.61);
    const paymentTime = await admin.query(
      `SELECT paid_at FROM tenant_project_payments WHERE quote_id = '${QUOTE}'`
    );
    ok(
      "ledger paid_at is the Stripe timestamp",
      new Date(paymentTime.rows[0].paid_at).toISOString() === STRIPE_PAID
    );

    const replay = await callRpc(admin, {
      tenant: TENANT,
      quote: QUOTE,
      project: PROJECT,
      session: first.outcome === "applied_new" ? "cs_test_parallel_a" : "cs_test_parallel_b",
    });
    const afterReplay = await admin.query(
      `SELECT count(*)::int AS n FROM tenant_project_payments WHERE quote_id = '${QUOTE}'`
    );
    ok("same-session replay is idempotent", replay.outcome === "already_recorded" && afterReplay.rows[0].n === 1);

    await admin.query(`
      INSERT INTO tenant_project_payments (
        tenant_id, quote_id, project_id, payment_type, payment_method, amount, paid_at, idempotency_key
      ) VALUES (
        '${TENANT}', '${QUOTE_C}', '${PROJECT_C}', 'deposit', 'check', 1000, '2026-09-01', 'manual-1'
      )
    `);
    const manual = await callRpc(admin, {
      tenant: TENANT,
      quote: QUOTE_C,
      project: PROJECT_C,
      session: "cs_test_after_manual",
    });
    const manualCount = await admin.query(
      `SELECT count(*)::int AS n FROM tenant_project_payments WHERE quote_id = '${QUOTE_C}'`
    );
    ok("manual deposit is preserved and the Stripe charge is not credited", manual.outcome === "needs_review" && manualCount.rows[0].n === 1);

    await admin.query(`
      INSERT INTO tenant_project_payments (
        tenant_id, quote_id, project_id, payment_type, payment_method, amount, paid_at
      ) VALUES (
        '${TENANT}', NULL, '${PROJECT_D}', 'deposit', 'cash', 500, '2026-08-01'
      )
    `);
    const legacy = await callRpc(admin, {
      tenant: TENANT,
      quote: QUOTE_D,
      project: PROJECT_D,
      session: "cs_test_after_legacy",
    });
    const legacyStripe = await admin.query(
      `SELECT count(*)::int AS n FROM tenant_project_payments WHERE quote_id = '${QUOTE_D}'`
    );
    ok("legacy null-quote deposit blocks automatic credit", legacy.outcome === "needs_review" && legacyStripe.rows[0].n === 0);

    const wrong = await callRpc(admin, {
      tenant: TENANT,
      quote: QUOTE_E,
      project: PROJECT_E,
      session: "cs_test_wrong_tenant",
    });
    ok("wrong tenant writes nothing", wrong.ok === false && wrong.code === "quote_not_found");

    const mismatch = await callRpc(admin, {
      tenant: OTHER,
      quote: QUOTE_E,
      project: PROJECT_E,
      session: "cs_test_wrong_amount",
      gross: 970.7,
    });
    const otherCredits = await admin.query(
      `SELECT count(*)::int AS n FROM tenant_project_payments WHERE tenant_id = '${OTHER}'`
    );
    ok("amount mismatch writes nothing", mismatch.ok === false && mismatch.code === "amount_mismatch" && otherCredits.rows[0].n === 0);

    await admin.query("BEGIN");
    await callRpc(admin, {
      tenant: OTHER,
      quote: QUOTE_E,
      project: PROJECT_E,
      session: "cs_test_rolled_back",
    });
    await admin.query("ROLLBACK");
    const rolled = await admin.query(
      `SELECT count(*)::int AS n FROM tenant_project_payments WHERE idempotency_key = 'cs_test_rolled_back'`
    );
    ok("rollback before commit leaves no credit", rolled.rows[0].n === 0);

    const hold = left.query(`
      BEGIN;
      SELECT id FROM public.quotes WHERE id = '${QUOTE_D}' FOR UPDATE;
      SELECT pg_sleep(3);
      COMMIT;
    `);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await right.query(`
      INSERT INTO tenant_project_payments (
        tenant_id, quote_id, project_id, payment_type, payment_method, amount, paid_at, idempotency_key
      ) VALUES (
        '${TENANT}', '${QUOTE_D}', '${PROJECT_D}', 'deposit', 'zelle', 250, now(), 'manual-during-lock'
      )
    `);
    const elapsed = Date.now() - started;
    await hold;
    ok("manual insert waits until the scheduling quote lock commits", elapsed >= 2000);

    const signed = await admin.query(`SELECT status FROM tenant_projects WHERE id = '${PROJECT_B}'`);
    ok("signed project can move to deposit_paid", signed.rows[0].status === "deposit_paid");

    console.log("PASS stripe scheduling deposit rpc (" + passed + ")");
  } finally {
    if (left) await left.end().catch(() => {});
    if (right) await right.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await pg.stop().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
