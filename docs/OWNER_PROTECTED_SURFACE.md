# Owner protected surface (V1 + Shield V2 wiring)

Owner (`/owner` → `public/owner.html`) is a **protected area**. Future work on Invoice Hub, Business Settings, Seller, Support, or another modal must not accidentally edit or regress Dueño.

This is a guardrail. It does not change Owner UI, pricing, send, calendar, voice, or auth **product** behavior. V2 only strengthens CI.

## Rule

Non-Owner work must **not** edit protected Owner files or Owner code regions in shared files.

A change is allowed only when the task, branch, or PR is **explicitly Owner**.

## When Owner work is allowed

Treat the work as explicitly Owner if **any** of these is true:

1. Branch name contains `owner-shield`
2. Branch name contains `owner-voice`
3. Branch name contains `owner-portal`
4. Branch name contains `feat/owner-`
5. Branch name contains `fix/owner-`
6. `ALLOW_OWNER_TOUCH=1` (local/manual only; CI must never set this)
7. PR title contains `[Owner]`

A branch that merely contains the word `owner` (for example `fix/business-settings-modern-owner-session`) is **not** authorized. A Seller PR cannot authorize an Owner file.

Otherwise, touching the protected surface **fails**:

> Owner protected surface changed outside Owner scope. Stop and move this to an Owner PR.

## GitHub required check (name frozen)

The required GitHub check is still named **`Owner Shield V1`**.

- Workflow file: `.github/workflows/owner-shield-v1.yml`
- Workflow name: `Owner Shield V1`
- Job name: `Owner Shield V1`
- Check name: `Owner Shield V1`

Do not rename the workflow, job, or check. Do not create an `Owner Shield V2` workflow. V2 is additional wiring and coverage behind that same name.

## What V2 adds in CI

The GitHub workflow file stays the **origin/main** Owner Shield V1 workflow, including the independent YAML guard step. V2 does **not** add a second job or rename the check.

On every pull request to `main`, **Owner Shield V1** still:

1. Runs the runner self-test
2. Runs `node scripts/guard-owner-scope.js --self-test`
3. Runs the independent YAML guard (`node scripts/guard-owner-scope.js`), skipped on `merge_group`
4. Always runs required suites: `node scripts/test-mg-owner-shield-v1.js`
5. Always runs `--full`: `node scripts/test-mg-owner-shield-v1.js --full`

The **real** guard also runs **inside** that required/full runner (`scripts/test-mg-owner-shield-v1.js`):

- Reads `GITHUB_EVENT_PATH` for PR base SHA, title, and head ref
- Invalid `GITHUB_EVENT_PATH` JSON **fails** (does not silently pass)
- If the base SHA is missing locally, fetches it with `git fetch --no-tags --depth=1 origin <sha>`
- Invalid or unsafe SHA **fails** (no shell concatenation, no fetch of non-hex)
- Spawns `node scripts/guard-owner-scope.js` with `BASE_REF`, `PR_TITLE`, and `GITHUB_HEAD_REF` via `env` (no shell interpolation)
- **Deletes inherited `ALLOW_OWNER_TOUCH`** before spawning the guard
- A guard failure is `exit 1` of the runner, so the same required check **`Owner Shield V1`** fails
- Skipped only on `merge_group`
- CI never sets `ALLOW_OWNER_TOUCH=1`

`scripts/test-owner-shield-v2.js` freezes this runner integration and asserts the workflow file is byte-identical vs `origin/main`.

A **non-Owner PR** that touches the protected surface fails **`Owner Shield V1`**. Required and `--full` still run on every PR (the runner guard runs first).

### `merge_group` limitation

The real guard is **skipped** on `merge_group` because that event does not expose a trusted PR title or head branch. Runner self-test, guard self-test, required suites, and `--full` still run. The independent YAML step is also skipped on `merge_group`.

## Any Owner touch requires the shield

If protected files or Owner regions in shared files change under Owner scope, run:

```bash
node scripts/test-mg-owner-shield-v1.js
```

Optional Invoice Hub integration plus Owner-adjacent suites:

```bash
node scripts/test-mg-owner-shield-v1.js --full
```

Before that, you can check scope with:

```bash
node scripts/guard-owner-scope.js
node scripts/guard-owner-scope.js --self-test
node scripts/test-owner-shield-v2.js
node scripts/test-owner-send-price-guard.js
```

Default comparison is `origin/main`. Override with `BASE_REF`.

## Protected files (exact)

Canonical list: `scripts/mg-owner-shield-v1.json`. Includes:

### UI and session

- `public/owner.html`
- `public/js/owner-voice-operational-plan.js`
- `public/js/owner-capacity-ui.js`
- `public/js/owner-recovery-auth.js`
- `public/js/owner-financial-advisor.js`
- `.github/workflows/owner-shield-v1.yml`

### Owner functions

- `restore-owner-session.js`
- `owner-settings-deposit-link.js`
- `get-owner-financial-settings.js`
- `_lib/owner-access.js` (Owner-only helper; still listed exact)

### Shield itself

- `scripts/guard-owner-scope.js`
- `scripts/mg-owner-shield-v1.json`
- `scripts/test-mg-owner-shield-v1.js`, `scripts/test-mg-owner-shield-v1-runner.js`
- `scripts/test-owner-shield-v1-surface.js`
- `scripts/test-owner-voice-operational-plan.js`
- `scripts/test-owner-shield-v2.js`
- `scripts/test-owner-send-price-guard.js`
- `docs/OWNER_PROTECTED_SURFACE.md`
- `MARGIN_GUARD_OWNER_PORTAL_SUMMARY.md`

Seller-owned files loaded by `/owner` (`voice-operational-plan.js`, `sales-capacity-calendar.js`, `quote-send-feedback.js`, and so on) stay **Seller Shield** exact. Do not copy them into Owner exact.

AI Closer, SaaS admin, supervisor assign, Support `require-owner-session.js`, and `dashboard.html` as a whole are **out of this shield**.

## Shared regions (markers)

`app.js` and shared `_lib` files are **not** blocked on every edit. The guard scans the **diff**. It fails (unless Owner scope) when changed lines match Owner markers. Empty or unreadable shared diffs **fail safe**. Missing required exact files that are not in the change list **fail safe**.

| File | Owner markers (summary) |
| --- | --- |
| `public/js/app.js` | load/save/reset, send, voice, labor, financial-settings identifiers |
| `_lib/tenant-device-guard.js` | `requireOwnerMembership`, `hasOwnerSessionIdentity`, `resolveOwnerOrSellerContext`, `isOwnerContext` |
| `_lib/tenant-for-session.js` | `resolveUniqueActiveOwnerAccess`, `entitledOwnerTenant` |

These shared files are **not** Owner-exact. Seller and Invoice Hub may edit non-Owner lines.

## CH-014 and `current_document`

- `qa-ch014-send-quote-price-guard.js` is an **obsolete** Owner assertion (`soldPriceGuard` / `currentMetrics`). It is **not required and not optional**. The live contract is frozen by `scripts/test-owner-send-price-guard.js`: `evaluateSendQuotePriceGuard(resolveVisibleSendQuoteMetrics(...))` on `openSendModal` and `sendQuote`.
- Owner interpret currently posts `current_document: EMPTY_DOCUMENT` (`schema_version: 1`, `source: "keyboard"`, `days: []`). That empty preview seed is frozen. **Hydrating the live Owner plan and persisting the internal plan on the server remain a future product change**, not Shield V2.

## What happens on Owner vs non-Owner PRs

- **Non-Owner PR** that edits a protected Owner file or Owner marker region: **FAIL** `Owner Shield V1`.
- **Non-Owner PR** that only edits Seller-only or Invoice Hub-only files: Owner guard **PASS**. Required + `--full` still run.
- **Owner-authorized PR** that edits Owner files: guard **PASS**, prints `OWNER_REGRESSION_REQUIRED=1`. Required + `--full` still run.
- Editing `.github/workflows/owner-shield-v1.yml` from a non-Owner branch: **FAIL**.

## Out of scope

- Zero product/runtime changes: do not edit `public/owner.html`, `public/js/app.js`, or send/pricing/auth/voice **handlers** as part of a shield-only PR.
- Do not modify Vendedor or **Seller Shield V1**.
- Do not modify Invoice Hub or **Invoice Hub Shield V2**.
- Do not change branch protection or the required check name.

## What this shield does not do

- It does not deploy, mutate production data, send email, or run SQL.
- It does not freeze CSS or copy.
- Pattern matching on shared files is not an AST. Prefer an Owner PR when unsure.
- `merge_group` does not run the real scope guard (see limitation above).
- Estimate Zapier remains an **unsigned JSON POST**, not HMAC. Invoice Hub Zapier stays Hub-owned.

See `MARGIN_GUARD_OWNER_PORTAL_SUMMARY.md` for portal notes.
