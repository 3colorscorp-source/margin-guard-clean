# Core Security Shield V1 — Phase 0 audit

Read-only audit of Margin Guard Core Security at `origin/main` SHA `56924e1351258d616614f76d115534fb6e879890`.

This document is evidence and recommendations only. Core Security Shield V1 does **not** change product behavior, apply SQL, rotate secrets, merge, or implement Core Security Shield V2.

## What was verified

| Area | How | Result |
|------|-----|--------|
| Owner `mg_session` HMAC, expiry, tamper, malformed payload | Live calls to `session.js` with dummy `SESSION_SECRET` | Valid accepted; invalid/expired/tampered/malformed rejected |
| Modern owner `email + tenant` vs legacy `email + session.c` | `hasOwnerSessionIdentity`, `requireOwnerMembership`, `resolveTenantFromSession` | Modern e+t works for owner membership; legacy e+c still resolves an entitled tenant |
| Inactive membership / inactive plan / wrong role | Mocked `profiles` + `tenants` | Rejected |
| Device session revoke / inactive / tenant mismatch / membership mismatch | Mocked `device_sessions` + `tenant_devices` + `profiles` | Rejected |
| Wrong seller/supervisor portal | `requireSellerDevice` / `requireSupervisorDevice` | `portal_type_forbidden` |
| Unassigned supervisor | `assertAssignedSupervisorProject` | `supervisor_not_assigned` |
| Seller reading another seller's quote | `assertSellerOwnQuote` | `seller_quote_forbidden` |
| Owner A vs tenant B IDs in query/body | `list-tenant-payments` + `resolveTenantFromSession` | Tenant always derived from authenticated session |
| Platform admin vs tenant owner | `assertPlatformAdminSession` | Owner with `is_admin=false` denied |
| Service-role key not sent to browser | `get-supabase-public-config` + scan of `public/` | Only URL + anon key |
| Square HMAC | `square-webhook-signature.js` | Missing/wrong/altered/wrong-secret rejected; timing-safe |
| Stripe local HMAC | `stripe-invoice-webhook.js` handler | Missing/wrong/altered/wrong-secret rejected; **no replay window** (finding) |
| Server-side pricing | `pricing-engine.js` | Client `rate: 1` cannot reduce protected labor totals |
| Bank details | `list-tenant-bank-accounts` | No session → 401; response is `id` + masked/label only |
| 24 heuristic-marked handlers | Explicit inventory in `scripts/mg-core-security-shield-v1.json` | Classified below; **not** added to the substring allowlist |

## What was **not** verified

- **PRODUCTION_RLS_NOT_VERIFIED.** No authorized read-only production Supabase access was configured in this environment. Presence of `ENABLE ROW LEVEL SECURITY` in SQL files is **not** a production PASS.
- Live Netlify, Zapier, Stripe, Square, or SendGrid.
- Runtime grants/`USING (true)` on the production database.
- `SECURITY DEFINER` `search_path` on production functions.

## Severity summary

| Severity | Count | Items |
|----------|-------|--------|
| High (document only; separate PR) | 2 | `resolveOwnerOrSupervisorContext` still requires `session.c`; contract Owner/Admin handlers still require `session.c` |
| Medium (document only; separate PR) | 4 | Estimates Zapier HMAC still compatibility-mode (not fail-closed); Stripe local verifier has no timestamp/replay window; `send-quote-zapier` logs recipients/emails; no global CSP/HSTS |
| Low / informational | 3 | Historical `rls_disabled_in_public` not in current source; historical SendGrid alert not verifiable from code; substring tenant-scope verifier is insufficient (24 false negatives vs explicit inventory) |
| Confirmed controls (not vulnerabilities) | 24 handlers | See classification |

Do **not** treat any of the High/Medium items as fixed by this PR.

## 24 handlers marked by `verify-netlify-function-tenant-scope.js`

The substring heuristic currently **fails** these 24 files on `origin/main`. Core Security Shield V1 classifies them from real controls. They were **not** added to `scripts/netlify-function-tenant-scope-allowlist.json`.

| Handler | Category |
|---------|----------|
| `admin-saas-square-dry-run.js` | `PLATFORM_ADMIN_ONLY` |
| `contract-certificate-create.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-certificates.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-envelope-create.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-envelope-send.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-envelopes.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-package-freeze.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signed-pdf-create.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signed-pdfs.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signer-create.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signer-delete.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signer-update.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signers.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signing-token-create.js` | `TENANT_SCOPED_CONFIRMED` |
| `contract-signing-token-revoke.js` | `TENANT_SCOPED_CONFIRMED` |
| `create-financial-connections-session.js` | `TENANT_SCOPED_CONFIRMED` |
| `device-logout.js` | `TENANT_SCOPED_CONFIRMED` |
| `get-tenant-quote-edit.js` | `TENANT_SCOPED_CONFIRMED` |
| `get-tenant-webhook-secret.js` | `INTERNAL_SECRET_AUTH` |
| `invite-supervisor-auth.js` | `TENANT_SCOPED_CONFIRMED` |
| `link-membership-auth.js` | `TENANT_SCOPED_CONFIRMED` |
| `list-tenant-payments.js` | `TENANT_SCOPED_CONFIRMED` |
| `sales-approval-email-action.js` | `DOCUMENTED_EXCEPTION` |
| `square-saas-webhook.js` | `SIGNED_WEBHOOK` |

Counts: 20 `TENANT_SCOPED_CONFIRMED`, 1 `PLATFORM_ADMIN_ONLY`, 1 `INTERNAL_SECRET_AUTH`, 1 `DOCUMENTED_EXCEPTION`, 1 `SIGNED_WEBHOOK`, 0 `PUBLIC_TOKEN_SCOPED`, 0 `VULNERABILITY_REQUIRES_SEPARATE_PR` in this set.

`sales-approval-email-action.js` is a legacy email capability token (`approval_id` + SHA-256 compared timing-safe to `email_action_token_hash`). That is the real control; it is not tenant-session scoped.

## Findings to fix in separate PRs (do not fix here)

1. **Estimates Zapier outbound HMAC Phase 1.** `send-quote-zapier.js` and `resend-tenant-quote.js` sign with Invoice Hub v1 (`timestamp.nonce.JSON`) when `ZAPIER_WEBHOOK_SECRET` is set (`ESTIMATES_HMAC_PHASE1_COMPATIBILITY_MODE`). Missing secret still sends unsigned. Phase 2 fail-closed is a separate PR.
2. **`resolveOwnerOrSupervisorContext()` still depends on `session.c`.** Owner path is `session?.e && session?.c` (`tenant-device-guard.js`). Seller dual-auth already uses `hasOwnerSessionIdentity`. Recommendation: align the supervisor dual-auth owner path; freeze with a test that currently documents the fail-closed modern `e+t` miss.
3. **Contract `requireOwnerOrAdmin` still requires `session.c`.** Same legacy gate. Recommendation: switch to `hasOwnerSessionIdentity` in a Contracts PR.
4. **Stripe local verifier has no replay/timestamp window.** `verifyStripeSignature` checks HMAC only. Recommendation: reject `t` outside ±5 minutes in a webhooks PR.
5. **Historical SendGrid exposure.** No SendGrid key remains in the tree. Rotation is **not verifiable from code**.
6. **No global CSP/HSTS.** `netlify.toml` has neither `Content-Security-Policy` nor `Strict-Transport-Security`.
7. **Logging of additional recipients** in `send-quote-zapier.js` (`additional_recipients`, `client_email`).
8. **Historical Supabase `rls_disabled_in_public`.** Not present in current source. Production policies were not inspected live.

## Service role

`SUPABASE_SERVICE_ROLE_KEY` is used from Netlify functions via `_lib/supabase-admin.js`. Browser config returns only `supabaseUrl` and `supabaseAnonKey`. A browser-supplied `tenant_id` is not treated as authority in the inventoried handlers: tenant comes from session, device session, verified public token, signed webhook, platform admin, or internal secret.

## Existing shields

Seller Shield V1, Owner Shield V1, and Invoice Hub Shield V2 were not renamed, weakened, or copied. Core Security Shield V1 runs their canonical runners in CI.
