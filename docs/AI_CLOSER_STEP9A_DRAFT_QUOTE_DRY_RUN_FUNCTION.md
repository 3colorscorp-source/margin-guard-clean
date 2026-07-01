# AI Closer Step 9A — Draft Quote Dry-Run Function

**Status:** Backend-only dry-run validation. **No quote creation. No UI wiring.**

Related: [AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md](./AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md), [AI_CLOSER_STEP8F_IDEMPOTENCY_GUARD_APPLIED.md](./AI_CLOSER_STEP8F_IDEMPOTENCY_GUARD_APPLIED.md)

---

## 1. Purpose

Step 9A adds an isolated Netlify function that validates whether an AI Closer prequote **could** be converted to an official DRAFT quote — without creating anything.

### What Step 9A does

- `POST /.netlify/functions/ai-closer-create-draft-quote` with `dry_run: true`
- Owner/admin auth and tenant scope (same pattern as `ai-closer-list-prequotes.js`)
- Read-only checks against `ai_closer_prequotes` and `ai_closer_quote_conversions`
- Returns a safe `conversion_plan` JSON payload

### What Step 9A does NOT do

- Does **not** insert into `public.quotes`, `quote_items`, `quote_labor`, or `labor_tracking_quote`
- Does **not** insert/update/delete/upsert any database rows
- Does **not** create invoices or payments
- Does **not** call `publish-public-quote` or `send-quote-zapier`
- Does **not** email the client
- Does **not** enable **Create Quote** in `/ai-closer-owner.html`
- Does **not** modify production HTML/JS or Supabase schema
- Does **not** expose internal cost, margin, overhead, labor rate, or protected pricing internals

---

## 2. Dry-run only

| Rule | Enforcement |
|------|-------------|
| `dry_run` required | Must be exactly `true` |
| `dry_run` missing or `false` | `400` — *Step 9A is dry-run only. No draft quote was created.* |
| Database writes | **Zero** — only `GET` via `supabaseRequest` |

Step 9B will allow actual DRAFT creation (still backend-only, no UI) after dry-run validation passes in testing.

---

## 3. Auth and tenant safety

| Check | Behavior |
|-------|----------|
| Session | `readSessionFromEvent` — `mg_session` cookie |
| Role | Active **owner** or **admin** membership only |
| Tenant | `tenant_id` from `profiles.auth_user_id` or email fallback — **never** from request body |
| Rejected body keys | `tenant_id` and other scope overrides are ignored / not trusted |

---

## 4. Request payload

```json
{
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
  "owner_note": "Optional note for future Step 9B",
  "dry_run": true
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `prequote_id` | Yes | Valid UUID |
| `final_price_owner_approved` | Yes | Finite number `> 0` |
| `owner_confirmations` | Yes | All six booleans must be `true` |
| `start_date` | No | Accepted in body; used in Step 9B |
| `owner_note` | No | Accepted in body; used in Step 9B |
| `dry_run` | Yes | Must be `true` for Step 9A |

---

## 5. Validations

1. `POST` only
2. Authenticated owner/admin
3. `prequote_id` valid UUID
4. `final_price_owner_approved` numeric and `> 0`
5. All required `owner_confirmations` are `true`
6. Prequote exists for authenticated `tenant_id`
7. Prequote status ∈ `reviewed`, `good_lead`, `needs_site_visit`
8. No existing row in `ai_closer_quote_conversions` for `ai_closer_prequote_id`

### HTTP error mapping

| Condition | Code |
|-----------|------|
| Not `POST` | 405 |
| No session | 401 |
| Not owner/admin | 403 |
| Invalid body / confirmations / price / missing dry_run | 400 |
| Prequote not found | 404 |
| Ineligible status or duplicate conversion | 409 |
| Supabase read failure | 502 |
| Unexpected error | 500 (generic) |

---

## 6. Expected success response

```json
{
  "ok": true,
  "dry_run": true,
  "message": "Draft quote conversion validated. No quote was created.",
  "conversion_plan": {
    "prequote_id": "<uuid>",
    "tenant_id": "<uuid>",
    "future_quote_status": "DRAFT",
    "project_name": "...",
    "client_name": "...",
    "client_email": "...",
    "estimated_amount": 12500,
    "scope_notes": "...",
    "will_create_quote": false,
    "will_create_quote_items": false,
    "will_create_quote_labor": false,
    "will_create_invoice": false,
    "will_create_payment": false,
    "will_publish": false,
    "will_email_client": false
  }
}
```

`estimated_amount` reflects owner-entered `final_price_owner_approved` only — not planning range or client budget.

---

## 7. Manual test instructions

**Prerequisites:** Logged in as owner/admin with valid `mg_session` cookie on deployed site or `netlify dev`.

### A. Dry-run rejected without flag

```bash
curl -X POST "https://<site>/.netlify/functions/ai-closer-create-draft-quote" \
  -H "Content-Type: application/json" \
  -H "Cookie: mg_session=<session>" \
  -d '{"prequote_id":"<uuid>","final_price_owner_approved":10000,"owner_confirmations":{"owner_reviewed_lead":true,"scope_confirmed":true,"measurements_confirmed":true,"materials_status_confirmed":true,"start_date_reviewed":true,"final_price_approved":true}}'
```

Expect `400` with *Step 9A is dry-run only.*

### B. Successful dry-run

Add `"dry_run": true` to the body. Use a prequote in `reviewed`, `good_lead`, or `needs_site_visit` with no conversion row.

Expect `200` with `conversion_plan` and all `will_create_*` / `will_publish` / `will_email_client` as `false`.

### C. Duplicate conversion guard

If `ai_closer_quote_conversions` already has a row for the prequote, expect `409` with a safe duplicate message.

### D. No writes

After a successful dry-run, verify in Supabase:

- No new `quotes` rows
- No new `ai_closer_quote_conversions` rows (Step 9A is read-only)

---

## 8. Next step — Step 9B

**Step 9B — Actual DRAFT quote creation (backend only, still no UI)**

- Extend `ai-closer-create-draft-quote.js` with `dry_run: false` path (or separate flag) **only after** dry-run testing passes
- Insert guard row in `ai_closer_quote_conversions`, then insert `public.quotes` as `DRAFT`
- Still: no `quote_labor`, no publish/send/invoice/payment, no UI enablement until a later step

---

## Step 9A sign-off

- [x] New function: `netlify/functions/ai-closer-create-draft-quote.js`
- [x] Dry-run enforced (`dry_run: true` required)
- [x] Read-only database access
- [x] Owner/admin auth + tenant scope
- [x] Idempotency read check via `ai_closer_quote_conversions`
- [x] Create Quote UI remains disabled
- [ ] Step 9B actual DRAFT insert (future)
