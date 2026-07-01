# AI Closer Step 10E — Current-Month Start Day Picker

**Status:** UI date-picker polish only. **No backend, schema, or create-logic changes.**

Related: [AI_CLOSER_STEP10D_UI_COPY_POLISH.md](./AI_CLOSER_STEP10D_UI_COPY_POLISH.md), [AI_CLOSER_STEP10B_UI_CREATE_DRAFT_QUOTE.md](./AI_CLOSER_STEP10B_UI_CREATE_DRAFT_QUOTE.md)

---

## 1. Purpose

Step 10E improves the AI Closer **Create Draft Quote** conversion preview so owners pick an optional start day from the **current month** instead of typing a full date/year manually.

This is **not** a scheduling system — it only improves optional `start_date` input for draft quote conversion.

### What Step 10E does

- Replaces manual `input type="date"` with a current-month day grid.
- Maps selected day → ISO `YYYY-MM-DD` for the existing backend payload.
- Shows friendly selected-date copy (e.g. `Selected: Jul 12, 2026`).

### What Step 10E does NOT do

- Does **not** modify Netlify functions or Supabase schema.
- Does **not** add API calls or database writes.
- Does **not** change create quote backend logic, duplicate guard, or endpoint URL.
- Does **not** touch sales, seller, supervisor, `app.js`, invoices, payments, or pricing engine.
- Does **not** expose internal cost, margin, overhead, or labor rate.

---

## 2. What changed visually

| Before | After |
|--------|--------|
| Label: `Start date (optional)` | Label: `Start day (optional)` |
| Manual date input (`type="date"`) | Current-month picker with month label (e.g. `July 2026`) |
| Owner types/selects full date | Owner clicks a day in the grid |
| — | Today has subtle marker |
| — | Selected day highlighted |
| — | `Clear date` link |
| — | Helper: `Selected: Jul 12, 2026` or `No start day selected.` |

All existing safety pills, price input, checklist, confirmation modal, and create button behavior are unchanged.

---

## 3. How selected day maps to `YYYY-MM-DD`

The picker uses the **browser’s current local month/year** at preview open time.

| Owner action | Internal value | API payload |
|--------------|----------------|-------------|
| Clicks day `12` in July 2026 | Hidden field: `2026-07-12` | `start_date: "2026-07-12"` |
| Clicks **Clear date** | Hidden field: `""` | `start_date` omitted (optional) |
| Never selects a day | Hidden field: `""` | `start_date` omitted |

Format: `{year}-{MM}-{DD}` via `isoFromPickerDay()` in `public/js/ai-closer-owner.js`.

---

## 4. Safety confirmations

| Check | Status |
|-------|--------|
| UI date-picker polish only | Confirmed |
| No Netlify/Supabase/schema changes | Confirmed |
| No DB writes / new API calls | Confirmed |
| Create logic unchanged (except `start_date` UI source) | Confirmed |
| Duplicate guard logic unchanged | Confirmed |
| Endpoint URL unchanged | Confirmed |
| Payload unchanged except `start_date` from picker | Confirmed |
| Confirmation still required before POST | Confirmed |
| No pricing/status/official quote behavior changed | Confirmed |
| No internal cost/margin exposed | Confirmed |

### Preserved behavior

- View Details, conversion preview, copy buttons, status actions, filters, refresh
- Close / backdrop / Escape (confirm → preview → detail)
- Final price + checklist gating
- `409` duplicate and `200` success handling unchanged

---

## 5. Test plan

### A. Day picker (any eligible prequote)

1. Open `/ai-closer-owner.html` → **View Details** → **Create Draft Quote Only**.
2. Confirm month label shows current month/year.
3. Click a day → helper shows `Selected: …` and day is highlighted.
4. Click **Clear date** → helper shows `No start day selected.`
5. Confirm no year typing is required.

### B. Optional payload

- Create without selecting a day → payload has no `start_date`.
- Create with day selected → payload includes ISO `start_date`.

### C. Already-converted prequote (duplicate guard)

Use the prequote converted in Step 9B:

| Step | Action |
|------|--------|
| 1 | Open conversion preview |
| 2 | Enter price, check all confirmations (optional: pick a day) |
| 3 | **Create Draft Quote Only** → confirm |

| Expected | Result |
|----------|--------|
| UI message | `Draft quote already created for this prequote.` (**unchanged**) |
| Create button | Disabled / blocked |
| Counts | `conversion_rows = 1`, `quotes_count = 279`, `invoices_count = 60`, `payments_count = 0` |

Date picker polish does not affect duplicate guard behavior.

---

## Step 10E sign-off

- [x] Current-month day picker in conversion preview
- [x] ISO `start_date` mapping preserved for backend
- [x] No backend/schema changes
- [x] Duplicate `409` behavior unchanged
