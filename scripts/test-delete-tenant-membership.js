/**
 * Team & Devices — permanent delete member (owner-only).
 * Isolated source + mocked handler. No live Netlify/Supabase.
 * Run: node scripts/test-delete-tenant-membership.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function checkSyntax(rel) {
  const r = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout || rel);
}

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_MEM = "00000000-0000-4000-8000-000000000001";
const MEMBER_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_A = "44444444-4444-4444-8444-444444444444";

const fnSrc = read("netlify/functions/delete-tenant-membership.js");
const updateSrc = read("netlify/functions/update-tenant-membership.js");
const uiSrc = read("public/js/team-devices.js");
const htmlSrc = read("public/team-devices.html");

checkSyntax("netlify/functions/delete-tenant-membership.js");
checkSyntax("public/js/team-devices.js");
ok("delete membership function syntax is valid", true);
ok("team-devices syntax is valid", true);

ok("delete requires owner membership", fnSrc.includes("requireOwnerMembership"));
ok("delete is POST-only", fnSrc.includes('event.httpMethod !== "POST"'));
ok("delete looks up membership by tenant", fnSrc.includes("resolveMembershipById"));
ok("delete refuses owner self-delete", fnSrc.includes("Owner membership cannot be deleted"));
ok("delete refuses owner/admin roles", fnSrc.includes("PROTECTED_ROLES"));
ok("delete only allows seller/supervisor", fnSrc.includes("ALLOWED_TARGET_ROLES"));
ok(
  "delete removes assigned devices by tenant",
  fnSrc.includes("tenant_devices?tenant_id=eq.${tid}&assigned_membership_id=eq.${mid}")
);
ok(
  "delete removes the profiles row by tenant",
  fnSrc.includes('method: "DELETE"') &&
    fnSrc.includes("profiles?id=eq.${mid}&tenant_id=eq.${tid}")
);
ok("remove stays a soft status update", updateSrc.includes('status: "removed"') || updateSrc.includes('"removed"'));

ok("UI member Delete action exists", uiSrc.includes('data-td-action="delete"'));
ok("UI posts to delete-tenant-membership", uiSrc.includes("/delete-tenant-membership"));
ok("member confirm is an in-app modal", htmlSrc.includes('id="tdDeleteMemberModal"'));
ok("member confirm title is professional", htmlSrc.includes('id="tdDeleteMemberTitle">Delete member<'));
ok("member confirm is not a browser dialog", !uiSrc.includes("Delete ${label} permanently?"));
ok(
  "member confirm explains devices are deleted",
  htmlSrc.includes("Assigned devices are deleted and any active sessions end immediately.")
);
ok(
  "member confirm preserves quotes",
  htmlSrc.includes("Quotes, projects, and company records are not deleted.")
);
ok("member confirm button is Delete member", htmlSrc.includes('id="tdDeleteMemberConfirm">Delete member<'));
ok("delete action opens the member confirm modal", uiSrc.includes('openDeleteMemberModal(id)'));
ok("UI still offers Remove on members", uiSrc.includes('data-td-action="remove"'));

function loadHandler(supabaseRequest) {
  [
    "../netlify/functions/delete-tenant-membership",
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/tenant-device-guard",
    "../netlify/functions/_lib/membership-resolve",
  ].forEach((id) => {
    try {
      delete require.cache[require.resolve(id)];
    } catch (_err) {
      /* optional */
    }
  });

  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./_lib/supabase-admin") {
      return { supabaseRequest };
    }
    if (request === "./_lib/tenant-device-guard") {
      return {
        requireOwnerMembership: async () => ({
          tenant: { id: TENANT_A },
          membership: { id: OWNER_MEM },
        }),
      };
    }
    return orig.call(this, request, parent, isMain);
  };

  try {
    return require("../netlify/functions/delete-tenant-membership");
  } finally {
    Module._load = orig;
  }
}

async function main() {
  const calls = [];
  const handlerMod = loadHandler(async (p, opts) => {
    const method = (opts && opts.method) || "GET";
    calls.push({ path: String(p), method });
    if (String(p).startsWith("profiles?") && method === "GET") {
      return [
        {
          id: MEMBER_A,
          tenant_id: TENANT_A,
          role: "seller",
          status: "active",
          email: "seller@example.com",
        },
      ];
    }
    if (String(p).startsWith("tenant_devices?") && method === "GET") {
      return [{ id: DEVICE_A }];
    }
    return [];
  });

  const methodRes = await handlerMod.handler({ httpMethod: "GET", body: "{}" });
  ok("GET is rejected", methodRes.statusCode === 405);

  const badId = await handlerMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ membership_id: "not-a-uuid" }),
  });
  ok("invalid membership_id is 400", badId.statusCode === 400);

  const selfRes = await handlerMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ membership_id: OWNER_MEM }),
  });
  ok("owner cannot delete self", selfRes.statusCode === 403);

  calls.length = 0;
  const okRes = await handlerMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ membership_id: MEMBER_A }),
  });
  const payload = JSON.parse(okRes.body || "{}");
  ok("owner delete succeeds", okRes.statusCode === 200 && payload.ok === true && payload.deleted === true);
  ok(
    "assigned device is deleted tenant-scoped",
    calls.some(
      (c) =>
        c.method === "DELETE" &&
        c.path.indexOf("tenant_devices?") === 0 &&
        c.path.indexOf("id=eq." + DEVICE_A) >= 0 &&
        c.path.indexOf("tenant_id=eq." + TENANT_A) >= 0
    )
  );
  ok(
    "membership delete is tenant-scoped",
    calls.some(
      (c) =>
        c.method === "DELETE" &&
        c.path.indexOf("profiles?") === 0 &&
        c.path.indexOf("id=eq." + MEMBER_A) >= 0 &&
        c.path.indexOf("tenant_id=eq." + TENANT_A) >= 0
    )
  );

  const missingMod = loadHandler(async (p, opts) => {
    const method = (opts && opts.method) || "GET";
    if (String(p).startsWith("profiles?") && method === "GET") return [];
    if (method === "DELETE") throw new Error("should not delete");
    return [];
  });
  const missing = await missingMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ membership_id: MEMBER_A }),
  });
  ok("unknown membership is 404", missing.statusCode === 404);

  const ownerRoleMod = loadHandler(async (p, opts) => {
    const method = (opts && opts.method) || "GET";
    if (String(p).startsWith("profiles?") && method === "GET") {
      return [{ id: MEMBER_A, tenant_id: TENANT_A, role: "owner", status: "active" }];
    }
    if (method === "DELETE") throw new Error("should not delete owner role");
    return [];
  });
  const ownerRole = await ownerRoleMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ membership_id: MEMBER_A }),
  });
  ok("owner-role membership cannot be deleted", ownerRole.statusCode === 403);

  console.log("\nDelete tenant membership: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
