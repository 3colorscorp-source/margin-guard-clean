# AI Closer Step 8F — Idempotency Guard Applied (Documentation)

**Status:** Documentation only. Schema was applied manually in Supabase by owner. **No production code changes in Step 8F.**

Related SQL: [AI_CLOSER_STEP8D_IDEMPOTENCY_GUARD_FINAL_SQL.sql](./AI_CLOSER_STEP8D_IDEMPOTENCY_GUARD_FINAL_SQL.sql)

---

## 1. Purpose

Step 8F records that the AI Closer idempotency/audit guard table was **manually applied and verified** in Supabase after review of Step 8D final SQL.

### What Step 8F does

- Documents applied schema and manual verification results.
- Confirms current safety posture before any conversion Netlify function or UI work.

### What Step 8F does NOT do

- Does **not** modify production HTML/JS, Netlify functions, or Supabase schema.
- Does **not** run SQL from this repository.
- Does **not** create official quotes, invoices, or payments.
- Does **not** enable **Create Quote** in `/ai-closer-owner.html`.

---

## 2. Applied schema

| Item | Value |
|------|--------|
| **Table** | `public.ai_closer_quote_conversions` |
| **Purpose** | Idempotency/audit guard for AI prequote → official DRAFT quote conversion |
| **Cardinality** | At most **one** conversion record per `ai_closer_prequote_id` (unique constraint) |
| **Source SQL** | `docs/AI_CLOSER_STEP8D_IDEMPOTENCY_GUARD_FINAL_SQL.sql` |

### Key columns

| Column | Role |
|--------|------|
| `tenant_id` | Tenant scope (FK → `public.tenants`) |
| `ai_closer_prequote_id` | FK → `public.ai_closer_prequotes` (unique) |
| `official_quote_id` | Nullable FK → `public.quotes` (set after draft quote insert) |
| `status` | `draft_pending` \| `draft_created` \| `failed` \| `cancelled` |
| `conversion_metadata` | Owner-safe audit JSON only (no internal pricing) |

### RLS (v1)

- RLS **enabled**
- **service_role** ALL policy only (matches `ai_closer_prequotes` / `ai_closer_tenant_settings` pattern)
- No authenticated owner/admin JWT policies enabled yet

---

## 3. Manual Supabase verification results

Verified manually in Supabase SQL editor after applying Step 8D SQL:

| Check | Result |
|-------|--------|
| Table exists | **Yes** — `public.ai_closer_quote_conversions` |
| RLS enabled | **true** |
| service_role ALL policy exists | **Yes** — `service role full access ai_closer_quote_conversions` |
| `conversion_rows` | **0** |
| Official quotes created by migration | **No** |
| Invoices created | **No** |
| Payments created | **No** |
| Create Quote UI enabled | **No** — button remains disabled in owner UI |

---

## 4. Current safety status

| Area | Status |
|------|--------|
| Guard table | **Exists** in Supabase |
| Conversion Netlify endpoint | **Not implemented** |
| Owner UI Create Quote button | **Disabled** (preview only) |
| Draft quote creation from prequote | **Not implemented** |
| Send / publish / invoice / payment | **No side effects** from this step |
| `publish-public-quote` | **Not called** |
| `send-quote-zapier` | **Not called** |
| `quote_labor` auto-insert | **Not done** (requires `user_id` per preflight) |

---

## 5. Important implementation notes for next step

When implementing the conversion function (Step 9A+), the handler **must**:

1. Use **service_role** via `supabase-admin` safely (same as existing AI Closer functions).
2. Require **owner/admin** auth in Netlify (not seller/supervisor).
3. Enforce **tenant scope** — `tenant_id` from `profiles.auth_user_id` / membership only.
4. **First** insert or check `ai_closer_quote_conversions` for idempotency (`unique(ai_closer_prequote_id)`).
5. Create **`public.quotes`** row with status **`DRAFT` only** (matches preflight default on `quotes`).
6. **Not** create `quote_labor` yet — `quote_labor` requires `user_id`.
7. **Not** create `quote_items` unless a safe draft-only path is explicitly defined.
8. **Not** create invoices or payments.
9. **Not** call `publish-public-quote.js` (allocates number, token, READY_TO_SEND, pricing engine).
10. **Not** call `send-quote-zapier.js` (email/PDF to client).
11. **Not** expose internal cost, margin, overhead, or labor rate in responses or `conversion_metadata`.
12. Store only owner-safe fields in `conversion_metadata` (e.g. `final_price_owner_approved`, `start_date`, `owner_note`).

Future authenticated RLS policies may use `public.mg_business_id()` and `public.mg_role()` after separate review; v1 remains service_role + Netlify gate.

---

## 6. Verification queries used

SELECT-only queries run manually after apply:

### Table exists

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'ai_closer_quote_conversions';
```

### RLS enabled

```sql
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where oid = 'public.ai_closer_quote_conversions'::regclass;
```

### service_role policy exists

```sql
select policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename = 'ai_closer_quote_conversions'
order by policyname;
```

### Row count (expect 0 after initial apply)

```sql
select count(*) as conversion_rows
from public.ai_closer_quote_conversions;
```

---

## 7. Next recommended safe step

**Step 9A — Owner-only DRAFT quote creation Netlify function (backend only)**

- New isolated function (e.g. `ai-closer-create-draft-quote.js`) per [AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md](./AI_CLOSER_STEP8A_DRAFT_QUOTE_CONVERSION_CONTRACT.md).
- **Do not connect UI** yet — manual POST testing only.
- Must use guard table first, then insert DRAFT `quotes` row, then update conversion to `draft_created`.
- No send, publish, invoice, payment, or `quote_labor` in v1.

---

## Step 8F sign-off

- [x] Schema applied manually from Step 8D SQL
- [x] Verification queries passed (table, RLS, policy, zero rows)
- [x] No production code changed in Step 8F
- [x] Create Quote remains disabled in owner UI
- [ ] Step 9A conversion function (future)
