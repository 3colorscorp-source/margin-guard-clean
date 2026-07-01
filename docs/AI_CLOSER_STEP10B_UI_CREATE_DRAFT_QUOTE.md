# AI Closer Step 10B — Guarded Create Draft Quote UI

**Status:** UI wired to verified backend. **DRAFT only — no send, publish, invoice, payment, or email.**

Related: [AI_CLOSER_STEP10A_UI_WIRING_PLAN.md](./AI_CLOSER_STEP10A_UI_WIRING_PLAN.md), [AI_CLOSER_STEP9B_BACKEND_DRAFT_QUOTE_CREATE.md](./AI_CLOSER_STEP9B_BACKEND_DRAFT_QUOTE_CREATE.md), [AI_CLOSER_STEP9C_BACKEND_DRAFT_QUOTE_VERIFIED.md](./AI_CLOSER_STEP9C_BACKEND_DRAFT_QUOTE_VERIFIED.md)

---

## 1. Purpose

Step 10B wires the AI Closer Owner **Official Quote Conversion Preview** modal to the verified backend endpoint for **Create Draft Quote Only**.

### What Step 10B does

- Adds owner final price input, required confirmation checkboxes, optional start date/note.
- Enables **Create Draft Quote Only** only when validations pass.
- Shows confirmation dialog before POST.
- Calls `POST /.netlify/functions/ai-closer-create-draft-quote` with `create_draft_quote: true`.
- Handles `200` success and `409` duplicate safely.

### What Step 10B does NOT do

- Does **not** modify Netlify functions or Supabase schema.
- Does **not** call `publish-public-quote` or `send-quote-zapier`.
- Does **not** create `quote_items`, `quote_labor`, `labor_tracking_quote`, invoices, or payments.
- Does **not** email client or mint public token.
- Does **not** auto-call endpoint on page load or modal open.
- Does **not** expose internal cost, margin, overhead, or labor rate.

---

## 2. UI entry point

| Location | Behavior |
|----------|----------|
| Detail modal | **Create Official Quote** (preview badge) opens conversion preview |
| Conversion preview | Guarded form + **Create Draft Quote Only** button |
| Confirmation overlay | **Create Draft Quote Only** → confirm → POST |

---

## 3. Required owner inputs

| Input | Required |
|-------|----------|
| Final owner-approved price | Yes — numeric `> 0` |
| Owner reviewed lead | Checkbox |
| Scope confirmed | Checkbox |
| Measurements confirmed | Checkbox |
| Materials/tile status confirmed | Checkbox |
| Start date reviewed | Checkbox |
| Final price approved | Checkbox |
| Start date | Optional |
| Owner note | Optional |

Help text on price: *This is the final DRAFT quote amount approved by the owner. It is not auto-calculated by AI.*

---

## 4. Button enablement

**Create Draft Quote Only** is disabled unless:

- Final price is numeric and `> 0`
- All six checkboxes are checked
- Prequote status is `reviewed`, `good_lead`, or `needs_site_visit`
- Not currently submitting
- Not already marked converted in local UI state

---

## 5. Confirmation modal

| Element | Copy |
|---------|------|
| Title | `Create Draft Quote Only` |
| Warning | `This will create a DRAFT quote only. It will not send, publish, invoice, request payment, or email the client.` |
| Cancel | `Cancel` |
| Confirm | `Create Draft Quote` |

Endpoint is called **only** after owner clicks **Create Draft Quote** in the confirmation overlay.

---

## 6. API payload

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
  "start_date": "optional",
  "owner_note": "optional"
}
```

Auth: `credentials: "include"` (session cookie), same as list/update prequote APIs.

---

## 7. Success behavior (`200`)

- Message: `Draft quote created. It was not sent, published, invoiced, or emailed.`
- Shows draft quote ID and status
- Disables create button and form fields
- Marks local prequote state as converted
- Shows side-effect confirmation: no invoice, payment, publish, email
- **No** auto-redirect

---

## 8. Duplicate behavior (`409`)

- Message: `Draft quote already created for this prequote.`
- Disables create button
- Marks local state as converted/blocked
- **No** automatic retry
- **No** second quote created

---

## 9. Tables backend writes (on create only)

| Table | Written |
|-------|---------|
| `public.ai_closer_quote_conversions` | Yes |
| `public.quotes` | Yes — one DRAFT row |

## 10. Tables backend does NOT write

- `quote_items`
- `quote_labor`
- `labor_tracking_quote`
- `invoices`
- `payments`

---

## 11. Safety labels (visible in preview)

`DRAFT only` · `Not sent` · `Not published` · `No invoice` · `No payment` · `No email`

---

## 12. Test plan — already-converted prequote

**Prequote ID (converted in Step 9B):** `3c4eb013-cf74-4cc7-94ad-a5a8d839c1ea`

### Steps

1. Sign in as owner/admin on `/ai-closer-owner.html`.
2. Open **View Details** for the prequote (project: `front floor` if still in inbox).
3. Click **Create Official Quote** to open conversion preview.
4. Enter final price `12000` (or any valid amount).
5. Check all six confirmation boxes.
6. Click **Create Draft Quote Only** → **Create Draft Quote** in confirmation.

### Expected result

| Item | Expected |
|------|----------|
| HTTP status | `409` |
| UI message | `Draft quote already created for this prequote.` |
| Create button | Disabled — `Draft quote already created` |
| Second draft quote | **Not** created |
| Counts | Unchanged: `conversion_rows = 1`, `quotes_count = 279`, `invoices_count = 60`, `payments_count = 0` |

### Fresh prequote test (optional)

Use an eligible prequote with no conversion row → expect `200`, one new DRAFT quote, counts +1 conversion and +1 quote only.

---

## Step 10B sign-off

- [x] Guarded UI in `ai-closer-owner.html` / `ai-closer-owner.js`
- [x] Confirmation before POST
- [x] No Netlify/schema changes in Step 10B
- [x] 409 duplicate handling
- [x] No publish/send/email/invoice/payment from UI
- [ ] Step 10C+ inbox conversion badge / deep link (future)
