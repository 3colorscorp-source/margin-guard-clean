# AI Closer Step 4 — Owner Prequote Status Actions

**Status:** Updates `public.ai_closer_prequotes.status` only. Does not create official quotes.

## Purpose

Let owner/admin users organize AI Closer starter pre-quotes from `/ai-closer-owner.html` with safe status labels after review.

## What this step does

- Adds **POST** `/.netlify/functions/ai-closer-update-prequote-status`
- Owner inbox cards get action buttons to set status
- Optional filter tabs to view pre-quotes by status

## What this step does NOT do

- Does **not** create official Margin Guard `quotes`
- Does **not** convert pre-quotes into estimates or invoices
- Does **not** change pricing, ranges, scope, client fields, or `raw_payload`
- Does **not** touch production sales, seller, supervisor, or payment workflows

## Allowed statuses

| Status | Owner action |
|--------|----------------|
| `new` | Default on submit (Step 2) |
| `reviewed` | Mark Reviewed |
| `good_lead` | Good Lead |
| `needs_site_visit` | Needs Site Visit |
| `bad_budget` | Bad Budget |
| `archived` | Archive |

## API

**POST** `/.netlify/functions/ai-closer-update-prequote-status`

Body:
```json
{
  "prequoteId": "<uuid>",
  "status": "reviewed"
}
```

Response:
```json
{ "ok": true, "id": "<uuid>", "status": "reviewed" }
```

### Auth & tenant isolation

Same pattern as `ai-closer-list-prequotes.js`:

1. `mg_session` cookie via `readSessionFromEvent`
2. `profiles.auth_user_id` → active owner/admin membership → `tenant_id`
3. Fallback: tenant session + email membership lookup

Update applies only when:
- `id = prequoteId`
- `tenant_id = authenticated membership.tenant_id`

Returns **401** (no session), **403** (not owner/admin), **404** (not found / wrong tenant).

Only the **`status`** column is patched.

## UI

- Status badge on each card (near range)
- Action buttons per card
- Filter tabs: All, New, Reviewed, Good Lead, Needs Site Visit, Bad Budget, Archived
- Placeholder: *Official quote conversion will come in a later step after owner review.*
- Refresh button retained

## Files

| File | Role |
|------|------|
| `netlify/functions/ai-closer-update-prequote-status.js` | Status PATCH handler |
| `public/ai-closer-owner.html` | Inbox UI + filters |
| `public/js/ai-closer-owner.js` | Load, filter, update status |
| `docs/AI_CLOSER_STEP4_OWNER_ACTIONS.md` | This doc |

## Test instructions

1. Sign in as owner/admin.
2. Open `/ai-closer-owner.html` — pre-quotes load from Step 2/3.
3. Click **Mark Reviewed** on a card — status updates without full page reload; success message appears.
4. Use filter tabs — list filters client-side by status.
5. Sign in as a different tenant (or use wrong id) — update returns 404.
6. Sign out — update returns 401; inbox shows safe auth message.
7. Confirm no new rows in `public.quotes` or invoice tables.

## Prerequisites

- Step 2 SQL applied (`ai_closer_prequotes` table)
- Step 3 list function deployed
- At least one submitted pre-quote for the tenant
