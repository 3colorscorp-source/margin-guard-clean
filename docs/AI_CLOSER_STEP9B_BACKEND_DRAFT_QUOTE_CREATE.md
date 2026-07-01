# AI Closer Step 9B — Backend DRAFT Quote Creation

**Status:** Backend-only create mode added. **No UI wiring. Create Quote button remains disabled.**

Related: [AI_CLOSER_STEP9A_DRAFT_QUOTE_DRY_RUN_FUNCTION.md](./AI_CLOSER_STEP9A_DRAFT_QUOTE_DRY_RUN_FUNCTION.md), [AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md](./AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md), [AI_CLOSER_STEP8F_IDEMPOTENCY_GUARD_APPLIED.md](./AI_CLOSER_STEP8F_IDEMPOTENCY_GUARD_APPLIED.md)

---

## 1. Purpose

Step 9B upgrades `netlify/functions/ai-closer-create-draft-quote.js` to support **explicit backend-only DRAFT quote creation** while preserving Step 9A dry-run validation.

### What Step 9B does

- `dry_run: true` — unchanged validation-only path (no writes)
- `dry_run: false` + `create_draft_quote: true` — creates one official DRAFT quote via guarded write sequence
- Owner/admin auth, tenant scope, confirmations, and idempotency checks

### What Step 9B does NOT do

- Does **not** connect `/ai-closer-owner.html` or `ai-closer-owner.js`
- Does **not** enable **Create Quote** in the owner UI
- Does **not** write `quote_items`, `quote_labor`, `labor_tracking_quote`, `invoices`, or `payments`
- Does **not** call `publish-public-quote` or `send-quote-zapier`
- Does **not** mint `public_token`, publish, or email the client
- Does **not** modify Supabase schema or pricing logic
- Does **not** expose internal cost, margin, overhead, or labor rate

---

## 2. Backend-only / no UI

Manual `POST` testing only. The owner conversion preview and **Create Quote — Disabled** button are unchanged.

---

## 3. Request modes

### Dry-run (Step 9A preserved)

```json
{
  "dry_run": true,
  "prequote_id": "<uuid>",
  "final_price_owner_approved": 12500,
  "owner_confirmations": { "...": true }
}
```

### Create DRAFT (Step 9B)

```json
{
  "dry_run": false,
  "create_draft_quote": true,
  "prequote_id": "<uuid>",
  "final_price_owner_approved": 12500,
  "owner_confirmations": {
    "owner_reviewed_lead": true,
    "scope_confirmed": true,
    "measurements_confirmed": true,
    "materials_status_confirmed": true,
    "start_date_reviewed": true,
    "final_price_approved": true
  },
  "start_date": "2026-07-15",
  "owner_note": "Optional owner note"
}
```

| Gate | Result |
|------|--------|
| `dry_run: false` without `create_draft_quote: true` | `400` |
| Incomplete confirmations or invalid price | `400` |
| Ineligible prequote status | `409` |
| Existing conversion row | `409` |

---

## 4. Exact write behavior

### Idempotency flow (create mode only)

1. **Read** `ai_closer_quote_conversions` for `ai_closer_prequote_id` — abort `409` if row exists
2. **Insert** `ai_closer_quote_conversions`:
   - `tenant_id`, `ai_closer_prequote_id`
   - `status`: `draft_pending`
   - `created_by`: owner/admin `profiles.id` when available
   - `conversion_metadata`: owner-safe JSON (`final_price_owner_approved`, optional `start_date`, `owner_note`)
3. **Insert** `public.quotes` (DRAFT only)
4. **Update** conversion row:
   - `official_quote_id` = new quote `id`
   - `status` = `draft_created`
5. If quote insert fails → best-effort mark conversion `failed`; **no automatic retry**

### Quote insert fields (minimal)

| Column | Source |
|--------|--------|
| `tenant_id` | Authenticated membership |
| `project_name` | Prequote |
| `client_name` | Prequote |
| `client_email` | Prequote |
| `estimated_amount` | `final_price_owner_approved` (owner-entered; verified Step 8C preflight) |
| `status` | `DRAFT` |
| `notes` | Optional: `scope_notes` + `owner_note` only (skipped if column rejected) |
| `start_date` | Optional from request (skipped if column rejected; verified Step 8C / operational migration) |

**Not set:** `total`, `currency`, `public_token`, `quote_number_display`, `deposit_required`, `payment_link`, workers, pricing internals.

API response `estimated_amount` is always `final_price_owner_approved` from the request (not read from a `total` column).

---

## 5. Tables written

| Table | Operations |
|-------|------------|
| `public.ai_closer_quote_conversions` | `INSERT` (`draft_pending`), then `PATCH` (`draft_created`) or `PATCH` (`failed` on quote error) |
| `public.quotes` | `INSERT` one DRAFT row |

## 6. Tables NOT written

- `quote_items`
- `quote_labor`
- `labor_tracking_quote`
- `invoices`
- `payments`
- `tenant_projects`
- `ai_closer_prequotes` (status unchanged in Step 9B)

---

## 7. Success response (create mode)

```json
{
  "ok": true,
  "dry_run": false,
  "message": "Draft quote created. It was not sent, published, invoiced, or emailed.",
  "draft_quote": {
    "id": "<uuid>",
    "status": "DRAFT",
    "project_name": "...",
    "client_name": "...",
    "client_email": "...",
    "estimated_amount": 12500
  },
  "conversion": {
    "id": "<uuid>",
    "status": "draft_created",
    "ai_closer_prequote_id": "<uuid>",
    "official_quote_id": "<uuid>"
  },
  "side_effects": {
    "created_quote_items": false,
    "created_quote_labor": false,
    "created_invoice": false,
    "created_payment": false,
    "published": false,
    "emailed_client": false
  }
}
```

---

## 8. Manual test instructions

**Prerequisites:** Owner/admin session cookie; eligible prequote (`reviewed`, `good_lead`, or `needs_site_visit`); no existing conversion row.

### A. Dry-run still works

```bash
curl -X POST "https://<site>/.netlify/functions/ai-closer-create-draft-quote" \
  -H "Content-Type: application/json" \
  -H "Cookie: mg_session=<session>" \
  -d '{"dry_run":true,"prequote_id":"<uuid>","final_price_owner_approved":12500,"owner_confirmations":{"owner_reviewed_lead":true,"scope_confirmed":true,"measurements_confirmed":true,"materials_status_confirmed":true,"start_date_reviewed":true,"final_price_approved":true}}'
```

Expect `200`, `dry_run: true`, no new DB rows.

### B. Create DRAFT

Same body with `"dry_run": false, "create_draft_quote": true`.

Expect `200` with `draft_quote.id` and `conversion.status: draft_created`.

### C. Duplicate guard

Repeat create on same prequote → `409`.

### D. Missing create flag

`"dry_run": false` without `create_draft_quote` → `400`.

---

## 9. Supabase verification queries

```sql
-- Conversion row for prequote
select id, tenant_id, ai_closer_prequote_id, official_quote_id, status, conversion_metadata
from public.ai_closer_quote_conversions
where ai_closer_prequote_id = '<prequote-uuid>';

-- Linked DRAFT quote (safe columns only)
select id, tenant_id, status, project_name, client_name, client_email, estimated_amount, public_token
from public.quotes
where id = '<quote-uuid>';

-- Confirm no child rows
select count(*) as quote_items from public.quote_items where quote_id = '<quote-uuid>';
select count(*) as quote_labor from public.quote_labor where quote_id = '<quote-uuid>';
```

Expect: one conversion row (`draft_created`), one quote (`DRAFT`), `public_token` null, zero `quote_items` / `quote_labor`.

---

## 10. Rollback guidance (test DRAFT only — manual, commented)

Run only in Supabase SQL editor for **test** data you intend to remove. Review IDs before executing.

```sql
-- ROLLBACK TEST DRAFT ONLY — replace UUIDs; run manually at owner discretion.
-- begin;
-- delete from public.quotes where id = '<quote-uuid>' and status = 'DRAFT';
-- delete from public.ai_closer_quote_conversions where ai_closer_prequote_id = '<prequote-uuid>';
-- commit;
```

Do not use for production quotes that left draft workflow or have invoices/payments.

---

## Step 9B sign-off

- [x] Dry-run path preserved (no writes)
- [x] Create mode: `ai_closer_quote_conversions` + `quotes` only
- [x] No UI changes
- [x] Create Quote button remains disabled
- [ ] Step 9C+ UI wiring (future, after explicit approval)
