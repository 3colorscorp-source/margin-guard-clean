#!/usr/bin/env node
/**
 * Core Security Shield V1 — static checks for Supabase hardening 1.
 * Does not connect to production, apply SQL, or mutate product files.
 * Run: node scripts/test-core-security-supabase-hardening-1.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const APPLY = "SUPABASE_MG_CORE_SECURITY_HARDENING_1.sql";
const ROLLBACK = "SUPABASE_MG_CORE_SECURITY_HARDENING_1_ROLLBACK.sql";
const VERIFY = "SUPABASE_MG_CORE_SECURITY_HARDENING_1_VERIFY.sql";

const TABLES = [
  "device_sessions",
  "quote_annual_counters",
  "sales_approvals",
  "tenant_devices",
  "tenant_project_change_orders",
  "tenant_project_expenses",
  "tenant_project_operational_snapshots",
  "users",
];

const MUTATION_RPCS = [
  "activate_next_invoice_for_quote(uuid)",
  "calc_quote_labor_cost(uuid)",
  "create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date)",
  "refresh_invoice_payment_totals(uuid)",
  "register_invoice_payment(uuid, numeric)",
  "register_invoice_payment(uuid, uuid, numeric, text, text, text, text)",
];

const TABLE_RESTORE_PRIVS = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

const TABLE_RESTORE_GRANT =
  "SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN";

const SEARCH_PATH_FUNCS = [
  "assert_device_session_same_tenant()",
  "assert_tenant_device_membership_same_tenant()",
  "platform_activity_events_reject_mutation()",
  "platform_domain_event_outbox_reject_mutation()",
  "prevent_tenant_devices_tenant_id_change()",
  "set_updated_at()",
  "tenant_contract_certificates_protect_immutable()",
  "tenant_contract_envelopes_assert_refs()",
  "tenant_contract_envelopes_touch_updated_at()",
  "tenant_contract_invitation_delivery_attempts_protect_delete()",
  "tenant_contract_invitation_delivery_attempts_protect_update()",
  "tenant_contract_invitation_generations_assert_refs()",
  "tenant_contract_invitation_generations_protect_delete()",
  "tenant_contract_invitation_generations_protect_update()",
  "tenant_contract_invitations_assert_refs()",
  "tenant_contract_invitations_protect_terminal()",
  "tenant_contract_packages_assert_refs()",
  "tenant_contract_packages_protect_immutable()",
  "tenant_contract_signature_events_append_only()",
  "tenant_contract_signed_artifacts_protect_immutable()",
  "tenant_contract_signers_assert_refs()",
  "tenant_contract_signers_touch_updated_at()",
  "tenant_contract_signing_tokens_assert_refs()",
  "tenant_contract_signing_tokens_protect_immutable()",
  "tenant_contract_signing_tokens_touch_updated_at()",
  "tenant_project_payment_intents_assert_refs()",
  "activate_next_invoice_for_quote(uuid)",
  "calc_quote_labor_cost(uuid)",
  "create_payment_schedule_from_quote(uuid, uuid, numeric, text, text, text, date)",
  "refresh_invoice_payment_totals(uuid)",
  "register_invoice_payment(uuid, numeric)",
  "register_invoice_payment(uuid, uuid, numeric, text, text, text, text)",
  "mg_business_id()",
  "mg_role()",
];

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function gitFiles() {
  const r = spawnSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (!r || r.status !== 0) throw new Error("git ls-files failed");
  return String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function countMatches(text, re) {
  const m = String(text || "").match(re);
  return m ? m.length : 0;
}

function main() {
  ok("34 search_path targets are frozen", SEARCH_PATH_FUNCS.length === 34);
  ok("8 server-only tables are frozen", TABLES.length === 8);
  ok("6 mutation RPC signatures are frozen", MUTATION_RPCS.length === 6);

  ok("apply SQL exists", fs.existsSync(path.join(ROOT, APPLY)));
  ok("rollback SQL exists", fs.existsSync(path.join(ROOT, ROLLBACK)));
  ok("verify SQL exists", fs.existsSync(path.join(ROOT, VERIFY)));

  const apply = read(APPLY);
  const rollback = read(ROLLBACK);
  const verify = read(VERIFY);

  ok("apply is not for CI", /DO NOT apply from CI/.test(apply));
  ok("rollback must not be executed", /DO NOT execute this file/.test(rollback));
  ok("verify is read-only", /BEGIN TRANSACTION READ ONLY/.test(verify));
  ok("verify rolls back", /ROLLBACK;/.test(verify));

  ok("apply does not use dynamic DO for search_path", !/DO \$\$[\s\S]*SET search_path/.test(apply));
  ok("apply does not invent search_path = ''", !/SET search_path = ''/.test(apply));
  ok(
    "apply sets pg_catalog, public on functions",
    countMatches(apply, /SET search_path = pg_catalog, public;/g) === 34
  );
  ok(
    "apply has 34 ALTER FUNCTION search_path statements",
    countMatches(apply, /ALTER FUNCTION public\./g) === 34
  );

  SEARCH_PATH_FUNCS.forEach((ident) => {
    ok(
      "apply pins " + ident,
      apply.indexOf("ALTER FUNCTION public." + ident) >= 0
    );
    ok(
      "rollback resets " + ident,
      rollback.indexOf("ALTER FUNCTION public." + ident + " RESET search_path;") >= 0 ||
        rollback.indexOf("ALTER FUNCTION public." + ident + "\nRESET search_path;") >= 0
    );
    ok("verify names " + ident, verify.indexOf("public." + ident) >= 0);
  });

  TABLES.forEach((tbl) => {
    ok("apply revokes PUBLIC on " + tbl, apply.indexOf("REVOKE ALL ON TABLE public." + tbl + " FROM PUBLIC;") >= 0);
    ok("apply revokes anon on " + tbl, apply.indexOf("REVOKE ALL ON TABLE public." + tbl + " FROM anon;") >= 0);
    ok(
      "apply revokes authenticated on " + tbl,
      apply.indexOf("REVOKE ALL ON TABLE public." + tbl + " FROM authenticated;") >= 0
    );
    ok(
      "apply keeps service_role on " + tbl,
      apply.indexOf(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public." + tbl + " TO service_role;"
      ) >= 0
    );
    ok(
      "verify fails if " + tbl + " keeps client grants",
      verify.indexOf("anon/authenticated still granted on public.%") >= 0
    );
  });

  MUTATION_RPCS.forEach((ident) => {
    ok(
      "apply revokes PUBLIC EXECUTE on " + ident,
      apply.indexOf("REVOKE ALL ON FUNCTION public." + ident + " FROM PUBLIC;") >= 0
    );
    ok(
      "apply revokes anon EXECUTE on " + ident,
      apply.indexOf("REVOKE ALL ON FUNCTION public." + ident + " FROM anon;") >= 0
    );
    ok(
      "apply revokes authenticated EXECUTE on " + ident,
      apply.indexOf("REVOKE ALL ON FUNCTION public." + ident + " FROM authenticated;") >= 0
    );
    ok(
      "apply grants service_role EXECUTE on " + ident,
      apply.indexOf("GRANT EXECUTE ON FUNCTION public." + ident + " TO service_role;") >= 0
    );
  });

  ok(
    "apply keeps authenticated EXECUTE on mg_business_id()",
    apply.indexOf("GRANT EXECUTE ON FUNCTION public.mg_business_id() TO authenticated;") >= 0
  );
  ok(
    "apply keeps authenticated EXECUTE on mg_role()",
    apply.indexOf("GRANT EXECUTE ON FUNCTION public.mg_role() TO authenticated;") >= 0
  );
  ok(
    "apply revokes PUBLIC on mg_business_id()",
    apply.indexOf("REVOKE ALL ON FUNCTION public.mg_business_id() FROM PUBLIC;") >= 0
  );
  ok(
    "apply revokes anon on mg_business_id()",
    apply.indexOf("REVOKE ALL ON FUNCTION public.mg_business_id() FROM anon;") >= 0
  );
  ok(
    "apply does not revoke authenticated on mg helpers",
    apply.indexOf("REVOKE ALL ON FUNCTION public.mg_business_id() FROM authenticated;") < 0 &&
      apply.indexOf("REVOKE ALL ON FUNCTION public.mg_role() FROM authenticated;") < 0
  );

  ok("verify fails if authenticated loses mg_business_id", /authenticated lost EXECUTE on mg_business_id/.test(verify));
  ok("verify fails if authenticated loses mg_role", /authenticated lost EXECUTE on mg_role/.test(verify));
  ok("verify fails if mutation RPC keeps client EXECUTE", /forbidden EXECUTE remains/.test(verify));
  ok("verify fails if search_path is mutable", /mutable search_path/.test(verify));
  ok("verify fails if public table loses RLS", /lost RLS/.test(verify));
  ok("verify fails if service_role loses table privileges", /service_role missing table privileges/.test(verify));
  ok("verify names expected 34 functions", /expected 34 target functions/.test(verify));

  ok("apply does not create policies", !/CREATE POLICY/i.test(apply));
  ok("apply does not drop policies", !/DROP POLICY/i.test(apply));
  ok("apply does not alter policies", !/ALTER POLICY/i.test(apply));
  ok("apply does not disable RLS", !/DISABLE ROW LEVEL SECURITY/i.test(apply));
  ok("apply does not enable RLS", !/ENABLE ROW LEVEL SECURITY/i.test(apply));
  ok("rollback does not touch policies", !/POLICY/i.test(rollback));
  ok("7 table restore privileges are frozen", TABLE_RESTORE_PRIVS.length === 7);
  ok("rollback table grants are not DML-only", !/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE/.test(rollback));
  ok("rollback does not restore PUBLIC table ACL", !/ON TABLE public\.\w+ TO PUBLIC/.test(rollback));

  TABLES.forEach((tbl) => {
    const grantAuth =
      "GRANT " + TABLE_RESTORE_GRANT + " ON TABLE public." + tbl + " TO anon, authenticated;";
    const grantSvc =
      "GRANT " + TABLE_RESTORE_GRANT + " ON TABLE public." + tbl + " TO service_role;";
    ok("rollback restores original table ACL to anon/authenticated on " + tbl, rollback.indexOf(grantAuth) >= 0);
    ok("rollback restores original table ACL to service_role on " + tbl, rollback.indexOf(grantSvc) >= 0);
    TABLE_RESTORE_PRIVS.forEach((priv) => {
      ok(
        "rollback restores " + priv + " on " + tbl,
        rollback.indexOf(grantAuth) >= 0 && grantAuth.indexOf(priv) >= 0
      );
    });
  });

  const executeTargets = MUTATION_RPCS.concat(["mg_business_id()", "mg_role()"]);
  executeTargets.forEach((ident) => {
    ok(
      "rollback restores PUBLIC EXECUTE on " + ident,
      rollback.indexOf("GRANT EXECUTE ON FUNCTION public." + ident + " TO PUBLIC;") >= 0
    );
    ok(
      "rollback restores anon/authenticated EXECUTE on " + ident,
      rollback.indexOf("GRANT EXECUTE ON FUNCTION public." + ident + " TO anon, authenticated;") >= 0
    );
    ok(
      "rollback restores service_role EXECUTE on " + ident,
      rollback.indexOf("GRANT EXECUTE ON FUNCTION public." + ident + " TO service_role;") >= 0
    );
  });

  const files = gitFiles();
  const code = files.filter((rel) => /\.(js|html)$/.test(rel) && /^public\//.test(rel));
  let browserFrom = 0;
  let browserRpc = 0;
  code.forEach((rel) => {
    const t = fs.readFileSync(path.join(ROOT, rel), "utf8");
    TABLES.forEach((tbl) => {
      const re = new RegExp("\\.from\\(\\s*['\"`]" + tbl + "['\"`]");
      if (re.test(t)) browserFrom += 1;
    });
    MUTATION_RPCS.forEach((ident) => {
      const name = ident.split("(")[0];
      if (t.indexOf(name) >= 0) browserRpc += 1;
    });
    if (/\.rpc\s*\(/.test(t)) browserRpc += 1;
  });
  ok("no browser supabase.from() on target tables", browserFrom === 0);
  ok("no browser rpc consumers of mutation RPCs", browserRpc === 0);

  const manifest = JSON.parse(read("scripts/mg-core-security-shield-v1.json"));
  const required = manifest.required || [];
  const hardening = required.find((row) => row && row.id === "core-security-supabase-hardening-1");
  ok("manifest lists hardening suite as required", Boolean(hardening));
  ok(
    "manifest hardening path is frozen",
    hardening && hardening.path === "scripts/test-core-security-supabase-hardening-1.js"
  );
  ok("manifest hardening minPassed is 303", hardening && hardening.minPassed === 303);
  ok("handler inventory stays 24", Array.isArray(manifest.handlerInventory) && manifest.handlerInventory.length === 24);

  console.log("\nCore Security Supabase hardening 1: " + passed + " passed");
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
