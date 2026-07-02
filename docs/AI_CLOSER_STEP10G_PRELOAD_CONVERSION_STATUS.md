# AI Closer Step 10G — Preload Conversion Status

**Status:** Read-only conversion preload + UI display. **No create logic, schema, or write changes.**

Related: [AI_CLOSER_STEP10C_UI_DUPLICATE_GUARD_VERIFIED.md](./AI_CLOSER_STEP10C_UI_DUPLICATE_GUARD_VERIFIED.md), [AI_CLOSER_STEP10F_DATE_PICKER_VERIFIED.md](./AI_CLOSER_STEP10F_DATE_PICKER_VERIFIED.md)

---

## 1. Purpose

Step 10G improves the AI Closer Owner inbox so **already-converted** prequotes show **Draft quote already created** before the owner fills final price/checklist.

### What Step 10G does

- Extends `ai-closer-list-prequotes.js` with a **read-only** lookup of `ai_closer_quote_conversions` for loaded prequote IDs.
- Returns safe per-prequote conversion metadata on inbox load.
- Shows **DRAFT CREATED** badge on cards and blocks create controls in detail/preview when converted.

### What Step 10G does NOT do

- Does **not** modify `ai-closer-create-draft-quote.js` or Supabase schema.
- Does **not** run SQL, perform database writes, or create quotes/invoices/payments.
- Does **not** call `publish-public-quote`, `send-quote-zapier`, or email clients.
- Does **not** touch sales, seller, supervisor, `app.js`, or pricing engine.
- Does **not** expose internal cost, margin, overhead, or labor rate.

---

## 2. Backend read-only preload behavior

**Endpoint:** `GET /.netlify/functions/ai-closer-list-prequotes` (unchanged URL/method)

After loading tenant-scoped `ai_closer_prequotes`:

1. Collect prequote IDs from the inbox result set.
2. **GET** `ai_closer_quote_conversions` where:
   - `tenant_id` = authenticated owner/admin tenant
   - `ai_closer_prequote_id` ∈ loaded prequote IDs
3. Select only: `ai_closer_prequote_id`, `status`, `official_quote_id`
4. Attach `conversion` object to each prequote in the JSON response.

### Per-prequote `conversion` shape

```json
{
  "is_converted": true,
  "conversion_status": "draft_created",
  "draft_quote_id": "<uuid or null>"
}
```

Unconverted prequotes:

```json
{
  "is_converted": false,
  "conversion_status": null,
  "draft_quote_id": null
}
```

**No** `insert` / `update` / `upsert` / `delete` / `.rpc(` mutations. Conversion lookup failure returns inbox without conversion flags (UI falls back to existing `409` guard).

---

## 3. UI behavior

| Location | Converted prequote |
|----------|-------------------|
| **Inbox card** | Badge: `DRAFT CREATED`; footer: *Draft quote already created for this pre-quote.* |
| **View Details** | Banner: `Draft quote already created` |
| **Conversion preview** | Banner + feedback: `Draft quote already created for this prequote.` |
| **Create button** | Disabled — text: `Draft quote already created` |
| **Price / checklist / date picker** | Disabled — owner does not need to fill form to discover duplicate |

### Unconverted prequotes

Unchanged guarded flow: final price + checklist + confirmation modal → POST create endpoint.

### Backup protection

Existing **409** duplicate handling on create remains unchanged if preload misses a row.

---

## 4. Safety confirmations

| Check | Status |
|-------|--------|
| Backend read-only only | Confirmed |
| No create endpoint changes | Confirmed |
| No Supabase/schema changes | Confirmed |
| No DB writes | Confirmed |
| No quote/invoice/payment creation | Confirmed |
| No publish/send/email | Confirmed |
| No pricing logic changes | Confirmed |
| No internal cost/margin exposed | Confirmed |
| `409` duplicate guard unchanged | Confirmed |

---

## 5. Test plan

### A. Already-converted prequote (Step 9B)

**Prequote ID:** `3c4eb013-cf74-4cc7-94ad-a5a8d839c1ea`

| Step | Expected |
|------|----------|
| Load `/ai-closer-owner.html` | Card shows **DRAFT CREATED** badge |
| Open **View Details** | Banner: *Draft quote already created* |
| Open conversion preview | Message immediately: *Draft quote already created for this prequote.* |
| Create controls | Disabled without entering price/checklist |
| Optional retry create + confirm | Still **409** (backup guard) |

### B. Unconverted eligible prequote

| Step | Expected |
|------|----------|
| No **DRAFT CREATED** badge | Normal inbox card |
| Conversion preview | Price + checklist required; create flow unchanged |

### C. Counts (converted prequote test)

Must remain unchanged:

| Metric | Value |
|--------|--------|
| `conversion_rows` | **1** |
| `quotes_count` | **279** |
| `invoices_count` | **60** |
| `payments_count` | **0** |

---

## Step 10G sign-off

- [x] Read-only conversion preload in list endpoint
- [x] Card badge + detail/preview blocking for converted prequotes
- [x] Unconverted guarded create flow unchanged
- [x] `409` backup guard preserved
- [ ] Future: optional draft quote deep link from preloaded `draft_quote_id` (owner approval required)
