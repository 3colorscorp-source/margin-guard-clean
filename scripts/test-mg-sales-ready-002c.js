#!/usr/bin/env node
/**
 * MG-SALES-READY-002C — password recovery requires password update
 * Usage: node scripts/test-mg-sales-ready-002c.js
 *
 * Mocked auth only. Does not call production, send email, or mutate passwords.
 */
"use strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "mg-sales-ready-002c-test-session-secret";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const recovery = require("../public/js/owner-recovery-auth.js");
const { createHandler: createRestoreHandler } = require("../netlify/functions/restore-owner-session");
const {
  buildSessionPayload,
  createSessionCookie,
  readSessionFromEvent,
} = require("../netlify/functions/_lib/session");
const { AUTH_FAILED } = require("../netlify/functions/_lib/owner-access");

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

function parse(res) {
  try {
    return JSON.parse(res.body || "{}");
  } catch (_err) {
    return {};
  }
}

function cookieFrom(res) {
  const raw = res.headers && (res.headers["Set-Cookie"] || res.headers["set-cookie"]);
  return raw ? String(raw) : "";
}

function sessionFromCookie(setCookie) {
  const match = /mg_session=([^;]+)/.exec(setCookie || "");
  if (!match) return null;
  return readSessionFromEvent({
    headers: { cookie: "mg_session=" + match[1] },
  });
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_EMAIL = "owner@example.com";
const SELLER_EMAIL = "seller@example.com";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY_HASH =
  "#access_token=test-token&refresh_token=test-refresh&type=recovery";
const INVITE_HASH = "#access_token=test-token&type=invite";

async function main() {
  const billingSrc = read("public/js/billing.js");
  const indexSrc = read("public/index.html");
  const inviteSrc = read("public/js/supervisor-invite.js");
  const restoreSrc = read("netlify/functions/restore-owner-session.js");
  const helperSrc = read("public/js/owner-recovery-auth.js");

  const hashFn = billingSrc.slice(
    billingSrc.indexOf("async function completeAuthHashIfPresent"),
    billingSrc.indexOf("async function saveNewPassword")
  );

  assert("1a. PASSWORD_RECOVERY is classified as recovery", recovery.isPasswordRecoveryEvent("PASSWORD_RECOVERY") && recovery.classifyAuthCallback(RECOVERY_HASH, "PASSWORD_RECOVERY") === "recovery");
  assert("1b. recovery hash is detected without minting", recovery.hashIndicatesRecovery(RECOVERY_HASH) && recovery.allowMintOwnerSession("recovery", false) === false);
  assert("2. hash callback function never mints mg_session", !/mintOwnerSession|restore-owner-session/.test(hashFn));
  assert("F. Forgot password UI exists", /Forgot password\?/.test(indexSrc) && /btnForgotPassword/.test(indexSrc) && /resetPasswordForEmail/.test(billingSrc));
  assert("F2. reset email redirect is login page not dashboard", recovery.recoveryRedirectTo("https://example.com") === "https://example.com/index.html" && !/dashboard\.html/.test(recovery.recoveryRedirectTo("https://example.com")));
  assert("UI recovery fields", /Reset your password/.test(indexSrc) && /New password/.test(indexSrc) && /Confirm new password/.test(indexSrc) && /Save new password/.test(indexSrc));
  assert("12. no auth token logged", !/console\.(log|info|debug|error)\([\s\S]{0,80}access_token/.test(billingSrc + helperSrc) && !/console\.(log|info)\([\s\S]{0,40}password/.test(billingSrc));
  assert("13. no password stored by Margin Guard", !/localStorage[\s\S]{0,40}password/.test(billingSrc) && /updateUser\(\{ password/.test(helperSrc));
  assert("invite classified separately", recovery.classifyAuthCallback(INVITE_HASH, "SIGNED_IN") === "invite" && recovery.allowMintOwnerSession("invite", false) === false);
  assert("supervisor invite still requires updateUser before link", /updateUser\(\{ password \}\)/.test(inviteSrc) && !/restore-owner-session/.test(inviteSrc));
  assert("002B restore still Bearer-only", /Authorization:\s*["']Bearer /.test(billingSrc) && !/restore-owner-session[\s\S]{0,80}\{ email \}/.test(billingSrc));
  assert("normal login still signInWithPassword then restore", /signInWithPassword/.test(billingSrc) && /restore-owner-session/.test(billingSrc));

  const mismatch = recovery.validateNewPassword("newpass99", "otherpass99");
  assert("3. password mismatch rejected", mismatch.ok === false && mismatch.error === "password_mismatch");

  let minted = 0;
  let updateCalls = 0;
  const mismatchFlow = await recovery.completePasswordEstablishment({
    password: "newpass99",
    confirm: "nope-nope",
    updateUser: async () => {
      updateCalls += 1;
      return {};
    },
    getSession: async () => ({ access_token: "tok" }),
    mintOwnerSession: async () => {
      minted += 1;
    },
  });
  assert("3b. mismatch does not call updateUser or mint", mismatchFlow.minted === false && updateCalls === 0 && minted === 0);

  let minted2 = 0;
  const updateFail = await recovery.completePasswordEstablishment({
    password: "newpass99",
    confirm: "newpass99",
    updateUser: async () => ({ error: { message: "rejected" } }),
    getSession: async () => ({ access_token: "tok" }),
    mintOwnerSession: async () => {
      minted2 += 1;
    },
  });
  assert("4. update failure does not mint mg_session", updateFail.ok === false && updateFail.error === "update_failed" && minted2 === 0);

  let mintedToken = "";
  let updatedPassword = "";
  const success = await recovery.completePasswordEstablishment({
    password: "brand-new-pass",
    confirm: "brand-new-pass",
    updateUser: async (payload) => {
      updatedPassword = String(payload.password || "");
      return {};
    },
    getSession: async () => ({ access_token: "post-update-jwt" }),
    mintOwnerSession: async (token) => {
      mintedToken = String(token || "");
    },
  });
  assert("5. successful update then owner session mint", success.ok === true && success.minted === true && mintedToken === "post-update-jwt");
  assert("5b. new password sent to updateUser not the old password", updatedPassword === "brand-new-pass" && updatedPassword !== "old-password");
  assert("1c. recovery still blocked until passwordUpdated", recovery.allowMintOwnerSession("recovery", false) === false && recovery.allowMintOwnerSession("recovery", true) === true);

  const expired = await recovery.completePasswordEstablishment({
    password: "newpass99",
    confirm: "newpass99",
    updateUser: async () => ({ error: { message: "invalid" } }),
    getSession: async () => null,
    mintOwnerSession: async () => {
      throw new Error("must not mint");
    },
  });
  assert("7. invalid/expired recovery does not authenticate", expired.minted === false && expired.ok === false);

  const consumed = await recovery.completePasswordEstablishment({
    password: "newpass99",
    confirm: "newpass99",
    updateUser: async () => ({}),
    getSession: async () => null,
    mintOwnerSession: async () => {
      throw new Error("must not mint");
    },
  });
  assert("6. consumed/missing session after update does not mint", consumed.ok === false && consumed.error === "session_lost" && consumed.minted === false);

  const ownerRes = await createRestoreHandler({
    verifySupabaseAccessToken: async (token) => {
      if (token !== "post-update-jwt") return { ok: false };
      return { ok: true, email: OWNER_EMAIL, userId: OWNER_ID };
    },
    resolveUniqueActiveOwnerAccess: async (email) => {
      if (email !== OWNER_EMAIL) return { ok: false };
      return {
        ok: true,
        tenant: { id: TENANT_A, owner_email: OWNER_EMAIL, plan_status: "active" },
        profile: { id: "p-owner", tenant_id: TENANT_A, email: OWNER_EMAIL, role: "owner", status: "active" },
      };
    },
    linkProfileAuthUserOnLogin: async () => ({}),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer post-update-jwt" },
    body: JSON.stringify({ tenant_id: TENANT_B, email: "attacker@example.com" }),
  });
  const ownerSession = sessionFromCookie(cookieFrom(ownerRes));
  assert("3c. successful update JWT can mint owner session", ownerRes.statusCode === 200 && parse(ownerRes).ok === true);
  assert("11. tenant_id remains server-derived", ownerSession && ownerSession.t === TENANT_A && ownerSession.t !== TENANT_B);
  assert("9. restore still rejects email-only body", !/body\.email/.test(restoreSrc));

  const sellerRes = await createRestoreHandler({
    verifySupabaseAccessToken: async () => ({ ok: true, email: SELLER_EMAIL, userId: "u-seller" }),
    resolveUniqueActiveOwnerAccess: async () => ({ ok: false }),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer seller-recovery-jwt" },
    body: "{}",
  });
  assert(
    "10. seller/supervisor recovery JWT cannot become owner",
    sellerRes.statusCode === 401 && parse(sellerRes).error === AUTH_FAILED && !cookieFrom(sellerRes)
  );

  const randomRes = await createRestoreHandler({
    verifySupabaseAccessToken: async () => ({ ok: true, email: "nobody@example.test", userId: "u-rand" }),
    resolveUniqueActiveOwnerAccess: async () => ({ ok: false }),
  })({
    httpMethod: "POST",
    headers: { Authorization: "Bearer random-jwt" },
    body: "{}",
  });
  assert("8. random email cannot trigger owner login", randomRes.statusCode === 401 && !cookieFrom(randomRes));

  assert("normal login helper allows mint without recovery classification", recovery.allowMintOwnerSession("none", false) === true);
  assert("blocked hash cannot mint", recovery.allowMintOwnerSession("blocked_hash", false) === false);

  const zisiCandidates = [
    path.join(
      ROOT,
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    ),
    path.join(
      "C:\\Margin Guard System\\margin-guard-clean",
      ".qa-ch013a48/netlify-cli-pkg/node_modules/netlify-cli/node_modules/@netlify/zip-it-and-ship-it/dist/main.js"
    ),
  ];
  const zisiPath = zisiCandidates.find((p) => fs.existsSync(p));
  const fnDir = path.join(ROOT, "netlify/functions");
  if (zisiPath) {
    const { listFunctions } = await import(pathToFileURL(zisiPath).href);
    const listed = await listFunctions(fnDir);
    const names = (listed || []).map((fn) => fn.name);
    assert("bundle includes restore-owner-session", names.includes("restore-owner-session"));
    assert("bundle still omits create-platform-customer", !names.includes("create-platform-customer"));
  } else {
    const fnFiles = fs.readdirSync(fnDir);
    assert("bundle includes restore-owner-session", fnFiles.includes("restore-owner-session.js"));
    assert("bundle still omits create-platform-customer", !fnFiles.includes("create-platform-customer.js"));
  }

  console.log("");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
