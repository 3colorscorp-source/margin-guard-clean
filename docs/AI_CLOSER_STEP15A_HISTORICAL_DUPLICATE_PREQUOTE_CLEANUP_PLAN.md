# AI Closer Step 15A — Historical Duplicate Prequote Cleanup Plan

## 1. Purpose

Step 15A is **planning only**. No production code, backend, or database changes are made in this step.

**Goal:** Decide safe handling for the historical duplicate AI Closer prequote created during Step 11B, before the client submit guard existed.

## 2. Current verified status

| Capability | Status |
|------------|--------|
| AI Closer client submit guard | PASS REAL (Steps 11D/11E) |
| Owner Inbox loads 4 prequotes | Verified |
| Converted Step 11B lead | `GOOD LEAD` + `DRAFT CREATED` |
| Duplicate Step 11B prequote | Remains unconverted historical test data |
| No invoice/payment/email/publish side effects | Verified |

**Baseline counts (post Step 14C):**

- `prequotes_count` = 4
- `conversion_rows` = 2
- `quotes_count` = 280
- `invoices_count` = 61
- `payments_count` = 0

## 3. Duplicate context

During **Step 11B**, the client form double-submitted and created **two matching prequotes** for:

- **Project:** AI Closer 11B Fresh Test
- **Client:** Librado Test 11B

**Key facts:**

- The duplicate was created **before** the Step 11D client submit guard shipped.
- Steps **11D/11E** verified duplicate prevention going forward — new submits are blocked client-side.
- This remaining duplicate is **not a new bug** after the guard; it is legacy test data.
- The duplicate **should not be deleted** — archive via existing status workflow only.

One matching prequote was converted successfully to a DRAFT quote. The other remains visible in the Owner Inbox as unconverted historical data.

## 4. Recommended safe cleanup option

Use the existing Owner Inbox **Archive** status action on the **unconverted duplicate only**.

| Action | Guidance |
|--------|----------|
| Archive unconverted duplicate | Yes — via existing UI |
| Delete data | No |
| Convert the duplicate | No |
| Create another draft quote | No |
| Manual SQL update | No — unless explicitly approved later |
| Preferred path | UI **Archive** — uses existing verified status workflow (`ai-closer-update-prequote-status`) |

No code changes required for Step 15B if the owner performs the archive manually through the verified Owner Inbox.

## 5. How to identify the duplicate later

| Field | Value |
|-------|--------|
| **Project** | `AI Closer 11B Fresh Test` |
| **Client** | `Librado Test 11B` |

**Identify the duplicate:**

- The row **without** `DRAFT CREATED` badge is the duplicate to archive.
- The row **with** `GOOD LEAD` + `DRAFT CREATED` is the converted lead — **do not archive or modify**.

If both rows appear with the same project/client name, use the `DRAFT CREATED` badge as the sole discriminator.

## 6. Expected result if Step 15B is approved

After archiving the unconverted duplicate via Owner Inbox UI:

| Metric | Expected |
|--------|----------|
| Duplicate prequote status | `Archived` |
| `prequotes_count` | 4 (unchanged — archive is status change, not delete) |
| `conversion_rows` | 2 |
| `quotes_count` | 280 |
| `invoices_count` | 61 |
| `payments_count` | 0 |

No quote, conversion, invoice, or payment is created. The converted Step 11B lead remains `GOOD LEAD` + `DRAFT CREATED`.

## 7. Must-not-do list for Step 15B

Step 15B must **not**:

- Archive the converted `DRAFT CREATED` prequote
- Create another draft quote from the duplicate
- Delete rows from the database
- Run SQL manually
- Add or change application code
- Change pricing or status logic
- Touch sidebar or dashboard
- Expose internal cost/margin or protected pricing internals

## 8. Recommended Step 15B manual test plan

1. Open `/ai-closer-owner.html`
2. Locate duplicate **AI Closer 11B Fresh Test** / **Librado Test 11B**
3. Confirm the target row does **not** show `DRAFT CREATED`
4. Confirm the other matching row **does** show `GOOD LEAD` + `DRAFT CREATED` — leave it untouched
5. Click **Archive** only on the unconverted duplicate
6. Confirm archived status/filter reflects the change
7. Run Supabase counts verification

**Expected counts after archive:**

| Metric | Count |
|--------|------:|
| `prequotes_count` | 4 |
| `conversion_rows` | 2 |
| `quotes_count` | 280 |
| `invoices_count` | 61 |
| `payments_count` | 0 |

8. Document result in Step 15C (verification doc) after owner approval

## 9. Final recommendation

- **Proceed with Step 15B only after owner approval**
- Use existing UI **Archive** action — no code, SQL, or delete
- Keep **sidebar integration deferred**

**Suggested sequence:**

1. **Step 15B** — Owner manually archives unconverted Step 11B duplicate via Inbox
2. **Step 15C** — Document production verification of archive cleanup
3. **Later** — Step 16A+ planning (draft quote deep link, inbox polish) or sidebar — only after cleanup PASS REAL
