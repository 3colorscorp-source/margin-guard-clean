# AI Closer Step 3 — Owner Prequote Inbox (Read-Only)

**Status:** Read-only owner review. Does not create official quotes or update prequote status.

## Purpose

Show tenant-scoped **starter pre-quotes** from `public.ai_closer_prequotes` on `/ai-closer-owner.html` for owner/admin review after Step 2 storage is live.

## Page

| URL | Script | API |
|-----|--------|-----|
| `/ai-closer-owner.html` | `public/js/ai-closer-owner.js` | `GET /.netlify/functions/ai-closer-list-prequotes` |

Requires owner session (`data-requires-auth="true"` + `auth.js`).

## Netlify function

**`netlify/functions/ai-closer-list-prequotes.js`**

- **GET only**
- Auth pattern (same family as other owner Netlify functions):
  1. `readSessionFromEvent` (`mg_session` cookie)
  2. Resolve membership via `profiles.auth_user_id` when `session.u` is present
  3. Fallback: `resolveTenantFromSession` + `resolveMembershipByEmail`
  4. Require **active** role `owner` or `admin`
- Query `ai_closer_prequotes` where `tenant_id = membership.tenant_id`
- Order `created_at desc`, default limit **25** (max 50)
- Returns **safe columns only** — never `raw_payload`
- **401/403** when unauthenticated or not owner/admin

## Tenant isolation

Rows are filtered by `tenant_id` from the authenticated owner/admin profile. No cross-tenant reads.

## UI behavior

- **AI Closer Owner Inbox** — card list with client, project, range, crew days, budget signal, Zoom slot, created date
- Label: **Starter Pre-Quote — Not Final**
- Placeholder action: *Review manually before creating an official quote.*
- Empty state: *No AI Closer pre-quotes yet.*
- Auth failure: safe message (no raw server errors)
- **localStorage lab fallback** only when API fails or inbox is empty (browser-local demo data)

## Explicit non-goals (Step 3)

- No writes to `ai_closer_prequotes.status`
- No conversion to official `quotes`
- No changes to `app.js`, sales, invoices, payments, pricing engine
- No public unauthenticated list endpoint

## Prerequisites

1. Run `docs/AI_CLOSER_STEP2_SUPABASE_STORAGE.sql` in Supabase
2. Deploy Step 2 submit function + Step 3 list function
3. Owner signed in with active owner/admin profile linked to tenant

## Quick QA

1. Sign in as owner on production/staging.
2. Open `/ai-closer-owner.html` — inbox loads or shows empty.
3. Submit a client pre-quote via `/ai-closer-client.html` (Step 2).
4. Refresh inbox — new card appears for your tenant only.
5. Sign out — safe auth message, no lead data exposed.
