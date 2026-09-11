# Core Security protected surface (V1 + V2)

Core Security Shield is **test, documentation, CI, and scope-guard infrastructure**. It does not change Vendedor, Dueño, Invoice Hub, or production behavior.

V2 adds a scope guard to the existing `Core Security Shield V1` check. It does not rename that check.

## Rule

A Core Security protected change is authorized **only when both** are true:

1. The PR title contains exactly `[Core Security]`.
2. The branch starts with one of:
   - `feat/core-security-`
   - `fix/core-security-`
   - `security/core-`

Title or branch alone is **not** enough.

There is **no bypass**:

- No `ALLOW_CORE_SECURITY_TOUCH`
- No manual environment override
- No labels
- A generic substring `security` does not authorize
- Branches named only `core`, `owner`, `seller`, or `support` do not authorize

## GitHub required check (name frozen)

- Workflow file: `.github/workflows/core-security-shield-v1.yml`
- Workflow name: `Core Security Shield V1`
- Job name: `Core Security Shield V1`
- Check name: `Core Security Shield V1`

Do not rename the workflow, job, or check.

## When the real guard runs

The real scope guard runs **only** on `pull_request`. Title + branch authorization is decided exclusively on that event, using `PR_TITLE`, `GITHUB_HEAD_REF`, and `BASE_REF` from the pull request.

`merge_group` and `workflow_dispatch` still run self-tests and the required Shield suites (Core V1 required/full, plus Seller, Owner, and Invoice Hub canonical runners). They **omit** the real guard because they do not have trusted PR metadata (`GITHUB_HEAD_REF` is empty; there is no `pull_request.title` or `pull_request.base.sha`). Those events must **not** treat missing title/branch as authorization.

## Shields that must not be renamed, weakened, or deleted

- `Seller Shield V1` (`.github/workflows/seller-shield-v1.yml`)
- `Owner Shield V1` (`.github/workflows/owner-shield-v1.yml`)
- `Invoice Hub Shield V2` (`.github/workflows/invoice-hub-shield-v2.yml`)

Core Security Shield V1 runs their **canonical** runners. It does not copy their tests or change their manifests.

## Exact protected files

- `.github/workflows/core-security-shield-v1.yml`
- `scripts/mg-core-security-shield-v1.json`
- `scripts/test-mg-core-security-shield-v1.js`
- `scripts/test-mg-core-security-shield-v1-runner.js`
- `scripts/test-core-session-security.js`
- `scripts/test-core-tenant-isolation.js`
- `scripts/test-core-role-permissions.js`
- `scripts/test-core-secret-boundaries.js`
- `scripts/test-core-webhook-security.js`
- `scripts/test-core-financial-endpoints.js`
- `scripts/guard-core-security-scope.js`
- `scripts/test-core-security-shield-v2.js`
- `scripts/test-core-security-supabase-hardening-1.js`
- `scripts/test-core-estimates-webhook-signing.js`
- `scripts/test-core-contract-modern-owner-session.js`
- `scripts/test-core-estimate-log-redaction.js`
- `scripts/test-core-stripe-webhook-replay.js`
- `scripts/test-core-remaining-modern-owner-gates.js`
- `scripts/test-core-global-security-headers.js`
- `scripts/test-core-estimates-hmac-verifier.js`
- `scripts/test-core-estimates-server-hmac-verifier.js`
- `netlify/functions/_lib/zapier-hmac-v1.js`
- `netlify/functions/verify-estimates-zapier-hmac.js`
- `netlify/functions/_lib/ops-log.js`
- `netlify/functions/_lib/require-owner-or-admin.js`
- `docs/CORE_SECURITY_AUDIT.md`
- `docs/CORE_SECURITY_PROTECTED_SURFACE.md`
- `docs/CORE_SECURITY_ESTIMATES_ZAPIER_HMAC_VERIFIER.js`
- `SUPABASE_MG_CORE_SECURITY_HARDENING_1.sql`
- `SUPABASE_MG_CORE_SECURITY_HARDENING_1_ROLLBACK.sql`
- `SUPABASE_MG_CORE_SECURITY_HARDENING_1_VERIFY.sql`

## Protected globs

- `scripts/fixtures/mg-core-security-shield/*`
- `scripts/test-core-security-*`
- `docs/CORE_SECURITY_*`

## Shared Core regions (`sharedScan`)

These product files are **not** wholly owned by Core Security. The guard fails only when a changed line or nearby diff context contains a Core marker, or when the shared diff is empty/unreadable (fail closed).

| File | What is protected |
| --- | --- |
| `netlify/functions/_lib/session.js` | Session HMAC/cookie contracts |
| `netlify/functions/_lib/device-session.js` | Device session HMAC/cookie contracts |
| `netlify/functions/_lib/tenant-for-session.js` | Tenant resolution authority |
| `netlify/functions/_lib/tenant-device-guard.js` | Owner/device/role guards |
| `netlify/functions/_lib/owner-access.js` | Owner identity and plan-status authority |
| `netlify/functions/_lib/membership-resolve.js` | Membership lookup/role |
| `netlify/functions/_lib/supabase-admin.js` | Service-role access |
| `netlify/functions/_lib/mg-support/require-platform-admin.js` | Platform-admin session authority |
| `netlify/functions/stripe-invoice-webhook.js` | Local Stripe HMAC verification and 300s replay window |
| `netlify/functions/_lib/square-webhook-signature.js` | Square HMAC / timing-safe compare |
| `netlify/functions/square-saas-webhook.js` | Square HMAC, idempotency, tenant activation identity |
| `netlify/functions/send-quote-zapier.js` | Estimates Zapier outbound HMAC Phase 1 |
| `netlify/functions/resend-tenant-quote.js` | Quote-resend Zapier outbound HMAC Phase 1 |
| `netlify.toml` | Security headers, Functions config, protected-portal redirects, `public/` publish |

See `scripts/mg-core-security-shield-v1.json` `sharedScan` for the exact markers.

## Supabase hardening 1 (not applied)

`SUPABASE_MG_CORE_SECURITY_HARDENING_1.sql` revokes Data API grants on eight server-only tables, revokes `EXECUTE` on server-only mutation RPCs, keeps `authenticated` `EXECUTE` on `mg_business_id()` / `mg_role()`, and pins 34 function `search_path` values. It does **not** change policies or RLS. Do not apply from CI. Rollback exists and must not be executed.

## Guard behavior

- Exact protected file changed without authorization → fail
- Shared marker hit or nearby context hit without authorization → fail
- Empty/unreadable/uncertain shared diff → fail closed
- Deleting a protected exact file → fail (even if authorized)
- Missing or unresolvable `BASE_REF` → fail
- Only safe Git SHAs (and the named ref `origin/main`) are accepted
- Git is spawned with argument arrays; never `shell: true`
- Title and branch are never interpolated into shell git commands
- Authorized protected change prints `CORE_SECURITY_REGRESSION_REQUIRED=1`. Core V1 required and full already run on every workflow event; that flag is evidence, not a second suite run.

Fail message:

`Core Security protected surface changed outside Core Security scope. Stop and move this to a Core Security PR.`

## What V1 covers

- Owner and device session HMAC, expiry, tamper, modern vs legacy identity
- Owner/supervisor dual-auth accepts modern `email + tenant` and legacy `email + session.c`; supervisor device path unchanged
- Contract `requireOwnerOrAdmin` and remaining equivalent Owner/Admin copies accept modern `email + tenant` and legacy `email + session.c`; Sales Admin/Platform Admin gates unchanged
- Device revoke / inactive / tenant / membership / portal mismatches
- Cross-tenant IDOR on body, query, and session hint
- Role gates (seller quote, supervisor assignment, platform admin vs tenant owner)
- Secret boundaries (no service-role in the browser, dummy child env)
- HMAC for Square, local Stripe (300s replay window), and estimates Zapier outbound fail-closed (`ESTIMATES_HMAC_FAIL_CLOSED`, Zapier v15) plus Catch Hook / server-side `verify-estimates-zapier-hmac` over `zapier_signed_payload` (Netlify env secret only; signed `final_to` / `final_additional_recipients` / `final_from_name`; unsigned Catch Hook POST is refused)
- Estimate send/resend logs omit recipient PII, payloads, public/PDF URLs, signatures, and secrets
- Server-side pricing and financial endpoint session isolation
- Global `netlify.toml` CSP (`object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`), HSTS (`max-age=31536000`), and Permissions-Policy (`microphone=(self)` for voice; camera and geolocation blocked)

## What this shield does not do

- Product fixes
- SQL migrations
- Secret rotation
- Branch protection changes
- Merges
- Declaring production RLS PASS from repository SQL alone
