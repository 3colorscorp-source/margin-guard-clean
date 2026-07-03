# AI Closer Step 12A — Owner Dashboard Card Integration Plan

## 1. Purpose

Step 12A is **planning only**. No dashboard code changes are made in this step.

**Goal:** Decide the safest way to expose AI Closer Leads to the Owner before any production dashboard edits.

## 2. Current verified AI Closer status

The following AI Closer capabilities are verified in production through Step 11F:

| Capability | Status |
|------------|--------|
| Client prequote submit | Verified |
| Client duplicate submit guard | Verified (PASS REAL) |
| Owner inbox | Verified |
| Status actions | Verified |
| Detail view | Verified |
| Date picker | Verified |
| Backend DRAFT quote creation | Verified |
| Guarded UI | Verified |
| Duplicate conversion guard | Verified |
| Preload DRAFT CREATED | Verified |
| Happy-path DRAFT creation | Verified |
| No invoice/payment/email/publish side effects | Verified |

**Baseline counts (post Step 11F):**

- `prequotes_count` = 4
- `conversion_rows` = 2
- `quotes_count` = 280
- `invoices_count` = 61
- `payments_count` = 0

## 3. Recommended placement

Add a small Owner Dashboard card/tile in a future step (Step 12B):

| Element | Value |
|---------|--------|
| **Title** | `AI Closer Leads` |
| **Subtitle** | `Review starter pre-quotes and create draft quotes.` |
| **Button/link** | `Open AI Closer` |
| **Target** | `/ai-closer-owner.html` |

**Access rules:**

- Owner/admin only
- Do not expose to Seller or Supervisor
- Do not place in public client flow
- Do not merge into Sales page yet
- Do not modify official quote workflow

## 4. Why dashboard card before sidebar

A dashboard card is recommended before sidebar or navigation integration because:

1. **Lower risk** than sidebar/nav changes
2. **Easier to QA** — single visible element, no global nav regression
3. **Does not affect** existing Owner/Sales/Seller/Supervisor flows
4. **Can be removed/reverted easily** if needed
5. **Keeps AI Closer isolated** but discoverable for the Owner

## 5. UI copy recommendation

Exact suggested copy for Step 12B:

| Element | Copy |
|---------|------|
| **Card title** | `AI Closer Leads` |
| **Body** | `Review AI starter pre-quotes, qualify leads, and create draft quotes after owner approval.` |
| **Safety line** | `Draft only · No send · No invoice · No payment` |
| **Button** | `Open AI Closer Leads` |

## 6. Access and route rules

- Link target: `/ai-closer-owner.html`
- The existing AI Closer owner page already requires owner sign-in
- Future dashboard card should be visible only in Owner dashboard context
- No tenant slug, internal pricing, margin, overhead, labor rate, or protected internals should be embedded in dashboard HTML

## 7. Must-not-do list for future implementation

Step 12B and later dashboard work must **not**:

- Create a draft quote from the dashboard
- Show internal cost/margin or protected pricing internals
- Show client sensitive details on the dashboard card
- Call AI Closer APIs from the dashboard in the first implementation
- Add counts/badges unless explicitly approved
- Touch sidebar or global navigation yet
- Touch invoices, payments, publish, or send flows

## 8. Recommended Step 12B implementation scope

| Item | Scope |
|------|--------|
| **Deliverable** | One dashboard card/link only |
| **Likely allowed file** | `public/dashboard.html` |
| **Optional** | Documentation file |
| **JS/API** | Not required |
| **Backend** | No changes |
| **Supabase** | No changes |
| **Pre-commit** | Verification required before push |

## 9. Test plan for Step 12B

1. Dashboard loads normally
2. Existing dashboard layout is not broken
3. Card is visible to Owner
4. Click opens `/ai-closer-owner.html`
5. AI Closer owner page still works (inbox, status, detail, draft create)
6. No console errors on dashboard or AI Closer page
7. No API calls triggered by the dashboard card itself
8. No DB counts change from viewing or clicking the card

**Expected counts after Step 12B card-only test:**

| Metric | Expected |
|--------|----------|
| `prequotes_count` | unchanged |
| `conversion_rows` | unchanged |
| `quotes_count` | unchanged |
| `invoices_count` | unchanged |
| `payments_count` | unchanged |

## 10. Final recommendation

- **Proceed with Step 12B only after owner approval**
- Keep sidebar integration for later, after dashboard card **PASS REAL**

**Suggested sequence:**

1. **Step 12B** — Implement dashboard card (HTML only, link to AI Closer owner inbox)
2. **Step 12C** — Document dashboard card production verification
3. **Later** — Sidebar/nav integration only after dashboard card is verified stable
