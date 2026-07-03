# AI Closer Step 12B — Owner Dashboard Card

## Purpose

Add one safe Owner Dashboard card/link for AI Closer Leads, based on the Step 12A plan. This gives the Owner a discoverable entry point to the AI Closer owner inbox without changing sidebar, navigation, backend, or AI Closer logic.

## Files changed

| File | Change |
|------|--------|
| `public/dashboard.html` | Added one isolated AI Closer Leads card in the secondary tools region |
| `docs/AI_CLOSER_STEP12B_OWNER_DASHBOARD_CARD.md` | This documentation |

## Exact card copy

| Element | Copy |
|---------|------|
| **Title** | `AI Closer Leads` |
| **Body** | `Review AI starter pre-quotes, qualify leads, and create draft quotes after owner approval.` |
| **Safety line** | `Draft only · No send · No invoice · No payment` |
| **Button** | `Open AI Closer Leads` |

## Route target

`/ai-closer-owner.html`

The link is a plain HTML anchor. No JavaScript, API calls, or embedded tenant/pricing data.

## Placement

The card was added in `fcc-dashboard-lower` (secondary tools region), above the existing Executive utilities bar. Existing dashboard cards, metrics, formulas, scripts, and behavior were not modified.

## Safety confirmations

| Check | Status |
|-------|--------|
| Dashboard HTML-only card/link | Yes |
| No JavaScript added | Yes |
| No API calls from dashboard card | Yes |
| No Netlify function changes | Yes |
| No Supabase/schema changes | Yes |
| No DB writes | Yes |
| No quotes/conversions/invoices/payments created | Yes |
| No publish/send/email | Yes |
| No pricing/status/official quote behavior changed | Yes |
| No internal cost/margin exposed | Yes |
| No sidebar/owner.html/AI Closer code changes | Yes |
| Existing dashboard content preserved | Yes |

## Test plan

1. Open `/dashboard.html` — page loads normally
2. Confirm existing dashboard layout (snapshot, treasury, KPIs, utilities) is intact
3. Confirm **AI Closer Leads** card is visible in the secondary tools section
4. Click **Open AI Closer Leads** — navigates to `/ai-closer-owner.html`
5. Confirm AI Closer Owner Inbox loads and works (inbox, status, detail, draft create)
6. No console errors on dashboard or AI Closer page
7. No API calls triggered by the dashboard card itself
8. No DB counts change from viewing or clicking the card

**Expected counts after card-only test:**

| Metric | Expected |
|--------|----------|
| `prequotes_count` | unchanged |
| `conversion_rows` | unchanged |
| `quotes_count` | unchanged |
| `invoices_count` | unchanged |
| `payments_count` | unchanged |

## Rollback note

To revert Step 12B, remove the `<section class="card fcc-panel" aria-label="AI Closer Leads">…</section>` block from `public/dashboard.html` in the `fcc-dashboard-lower` region. No backend, database, or script changes are required for rollback.
