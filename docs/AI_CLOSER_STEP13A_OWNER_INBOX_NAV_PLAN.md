# AI Closer Step 13A — Owner Inbox Navigation Polish Plan

## 1. Purpose

Step 13A is **planning only**. No production code changes are made in this step.

**Goal:** Improve navigation after Dashboard → AI Closer Owner Inbox, so the Owner can return to the dashboard easily after reviewing leads.

## 2. Current verified status

The following AI Closer and dashboard capabilities are verified in production through Step 12C:

| Capability | Status |
|------------|--------|
| Dashboard card opens `/ai-closer-owner.html` | Verified (PASS REAL) |
| AI Closer Owner Inbox loads normally | Verified |
| Client submit guard works | Verified (PASS REAL) |
| Draft quote creation remains owner-gated | Verified |
| No invoice/payment/email/publish side effects | Verified |
| Dashboard card | PASS REAL |

**Baseline counts (post Step 12C):**

- `prequotes_count` = 4
- `conversion_rows` = 2
- `quotes_count` = 280
- `invoices_count` = 61
- `payments_count` = 0

## 3. Recommended small improvement

Add a simple link/button in AI Closer Owner Inbox:

| Element | Value |
|---------|--------|
| **Label** | `Back to Dashboard` |
| **Target** | `/dashboard.html` |

**Placement:** Near existing top links, next to `Client flow` and `Lab settings`, or in the page header.

**Implementation notes:**

- Plain HTML link only
- No API calls
- No JavaScript required
- No database interaction

## 4. Why this before sidebar

A small inbox back-link is recommended before sidebar or global navigation integration because:

1. **Lower risk** than sidebar/nav integration
2. **Easy to QA** — single link, no global nav regression
3. **Does not affect** Owner/Sales/Seller/Supervisor flows
4. **Helps the owner** return to the dashboard after reviewing leads
5. **Easy rollback** — remove one anchor if needed

## 5. Recommended Step 13B implementation scope

| Item | Scope |
|------|--------|
| **Deliverable** | One HTML back-link in Owner Inbox header |
| **Likely allowed files** | `public/ai-closer-owner.html`, `docs/AI_CLOSER_STEP13B_OWNER_INBOX_BACK_TO_DASHBOARD.md` |
| **Implementation** | HTML-only link preferred |
| **JavaScript** | None |
| **Backend** | None |
| **Supabase** | None |
| **Official quote/invoice/payment** | No changes |

## 6. Must-not-do list for Step 13B

Step 13B must **not**:

- Touch sidebar or global navigation shell
- Touch `dashboard.html` again
- Add counts or badges
- Call APIs from the new link
- Create drafts from the header
- Change status actions
- Change conversion flow
- Expose internal cost/margin or protected pricing internals

## 7. Test plan for Step 13B

1. Open `/ai-closer-owner.html`
2. Confirm existing Owner Inbox still loads (inbox list, filters, detail, draft create)
3. Confirm existing **Client flow** and **Lab settings** links still work
4. Confirm new **Back to Dashboard** link appears
5. Click **Back to Dashboard**
6. Confirm `/dashboard.html` loads normally (layout, KPIs, AI Closer card intact)
7. Confirm no DB counts change
8. Confirm no console errors on either page

**Expected counts after Step 13B link-only test:**

| Metric | Expected |
|--------|----------|
| `prequotes_count` | unchanged |
| `conversion_rows` | unchanged |
| `quotes_count` | unchanged |
| `invoices_count` | unchanged |
| `payments_count` | unchanged |

## 8. Final recommendation

- **Proceed with Step 13B only after owner approval**
- Keep sidebar integration deferred until this small link is verified **PASS REAL**

**Suggested sequence:**

1. **Step 13B** — Add `Back to Dashboard` link to `ai-closer-owner.html` (HTML only)
2. **Step 13C** — Document inbox back-link production verification
3. **Later** — Sidebar/nav integration only after inbox ↔ dashboard navigation is stable
