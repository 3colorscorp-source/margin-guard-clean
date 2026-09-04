#!/usr/bin/env node
/**
 * MG-SUPPORT-003E.2BC — joint release freeze (mocked session/DB/OpenAI).
 * Usage: node scripts/test-mg-support-003e-2bc.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { classifySupportIntent, isMyCasesQuestion } = require("../netlify/functions/_lib/mg-support/router");
const {
  CASE_SELECT,
  toDetail,
  toListItem,
  mapStatus,
} = require("../netlify/functions/_lib/mg-support/my-cases");
const {
  ACTIVE_STATUSES,
  parseUpdateBody,
  UPDATE_BODY_KEYS,
  TRANSITION_RPC,
} = require("../netlify/functions/_lib/mg-support/admin-cases");

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

function decodePath(p) {
  try {
    return decodeURIComponent(String(p || ""));
  } catch (_err) {
    return String(p || "");
  }
}

function caseRow(extra) {
  return Object.assign(
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "open",
      category: "possible_bug",
      subject: "Possible Margin Guard issue",
      question_excerpt: "Something broke.",
      support_module: "quote",
      related_entity_type: "none",
      related_entity_ref: null,
      created_at: "2026-08-28T20:00:00.000Z",
      updated_at: "2026-08-28T21:00:00.000Z",
      resolved_at: null,
      customer_resolution: "Historical fix.",
      tenant_action_message: "Historical ask.",
    },
    extra || {}
  );
}

function main() {
  const navSrc = read("public/js/mg-app-nav.js");
  const chatUiSrc = read("public/js/mg-support-chat.js");
  const adminUiSrc = read("public/js/support-admin.js");
  const adminHtml = read("public/support-admin.html");
  const helperSrc = read("netlify/functions/_lib/mg-support/admin-cases.js");
  const updateSrc = read("netlify/functions/mg-support-admin-update-case.js");
  const chatSrc = read("netlify/functions/mg-support-chat.js");
  const myCasesSrc = read("netlify/functions/_lib/mg-support/my-cases.js");
  const myCasesEndpoint = read("netlify/functions/mg-support-my-cases.js");
  const sqlSrc = read("SUPABASE_MG_SUPPORT_003E_2A_CASE_LIFECYCLE_OUTBOX.sql");
  const sqlVerify = read("SUPABASE_MG_SUPPORT_003E_2A_CASE_LIFECYCLE_OUTBOX_VERIFY.sql");

  assert(
    "1. RPC CAS uses loaded status and status_version",
    /p_expected_status: current/.test(helperSrc) &&
      /p_expected_status_version: version/.test(helperSrc) &&
      TRANSITION_RPC === "mg_support_transition_case"
  );
  assert("2. browser cannot supply status_version", !UPDATE_BODY_KEYS.has("status_version") && parseUpdateBody({ case_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", action: "resolve", status_version: 9 }).ok === false);
  assert("3. RPC stale_state does not retry mutation", /code === "stale_state"/.test(helperSrc) && /stale_state/.test(helperSrc + updateSrc + adminUiSrc) && !/conflictFromReload/.test(helperSrc));
  assert("4. conflict does not retry RPC", !/while\s*\(/.test(helperSrc) && (helperSrc.match(/await rpc\(/g) || []).length === 1 && (helperSrc.match(/await patch\(/g) || []).length === 0);
  assert("5. waiting validation before RPC", /action === "request_customer_action"/.test(helperSrc) && helperSrc.indexOf('action === "request_customer_action"') < helperSrc.indexOf("const rpc = queryRpc"));

  const open = toDetail(caseRow({ status: "open" }));
  const review = toDetail(caseRow({ status: "in_review" }));
  const waiting = toDetail(caseRow({ status: "waiting_on_customer", tenant_action_message: "Send the photo." }));
  const resolved = toDetail(caseRow({ status: "resolved", customer_resolution: "We restored the quote." }));
  assert(
    "6. open tenant serialization hides snapshots",
    open.customer_resolution === null && open.tenant_action_message === null && open.tenant_action_required === false
  );
  assert(
    "7. in_review tenant serialization hides snapshots",
    review.customer_resolution === null && review.tenant_action_message === null && review.tenant_action_required === false
  );
  assert(
    "8. waiting tenant serialization shows action only",
    waiting.customer_resolution === null &&
      waiting.tenant_action_required === true &&
      waiting.tenant_action_message === "Send the photo."
  );
  assert(
    "9. resolved tenant serialization shows resolution only",
    resolved.tenant_action_required === false &&
      resolved.tenant_action_message === null &&
      resolved.customer_resolution === "We restored the quote."
  );
  const listed = toListItem(caseRow({ status: "waiting_on_customer", tenant_action_message: "Send the photo.", customer_resolution: "We restored the quote." }));
  assert(
    "10. list omits action/resolution/version/ids",
    listed.status_label === "Waiting on You" &&
      !("tenant_action_message" in listed) &&
      !("customer_resolution" in listed) &&
      !("status_version" in listed) &&
      !("tenant_id" in listed) &&
      !("id" in listed)
  );
  assert("11. status_version not tenant-selected", !/status_version/.test(CASE_SELECT) && !("status_version" in open));
  assert("12. unknown remains unverified", mapStatus("closed").status === "unverified");

  assert("13. My Cases chat sources only My Cases", /sources: \["My Cases"\]/.test(chatSrc));
  assert(
    "14. known My Cases path does not call OpenAI",
    /intent === "my_cases"/.test(chatSrc) &&
      chatSrc.indexOf('intent === "my_cases"') < chatSrc.indexOf("const apiKey = getKey()")
  );
  assert(
    "15. case text not sent to OpenAI on My Cases",
    !/customer_resolution|tenant_action_message|question_excerpt/.test(
      chatSrc.slice(chatSrc.lastIndexOf('intent === "my_cases"'), chatSrc.indexOf("const apiKey = getKey()"))
    )
  );

  assert("16. mg-support-chat asset version is 004a", /SUPPORT_CHAT_ASSET_VERSION = '004a'/.test(navSrc));
  assert(
    "17. Support chat loader uses version query",
    /mg-support-chat\.js\?v=' \+ encodeURIComponent\(SUPPORT_CHAT_ASSET_VERSION\)/.test(navSrc)
  );
  assert("18. Support Admin JS cache-bust query is 004c", /src="\/js\/support-admin\.js\?v=004c"/.test(adminHtml));
  assert("19. admin case-derived rendering has no innerHTML", !/innerHTML/.test(adminUiSrc) && /textContent/.test(adminUiSrc) && /appendDl/.test(adminUiSrc));
  assert("20. tenant My Cases card/detail has no innerHTML", !/innerHTML/.test(chatUiSrc.slice(chatUiSrc.indexOf("function renderCaseCard"), chatUiSrc.indexOf("function renderCasesPanel"))));

  assert(
    "21. Active filter is open+in_review+waiting",
    ACTIVE_STATUSES.join(",") === "open,in_review,waiting_on_customer"
  );
  assert("22. Total KPI is all-rows count not open+resolved formula", /total: totalCount/.test(helperSrc) && !/openCount \+ resolvedCount/.test(helperSrc));
  assert("23. no outbox insert in E2.B/C", !/tenant_support_notification_outbox/.test(helperSrc + updateSrc + myCasesSrc + myCasesEndpoint + chatSrc));
  assert("24. no email/Zapier in E2.B/C write path", !/nodemailer|sendgrid|zapier/i.test(helperSrc + updateSrc + myCasesSrc + myCasesEndpoint));

  assert(
    "25. routing: show my support cases",
    classifySupportIntent("show my support cases") === "my_cases" && isMyCasesQuestion("show my support cases")
  );
  assert(
    "26. routing: exact MG-SUP is My Cases",
    classifySupportIntent("what is the status of case MG-SUP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") === "my_cases"
  );
  assert("27. routing: create a support case is not My Cases", classifySupportIntent("create a support case") !== "my_cases");
  assert("28. routing: resend invoice", classifySupportIntent("resend invoice INV-TEST-100") === "invoice_diagnostic");
  assert("29. routing: supervisor cannot pair device", classifySupportIntent("supervisor cannot pair device") === "device_pairing_diagnostic");
  assert(
    "30. routing: deposit button missing",
    classifySupportIntent("deposit button missing on public estimate for quote 2026-0141") === "deposit_cta_diagnostic"
  );
  assert("31. routing: supervisor cannot see project", classifySupportIntent("supervisor cannot see project") === "project_diagnostic");

  assert(
    "32. E2.A SQL files present and not executed by tests",
    /MG-SUPPORT-003E\.2A/.test(sqlSrc) &&
      /waiting_on_customer/.test(sqlSrc) &&
      /tenant_support_notification_outbox/.test(sqlSrc) &&
      /status_version/.test(sqlVerify)
  );
  assert("33. stale_state does not increment in UI retry", (adminUiSrc.match(/fetch\(UPDATE_API/g) || []).length === 1);
  assert("34. GET-only My Cases", /method !== "GET"/.test(myCasesEndpoint));

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main();
