# AI Closer Step 10D — Create Draft Quote UI Copy Polish

**Status:** UI text polish only. **No logic, API, schema, or behavior changes.**

Related: [AI_CLOSER_STEP10B_UI_CREATE_DRAFT_QUOTE.md](./AI_CLOSER_STEP10B_UI_CREATE_DRAFT_QUOTE.md), [AI_CLOSER_STEP10C_UI_DUPLICATE_GUARD_VERIFIED.md](./AI_CLOSER_STEP10C_UI_DUPLICATE_GUARD_VERIFIED.md)

---

## 1. Purpose

Step 10D polishes the AI Closer Owner UI copy so the detail-view entry button clearly communicates it creates a **DRAFT quote only**, not an official sent/published quote.

### What Step 10D does

- Relabels the detail-view entry button and its badge.
- Keeps all existing draft-only safety copy visible.

### What Step 10D does NOT do

- Does **not** modify Netlify functions or Supabase schema.
- Does **not** add API calls or database writes.
- Does **not** change create logic, duplicate guard logic, or endpoint payload.
- Does **not** touch sales, seller, supervisor, `app.js`, invoices, payments, pricing engine, or official quote workflows.
- Does **not** expose internal cost, margin, overhead, labor rate, or protected pricing internals.

---

## 2. Copy changes made

| Location | Before | After |
|----------|--------|-------|
| Detail-view entry button (`public/js/ai-closer-owner.js`) | `Create Official Quote` | `Create Draft Quote Only` |
| Entry button badge | `Preview only` | `DRAFT ONLY` |

**File note:** The detail-view entry button and badge are rendered from `public/js/ai-closer-owner.js` (template literal in `renderDetailModal`). `public/ai-closer-owner.html` contained no matching visible copy for these two strings, so no HTML text change was required.

### Preserved safety copy (unchanged)

In the conversion preview, the safety labels remain visible:

- `DRAFT only`
- `Not sent`
- `Not published`
- `No invoice`
- `No payment`
- `No email`

Confirmation modal copy (title, warning, buttons) is unchanged from Step 10B.

---

## 3. Safety confirmations

| Check | Status |
|-------|--------|
| UI copy/text polish only | Confirmed |
| No Netlify function changes | Confirmed |
| No Supabase/schema changes | Confirmed |
| No DB writes / API calls added | Confirmed |
| No create logic changed | Confirmed |
| No duplicate guard logic changed | Confirmed |
| No endpoint payload changed | Confirmed |
| No pricing/status/official quote behavior changed | Confirmed |
| No internal cost/margin exposed | Confirmed |

### Behavior preserved

- View Details works
- Conversion preview opens
- Final price + checklist still required
- Confirmation modal still required
- Endpoint called only after explicit owner confirmation
- `409` duplicate handling unchanged
- Success handling unchanged
- Button disabled/blocking behavior unchanged

---

## 4. Test plan

1. Sign in as owner/admin on `/ai-closer-owner.html`.
2. Open **View Details** on any prequote.
3. Confirm the entry button now reads **Create Draft Quote Only** with a **DRAFT ONLY** badge.
4. Click it → conversion preview opens (unchanged).
5. Confirm safety labels still show: DRAFT only · Not sent · Not published · No invoice · No payment · No email.
6. Confirm price input + checklist + confirmation modal still gate the create action.

### Expected result — already-converted prequote

For the already-converted prequote (converted in Step 9B):

| Item | Expected |
|------|----------|
| Fill price + all confirmations, click create, confirm | Backend returns **409** |
| UI message | `Draft quote already created for this prequote.` (**unchanged**) |
| Create button | Disabled / blocked (**unchanged**) |
| Counts | Unchanged: `conversion_rows = 1`, `quotes_count = 279`, `invoices_count = 60`, `payments_count = 0` |

Duplicate-guard behavior and messaging are identical to Step 10C; only the entry button label/badge changed.

---

## Step 10D sign-off

- [x] Entry button relabeled to `Create Draft Quote Only`
- [x] Badge relabeled to `DRAFT ONLY`
- [x] Safety copy preserved
- [x] No logic, API, schema, or behavior changes
- [x] Duplicate `409` message unchanged
