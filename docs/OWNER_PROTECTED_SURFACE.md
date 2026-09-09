# Owner protected surface (V1)

Owner (`/owner` → `public/owner.html`) is a **protected area**. Future work on Invoice Hub, Business Settings, Seller, Support, or another modal must not silently break Dueño.

This is a guardrail. It does not change Owner UI, pricing, send, calendar, or voice behavior.

There is **no GitHub workflow in this stage**. Do not add `.github/workflows/owner-shield-v1.yml` until the runner is reviewed.

## What the scope guard actually does

Protection is attached to **files and shared-code regions**, not to the current branch name.

1. Collect changed files versus `origin/main` (plus staged and untracked).
2. Classify each file:
   - **Protected** — exact paths and globs in `scripts/mg-owner-shield-v1.json` (`public/owner.html`, Owner voice/capacity/recovery, restore-owner-session, this shield).
   - **Shared** — `public/js/app.js` only. The guard scans the **diff**. It fails (unless authorized) when changed lines match Owner markers such as `loadOwner`, `saveOwner`, `mg_owner_v2`, `resetOwnerDraftToNewQuote`, `runOwnerSellerPublicSend`, `ownerVoicePlan`. An empty or unreadable `app.js` diff **fails safe**.
   - **Other** — Seller, Invoice Hub, Support, and unrelated files. The Owner guard does **not** block them.
3. If nothing classified as Owner changed, the guard passes.
4. If Owner files or Owner regions changed, the change is allowed only when the work is **explicitly authorized** (below). Otherwise it fails:

> Owner protected surface changed outside Owner scope. Stop and move this to an Owner PR.

The branch name is **one authorization signal**, not the protection itself. A Support or Seller branch that edits `public/owner.html` still fails. A branch whose name merely contains the word `owner` (for example `fix/business-settings-modern-owner-session`) is **not** authorized.

## How to deliberately touch Dueño

Treat the work as explicitly Owner if **any** of these is true:

1. `ALLOW_OWNER_TOUCH=1`
2. PR title contains `[Owner]`
3. Branch name contains one of these **deliberate** substrings:
   - `owner-shield`
   - `owner-voice`
   - `owner-portal`
   - `feat/owner-`
   - `fix/owner-`

Then run:

```bash
node scripts/test-mg-owner-shield-v1.js
```

Optional Invoice Hub integration plus Owner-adjacent suites:

```bash
node scripts/test-mg-owner-shield-v1.js --full
```

Check scope first:

```bash
node scripts/guard-owner-scope.js
```

Default comparison is `origin/main`. Override with `BASE_REF`.

## What V1 freezes

- Premium `#ownerVoicePlanTranscript` selector, dark (non-white) fill, green focus, mobile `font-size` at least 16px
- Voice modal, Review & confirm plan, Confirm and apply (disabled until Interpret)
- Portrait labor as cards, visible Acciones, Dueño keeps Costo base / Costo labor (this is **not** Seller cost-hiding)
- Structural overflow rules (`overflow-x`, `min-width: 0`, wrap, 16px inputs)
- `mg_owner_v2` load/save/reset source contract and legacy worker-rate cleanup
- Existing suites for Owner auth, send, hours, calendar, voice, dates, deposit, branding isolation

`--full` runs the existing Invoice Hub **orchestrator** (`scripts/test-invoice-hub-regression-suite.js`) as one optional entry. It does not copy Hub's seven suites into Owner required. Modern Owner session on Business Settings stays **required**.

## Known gaps (printed, do not FAIL the gate)

- `qa-ch014-send-quote-price-guard.js` — obsolete Owner send assertion; **not required, not PASS**
- Browser localStorage round-trip of `/owner` (the `app.js` IIFE cannot be invoked from Node without changing product)
- Archive / test-project isolation
- UI project-switch leftovers beyond `resetOwnerDraftToNewQuote` source
- Interpret `current_document` hydration / internal plan server persist (phase 3+)
- Payroll presets
- Playwright `owner-send-e2e.mjs`
- Pixel-level overflow screenshots

## What V1 does not do

- It does not deploy, mutate production data, send email, or run SQL.
- It does not replace Seller Shield or Invoice Hub Shield.
- It does not add a required GitHub check in this stage.
- Estimate Zapier remains an **unsigned JSON POST**, not HMAC. Invoice Hub Zapier stays Hub-owned.
