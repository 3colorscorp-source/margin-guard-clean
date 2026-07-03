# AI Closer Step 13B — Owner Inbox Back to Dashboard Link

## Purpose

Add one safe plain HTML navigation link from AI Closer Owner Inbox back to the Owner Dashboard, completing the Dashboard → AI Closer → Dashboard round trip planned in Step 13A.

## Files changed

| File | Change |
|------|--------|
| `public/ai-closer-owner.html` | Added `Back to Dashboard` link in the top `acl-lab-links` bar |
| `docs/AI_CLOSER_STEP13B_OWNER_INBOX_BACK_TO_DASHBOARD.md` | This documentation |

## Exact link label and target

| Element | Value |
|---------|--------|
| **Label** | `Back to Dashboard` |
| **Target** | `/dashboard.html` |

The link uses the existing `acl-lab-links` styling alongside **Client flow** and **Lab settings**. No JavaScript, API calls, or dynamic data.

## Placement

```html
<div class="acl-lab-links">
  <a href="/dashboard.html">Back to Dashboard</a>
  <span>·</span>
  <a href="/ai-closer-client.html">Client flow</a>
  <span>·</span>
  <a href="/ai-closer-settings.html">Lab settings</a>
</div>
```

Existing links and all Owner Inbox behavior (status actions, detail view, draft quote creation) are unchanged.

## Safety confirmations

| Check | Status |
|-------|--------|
| HTML-only link | Yes |
| No JavaScript added | Yes |
| No API calls added | Yes |
| No dashboard/sidebar changes | Yes |
| No `ai-closer-owner.js` changes | Yes |
| No Netlify function changes | Yes |
| No Supabase/schema changes | Yes |
| No DB writes | Yes |
| No quotes/conversions/invoices/payments created | Yes |
| No publish/send/email | Yes |
| No pricing/status/official quote behavior changed | Yes |
| No internal cost/margin exposed | Yes |
| Existing Owner Inbox behavior preserved | Yes |

## Test plan

1. Open `/ai-closer-owner.html`
2. Confirm Owner Inbox loads normally (list, filters, detail, draft create)
3. Confirm existing **Client flow** link still appears and works
4. Confirm existing **Lab settings** link still appears and works
5. Confirm new **Back to Dashboard** link appears
6. Click **Back to Dashboard**
7. Confirm `/dashboard.html` loads normally (layout, KPIs, AI Closer card intact)
8. Confirm no DB counts change
9. Confirm no console errors on either page

**Expected counts after link-only test:**

| Metric | Expected |
|--------|----------|
| `prequotes_count` | unchanged |
| `conversion_rows` | unchanged |
| `quotes_count` | unchanged |
| `invoices_count` | unchanged |
| `payments_count` | unchanged |

## Rollback note

To revert Step 13B, remove the `Back to Dashboard` anchor and its preceding/following separator from the `acl-lab-links` block in `public/ai-closer-owner.html`. No backend, database, or script changes are required for rollback.
