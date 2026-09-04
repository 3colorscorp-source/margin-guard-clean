#!/usr/bin/env node
/**
 * MG-SUPPORT-004C — Support Admin full-screen case review modal (UI only).
 * Usage: node scripts/test-mg-support-004c.js
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
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");

  assert(
    "1. Support Inbox loads without permanent detail pane",
    /id="siInbox"/.test(html) &&
      /id="siList"/.test(html) &&
      !/class="si-workspace"/.test(html) &&
      !/grid-template-columns: minmax\(300px, 34%\)/.test(css) &&
      /id="siDrawer"[\s\S]*hidden/.test(html)
  );
  assert(
    "2. clicking case opens modal",
    /state\.selected = state\.cases\.find/.test(uiSrc) &&
      /renderDrawer\(\)/.test(uiSrc) &&
      /drawer\.hidden = false/.test(uiSrc) &&
      /role="dialog"/.test(html)
  );
  assert(
    "3. modal uses nearly full viewport on desktop",
    /width: min\(98vw, 1800px\)/.test(css) &&
      /height: 95dvh/.test(css) &&
      !/max-width:\s*700px/.test(css) &&
      !/max-width:\s*900px/.test(css) &&
      !/width: min\(420px/.test(css)
  );
  assert(
    "4. background is dimmed",
    /si-modal-backdrop/.test(css) &&
      /rgba\(0, 0, 0, 0\.72\)/.test(css) &&
      /backdrop\.hidden = false/.test(uiSrc)
  );
  assert(
    "5. background page does not scroll while modal is open",
    /lockBodyScroll/.test(uiSrc) &&
      /si-modal-open/.test(css) &&
      /overflow: hidden/.test(css)
  );
  assert(
    "6. modal content can scroll",
    /si-modal__body/.test(css) && /overflow: auto/.test(css)
  );
  assert(
    "7. original customer issue is prominently displayed",
    /Customer issue/.test(html) &&
      /id="siQuestionText"/.test(html) &&
      /si-issue/.test(css) &&
      /setText\("siQuestionText"/.test(uiSrc)
  );
  assert(
    "8. Close works",
    /id="siDrawerClose"/.test(html) && /requestCloseModal/.test(uiSrc)
  );
  assert(
    "9. Escape works safely",
    /ev\.key === "Escape"/.test(uiSrc) &&
      /hasUnsavedWork/.test(uiSrc) &&
      /Discard unsaved message text/.test(uiSrc)
  );
  assert(
    "10. focus remains trapped in modal",
    /trapFocus/.test(uiSrc) && /ev\.key !== "Tab"/.test(uiSrc)
  );
  assert(
    "11. focus returns to selected case after closing",
    /restoreCaseFocus/.test(uiSrc) && /lastFocusCaseId/.test(uiSrc)
  );
  assert(
    "12. Mark In Review still works",
    /updateCase\("mark_in_review"\)/.test(uiSrc) && /id="siMarkInReview"/.test(html)
  );
  assert(
    "13. Request Customer Action still works",
    /updateCase\("request_customer_action"\)/.test(uiSrc) && /id="siRequestAction"/.test(html)
  );
  assert(
    "14. Mark Resolved still works",
    /updateCase\("resolve"\)/.test(uiSrc) && /id="siResolve"/.test(html)
  );
  assert(
    "15. required tenant message validation unchanged",
    /Enter what the tenant needs to do before requesting customer action/.test(uiSrc) &&
      /action === "request_customer_action"/.test(uiSrc)
  );
  assert(
    "16. CAS/status_version payload unchanged",
    /JSON\.stringify\(body\)/.test(uiSrc) &&
      !/status_version/.test(uiSrc) &&
      /p_expected_status_version/.test(helperSrc)
  );
  assert(
    "17. no backend behavior changed",
    /HMAC mg_session \+ public.users.is_admin/.test(listSrc) &&
      /Closed PATCH via atomic RPC/.test(updateSrc) &&
      /assertPlatformAdminSession/.test(listSrc) &&
      /assertPlatformAdminSession/.test(updateSrc)
  );
  assert(
    "18. mobile becomes full-screen",
    /@media \(max-width: 767px\)/.test(css) &&
      /width: 100vw/.test(css) &&
      /height: 100dvh/.test(css) &&
      /border-radius: 0/.test(css)
  );
  assert("20. no DB migration in this task", !/CREATE TABLE|ALTER TABLE/i.test(html + uiSrc));
  assert("sticky header", /si-modal__header/.test(css) && /flex: 0 0 auto/.test(css));
  assert("sticky footer actions", /si-modal__footer/.test(html) && /siMarkInReview/.test(html));
  assert("dialog semantics", /aria-modal="true"/.test(html) && /aria-labelledby="siDrawerTitle"/.test(html));
  assert("safest close is X and Escape, not backdrop", !/siBackdrop"\) \$\("siBackdrop"\)\.addEventListener\("click", closeDrawer\)/.test(uiSrc));
  assert("no page reload on case change", !/location\.reload/.test(uiSrc));
  assert("cache-bust 004c", /support-admin\.js\?v=004c/.test(html));
  assert("004A detector still present", /isExplicitUnresolvedSupportRequest/.test(chatSrc));
  assert("create-case allowlist unchanged", /ALLOWED_KEYS = new Set\(\["confirmation_token", "confirmed"\]\)/.test(createSrc));
  assert("19b. admin UI does not call sweep", !/notification-sweep|notification-delivery|outbox/.test(uiSrc));
  assert("sweep helper still present", /mg-support-case-notification-sweep/.test(sweepSrc));
  assert("canonical /support-admin", /support-admin/.test(read("netlify.toml")));
  assert("no utm query authority", !/utm_source/.test(uiSrc + html) && !/queryStringParameters/.test(uiSrc));

  const { isExplicitUnresolvedSupportRequest } = require("../netlify/functions/_lib/mg-support/case-intake");
  assert(
    "19c. 004A detector still offers cases",
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
