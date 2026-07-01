# AI Closer Step 8A — Official Draft Quote Conversion Contract

**Status:** Specification / contract only. **No implementation in Step 8A.**

Related: [AI_CLOSER_STEP7_QUOTE_MAPPING_AUDIT.md](./AI_CLOSER_STEP7_QUOTE_MAPPING_AUDIT.md)

---

## 1. Purpose

Step 8A defines the **exact implementation contract** for a future step that converts one `public.ai_closer_prequotes` row into one **official Margin Guard DRAFT quote** (`public.quotes`).

### What Step 8A does

- Documents future server behavior, request/response shape, validations, mapping rules, idempotency, and UI follow-up (Step 8B).
- Locks safety boundaries so implementation cannot accidentally call publish/send/invoice flows.

### What Step 8A does NOT do

- Does **not** create official quotes.
- Does **not** enable **Create Quote — Disabled** in `/ai-closer-owner.html`.
- Does **not** add Netlify functions, Supabase migrations, or production HTML/JS changes.
- Does **not** perform database writes or API calls.
- Does **not** expose internal cost, margin, overhead, labor rate, or protected pricing internals.

**Implementation target:** Step 8B+ (function + schema if needed + UI enablement), only after this contract is approved.

---

## 2. Future conversion behavior

When implemented, conversion must obey all of the following:

| Rule | Requirement |
|------|-------------|
| Auth | **Owner/admin only** (same resolution pattern as `ai-closer-list-prequotes.js` / `ai-closer-update-prequote-status.js`) |
| Tenant scope | `tenant_id` from authenticated membership only — never from client body alone |
| Cardinality | **One** `ai_closer_prequotes` row → **one** official DRAFT quote |
| Quote status | Insert/update as **`draft`** (or equivalent non-send status accepted by `quote-edit-guard.js`) |
| Send | **Does not** call `send-quote-zapier` |
| Publish | **Does not** call `publish-public-quote` |
| Public link | **Does not** mint `public_token` or return `public_url` |
| Invoice | **Does not** insert/patch `invoices` |
| Payments | **Does not** create deposits, payment links, or trigger deposit automation |
| Email | **Does not** email the client (no Zapier) |
| Projects | **Does not** upsert `tenant_projects` |
| Pricing engine | **Does not** auto-run full `calculateQuotePublishFinancials` from AI Closer range |
| Confirmation | **Requires** explicit owner confirmation payload (checklist + final price) |
| Prequote side effect | May set prequote status to `converted` (future) — optional in 8B; document only here |

---

## 3. Proposed future endpoint

**File (not created in Step 8A):**

```
netlify/functions/ai-closer-create-draft-quote.js
```

| Property | Value |
|----------|--------|
| Method | `POST` |
| Auth | Session cookie (`mg_session`) → owner/admin membership |
| Tenant | `profiles.auth_user_id` → `tenant_id` (with email fallback per AI Closer pattern) |
| Scope | Isolated from `publish-public-quote.js` — **new handler**, shared libs only for auth/tenant/display |

**Response (success, safe fields only):**

```json
{
  "ok": true,
  "quote_id": "<uuid>",
  "status": "draft",
  "prequote_id": "<uuid>",
  "project_name": "...",
  "client_name": "...",
  "total": 12500,
  "edit_hint": "Open quote in owner draft editor to complete workers, terms, and send."
}
```

**Must NOT return:** `public_token`, `public_url`, internal pricing breakdown, `raw_payload`, labor rates, margin, deposit automation fields unless owner already set deposit in a later step.

---

## 4. Proposed request payload

```json
{
  "prequote_id": "<uuid>",
  "final_price_owner_approved": 12500,
  "owner_confirmations": {
    "scope_confirmed": true,
    "measurements_confirmed": true,
    "work_type_confirmed": true,
    "unit_type_confirmed": true,
    "materials_tile_status_confirmed": true,
    "start_date_reviewed": true,
    "final_price_owner_approved": true,
    "terms_warranty_payment_reviewed": true,
    "site_visit_requirement_reviewed": true
  },
  "start_date": "2026-07-15",
  "owner_note": "Optional internal note for quote notes block"
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `prequote_id` | Yes | UUID of `ai_closer_prequotes.id` |
| `final_price_owner_approved` | Yes | Positive finite number; **owner-entered** in UI |
| `owner_confirmations` | Yes | All checklist booleans must be `true` |
| `start_date` | No | ISO `YYYY-MM-DD`; if omitted, may map from prequote `target_date` only after owner reviewed |
| `owner_note` | No | Appended to structured `quotes.notes`; max length TBD (e.g. 5000) |

**Rejected body keys (non-exhaustive):** `tenant_id`, `public_token`, `status` (other than implicit draft), `workers`, `deposit_required`, `send_now`, `range_low`, `range_high`, `client_budget`.

---

## 5. Required validations

### Auth & tenant

1. Valid session (`readSessionFromEvent`).
2. Active owner/admin membership for resolved `tenant_id`.
3. Reject seller/supervisor/device-only sessions unless explicitly extended later (default: **owner/admin only**).

### Prequote

4. `prequote_id` is valid UUID.
5. Row exists: `ai_closer_prequotes.id = prequote_id AND tenant_id = membership.tenant_id`.
6. **Eligible status** only: `reviewed`, `good_lead`, `needs_site_visit`.
7. Block: `new`, `bad_budget`, `archived`, and already-converted (future status).

### Price

8. `final_price_owner_approved` required, finite, `> 0`.
9. **Must not** derive final price from `range_low`, `range_high`, or `client_budget`.
10. Optional server floor: reject if below tenant minimum without explicit override flag (future; default reject below snapshot minimum if detectable without exposing internals in error text).

### Idempotency & side effects

11. **Idempotency:** If quote already linked to this `prequote_id`, return **200** with existing `quote_id` (no duplicate insert).
12. **No** call to `publish-public-quote`, `send-quote-zapier`, `quote-accept-bridge`, `upsert-tenant-invoice-draft`, `publish-public-invoice`.
13. **No** partial writes: use single insert transaction semantics; on failure, no invoice/payment rows.

### HTTP error mapping (safe messages)

| Condition | Code |
|-----------|------|
| No session | 401 |
| Not owner/admin | 403 |
| Prequote not found / wrong tenant | 404 |
| Ineligible status | 409 |
| Validation (price, confirmations) | 400 |
| Idempotent hit (optional) | 200 with existing quote |
| Server error | 500 generic |

---

## 6. Proposed mapping

| AI Closer prequote field | Future official quote field | Auto-fill? | Owner must confirm? | Risk |
|--------------------------|----------------------------|------------|---------------------|------|
| `id` | Link metadata `ai_closer_prequote_id` (future column) | Yes (system) | No | **Schema blocker** — column or log table needed |
| `tenant_id` | `quotes.tenant_id` | Yes (auth) | No | Wrong tenant if auth bypassed |
| `client_name` | `quotes.client_name` | Yes | Yes (checklist) | Typos / wrong person |
| `client_email` | `quotes.client_email` | Yes | Yes (implicit in review) | Invalid email |
| `client_phone` | `quotes.client_phone` | Yes | Yes | Missing phone |
| `preferred_contact` | `quotes.notes` (structured) | Yes | Yes | No dedicated column |
| `project_name` | `quotes.project_name`, `quotes.title` | Yes | Yes | Duplicate project names |
| `work_type` | `quotes.notes` | Yes | Yes (`work_type_confirmed`) | Not a first-class quote column |
| `unit_type` | `quotes.notes` | Yes | Yes (`unit_type_confirmed`) | Must match pricing later |
| `scope_size` | `quotes.notes` | Yes | Yes (`measurements_confirmed`) | Not sufficient for workers |
| `scope_notes` | `quotes.notes` | Yes | Yes (`scope_confirmed`) | Client-facing if sent later |
| `client_notes` | `quotes.notes` (owner section) | Yes (server read) | Yes | Not in list API today |
| `estimated_crew_days` | `quotes.notes` hint only | Yes | Yes | **Do not** auto-build `workers` |
| `range_low` / `range_high` | **Not mapped** to `total` | **No** | N/A | **High** — starter range ≠ official price |
| `client_budget` | `quotes.notes` informational | Yes | No | Must not set price |
| `budget_signal` | `quotes.notes` informational | Yes | No | |
| `zoom_slot` | `quotes.notes` | Yes | No | |
| `target_date` | `quotes.start_date` (if valid ISO) | Optional | Yes (`start_date_reviewed`) | May be free text |
| `plan_file_name` etc. | `quotes.notes` attachment list | Yes | Yes | Files not in DB |
| `status` (prequote) | Eligibility gate only | No | Yes (reviewed lead) | Wrong status convert |
| `created_at` | Conversion audit metadata | Yes | No | |
| `final_price_owner_approved` (request) | `quotes.total` | **Owner input** | **Yes** | Core commercial field |
| Tenant display | `quotes.business_*` | Yes (snapshot) | Yes (terms checklist) | Stale branding |
| `terms` | `quotes.terms` | Default from tenant settings | Yes | Legal/warranty |
| `deposit_required` | **Not set** in 8B draft | **No** | Yes (later) | Tied to pricing engine |
| `public_token` | **Omitted** | **No** | Yes (at send) | Accidental client exposure |
| `quote_number_display` | See §9 | TBD | Yes (at promote) | Sequence consumption |
| `workers` | **Not set** | **No** | Yes (in Sales UI) | Pricing engine dependency |

### Structured notes template (implementation hint)

```
--- AI Closer pre-quote (converted to draft) ---
Prequote ID: {id}
Submitted: {created_at}
Work type: {work_type}
Scope: {scope_size} {unit_type}
Planning range (non-binding): {range_low}–{range_high}
Client budget: {client_budget} ({budget_signal})
Zoom: {zoom_slot}
Attachments: {filenames}
{scope_notes}
{owner_note}
```

---

## 7. Fields owner must manually approve

Before conversion is allowed (UI + server), owner must affirm:

1. **Final official price** — typed in UI; not from planning range or client budget.
2. **Project scope text** — `scope_notes` + work description accurate.
3. **Measurements** — `scope_size` / unit type verified on site or plans.
4. **Work type** — matches production category.
5. **Unit type** — sq ft / room / etc. correct.
6. **Start date** — `start_date` or `target_date` reviewed.
7. **Terms / warranty / payment language** — tenant defaults reviewed in draft editor.
8. **Material exclusions** — owner acknowledges exclusions not auto-imported from AI Closer.
9. **Site visit requirement** — especially when status is `needs_site_visit`.

Post-conversion, owner must still complete in official workflow:

- `workers` / labor lines via Sales or reprice flow
- `deposit_required` when promoting toward send
- `project_address` / job site if required
- Send / publish explicitly

---

## 8. Idempotency plan

### Preferred (requires future schema step 8A-schema or 8B)

Add to `public.quotes`:

```sql
-- FUTURE — NOT IN STEP 8A
-- ai_closer_prequote_id uuid null references public.ai_closer_prequotes(id)
-- unique partial index on (tenant_id, ai_closer_prequote_id) where not null
```

Conversion handler logic:

1. `SELECT id, status FROM quotes WHERE tenant_id = ? AND ai_closer_prequote_id = ? LIMIT 1`
2. If found → return `{ ok: true, quote_id, idempotent: true }` without insert.
3. If not found → insert draft quote with `ai_closer_prequote_id` set.

### Fallback if schema delayed

- **`ai_closer_conversion_log`** table (future): `tenant_id`, `prequote_id`, `quote_id`, `created_at`, unique `(tenant_id, prequote_id)`.
- **Never** dedupe by `(client_email, project_name)` alone — collisions likely.

### Prequote status after convert (optional future)

- New status `converted` or patch `archived` with metadata — prevents double convert from inbox UI.

---

## 9. Draft quote status plan

| Topic | Plan |
|-------|------|
| `quotes.status` | Set **`draft`** (lowercase per `quote-edit-guard.js` editable set) |
| `publish-public-quote` | **Do not call** — it defaults `READY_TO_SEND`, allocates number, mints token, runs pricing engine |
| `send-quote-zapier` | **Do not call** |
| `public_token` | **NULL / omitted** on insert unless DB constraint requires non-null — **verify constraint before implementation** |
| `deposit_required` | **NULL or 0** until owner sets via reprice/publish path — verify NOT NULL constraints |
| `total` | Set from `final_price_owner_approved` only |
| `currency` | `USD` default |
| Quote numbering | See below |

### Quote number allocation

Existing RPC: `allocate_next_quote_number(p_tenant_id)` in `SUPABASE_QUOTE_ANNUAL_NUMBERING.sql`, used by `publish-public-quote.js`.

| Option | Pros | Cons |
|--------|------|------|
| **A. Defer numbering** — leave `quote_number_display` null until owner promotes | No wasted sequence; clear draft state | UI/list may expect number; verify null allowed |
| **B. Allocate at draft create** | Appears in Sales Admin immediately | Consumes sequence for abandoned drafts |
| **C. Draft prefix** e.g. `DRAFT-{year}-{seq}` | Visible distinction | Requires new RPC or convention |

**Recommendation:** Option **A** if schema allows null `quote_number_display`; else **B** with owner education. Document choice in Step 8B implementation PR.

---

## 10. Failure handling plan

| Failure | Behavior |
|---------|----------|
| Validation error | 400/403/404/409 with short `error` string; no SQL/stack in response |
| Insert fails mid-request | No invoice/payment/email; no retry that duplicates without idempotency check |
| Partial column mismatch | Retry variants pattern (like publish) **only** for optional columns — not for financial side effects |
| Duplicate prequote | 200 idempotent return OR 409 with existing `quote_id` — pick one in 8B |
| Pricing snapshot missing | Fail safe: still allow draft with owner price; defer workers to editor |
| Email/Zapier | Never invoked on error or success |
| Public token | Never created on error path |
| Ops log | Optional `logOps` with `prequote_id`, `quote_id` truncated — no internal rates |

---

## 11. UI plan for later Step 8B

Location: `/ai-closer-owner.html` conversion preview + detail workspace (existing Step 6C overlays).

| Element | Behavior |
|---------|----------|
| **Create Quote** button | Remains disabled until Step 8B; then enabled only when checklist complete + price entered |
| Checklist | Mirror `owner_confirmations` — all required toggles |
| Final price input | Required number field; label: *Final official price (not planning range)* |
| Confirmation modal | Title: **Create Draft Quote Only** — copy: no send, no invoice, no client email |
| Submit | `POST /.netlify/functions/ai-closer-create-draft-quote` |
| Success | Toast + link: *Open draft quote* → existing owner quote edit / Sales Admin quote view |
| Failure | Safe inline error; drawer stays open |
| Auto actions | **No** send, publish, PDF, or Zapier |
| Prequote inbox | Optional badge *Converted*; filter tab future |

**Do not** auto-navigate to `estimate-public.html` or trigger `estimate-public-send.js`.

---

## 12. Open questions / blockers

Discovered during Step 7 audit and this contract:

| # | Blocker / question | Impact |
|---|-------------------|--------|
| 1 | **No `quotes.ai_closer_prequote_id` column** | Idempotency requires migration or conversion log table |
| 2 | **`quotes.public_token` NOT NULL?** | If required, need draft-safe token strategy that blocks public GET until publish |
| 3 | **`quotes.total` / `deposit_required` NOT NULL?** | Draft insert may need explicit zeros or deferred columns |
| 4 | **`quote_number_display` nullability** | Defer numbering vs allocate at create |
| 5 | **No existing “insert draft quote only” function** | Must not reuse `publish-public-quote` unchanged |
| 6 | **`workers` required before quote is meaningful in Sales** | Draft may be metadata-only until owner opens reprice/builder |
| 7 | **`client_notes` not in list API** | Server must read full prequote row on convert |
| 8 | **`contact_id` linking** | Optional match/create `tenant_contacts` — out of scope for 8B v1 |
| 9 | **Prequote status `converted`** | Not in current `ALLOWED_STATUSES` — extend status enum in Step 8B |
| 10 | **Owner draft editor entry URL** | Confirm deep link: `get-tenant-quote-edit` + existing owner UI route |
| 11 | **Minimum price floor** | May need `calc-secure-pricing` or snapshot read without exposing margin in errors |
| 12 | **Case of `draft` vs `DRAFT`** | Use lowercase to match `quote-edit-guard.js` normalization |

### Explicit non-goals for Step 8B v1

- Seller device attribution on converted quotes
- Automatic `tenant_projects` creation
- Automatic invoice/deposit creation
- Client email / public link
- Importing AI Closer file uploads (filenames only today)

---

## Step 8A completion statement

- **Only** this document is added in Step 8A.
- No production code, Netlify functions, schema, or UI changes.
- **Create Quote — Disabled** remains unchanged in production.
- Next step after approval: **Step 8A-schema** (if needed) + **Step 8B** implementation per this contract.

---

## References (read-only)

| Artifact | Path |
|----------|------|
| Mapping audit | `docs/AI_CLOSER_STEP7_QUOTE_MAPPING_AUDIT.md` |
| Prequote schema | `docs/AI_CLOSER_STEP2_SUPABASE_STORAGE.sql` |
| Publish (do not call for draft) | `netlify/functions/publish-public-quote.js` |
| Send (do not call) | `netlify/functions/send-quote-zapier.js` |
| Quote edit guard | `netlify/functions/_lib/quote-edit-guard.js` |
| AI Closer auth pattern | `netlify/functions/ai-closer-list-prequotes.js` |
| Quote numbering RPC | `SUPABASE_QUOTE_ANNUAL_NUMBERING.sql` |
