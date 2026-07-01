# AI Closer Step 7 — Official Quote Mapping Audit (Read-Only)

**Status:** Documentation / audit only. **No code, schema, API, or UI behavior changes in Step 7.**

## 1. Scope / Purpose

Step 7 audits how an AI Closer starter pre-quote (`public.ai_closer_prequotes`) could **later** map into the existing Margin Guard official quote workflow **without** enabling conversion yet.

### What Step 7 does

- Reads and documents existing official quote creation, publish, and send patterns in this repository.
- Maps AI Closer prequote fields to likely official quote destinations.
- Lists risks, guardrails, and a recommended safe path for a future Step 8.

### What Step 7 does NOT do

- Does **not** create official quotes.
- Does **not** insert or update `quotes`, `invoices`, `payments`, `tenant_projects`, or any production table.
- Does **not** add or modify Netlify functions, Supabase schema, or production HTML/JS.
- Does **not** expose internal cost, margin, overhead, labor rate, or protected pricing internals.
- Does **not** enable the disabled **Create Quote — Disabled** button in `/ai-closer-owner.html`.

---

## 2. Existing official quote workflow summary

### Where official quotes are created today

Primary server path:

| Step | File / endpoint | Role |
|------|-----------------|------|
| 1 | `public/js/estimate-public-send.js` | Shared client pipeline: publish → validate → PDF → send |
| 2 | `POST /.netlify/functions/publish-public-quote` | **Creates** `public.quotes` row, allocates quote number, assigns `public_token`, computes `total` / `deposit_required` via pricing engine |
| 3 | `POST /.netlify/functions/calc-secure-pricing` | Server-side pricing preview (workers + tenant snapshot settings); same pricing engine as publish |
| 4 | `POST /.netlify/functions/send-quote-zapier` | **Sends** quote email + PDF; updates quote send state; must not run during draft-only conversion |
| 5 | `GET /.netlify/functions/get-public-estimate` | Public read by `public_token` → `/estimate-public.html?token=…` |

Supporting owner/admin quote flows (existing production; do not disturb):

| File / endpoint | Role |
|-----------------|------|
| `GET /.netlify/functions/list-tenant-quotes` | Tenant-scoped quote list (no `public_token` returned) |
| `GET /.netlify/functions/get-tenant-quote-edit` | Owner/admin read for safe edit fields + lock evaluation |
| `PATCH /.netlify/functions/update-tenant-quote-edit` | Owner/admin metadata-only updates (no pricing/status changes in guard) |
| `POST /.netlify/functions/reprice-tenant-quote` | Reprice existing quote (pricing engine — out of scope for AI Closer auto-map) |
| `POST /.netlify/functions/resend-tenant-quote` | Resend using existing `public_token` |
| `POST /.netlify/functions/archive-tenant-quote` | Archive by tenant + display number / project |

UI entry points (inspected, not modified):

- `public/js/app.js` — Owner estimate builder / send estimate flow
- `public/sales.html` + seller device flows — Seller publish/send
- `public/js/sales-admin-quotes.js` — Sales Admin quote views

### Official quote data shape (persisted)

From `publish-public-quote.js` insert payload and `quote-edit-guard.js` safe fields, a published quote row typically includes:

| Area | Columns / concepts |
|------|-------------------|
| Identity | `id`, `tenant_id`, `quote_year`, `quote_sequence`, `quote_number_display` |
| Client | `client_name`, `client_email`, `client_phone`, `contact_id` (optional, tenant-scoped) |
| Project | `project_name`, `title`, `project_address` / `job_site` |
| Commercial | `status`, `currency`, `total`, `deposit_required`, `payment_link` |
| Public link | `public_token` → `/estimate-public.html?token=…` |
| Content | `notes`, `terms` |
| Business branding | `business_name`, `business_email`, `business_phone`, `business_address` |
| Dates | `issue_date`, `expiration_date`, `start_date`, `due_date` (when columns present) |
| Operations | `operational_plan`, `estimated_days`, `estimated_hours` (when operational plan published) |
| Attribution | `seller_membership_id`, `seller_user_id`, `seller_email`, `source_device_id`, `created_by_role` |
| Lifecycle | `accepted_at`, `deposit_paid_at`, view/ack timestamps |

**Labor / pricing input at publish time:** Publish expects a **`workers` array** in the POST body (labor lines with `days` > 0). Pricing is computed server-side via `_lib/pricing-engine.js` using the latest `tenant_snapshots` settings — **not** from AI Closer `range_low` / `range_high` directly.

**Note:** This repo references `quote_labor` / `quote_service_lines` only in AI Closer isolation docs. No such tables appear in migrations inspected for this audit. Labor at publish is carried in the request `workers` payload; accepted projects may store `quoted_labor_plan` on `tenant_projects` via acceptance bridge — separate from AI Closer.

### Quote numbering

- RPC: `allocate_next_quote_number(p_tenant_id)` (`SUPABASE_QUOTE_ANNUAL_NUMBERING.sql`)
- Format: `{year}-{sequence padded}` → `quote_number_display`
- Unique per tenant: index on `(tenant_id, quote_number_display)`
- **Risk:** Calling publish allocates a number immediately — future AI Closer draft conversion should either defer numbering or use a dedicated draft path that does not consume production numbers until owner confirms.

### Public token / link patterns

- Generated by `makePublicToken("qt")` in `_lib/public-token.js` unless caller supplies unused token.
- Public URL: `{site}/estimate-public.html?token={public_token}`
- Used by: `get-public-estimate`, `track-estimate-view`, `send-quote-zapier`, deposit automation, invoice linking.
- **Risk:** Creating `public_token` before owner approval exposes a client-facing estimate URL.

### Tenant scoping patterns

| Flow | Pattern |
|------|---------|
| AI Closer list/status | `profiles.auth_user_id` → owner/admin `tenant_id`; queries `ai_closer_prequotes?tenant_id=eq.{tenantId}` |
| Publish quote | `resolveOwnerOrSellerContext(event)` → session/device membership → `tenant.id`; rejects body `tenant_id` mismatch |
| Quote edit/list | `tenant_id=eq.{authenticated tenant}` on all reads/writes |
| Public estimate | `public_token` + `tenant_id` not null (no cross-tenant token reuse) |

### Invoice / deposit dependencies (must NOT trigger on draft conversion)

| Trigger | When | Must avoid in Step 8 draft |
|---------|------|---------------------------|
| `publish-public-quote` | Sets `total`, `deposit_required` from pricing engine | Do not call as-is for AI Closer auto-convert |
| `send-quote-zapier` | Email + PDF to client | Do not call |
| `quote-accept-bridge` (`_lib/quote-accept-bridge.js`) | On quote acceptance → may insert/patch `invoices`, link `tenant_projects` | Do not run |
| `upsert-tenant-invoice-draft` | Manual invoice draft create | Do not call |
| `publish-public-invoice` | Invoice publish with `public_token` | Do not call |
| Deposit post-automation | Tied to `public_token` / paid flows | Do not trigger |

Default publish status is **`READY_TO_SEND`** (overridable in body). Editable quote statuses in guard include `draft`, `ready_to_send`, `sent`, etc. A future AI Closer draft should use an explicit **non-send** status (e.g. `draft`) and must not chain into send/publish pipelines.

### Flows that must not be disturbed

- Seller / Owner **Send Estimate** pipeline (`estimate-public-send.js` → `publish-public-quote` → `send-quote-zapier`)
- Sales Admin quote list, reprice, archive, resend
- Public estimate view, deposit, acceptance, invoice bridge
- `app.js`, `sales.html`, pricing engine, supervisor/seller portals
- All existing AI Closer Steps 1–6C (inbox, status, detail, preview UI)

---

## 3. AI Closer prequote fields available today

Source: `docs/AI_CLOSER_STEP2_SUPABASE_STORAGE.sql`, `ai-closer-list-prequotes.js` (`SAFE_PREQUOTE_SELECT`), `ai-closer-submit-prequote.js`.

| Field | DB column | Owner inbox exposed | Notes |
|-------|-----------|---------------------|-------|
| Prequote ID | `id` | Yes (`id`) | Future idempotency key candidate |
| Tenant ID | `tenant_id` | No (implicit via auth) | Required for all conversion queries |
| Tenant slug | `tenant_slug` | Yes | Informational; resolve tenant by `tenant_id` |
| Source | `source` | No | Default `ai_closer_client` |
| Status | `status` | Yes | `new`, `reviewed`, `good_lead`, etc. |
| Client name | `client_name` | Yes | |
| Client email | `client_email` | Yes | |
| Client phone | `client_phone` | Yes | |
| Preferred contact | `preferred_contact` | Yes | |
| Project name | `project_name` | Yes | |
| Work type | `work_type` | Yes | No direct `quotes` column — likely `notes` or internal metadata |
| Unit type | `unit_type` | Yes | e.g. `sq_ft`, `room` |
| Scope size | `scope_size` | Yes | Numeric |
| Scope notes | `scope_notes` | Yes | |
| Client notes | `client_notes` | Yes | Owner-only in list; not in SAFE select today for client_notes — **listed in schema**; verify list API if needed later |
| Estimated crew days | `estimated_crew_days` | Yes | Starter estimate only |
| Planning range low | `range_low` | Yes | **Public starter range — not official price** |
| Planning range high | `range_high` | Yes | **Public starter range — not official price** |
| Client budget | `client_budget` | Yes | Text |
| Budget signal | `budget_signal` | Yes | `overlaps_range`, `below_range`, `above_range` |
| Zoom slot | `zoom_slot` | Yes | |
| Target date | `target_date` | Yes | Text/ISO; may map to `start_date` / `due_date` after owner review |
| Plan filename | `plan_file_name` | Yes | Filename only; no file storage in prequote row |
| Current photo filename | `current_photo_name` | Yes | Filename only |
| Inspiration photo filename | `inspiration_photo_name` | Yes | Filename only |
| Submitted date | `created_at` | Yes | |
| Raw payload | `raw_payload` | **No** | Internal JSON; must never be exposed or copied to quotes wholesale |

**Correction:** `client_notes` is in schema and submit handler; confirm list API includes it before mapping — `SAFE_PREQUOTE_SELECT` in list function does **not** currently return `client_notes`. Future conversion should read from DB server-side if needed, not from client.

---

## 4. Proposed future mapping to official quote

| AI Closer field | Official quote destination | Confidence | Notes / risk |
|-----------------|---------------------------|------------|--------------|
| `id` | Conversion metadata only (e.g. future `quotes.ai_closer_prequote_id` or link table) | Medium | **Schema not present today** — needs migration in later step; enables idempotency |
| `tenant_id` | `quotes.tenant_id` | High | Must match authenticated owner/admin tenant |
| `client_name` | `quotes.client_name` | High | Direct map |
| `client_email` | `quotes.client_email` | High | Validate email; may link `tenant_contacts` later |
| `client_phone` | `quotes.client_phone` | High | Direct map when column accepted |
| `preferred_contact` | `quotes.notes` prefix or conversion metadata | Low | No dedicated column; do not lose — append to notes block |
| `project_name` | `quotes.project_name`, `quotes.title` | High | `title` often mirrors project name in publish |
| `work_type` | `quotes.notes` structured section | Medium | No first-class column; owner should confirm |
| `unit_type` + `scope_size` | `quotes.notes` + operational hint only | Medium | Official pricing needs `workers[]`, not scope alone |
| `scope_notes` | `quotes.notes` | High | Owner-editable before send |
| `client_notes` | `quotes.notes` (separate section) | Medium | Not in list API today; server-side read only |
| `estimated_crew_days` | Hint for `workers[].days` or `estimated_days` | Low | **Do not auto-build workers from crew days without pricing review** |
| `range_low` / `range_high` | **Not** `quotes.total` | High risk if wrong | Starter planning range only — **never auto-set official price** |
| `client_budget` | `quotes.notes` | High | Informational |
| `budget_signal` | `quotes.notes` | High | Informational |
| `zoom_slot` | `quotes.notes` | High | Scheduling context |
| `target_date` | `quotes.start_date` / `due_date` (after owner confirms ISO) | Medium | Parse/validate; may be free text today |
| Plan/photo filenames | `quotes.notes` attachment list | High | Files not in Supabase prequote row |
| `status` | Eligibility gate only (not `quotes.status`) | High | e.g. require `reviewed` or `good_lead` before convert |
| `created_at` | Conversion audit metadata | High | Provenance |
| Final official price | `quotes.total` | **Manual only** | Owner enters in Sales/pricing UI after conversion |
| Deposit | `quotes.deposit_required` | **Manual / pricing engine** | Do not copy from AI Closer range |
| Business branding | `quotes.business_*` | High | From `tenant_display` / settings snapshot at convert time |
| Quote number | `quote_number_display` | Deferred | Allocate only when owner commits draft to send path |
| Public token | `quotes.public_token` | **Defer** | Do not mint until owner approves client-facing link |
| `workers` / labor lines | Request body at reprice/publish | **Not auto** | Requires pricing engine + tenant snapshot |

---

## 5. Required owner confirmation before conversion

Future Step 8 should block conversion until owner explicitly confirms:

1. **Scope confirmed** — matches site reality and `scope_notes`
2. **Measurements confirmed** — scope size / unit type verified
3. **Work type confirmed** — matches intended production workflow
4. **Unit type confirmed** — sq ft / room / etc.
5. **Materials/tile status confirmed** — owner checklist item
6. **Start date reviewed** — `target_date` validated
7. **Final official price manually approved by owner** — not derived from `range_low`/`range_high`
8. **Terms/warranty/payment terms reviewed** — `quotes.terms` from tenant defaults, owner editable

Additionally align with Step 6 preview checklist:

- Owner reviewed lead
- Scope confirmed
- Measurements confirmed
- Materials/tile status confirmed
- Start date reviewed
- Final price to be set by owner

---

## 6. Fields that must NOT be auto-filled yet

| Item | Reason |
|------|--------|
| Final official price (`quotes.total`) | Requires pricing engine + owner approval; AI Closer range is non-binding |
| Deposit / payment schedule (`deposit_required`, `payment_link`) | Tied to pricing engine and send flow |
| Invoice records | Created on acceptance / manual invoice flows — not on prequote convert |
| Owner profit / margin / internal costs | Pricing engine only; never from AI Closer |
| Labor burden / overhead / protected pricing internals | `tenant_snapshots` + `pricing-engine.js` |
| Seller/supervisor commission / bonus / attribution | Seller device flows only unless owner explicitly assigns |
| `public_token` / public URL | Client-facing until owner approves send |
| `quote_number_display` | Consumes tenant sequence; defer until commit to official quote |
| `workers` labor lines with rates | Must be built in Sales UI with snapshot rates |
| `raw_payload` copy | May contain stripped client fields; never bulk copy |
| `READY_TO_SEND` / send timestamps | Implies send-ready state |
| Zapier / email send | `send-quote-zapier` |

---

## 7. Safe future conversion plan (recommended Step 8)

Recommend **Step 8: owner-only draft conversion** as a **new isolated Netlify function** (not reusing `publish-public-quote` unchanged):

| Requirement | Detail |
|-------------|--------|
| Auth | Owner/admin only; same tenant resolution as `ai-closer-list-prequotes.js` |
| Scope | `ai_closer_prequotes` → **DRAFT** `quotes` row only |
| Status | `quotes.status = 'draft'` (or equivalent non-send status) |
| Pricing | Placeholder or zero totals until owner completes Sales pricing step |
| Numbering | **Defer** `allocate_next_quote_number` until owner promotes to send |
| Public token | **Omit** until owner explicitly publishes |
| Send | **Disabled** — no `send-quote-zapier` |
| Invoice | **No** insert/patch |
| Payments / deposits | **No** |
| Projects | **No** `tenant_projects` upsert |
| Link back | Store `ai_closer_prequote_id` (new column or junction) + conversion timestamp |
| Post-convert | Redirect owner to existing quote edit / Sales pricing UI to set `workers`, price, terms |
| UI | Enable **Create Quote** only after checklist + confirmations |

---

## 8. Risk list

| Risk | Impact | Mitigation |
|------|--------|------------|
| Wrong tenant mapping | Cross-tenant data leak | Enforce `tenant_id` on prequote + quote; auth via `profiles.tenant_id` |
| Duplicate quote creation | Multiple quotes per lead | Idempotency on `ai_closer_prequote_id`; return existing draft if present |
| Accidental send/publish | Client email / public link | No `send-quote-zapier`; no `public_token`; status `draft` only |
| Quote number conflicts | Gaps or duplicates | Defer RPC until send; unique `(tenant_id, quote_number_display)` |
| Invoice/deposit side effects | Financial records without approval | Do not call accept bridge, invoice upsert, or deposit automation |
| Exposing internal pricing | Margin/labor leak | Never map `raw_payload`; never set `total` from `range_*` |
| Stale Business Settings | Wrong terms/branding | Load `tenant_display` + latest snapshot at convert time |
| Incomplete client/scope info | Bad official quote | Require checklist + editable draft before numbering/send |
| Calling `publish-public-quote` directly | Forces pricing + deposit + token + READY_TO_SEND | Use separate draft insert path |
| Prequote status `archived` / `bad_budget` | Low-quality convert | Status eligibility gate |

---

## 9. Recommended guardrails for future implementation

1. **Idempotency** — `SELECT quotes WHERE ai_closer_prequote_id = ? AND tenant_id = ?` before insert (column TBD).
2. **Owner/admin auth only** — mirror `ai-closer-update-prequote-status.js` context resolution.
3. **`tenant_id` enforcement** — prequote row must match membership tenant.
4. **Status eligibility** — e.g. allow convert only for `reviewed`, `good_lead`, `needs_site_visit`; block `archived`, `bad_budget`, optionally `new`.
5. **Disabled send/publish by default** — draft row has no public URL.
6. **Create draft only** — no Zapier, no PDF email, no view tracking side effects.
7. **Conversion metadata** — `converted_at`, `converted_by`, `source: ai_closer_prequote`.
8. **No invoice/deposit creation** — hard rule in handler.
9. **No client email** — automated or Zapier.
10. **Audit log** — ops log entry with prequote id + quote id (no internal pricing in log).
11. **Update prequote status** — optional `converted` status after successful draft (future schema/UI).
12. **Manual price gate** — UI requires owner to open Sales/pricing before quote leaves draft.

---

## 10. Read-only SQL suggestions (Supabase inspection)

Run in Supabase SQL editor only. **SELECT-only.**

### AI Closer prequotes for a tenant

```sql
select
  id,
  tenant_id,
  status,
  project_name,
  client_name,
  client_email,
  estimated_crew_days,
  range_low,
  range_high,
  created_at
from public.ai_closer_prequotes
where tenant_id = '<tenant-uuid>'
order by created_at desc
limit 50;
```

### Recent official quotes for same tenant (compare shape)

```sql
select
  id,
  tenant_id,
  quote_number_display,
  project_name,
  client_name,
  client_email,
  status,
  total,
  deposit_required,
  public_token is not null as has_public_token,
  created_at
from public.quotes
where tenant_id = '<tenant-uuid>'
order by created_at desc
limit 50;
```

### Quote numbering sequence head

```sql
select tenant_id, quote_year, max(quote_sequence) as max_seq
from public.quotes
where tenant_id = '<tenant-uuid>'
group by tenant_id, quote_year;
```

### Invoices linked to quotes (ensure convert did not create)

```sql
select i.id, i.invoice_no, i.status, i.quote_id, i.amount, i.created_at
from public.invoices i
join public.quotes q on q.id = i.quote_id
where q.tenant_id = '<tenant-uuid>'
order by i.created_at desc
limit 25;
```

### Tenant contacts (optional future `contact_id` link)

```sql
select id, full_name, email, phone, status
from public.tenant_contacts
where tenant_id = '<tenant-uuid>' and status = 'active'
order by updated_at desc
limit 25;
```

### Check for duplicate email leads (conversion dedupe research)

```sql
select client_email, count(*) as prequote_count
from public.ai_closer_prequotes
where tenant_id = '<tenant-uuid>' and client_email is not null
group by client_email
having count(*) > 1
order by prequote_count desc;
```

---

## Files inspected (read-only)

| Path | Relevance |
|------|-----------|
| `netlify/functions/publish-public-quote.js` | Official quote insert, numbering, token, pricing |
| `netlify/functions/send-quote-zapier.js` | Send side effects |
| `netlify/functions/calc-secure-pricing.js` | Pricing engine entry |
| `netlify/functions/_lib/pricing-engine.js` | Internal financials (not duplicated here) |
| `netlify/functions/_lib/quote-edit-guard.js` | Editable quote fields / statuses |
| `netlify/functions/_lib/quote-accept-bridge.js` | Invoice/project side effects on accept |
| `netlify/functions/ai-closer-list-prequotes.js` | Safe prequote fields |
| `netlify/functions/ai-closer-submit-prequote.js` | Prequote write shape |
| `docs/AI_CLOSER_STEP2_SUPABASE_STORAGE.sql` | Prequote schema |
| `SUPABASE_QUOTE_ANNUAL_NUMBERING.sql` | Quote numbering RPC |
| `public/js/estimate-public-send.js` | Publish → send pipeline |

---

## Step 7 completion statement

- **Only** `docs/AI_CLOSER_STEP7_QUOTE_MAPPING_AUDIT.md` is added in this step.
- No production code, Netlify functions, schema, or UI behavior changed.
- **Create Quote — Disabled** remains disabled in the owner UI.
- Next recommended work: **Step 8** isolated draft conversion function + owner confirmation UI, designed per this audit.
