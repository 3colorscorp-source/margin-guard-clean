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
| Stripe local HMAC + replay window | `stripe-invoice-webhook.js` handler | Missing/wrong/altered/wrong-secret/expired/future rejected; valid `t=` required; ±300s window; timing-safe `v1` |
| Server-side pricing | `pricing-engine.js` | Client `rate: 1` cannot reduce protected labor totals |
| Bank details | `list-tenant-bank-accounts` | No session → 401; response is `id` + masked/label only |
| 10 remaining heuristic-marked handlers | Explicit inventory in `scripts/mg-core-security-shield-v1.json` | Classified below; **not** added to the substring allowlist. 14 Contract handlers now use shared `requireOwnerOrAdmin` and no longer fail the substring heuristic |

## What was **not** verified

- **PRODUCTION_RLS_NOT_VERIFIED.** No authorized read-only production Supabase access was configured in this environment. Presence of `ENABLE ROW LEVEL SECURITY` in SQL files is **not** a production PASS.
- Live Netlify, Zapier, Stripe, Square, or SendGrid.
- Runtime grants/`USING (true)` on the production database.
- `SECURITY DEFINER` `search_path` on production functions.

## Severity summary

| Severity | Count | Items |
|----------|-------|--------|
| High (document only; separate PR) | 0 | — |
| Medium (document only; separate PR) | 0 | — |
| Low / informational | 3 | Historical `rls_disabled_in_public` not in current source; historical SendGrid alert not verifiable from code; substring tenant-scope verifier is insufficient (10 remaining false negatives vs explicit inventory) |
| Confirmed controls (not vulnerabilities) | 10 remaining heuristic-marked handlers | 14 Contract handlers now use shared `requireOwnerOrAdmin` |

Do **not** treat remaining High/Medium items as fixed by later PRs until those PRs land.

## 10 handlers still marked by `verify-netlify-function-tenant-scope.js`

The substring heuristic currently **fails** these 10 files. Core Security Shield V1 classifies them from real controls. They were **not** added to `scripts/netlify-function-tenant-scope-allowlist.json`.

14 Contract Owner/Admin handlers (`contract-certificate-*`, `contract-envelope-*`, `contract-envelopes.js`, `contract-package-freeze.js`, `contract-signed-pdf*`, `contract-signer*`, `contract-signing-token-*`) now use shared `requireOwnerOrAdmin` (`hasOwnerSessionIdentity` + `resolveTenantFromSession`). They no longer fail the substring heuristic because the handler files no longer call `supabaseRequest` directly. Isolation for those handlers is frozen in `scripts/test-core-contract-modern-owner-session.js`.

| Handler | Category |
|---------|----------|
| `admin-saas-square-dry-run.js` | `PLATFORM_ADMIN_ONLY` |
| `create-financial-connections-session.js` | `TENANT_SCOPED_CONFIRMED` |
| `device-logout.js` | `TENANT_SCOPED_CONFIRMED` |
| `get-tenant-quote-edit.js` | `TENANT_SCOPED_CONFIRMED` |
| `get-tenant-webhook-secret.js` | `INTERNAL_SECRET_AUTH` |
| `invite-supervisor-auth.js` | `TENANT_SCOPED_CONFIRMED` |
| `link-membership-auth.js` | `TENANT_SCOPED_CONFIRMED` |
| `list-tenant-payments.js` | `TENANT_SCOPED_CONFIRMED` |
| `sales-approval-email-action.js` | `DOCUMENTED_EXCEPTION` |
| `square-saas-webhook.js` | `SIGNED_WEBHOOK` |

Counts: 6 `TENANT_SCOPED_CONFIRMED`, 1 `PLATFORM_ADMIN_ONLY`, 1 `INTERNAL_SECRET_AUTH`, 1 `DOCUMENTED_EXCEPTION`, 1 `SIGNED_WEBHOOK`, 0 `PUBLIC_TOKEN_SCOPED`, 0 `VULNERABILITY_REQUIRES_SEPARATE_PR` in this set.

`sales-approval-email-action.js` is a legacy email capability token (`approval_id` + SHA-256 compared timing-safe to `email_action_token_hash`). That is the real control; it is not tenant-session scoped.

## Findings to fix in separate PRs (do not fix here)

1. **Estimates Zapier outbound HMAC fail-closed + Catch Hook verifier + server verifier (Zapier v15).** `send-quote-zapier.js` and `resend-tenant-quote.js` require HMAC v1 (`timestamp.nonce.JSON`), timestamp, nonce, and `zapier_signed_payload` before POSTing to the Catch Hook (`ESTIMATES_HMAC_FAIL_CLOSED`). If a Zapier URL is configured and the secret is missing, the webhook is not sent and the handler fails closed with a generic response. Missing URL on send still skips outbound (`skipped_no_webhook_url`); resend without URL still returns `zapier_not_configured`. `verify-estimates-zapier-hmac.js` verifies `zapier_signed_payload` server-side from Netlify env only (Zapier does not store the secret). Authorized outputs are `signature_valid`, `final_to`, `final_additional_recipients`, `final_from_name`, `final_subject`, and `final_body`, taken only from the signed JSON. Flattened Catch Hook `client_email` / `additional_recipients` / `business_name` cannot redirect a signed quote or spoof the From name. Catch Hook does not keep the raw body or `X-MG-*` headers (`docs/CH-013A21Z-ZAPIER-CONTRACT-EMAIL.md`).
2. **`resolveOwnerOrSupervisorContext()` accepts modern owner sessions.** Owner path uses `hasOwnerSessionIdentity` (email + tenant, or legacy email + `session.c`). Supervisor device path is unchanged. Seller dual-auth is unchanged.
3. **Contract and remaining equivalent Owner/Admin gates accept modern owner sessions.** Shared `requireOwnerOrAdmin` uses `hasOwnerSessionIdentity` (email + tenant, or legacy email + `session.c`). Contacts, quote resend/reprice, and project contract/intelligence/payment-intent handlers reuse that helper. Sales Admin / Platform Admin gates are unchanged. Seller, supervisor device, and incomplete sessions are not owner identity. `upsert-tenant-contact.js` keeps its seller-device create fallback after the owner gate fails.
4. **Stripe local verifier rejects replayed signatures.** `verifyStripeSignature` requires a valid unix `t=` in `Stripe-Signature`, HMAC over `` `${t}.${rawBody}` ``, timing-safe compare of one or more `v1` signatures, and `|t - now| <= 300` seconds. Future timestamps outside that tolerance are rejected. The clock is injectable only via the test hook; headers, body, and query cannot bypass the window.
5. **Historical SendGrid exposure.** No SendGrid key remains in the tree. Rotation is **not verifiable from code**.
6. **Global CSP/HSTS/Permissions-Policy.** `netlify.toml` `/*` sends `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no `preload`), `Content-Security-Policy: object-src 'none'; base-uri 'self'; frame-ancestors 'none'`, and `Permissions-Policy: microphone=(self), camera=(), geolocation=()`. `script-src`/`style-src` are not set so existing inline scripts, Google Fonts, and jsDelivr stay intact. `microphone=(self)` is required for Seller/Owner `SpeechRecognition` voice. Camera and geolocation stay blocked because no public HTML/JS uses those APIs. Function CORS/`Cache-Control` are not set in this global block.
7. **Estimate send/resend logs redact recipient PII.** `send-quote-zapier.js` and `resend-tenant-quote.js` log only operational metadata via `ops-log.js` (event, status, counts, codes, request id). Recipients, `additional_recipients`, full payloads, public/PDF URLs, signatures, nonces, and secrets are not logged.
8. **Historical Supabase `rls_disabled_in_public`.** Not present in current source. Production policies were not inspected live.
9. **Remaining special gates accept modern owner sessions without collapsing groups.** Project Control (14), sales approval (3), supervisor assignment (1), and logo upload use `hasOwnerSessionIdentity` (email + tenant, or legacy email + `session.c`). They are **not** routed through shared `requireOwnerOrAdmin` because responses and roles differ: Project Control uses 401/404 and three financial handlers stay owner-only; `create-sales-approval.js` keeps HTTP 200 `{ ok: false, stage: "session" }`; get/update sales keep 401/422; logo resolves tenant via `resolveTenantFromSession` (owner membership), not stripe-customer lookup. Seller, Supervisor, incomplete `e`-only, and other-tenant IDs are denied. Frozen in `scripts/test-core-remaining-special-gates.js`.
10. **Estimate PDFs are no longer emailed as public storage URLs.** `send-quote-zapier.js` still uploads to `estimate-pdfs` with `public: false` on create-if-missing and never PATCHes an existing production bucket. New `pdf_url` values are `/.netlify/functions/get-estimate-pdf?token=&path=&sig=`. The public token HMAC-binds that quote to the canonical object path, so a valid token cannot open another PDF in the same tenant. Owner/Seller sessions are tenant-scoped after role checks (modern `e+t`, legacy `e+c`, valid seller device). Supervisor and other-tenant seller devices are denied. Traversal is rejected, the bucket is server-side `estimate-pdfs`, signed URLs expire in 60s, and responses send `Cache-Control: private, no-store`. Frozen in `scripts/test-core-estimate-pdf-access.js`. The CORE SECURITY TEST path was used only as a fixture; customer PDFs were not fetched.
11. **Final privatize of `estimate-pdfs` is SQL-gated and not applied here.** `SUPABASE_MG_CORE_SECURITY_PRIVATE_ESTIMATE_PDFS.sql` updates only `storage.buckets.public` for `id = name = estimate-pdfs` to `false`. Verify and rollback exist. No `CREATE POLICY`, no GRANT to `anon`/`authenticated`. Writes and `createSignedUrl` stay Netlify `service_role`. `tenant-logos` stays public. `contract-signed-pdfs` stays private. **Historical impact:** emails and attachments that already stored `/storage/v1/object/public/estimate-pdfs/{tenant}/{date}/{file}.pdf` will stop loading once that SQL is applied. Local copies and mail-client attachments already downloaded keep working. New send emails using `get-estimate-pdf?token=&path=&sig=` keep working. The public estimate HTML page (`estimate-public.html?token=`) is not a Storage URL and stays available. Resend still sends `pdf_url: ""` (no PDF URL). Frozen in `scripts/test-core-private-estimate-pdfs.js`. Production bucket is not flipped by this PR.

## Service role

`SUPABASE_SERVICE_ROLE_KEY` is used from Netlify functions via `_lib/supabase-admin.js`. Browser config returns only `supabaseUrl` and `supabaseAnonKey`. A browser-supplied `tenant_id` is not treated as authority in the inventoried handlers: tenant comes from session, device session, verified public token, signed webhook, platform admin, or internal secret.

## Existing shields

Seller Shield V1, Owner Shield V1, and Invoice Hub Shield V2 were not renamed, weakened, or copied. Core Security Shield V1 runs their canonical runners in CI.
