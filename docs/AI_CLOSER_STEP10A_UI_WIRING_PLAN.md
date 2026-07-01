# AI Closer Step 10A — Create Draft Quote UI Wiring Plan

**Status:** Documentation / plan only. **No code, schema, API, or UI behavior changes in Step 10A.**

Related: [AI_CLOSER_STEP9C_BACKEND_DRAFT_QUOTE_VERIFIED.md](./AI_CLOSER_STEP9C_BACKEND_DRAFT_QUOTE_VERIFIED.md), [AI_CLOSER_STEP9B_BACKEND_DRAFT_QUOTE_CREATE.md](./AI_CLOSER_STEP9B_BACKEND_DRAFT_QUOTE_CREATE.md), [AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md](./AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md)

---

## 1. Purpose

Step 10A documents the **exact UI wiring plan** for enabling AI Closer **Create Official Quote** as **Create Draft Quote Only** in a future owner-approved step.

### What Step 10A does

- Defines entry point, inputs, enablement rules, confirmation modal, API payload, success/error UX, and safety boundaries.
- Locks scope for Step 10B implementation.

### What Step 10A does NOT do

- Does **not** modify `public/ai-closer-owner.html`, `public/js/ai-closer-owner.js`, Netlify functions, or Supabase schema.
- Does **not** run SQL, add API calls, or perform database writes.
- Does **not** create another quote or enable the Create Quote button.
- Does **not** touch official quotes, invoices, payments, sales, seller, supervisor, `app.js`, or pricing logic.
- Does **not** expose internal cost, margin, overhead, labor rate, or protected pricing internals.

**Create Quote remains disabled** until Step 10B after explicit owner approval.

---

## 2. Current verified backend status

| Item | Status |
|------|--------|
| **Endpoint** | `POST /.netlify/functions/ai-closer-create-draft-quote` |
| **Dry-run** (`dry_run: true`) | **Verified** — validation only, no writes |
| **Create mode** (`dry_run: false`, `create_draft_quote: true`) | **Verified** — DRAFT quote + `draft_created` conversion |
| **Duplicate guard** | **Verified** — repeat create returns `409` |
| **Converted test prequote** | Returns `409` on repeat; no second quote |

See [AI_CLOSER_STEP9C_BACKEND_DRAFT_QUOTE_VERIFIED.md](./AI_CLOSER_STEP9C_BACKEND_DRAFT_QUOTE_VERIFIED.md).

---

## 3. Future UI entry point

**Location:** `/ai-closer-owner.html` — detail modal and conversion preview modal (existing Step 6C workspace).

| Element | Plan |
|---------|------|
| **Button label** | `Create Draft Quote Only` |
| **Must NOT say** | Send Quote, Publish Quote, Create Invoice, Request Deposit |

The button replaces the current disabled **Create Quote — Disabled** label only in Step 10B, after checklist + price + confirmation are satisfied.

---

## 4. Required UI inputs before enabling button

### Final owner-approved price

- Dedicated number input.
- Label must clarify: *Final official price (owner-approved, not planning range)*.
- Required; must be numeric and `> 0`.

### Owner confirmation checklist

All must be checked before enablement:

| Key | Label (owner-facing) |
|-----|-------------------|
| `owner_reviewed_lead` | Owner reviewed lead |
| `scope_confirmed` | Scope confirmed |
| `measurements_confirmed` | Measurements confirmed |
| `materials_status_confirmed` | Materials/tile status confirmed |
| `start_date_reviewed` | Start date reviewed |
| `final_price_approved` | Final price approved |

### Optional fields

| Field | Notes |
|-------|--------|
| `start_date` | ISO `YYYY-MM-DD`; optional |
| `owner_note` | Optional internal note for quote notes block |

**Must NOT display or derive price from:** `range_low`, `range_high`, `client_budget`, internal cost, margin, overhead, or labor rate.

---

## 5. Button enablement rules

| Rule | Behavior |
|------|----------|
| **Default** | Button **disabled** |
| **Enable when** | Final price numeric `> 0` **and** all checklist items checked **and** prequote status ∈ `reviewed`, `good_lead`, `needs_site_visit` **and** prequote not already converted |
| **Already converted** | Show message: `Draft quote already created` — button stays **disabled** |
| **Ineligible status** | Button disabled; optional helper text for owner |

### Conversion detection (UI)

- Prefer local state after successful create.
- On load/detail open: optional read-only hint if inbox later exposes conversion status; until then, rely on `409` from backend on duplicate attempt.
- Step 10B may cache `draft_quote.id` in modal state after success.

---

## 6. Confirmation modal plan

Shown **after** checklist + price valid, **before** API call.

| Element | Copy |
|---------|------|
| **Title** | `Create Draft Quote Only` |
| **Warning** | `This will create a DRAFT quote only. It will not send, publish, invoice, request payment, or email the client.` |
| **Confirm** | `Create Draft Quote` |
| **Cancel** | `Cancel` |

Confirm triggers POST; Cancel closes confirmation only (detail/preview modal stays open).

---

## 7. API request plan

**Method:** `POST`  
**URL:** `/.netlify/functions/ai-closer-create-draft-quote`  
**Credentials:** include session cookie (`mg_session`) — same pattern as list/update prequote functions.

### Payload

```json
{
  "dry_run": false,
  "create_draft_quote": true,
  "prequote_id": "<uuid>",
  "final_price_owner_approved": 12000,
  "owner_confirmations": {
    "owner_reviewed_lead": true,
    "scope_confirmed": true,
    "measurements_confirmed": true,
    "materials_status_confirmed": true,
    "start_date_reviewed": true,
    "final_price_approved": true
  },
  "start_date": "2026-07-15",
  "owner_note": "Optional note"
}
```

**Do not send:** `tenant_id`, `public_token`, `status`, workers, deposit flags, send/publish flags, planning range fields.

---

## 8. Success UI behavior

On `200` with `ok: true`:

| Action | Behavior |
|--------|----------|
| **Message** | `Draft quote created. It was not sent, published, invoiced, or emailed.` |
| **Draft info** | Show `draft_quote.id` and `draft_quote.status` (expect `DRAFT`) |
| **Local state** | Mark prequote as converted in card/detail when possible |
| **Button** | Disable create button; show `Draft quote already created` |
| **Side effects** | Display safe status from `side_effects`: no invoice, no payment, no publish, no email |
| **Navigation** | **Do not** auto-redirect to Sales or public estimate unless later approved |

Optional future: link *Open draft quote* to existing owner quote edit route — out of scope for 10B v1 unless owner requests.

---

## 9. Duplicate / 409 UI behavior

When endpoint returns `409`:

| Action | Behavior |
|--------|----------|
| **Message** | `A draft quote already exists for this prequote.` |
| **Button** | Disable create button |
| **Retry** | **No** automatic retry |
| **Second quote** | **Must not** be created |

Treat same as already-converted local state.

---

## 10. Error handling

| Rule | Behavior |
|------|----------|
| User-facing errors | Short `error` string from JSON body only |
| **Never show** | Raw stack traces, service role details, Supabase internals, margin/cost/overhead/labor rate |
| **Modal** | Keep detail/preview modal open so owner can fix missing fields |
| **400** | Validation — highlight checklist or price |
| **401 / 403** | Session / role — prompt re-login if needed |
| **404** | Prequote not found — safe message, disable create |
| **502 / 500** | Generic retry-later message |

---

## 11. Tables expected to be written (backend only)

| Table | Operation |
|-------|-----------|
| `public.ai_closer_quote_conversions` | INSERT + PATCH (idempotency guard) |
| `public.quotes` | INSERT one DRAFT row |

UI triggers Netlify function only; **no direct Supabase writes from browser**.

---

## 12. Tables that must NOT be written from UI flow

- `quote_items`
- `quote_labor`
- `labor_tracking_quote`
- `invoices`
- `payments`
- `tenant_projects`

---

## 13. Things the UI must NOT do

- Must **not** call `publish-public-quote`
- Must **not** call `send-quote-zapier`
- Must **not** create or display `public_token` / public estimate URL
- Must **not** create invoice or payment
- Must **not** email client
- Must **not** expose internal margin, cost, overhead, or labor rate
- Must **not** wire to `estimate-public-send.js` or seller device flows
- Must **not** modify `app.js`, `sales.html`, or supervisor/seller portals

---

## 14. Next safe implementation step

### Step 10B — Guarded UI implementation

**Only after owner approval of this plan (10A).**

**Allowed files:**

| File | Change |
|------|--------|
| `public/ai-closer-owner.html` | Checklist, price input, confirmation modal, button label |
| `public/js/ai-closer-owner.js` | Enablement logic, fetch to create endpoint, success/error UX |
| `docs/AI_CLOSER_STEP10B_UI_CREATE_DRAFT_QUOTE.md` | Implementation notes + sign-off |

**Step 10B must:**

- Implement all rules in sections 3–13 above.
- Reuse existing owner session fetch pattern from list/update prequote.
- Keep dry-run available for optional dev testing only (not default UI path).

**Step 10B must NOT:**

- Enable send, publish, invoice, payment, or email on create.
- Touch Netlify functions or Supabase schema without separate approval.

---

## Step 10A sign-off

- [x] UI wiring plan documented
- [x] Backend status referenced (Steps 9B / 9C)
- [x] No production code changed in Step 10A
- [x] Create Quote button remains disabled in production
- [ ] Step 10B guarded UI implementation (future, owner approval required)
