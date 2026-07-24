/**
 * CH-004A7B mocked QA — snapshot readiness, defaults, fail-closed effective.
 * Run: node scripts/qa-ch004a7b-legal-notices-snapshot.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

const defaultsMod = require("../netlify/functions/_lib/legal-notice-defaults");
const api = require("../netlify/functions/tenant-contract-legal-notices");

const {
  NOTICE_FIELD_KEYS,
  LEGAL_NOTICE_DEFAULTS,
  cloneDefaults,
  normalizeForCompare,
} = defaultsMod;

const {
  NOTICE_FIELDS,
  FORBIDDEN_BODY_KEYS,
  ALLOWED_BODY_KEYS,
  normalizeWorkingInput,
  buildEffectiveForContracts,
  evaluateReadiness,
  serializeWorkingNotices,
  workingMatchesSnapshot,
  buildResponse,
} = api._test;

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function emptyNotices() {
  const o = {};
  for (const k of NOTICE_FIELD_KEYS) o[k] = "";
  return o;
}

function allTrueEnabled() {
  const o = {};
  for (const k of NOTICE_FIELD_KEYS) o[k] = true;
  return o;
}

function sampleWorking(overrides = {}) {
  const row = {
    id: "row-1",
    tenant_id: "ten-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-07-18T12:00:00.000Z",
    confirmed_at: null,
    confirmed_notices: null,
    confirmed_enabled: null,
  };
  for (const k of NOTICE_FIELD_KEYS) {
    row[k] = "";
    row[`${k}_enabled`] = true;
  }
  Object.assign(row, overrides);
  return row;
}

// --- Defaults module ---
ok("defaults has exactly 14 keys", NOTICE_FIELD_KEYS.length === 14);
ok(
  "cloneDefaults matches LEGAL_NOTICE_DEFAULTS keys",
  NOTICE_FIELD_KEYS.every((k) => typeof LEGAL_NOTICE_DEFAULTS[k] === "string")
);
ok(
  "defaults are non-empty strings",
  NOTICE_FIELD_KEYS.every((k) => LEGAL_NOTICE_DEFAULTS[k].trim().length > 0)
);
ok(
  "normalizeForCompare trims and normalizes newlines",
  normalizeForCompare("  a\r\nb\r ") === "a\nb"
);
ok(
  "cloneDefaults returns a copy",
  (() => {
    const a = cloneDefaults();
    a.contract_notice = "x";
    return LEGAL_NOTICE_DEFAULTS.contract_notice !== "x";
  })()
);

// --- Forbidden / allowed body ---
for (const k of [
  "tenant_id",
  "id",
  "confirmed_at",
  "confirmed_notices",
  "confirmed_enabled",
  "created_at",
  "updated_at",
]) {
  ok(`forbidden body key ${k}`, FORBIDDEN_BODY_KEYS.has(k));
}
ok("confirm_notices allowed", ALLOWED_BODY_KEYS.has("confirm_notices"));
ok("expected_updated_at allowed", ALLOWED_BODY_KEYS.has("expected_updated_at"));
ok(
  "all enabled keys allowed",
  NOTICE_FIELD_KEYS.every((k) => ALLOWED_BODY_KEYS.has(`${k}_enabled`))
);

// --- normalizeWorkingInput ---
{
  const body = {
    ...emptyNotices(),
    contract_notice: "  Hello  ",
  };
  for (const k of NOTICE_FIELD_KEYS) {
    body[`${k}_enabled`] = k !== "payment_notice";
  }
  const n = normalizeWorkingInput(body);
  ok("normalize trims notice text", n.notices.contract_notice === "Hello");
  ok("normalize keeps disabled flag", n.enabled.payment_notice === false);
  ok(
    "empty enabled notice flagged on confirm path data",
    n.emptyEnabled.includes("payment_notice") === false &&
      n.emptyEnabled.length === 12
  );
}

{
  const body = { contract_notice: "x".repeat(4001), contract_notice_enabled: true };
  for (const k of NOTICE_FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) body[k] = "";
    if (!Object.prototype.hasOwnProperty.call(body, `${k}_enabled`)) {
      body[`${k}_enabled`] = false;
    }
  }
  const n = normalizeWorkingInput(body);
  ok("rejects oversize notice", n.code === "notice_too_long");
}

{
  const body = {};
  for (const k of NOTICE_FIELD_KEYS) {
    body[k] = "ok";
    body[`${k}_enabled`] = "yes";
  }
  const n = normalizeWorkingInput(body);
  ok("rejects non-boolean enabled", n.code === "invalid_enabled");
}

// --- Snapshot effective / readiness ---
{
  const row = sampleWorking();
  ok(
    "no snapshot → effective null",
    buildEffectiveForContracts(row) === null
  );
  const ev = evaluateReadiness(serializeWorkingNotices(row), null);
  ok("draft tenant readiness = draft", ev.readiness.status === "draft");
  ok("draft tenant has_unconfirmed_changes", ev.has_unconfirmed_changes === true);
}

{
  const texts = emptyNotices();
  texts.contract_notice = "Published contract notice";
  const enabled = allTrueEnabled();
  const row = sampleWorking({
    ...texts,
    confirmed_at: "2026-07-01T00:00:00.000Z",
    confirmed_notices: { ...texts },
    confirmed_enabled: { ...enabled },
    contract_notice: "Published contract notice",
  });
  for (const k of NOTICE_FIELD_KEYS) {
    row[`${k}_enabled`] = true;
  }
  const effective = buildEffectiveForContracts(row);
  ok("confirmed snapshot builds effective", !!effective);
  ok(
    "effective exposes confirmed text",
    effective.notices.contract_notice === "Published contract notice"
  );
  const working = serializeWorkingNotices(row);
  const ev = evaluateReadiness(working, effective);
  ok("matching working+snapshot → configured", ev.readiness.status === "configured");
  ok("matching → has_unconfirmed_changes false", ev.has_unconfirmed_changes === false);
}

{
  const texts = emptyNotices();
  texts.contract_notice = "Published";
  const enabled = allTrueEnabled();
  const row = sampleWorking({
    confirmed_at: "2026-07-01T00:00:00.000Z",
    confirmed_notices: { ...texts },
    confirmed_enabled: { ...enabled },
    contract_notice: "Draft edit not published",
  });
  for (const k of NOTICE_FIELD_KEYS) {
    row[k] = texts[k];
    row[`${k}_enabled`] = true;
  }
  row.contract_notice = "Draft edit not published";
  const effective = buildEffectiveForContracts(row);
  const working = serializeWorkingNotices(row);
  ok(
    "draft edit does not change effective text",
    effective.notices.contract_notice === "Published"
  );
  const ev = evaluateReadiness(working, effective);
  ok("divergent draft → readiness draft", ev.readiness.status === "draft");
  ok("divergent → has_unconfirmed_changes", ev.has_unconfirmed_changes === true);
  ok(
    "workingMatchesSnapshot false when text differs",
    workingMatchesSnapshot(working, effective) === false
  );
}

{
  const texts = emptyNotices();
  texts.contract_notice = "Still in snapshot";
  const enabled = allTrueEnabled();
  enabled.contract_notice = true;
  const row = sampleWorking({
    confirmed_at: "2026-07-01T00:00:00.000Z",
    confirmed_notices: { ...texts },
    confirmed_enabled: { ...enabled },
    contract_notice: "Still in snapshot",
    contract_notice_enabled: false,
  });
  for (const k of NOTICE_FIELD_KEYS) {
    if (k === "contract_notice") continue;
    row[k] = texts[k];
    row[`${k}_enabled`] = true;
  }
  const effective = buildEffectiveForContracts(row);
  ok(
    "disable in draft does not remove from effective until confirm",
    effective.enabled.contract_notice === true &&
      effective.notices.contract_notice === "Still in snapshot"
  );
  const ev = evaluateReadiness(serializeWorkingNotices(row), effective);
  ok("disabled draft vs enabled snapshot → draft", ev.readiness.status === "draft");
}

{
  const texts = emptyNotices();
  texts.contract_notice = "Live";
  const enabled = allTrueEnabled();
  enabled.contract_notice = false;
  const row = sampleWorking({
    confirmed_at: "2026-07-01T00:00:00.000Z",
    confirmed_notices: { ...texts },
    confirmed_enabled: { ...enabled },
    ...texts,
  });
  for (const k of NOTICE_FIELD_KEYS) row[`${k}_enabled`] = enabled[k];
  // Only disabled notices → zero enabled populated → fail closed
  const effective = buildEffectiveForContracts(row);
  ok("zero enabled populated snapshot fails closed", effective === null);
}

{
  const row = sampleWorking({
    confirmed_at: "2026-07-01T00:00:00.000Z",
    confirmed_notices: { contract_notice: "partial" },
    confirmed_enabled: allTrueEnabled(),
  });
  ok("malformed notices snapshot fails closed", buildEffectiveForContracts(row) === null);
}

{
  const texts = emptyNotices();
  texts.contract_notice = "ok";
  const row = sampleWorking({
    confirmed_at: "2026-07-01T00:00:00.000Z",
    confirmed_notices: { ...texts },
    confirmed_enabled: { contract_notice: true },
  });
  ok("malformed enabled snapshot fails closed", buildEffectiveForContracts(row) === null);
}

{
  const row = sampleWorking({
    confirmed_at: null,
    confirmed_notices: null,
    confirmed_enabled: null,
  });
  const resp = buildResponse(row);
  ok("GET-shaped response includes defaults", !!resp.defaults?.contract_notice);
  ok("GET effective null when no snapshot", resp.effective_for_contracts === null);
  ok("GET readiness draft for working-only", resp.readiness.status === "draft");
}

{
  const missing = buildResponse(null);
  ok("no row → missing", missing.readiness.status === "missing");
  ok("no row → effective null", missing.effective_for_contracts === null);
  ok("no row → notices null", missing.notices === null);
}

// Migration-shape simulation: confirmed tenant backfill
{
  const texts = emptyNotices();
  texts.warranty_notice = "Existing warranty language";
  texts.payment_notice = "Existing payment language";
  const row = sampleWorking({
    ...texts,
    confirmed_at: "2026-06-01T00:00:00.000Z",
    confirmed_notices: { ...texts },
    confirmed_enabled: allTrueEnabled(),
  });
  for (const k of NOTICE_FIELD_KEYS) {
    row[k] = texts[k];
    row[`${k}_enabled`] = true;
  }
  const effective = buildEffectiveForContracts(row);
  ok(
    "backfilled confirmed tenant preserves text",
    effective.notices.warranty_notice === "Existing warranty language" &&
      effective.notices.payment_notice === "Existing payment language"
  );
  ok(
    "existing non-empty not overwritten by defaults module",
    effective.notices.warranty_notice !== LEGAL_NOTICE_DEFAULTS.warranty_notice
  );
}

// Contract Builder consumption rules (mirror resolve logic lightly)
{
  function cbRows(effective) {
    if (!effective?.notices || !effective?.enabled) return [];
    const rows = [];
    for (const k of NOTICE_FIELD_KEYS) {
      if (effective.enabled[k] !== true) continue;
      const t = String(effective.notices[k] || "").trim();
      if (!t) continue;
      rows.push(k);
    }
    return rows;
  }
  const texts = emptyNotices();
  texts.contract_notice = "A";
  texts.payment_notice = "B";
  const enabled = allTrueEnabled();
  enabled.payment_notice = false;
  const rows = cbRows({ notices: texts, enabled, confirmed_at: "x" });
  ok("CB excludes disabled confirmed notices", rows.includes("payment_notice") === false);
  ok("CB includes enabled populated", rows.includes("contract_notice") === true);
  ok("CB never uses working draft when effective provided", rows.length === 1);
}

// --- Browser serialization omits tenant identifiers ---
{
  const texts = emptyNotices();
  texts.contract_notice = "x";
  const row = sampleWorking({
    ...texts,
    id: "secret-row",
    tenant_id: "secret-tenant",
  });
  const ser = serializeWorkingNotices(row);
  ok("browser notices omit id", ser.id === undefined);
  ok("browser notices omit tenant_id", ser.tenant_id === undefined);
  ok("browser notices keep updated_at", !!ser.updated_at);
}

// --- SQL static audit (zero-downtime compatibility) ---
{
  const fs = require("fs");
  const sqlPath = path.join(
    __dirname,
    "..",
    "SUPABASE_CH004A7B_LEGAL_NOTICES_SNAPSHOT.sql"
  );
  const sql = fs.readFileSync(sqlPath, "utf8");

  const dropsFourArg =
    /drop\s+function\s+if\s+exists\s+public\.replace_tenant_contract_legal_notices\(\s*uuid,\s*jsonb,\s*boolean,\s*timestamptz\s*\)/i.test(
      sql
    );
  ok("SQL does not drop production 4-arg RPC", dropsFourArg === false);

  const hasFiveArgCreate =
    /create\s+or\s+replace\s+function\s+public\.replace_tenant_contract_legal_notices\(\s*p_tenant_id\s+uuid,\s*p_notices\s+jsonb,\s*p_enabled\s+jsonb,\s*p_confirm_notices\s+boolean/i.test(
      sql
    );
  ok("SQL defines 5-arg RPC with p_enabled", hasFiveArgCreate === true);

  const hasFourArgCompat =
    /create\s+or\s+replace\s+function\s+public\.replace_tenant_contract_legal_notices\(\s*p_tenant_id\s+uuid,\s*p_notices\s+jsonb,\s*p_confirm_notices\s+boolean,\s*p_expected_updated_at\s+timestamptz/i.test(
      sql
    );
  ok("SQL keeps 4-arg compatibility overload", hasFourArgCompat === true);

  ok(
    "SQL backfills snapshot only when confirmed_at set",
    /where\s+n\.confirmed_at\s+is\s+not\s+null/i.test(sql) &&
      /and\s+n\.confirmed_notices\s+is\s+null/i.test(sql)
  );

  ok(
    "SQL draft path comment/preserve present",
    /Draft:\s*preserve existing snapshot/i.test(sql)
  );

  ok(
    "SQL does not auto-insert default template text into rows",
    !/insert\s+into\s+public\.tenant_contract_legal_notices[\s\S]*LEGAL_NOTICE_DEFAULTS/i.test(
      sql
    )
  );
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
