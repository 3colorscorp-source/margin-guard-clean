# AI Closer Step 14A — Owner Inbox Copy Polish Plan

## 1. Purpose

Step 14A is **planning only**. No production code changes are made in this step.

**Goal:** Identify safe Owner Inbox copy updates so helper text matches verified capabilities (owner-gated DRAFT quote creation) without changing behavior, pricing, or workflows.

## 2. Current verified status

The following AI Closer capabilities are verified in production through Step 13C:

| Capability | Status |
|------------|--------|
| Client flow creates prequotes | Verified |
| Duplicate submit guard | PASS REAL |
| Owner Inbox loads 4 prequotes | Verified |
| Status gating | Verified |
| Create Draft Quote Only | Verified |
| Duplicate conversion guard | Verified |
| Dashboard card | PASS REAL |
| Back to Dashboard link | PASS REAL |
| No invoice/payment/email/publish side effects | Verified |

**Baseline counts (post Step 13C):**

- `prequotes_count` = 4
- `conversion_rows` = 2
- `quotes_count` = 280
- `invoices_count` = 61
- `payments_count` = 0

## 3. Copy issue to fix later

### Outdated copy (HTML)

In `public/ai-closer-owner.html`, the `acl-owner-note` helper currently says:

> Organize leads with status actions below. Official quote conversion will come in a later step after owner review.

### Why this is outdated

- This was **correct earlier** in the AI Closer lab sequence, before backend DRAFT quote creation shipped (Steps 9A/9B) and before owner UI wiring (Steps 10B–10G).
- **Now** owner-approved DRAFT quote creation exists and is verified. The inbox should describe the current flow, not a future step.
- Updated copy must still emphasize **DRAFT ONLY** and **no send / invoice / payment**.

### Already-accurate copy (JS)

Per-card helper text in `public/js/ai-closer-owner.js` already uses:

- Non-converted: `Review in View Details to create a DRAFT quote when ready.`
- Converted: `Draft quote already created for this pre-quote.`

Step 14B should **not** change these unless a consistency pass is explicitly approved. Primary fix target is the HTML `acl-owner-note`.

### Keep unchanged

- `STARTER PRE-QUOTE — NOT FINAL` (inbox pill)
- `DRAFT CREATED` badges
- Status labels and filter tabs
- Existing buttons and behavior

## 4. Recommended Step 14B copy updates

| Location | Suggested replacement |
|----------|----------------------|
| **Main helper** (`acl-owner-note`) | `Organize leads with status actions below. When a lead is ready, use View Details to create a DRAFT quote only after owner review.` |
| **Safety note** (add below main helper or inline) | `Draft only · No send · No invoice · No payment` |
| **Detail/helper note** (per-card, JS — already correct) | `Review in View Details to create a DRAFT quote when ready.` |

**Preserve:**

- `STARTER PRE-QUOTE — NOT FINAL`
- `DRAFT CREATED` badges
- Status labels
- Existing buttons and behavior

## 5. Must-not-do list for Step 14B

Step 14B must **not**:

- Change pricing or range display logic
- Change status behavior or gating rules
- Change conversion / draft-create behavior
- Add new buttons or navigation
- Add API calls
- Create invoices or payments
- Publish or send email
- Touch sidebar or dashboard
- Expose internal cost/margin or protected pricing internals

## 6. Recommended Step 14B implementation scope

| Item | Scope |
|------|--------|
| **Primary file** | `public/ai-closer-owner.html` — update `acl-owner-note` (and optional safety line) |
| **JS** | `public/js/ai-closer-owner.js` only if additional outdated strings are found; **no logic changes** |
| **Documentation** | `docs/AI_CLOSER_STEP14B_OWNER_INBOX_COPY_POLISH.md` |
| **Change type** | Copy-only |
| **Backend / Supabase** | None |
| **Official quote/invoice/payment** | No changes |

## 7. Test plan for Step 14B

1. Open `/ai-closer-owner.html`
2. Confirm Owner Inbox loads normally
3. Confirm new main helper copy is accurate (no “later step” language)
4. Confirm safety line visible if added
5. Confirm 4 prequotes still load
6. Confirm status buttons still appear and work
7. Confirm **View Details** still works
8. Confirm **DRAFT CREATED** state still appears for converted lead (Step 11B)
9. Confirm **Create Draft Quote Only** flow unchanged for eligible leads
10. Confirm no DB counts change
11. Confirm no console errors

**Expected counts after copy-only test:**

| Metric | Expected |
|--------|----------|
| `prequotes_count` | unchanged |
| `conversion_rows` | unchanged |
| `quotes_count` | unchanged |
| `invoices_count` | unchanged |
| `payments_count` | unchanged |

## 8. Final recommendation

- **Proceed with Step 14B only after owner approval**
- Keep it **copy-only** — HTML first; touch JS only for stray outdated strings, not logic
- Keep **sidebar integration deferred** until inbox copy polish is verified **PASS REAL**

**Suggested sequence:**

1. **Step 14B** — Apply copy updates in `ai-closer-owner.html`
2. **Step 14C** — Document production verification
3. **Later** — Optional inbox polish (archive duplicate Step 11B prequote in UI, draft quote deep link) or sidebar — only after 14B PASS REAL
