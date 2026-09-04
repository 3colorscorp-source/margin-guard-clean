#!/usr/bin/env node
/**
 * MG-SUPPORT-004B — Support Admin full-width two-pane workspace (UI only).
 * Usage: node scripts/test-mg-support-004b.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

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

function extractCss(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : "";
}

async function main() {
  const html = read("public/support-admin.html");
  const uiSrc = read("public/js/support-admin.js");
  const css = extractCss(html);
  const listSrc = read("netlify/functions/mg-support-admin-list-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const createSrc = read("netlify/functions/mg-support-create-case.js");
  const sweepSrc = read("netlify/functions/_lib/mg-support/notification-sweep.js");
  const deliverySrc = read("netlify/functions/_lib/mg-support/notification-delivery.js");

  assert(
    "1. desktop no longer uses narrow overlay drawer or split pane",
    /width: min\(98vw, 1800px\)/.test(css) &&
      /role="dialog"/.test(html) &&
      /aria-modal="true"/.test(html) &&
      !/grid-template-columns: minmax\(300px, 34%\) minmax\(520px, 66%\)/.test(css)
  );
  assert("1b. shell uses nearly full viewport width", /width: min\(calc\(100% - 32px\), 1600px\)/.test(css));
  assert(
    "2. inbox list exists without permanent detail pane",
    /id="siInbox"/.test(html) &&
      /id="siDrawer"/.test(html) &&
      /id="siList"/.test(html) &&
      !/class="si-workspace"/.test(html)
  );
  assert(
    "3. selected case appears in case modal",
    /si-row--selected/.test(uiSrc) && /siDrawerTitle/.test(uiSrc) && /id="siWorkspaceMain"/.test(html)
  );
  assert(
    "4. changing selected case updates workspace without reload",
    /state\.selected = state\.cases\.find/.test(uiSrc) &&
      /renderDrawer\(\)/.test(uiSrc) &&
      !/location\.reload/.test(uiSrc)
  );
  assert(
    "5. Request Customer Action still works",
    /updateCase\("request_customer_action"\)/.test(uiSrc) && /id="siRequestAction"/.test(html)
  );
  assert(
    "6. Mark In Review still works",
    /updateCase\("mark_in_review"\)/.test(uiSrc) && /id="siMarkInReview"/.test(html)
  );
  assert(
    "7. Mark Resolved still works",
    /updateCase\("resolve"\)/.test(uiSrc) && /id="siResolve"/.test(html)
  );
  assert(
    "8. required tenant-action validation remains",
    /Enter what the tenant needs to do before requesting customer action/.test(uiSrc) &&
      /action === "request_customer_action"/.test(uiSrc)
  );
  assert(
    "9. status_version/CAS payload remains unchanged",
    /JSON\.stringify\(body\)/.test(uiSrc) &&
      !/status_version/.test(uiSrc) &&
      /p_expected_status_version/.test(read("netlify/functions/_lib/mg-support/admin-cases.js"))
  );
  assert(
    "10. no new tenant-controlled authority",
    !/queryStringParameters/.test(uiSrc) &&
      !/utm_source/.test(uiSrc + html) &&
      /credentials: "include"/.test(uiSrc)
  );
  assert(
    "11. platform admin authorization remains required",
    /assertPlatformAdminSession/.test(listSrc) &&
      /assertPlatformAdminSession/.test(updateSrc) &&
      /data\.is_admin !== true/.test(uiSrc)
  );
  assert(
    "12. mobile remains usable",
    /@media \(max-width: 767px\)/.test(css) &&
      /siDrawerClose/.test(html) &&
      /id="siActionMessageInput"/.test(html) &&
      /id="siResolve"/.test(html)
  );
  assert(
    "13. no backend Support behavior changed in this UI task",
    /HMAC mg_session \+ public.users.is_admin/.test(listSrc) &&
      /Closed PATCH via atomic RPC/.test(updateSrc)
  );
  assert("empty state is not a permanent detail pane", !/Select a support case to review its details/.test(html));
  assert("modal body scrolls independently", /si-modal__body/.test(css) && /overflow: auto/.test(css));
  assert("wide textareas", /min-height: 140px/.test(css));
  assert("canonical /support-admin remains", /support-admin/.test(read("netlify.toml")));
  assert("004A chat detector still present", /isExplicitUnresolvedSupportRequest/.test(chatSrc));
  assert("create-case allowlist unchanged", /ALLOWED_KEYS = new Set\(\["confirmation_token", "confirmed"\]\)/.test(createSrc));
  assert("14. notification sweep still present", /mg-support-case-notification-sweep/.test(sweepSrc));
  assert("14b. admin UI does not call outbox", !/notification-sweep|notification-delivery|outbox/.test(uiSrc));
  assert("delivery helper still present", /OUTBOX_TABLE/.test(deliverySrc));
  assert("list API path unchanged", /mg-support-admin-list-cases/.test(uiSrc));
  assert("update API path unchanged", /mg-support-admin-update-case/.test(uiSrc));
  assert("cache-bust 004d", /support-admin\.js\?v=004d/.test(html));

  const { isExplicitUnresolvedSupportRequest } = require("../netlify/functions/_lib/mg-support/case-intake");
  assert(
    "15. 004A detector still offers cases",
    isExplicitUnresolvedSupportRequest("Necesito soporte porque el problema continúa.") === true
  );

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
