# Core Security protected surface (V1)

Core Security Shield V1 is **test, documentation, and CI infrastructure**. It does not change Vendedor, Dueño, Invoice Hub, or production behavior.

This is a guardrail for future Core Security work. It does not implement Core Security Shield V2.

## Rule

Non-Core-Security work should **not** edit these files. A change is Core Security when the task, branch, or PR is explicitly Core Security (`feat/core-security-*` or PR title `[Core Security]`).

V1 does **not** ship a scope guard binary. The GitHub check **Core Security Shield V1** is the freeze.

## GitHub required check (name frozen)

- Workflow file: `.github/workflows/core-security-shield-v1.yml`
- Workflow name: `Core Security Shield V1`
- Job name: `Core Security Shield V1`
- Check name: `Core Security Shield V1`

Do not rename the workflow, job, or check.

## Shields that must not be renamed, weakened, or deleted

- `Seller Shield V1` (`.github/workflows/seller-shield-v1.yml`)
- `Owner Shield V1` (`.github/workflows/owner-shield-v1.yml`)
- `Invoice Hub Shield V2` (`.github/workflows/invoice-hub-shield-v2.yml`)

Core Security Shield V1 runs their **canonical** runners. It does not copy their tests or change their manifests.

## Protected files (this shield)

See `scripts/mg-core-security-shield-v1.json` `exact` / `globs`.

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
- `scripts/fixtures/mg-core-security-shield/*`
- `docs/CORE_SECURITY_AUDIT.md`
- `docs/CORE_SECURITY_PROTECTED_SURFACE.md`

## What V1 covers

- Owner and device session HMAC, expiry, tamper, modern vs legacy identity
- Device revoke / inactive / tenant / membership / portal mismatches
- Cross-tenant IDOR on body, query, and session hint
- Role gates (seller quote, supervisor assignment, platform admin vs tenant owner)
- Secret boundaries (no service-role in the browser, dummy child env)
- HMAC for Square and local Stripe; unsigned estimate webhook documented, not changed
- Server-side pricing and financial endpoint session isolation

## What V1 does not do

- Product fixes
- SQL migrations
- Secret rotation
- Branch protection changes
- Merges
- Core Security Shield V2
- Declaring production RLS PASS from repository SQL alone
