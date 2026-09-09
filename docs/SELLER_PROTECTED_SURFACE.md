# Seller protected surface (V1 + Shield V2 wiring)

Seller is a **protected area**. Future work on Dueño, Business Settings, Invoice Hub, or other modals must not accidentally edit or regress it.

This is a guardrail. It does not change Seller UI, pricing, send, calendar, voice, pairing, or auth **product** behavior. V2 only strengthens CI.

## Rule

Non-Seller work must **not** edit protected Seller files or Seller code regions in shared files.

A change is allowed only when the task, branch, or PR is **explicitly Seller**.

## When Seller work is allowed

Treat the work as explicitly Seller if **any** of these is true:

1. Branch name contains `seller`
2. Branch name contains `voice-plan`
3. Branch name contains `seller-shield`
4. `ALLOW_SELLER_TOUCH=1` (local/manual only; CI must never set this)
5. PR title contains `[Seller]`

Otherwise, touching the protected surface **fails**:

> Seller protected surface changed outside Seller scope. Stop and move this to a Seller PR.

## GitHub required check (name frozen)

The required GitHub check is still named **`Seller Shield V1`**.

- Workflow file: `.github/workflows/seller-shield-v1.yml`
- Workflow name: `Seller Shield V1`
- Job name: `Seller Shield V1`
- Check name: `Seller Shield V1`

Do not rename the workflow, job, or check. V2 is additional wiring and coverage behind that same name.

## What V2 adds in CI

The GitHub workflow file stays the **origin/main** Seller Shield V1 workflow. V2 does **not** add a second job or rename the check.

On every pull request to `main`, **Seller Shield V1** still:

1. Runs the runner self-test
2. Runs `node scripts/guard-seller-scope.js --self-test`
3. Always runs required suites: `node scripts/test-mg-seller-shield-v1.js`
4. Always runs `--full`: `node scripts/test-mg-seller-shield-v1.js --full`

The **real** guard runs **inside** that required/full runner (`scripts/test-mg-seller-shield-v1.js`):

- Reads `GITHUB_EVENT_PATH` for PR base SHA, title, and head ref
- If the base SHA is missing locally, fetches it with `git fetch --no-tags --depth=1 origin <sha>`
- Spawns `node scripts/guard-seller-scope.js` with `BASE_REF`, `PR_TITLE`, and `GITHUB_HEAD_REF` via `env` (no shell interpolation)
- A guard failure is `exit 1` of the runner, so the same required check **`Seller Shield V1`** fails
- Skipped only on `merge_group`
- CI never sets `ALLOW_SELLER_TOUCH=1`

`scripts/test-seller-shield-v2.js` freezes this runner integration and asserts the workflow file is unchanged vs `origin/main`.

A **non-Seller PR** that touches the protected surface fails **`Seller Shield V1`**. Required and `--full` still run on every PR (the guard runs first inside each).

### `merge_group` limitation

The real guard is **skipped** on `merge_group` because that event does not expose a trusted PR title or head branch. Runner self-test, guard self-test, required suites, and `--full` still run.

## Any Seller touch requires the shield

If protected files or Seller regions in shared files change under Seller scope, run:

```bash
node scripts/test-mg-seller-shield-v1.js
```

Optional Hub-adjacent RLS suite:

```bash
node scripts/test-mg-seller-shield-v1.js --full
```

Before that, you can check scope with:

```bash
node scripts/guard-seller-scope.js
node scripts/guard-seller-scope.js --self-test
node scripts/test-seller-shield-v2.js
```

Default comparison is `origin/main`. Override with `BASE_REF`.

## Do not change these unless the task is specifically about that area

- Tenant rates / `hoursPerDay`
- Publish and send
- Calendar reservation
- Voice confirm-and-apply
- Device auth / pairing
- Estimate Zapier payload
- Seller Business Settings snapshot
- Quote number allocation

The estimate Zapier webhook is an **unsigned JSON POST**. Do not copy HMAC guarantees from contracts or Invoice Hub onto this flow.

## Protected files (exact)

Canonical list: `scripts/mg-seller-shield-v1.json`. Includes:

### UI and session

- `public/sales.html`
- `public/js/sales-device-portal.js`
- `public/js/voice-operational-plan.js`
- `public/js/quote-send-feedback.js`
- `public/js/sales-capacity-calendar.js`
- `public/js/sales-operational-plan.js`
- `public/js/device-portal-auth.js`
- `public/portal-pair.html`
- `.github/workflows/seller-shield-v1.yml`

### Seller functions

- `publish-public-quote.js`, `send-quote-zapier.js`, `calc-secure-pricing.js`
- `voice-operational-plan-command.mjs`, `get-tenant-branding.js`
- `get-seller-business-settings.js`
- `get-sales-capacity-calendar.js`
- `quote-internal-operational-plan.js`
- `list-tenant-contacts.js`, `upsert-tenant-contact.js` (also used by Owner Contacts; a Contacts PR that edits these files fails Seller Shield unless it is Seller-authorized)
- `pair-device.js`, `device-auth-status.js`, `device-heartbeat.js`, `device-logout.js`

### Shield itself

- `scripts/guard-seller-scope.js`
- `scripts/mg-seller-shield-v1.json`
- `scripts/test-mg-seller-shield-v1.js`, `scripts/test-mg-seller-shield-v1-runner.js`
- `scripts/test-get-seller-business-settings.js`
- `docs/SELLER_PROTECTED_SURFACE.md`, `MARGIN_GUARD_SELLER_PORTAL_SUMMARY.md`
- glob `scripts/test-seller-*.js` (pairing, quote-number, V2 wiring, hours-publish-parity, …)

## Shared regions (markers)

`app.js` and shared `_lib` files are **not** blocked on every edit. The guard scans the **diff**. It fails (unless Seller scope) when changed lines match Seller markers. Empty or unreadable shared diffs **fail safe**.

| File | Seller markers (summary) |
| --- | --- |
| `public/js/app.js` | send/publish/voice/calendar seller identifiers |
| `_lib/tenant-device-guard.js` | `requireSellerDevice`, `resolveOwnerOrSellerContext`, `assertSellerOwnQuote` |
| `_lib/pricing-engine.js` | `calculateQuotePublishFinancials`, `hoursPerDay`, `minimum_price` |
| `_lib/device-session.js` | `mg_device_session`, cookie/session helpers |
| `_lib/membership-resolve.js` | `resolveMembershipById`, `membershipRole`, `membershipIsActive` |
| `_lib/sales-capacity-calendar.js` | `computeSalesCapacityCalendar`, seller override flags |
| `_lib/quote-internal-operational-plan-store.js` | persist/rollback / `mg_confirm_quote_operational_plan` |
| `_lib/operational-plan.js` | quote plan normalize/resolve/labor used by publish |
| `_lib/voice-operational-plan.js` | confirm/preview, rate strip, public client scope |
| `_lib/public-token.js` | `makePublicToken` (also used by Invoice Hub invoice links) |
| `_lib/attribution-context.js` | `buildSellerAttribution` only |
| `_lib/tenant-display.js` | `loadTenantDisplayForTenantId` |

Owner-only files (`public/owner.html`, Owner Shield workflow) and Invoice Hub-only files (`public/estimates-invoices.html`, Hub invoice functions) are **not** Seller-exact. A Dueño or Invoice Hub PR that does not touch Seller files or Seller regions **passes** this guard.

## What happens on Seller vs non-Seller PRs

- **Non-Seller PR** (Dueño, Business Settings, Invoice Hub, Support, …) that edits a protected Seller file or Seller marker region: **FAIL** `Seller Shield V1`.
- **Non-Seller PR** that only edits Owner-only or Invoice Hub-only files: Seller guard **PASS**. Required + `--full` still run.
- **Seller-authorized PR** that edits Seller files: guard **PASS**, prints `SELLER_REGRESSION_REQUIRED=1`. Required + `--full` still run (they are not gated on that flag).
- Editing `.github/workflows/seller-shield-v1.yml` from a non-Seller branch: **FAIL**.

## New suites (former known gaps)

These V1 gaps now have isolated suites and are **required**. They use fake Supabase fetch only. No live Supabase, Zapier, Netlify, or secrets.

1. `scripts/test-get-seller-business-settings.js` — valid seller device, tenant A ≠ tenant B, latest snapshot, missing settings, revoked session.
2. `scripts/test-seller-device-pairing.js` — 8-character code, invalid/expired, seller role, tenant match, device limit, cookie/session, auth-status, heartbeat, logout, pairing UI endpoints.
3. `scripts/test-seller-quote-number-allocation.js` — real `publish-public-quote` handler, `allocate_next_quote_number` RPC, required tenant id, incomplete RPC fails safe, two publishes get distinct numbers, no local fallback, no insert on invalid number.

`scripts/test-seller-shield-v2.js` freezes the original workflow (name `Seller Shield V1`, unchanged vs `origin/main`) and the real-guard integration **inside** `scripts/test-mg-seller-shield-v1.js`. Owner and Invoice Hub workflows stay untouched.

## Out of scope

- Zero product/runtime changes: do not edit `public/sales.html` or send/pricing/auth/pairing/voice/calendar **handlers** as part of a shield-only PR.
- Do not modify Dueño or **Owner Shield V1**.
- Do not modify Invoice Hub or **Invoice Hub Shield V2**.
- Do not change branch protection or the required check name.

## What this shield does not do

- It does not deploy, mutate production data, send email, or run SQL.
- It does not freeze CSS or copy.
- Pattern matching on shared files is not an AST. Prefer a Seller PR when unsure.
- `merge_group` does not run the real scope guard (see limitation above).

See `MARGIN_GUARD_SELLER_PORTAL_SUMMARY.md` for the suite list and how to add a future suite.
