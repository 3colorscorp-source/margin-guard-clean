/**
 * Team & Devices — permanent delete device (owner-only).
 * Isolated source + mocked handler. No live Netlify/Supabase.
 * Run: node scripts/test-delete-tenant-device.js
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
const DEVICE_A = "44444444-4444-4444-8444-444444444444";

const fnSrc = read("netlify/functions/delete-tenant-device.js");
const uiSrc = read("public/js/team-devices.js");
const htmlSrc = read("public/team-devices.html");
const revokeSrc = read("netlify/functions/revoke-tenant-device.js");

checkSyntax("netlify/functions/delete-tenant-device.js");
checkSyntax("public/js/team-devices.js");
ok("delete function syntax is valid", true);
ok("team-devices syntax is valid", true);

ok("delete requires owner membership", fnSrc.includes("requireOwnerMembership"));
ok("delete is POST-only", fnSrc.includes('event.httpMethod !== "POST"'));
ok(
  "delete looks up device by id and tenant",
  fnSrc.includes("tenant_devices?id=eq.${did}&tenant_id=eq.${tid}")
);
ok("delete asserts same tenant", fnSrc.includes("assertSameTenant"));
ok(
  "delete removes sessions by device and tenant",
  fnSrc.includes("device_sessions") &&
    fnSrc.includes("device_id=eq.") &&
    fnSrc.includes("&tenant_id=eq.") &&
    /method:\s*"DELETE"/.test(fnSrc)
);
ok(
  "delete removes the tenant_devices row",
  fnSrc.includes('method: "DELETE"') &&
    fnSrc.includes("tenant_devices?id=eq.${did}&tenant_id=eq.${tid}")
);
ok("delete does not soft-revoke the row", !fnSrc.includes('status: "revoked"'));
ok("revoke remains soft-only", revokeSrc.includes('status: "revoked"') && !revokeSrc.includes('method: "DELETE"'));

ok("UI Delete action exists", uiSrc.includes('data-td-device-action="delete"'));
ok("UI Delete label exists", uiSrc.includes(">Delete</button>"));
ok("UI posts to delete-tenant-device", uiSrc.includes("/delete-tenant-device"));
ok("delete confirm is an in-app modal", htmlSrc.includes('id="tdDeleteDeviceModal"'));
ok("delete confirm title is professional", htmlSrc.includes('id="tdDeleteDeviceTitle">Delete device<'));
ok(
  "delete confirm is not a browser dialog",
  !uiSrc.includes("Delete ${label} permanently?") && !uiSrc.includes("handleDeleteDevice")
);
ok("delete confirm explains session end", htmlSrc.includes("Any active session on that tablet ends immediately."));
ok(
  "delete confirm preserves quotes and members",
  htmlSrc.includes("Quotes, projects, and member accounts are not deleted.")
);
ok("delete confirm button is Delete device", htmlSrc.includes('id="tdDeleteDeviceConfirm">Delete device<'));
ok("UI still offers Revoke on active devices", uiSrc.includes('data-td-device-action="revoke"'));
ok(
  "revoked rows keep Delete instead of a dead Revoked span",
  uiSrc.includes("canManage") &&
    uiSrc.includes('data-td-device-action="delete"') &&
    !uiSrc.includes('<span class="td-protected">Revoked</span>')
);
ok("delete action opens the confirm modal", uiSrc.includes('if (action === "delete") openDeleteDeviceModal(id);'));

function loadHandler(supabaseRequest) {
  [
    "../netlify/functions/delete-tenant-device",
    "../netlify/functions/_lib/supabase-admin",
    "../netlify/functions/_lib/tenant-device-guard",
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
          membership: { id: "owner-mem" },
        }),
        assertSameTenant: (a, b) => {
          if (String(a) !== String(b)) {
            const err = new Error("tenant mismatch");
            err.isGuardError = true;
            err.statusCode = 403;
            err.code = "tenant_mismatch";
            throw err;
          }
        },
      };
    }
    return orig.call(this, request, parent, isMain);
  };

  try {
    return require("../netlify/functions/delete-tenant-device");
  } finally {
    Module._load = orig;
  }
}

async function main() {
  const calls = [];
  const handlerMod = loadHandler(async (p, opts) => {
    calls.push({ path: String(p), method: (opts && opts.method) || "GET" });
    if (String(p).startsWith("tenant_devices?") && (!opts || opts.method === "GET")) {
      return [
        {
          id: DEVICE_A,
          tenant_id: TENANT_A,
          display_name: "Smoke Device",
          status: "revoked",
        },
      ];
    }
    if (String(p).startsWith("device_sessions?")) {
      return [{ id: "sess-1" }];
    }
    return [];
  });

  const methodRes = await handlerMod.handler({ httpMethod: "GET", body: "{}" });
  ok("GET is rejected", methodRes.statusCode === 405);

  const badId = await handlerMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ device_id: "not-a-uuid" }),
  });
  ok("invalid device_id is 400", badId.statusCode === 400);

  calls.length = 0;
  const okRes = await handlerMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ device_id: DEVICE_A }),
  });
  const payload = JSON.parse(okRes.body || "{}");
  ok("owner delete succeeds", okRes.statusCode === 200 && payload.ok === true && payload.deleted === true);
  ok(
    "sessions delete is tenant-scoped",
    calls.some(
      (c) =>
        c.method === "DELETE" &&
        c.path.indexOf("device_sessions?") === 0 &&
        c.path.indexOf("device_id=eq." + DEVICE_A) >= 0 &&
        c.path.indexOf("tenant_id=eq." + TENANT_A) >= 0
    )
  );
  ok(
    "device delete is tenant-scoped",
    calls.some(
      (c) =>
        c.method === "DELETE" &&
        c.path.indexOf("tenant_devices?") === 0 &&
        c.path.indexOf("id=eq." + DEVICE_A) >= 0 &&
        c.path.indexOf("tenant_id=eq." + TENANT_A) >= 0
    )
  );

  const missingCalls = [];
  const missingMod = loadHandler(async (p, opts) => {
    missingCalls.push({ path: String(p), method: (opts && opts.method) || "GET" });
    return [];
  });
  const missing = await missingMod.handler({
    httpMethod: "POST",
    body: JSON.stringify({ device_id: DEVICE_A }),
  });
  ok("unknown device is 404", missing.statusCode === 404);
  ok(
    "unknown device does not delete",
    !missingCalls.some((c) => c.method === "DELETE")
  );

  console.log("\nDelete tenant device: " + passed + " passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
