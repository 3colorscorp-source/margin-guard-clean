-- =============================================================================
-- Margin Guard | MG-SUPPORT-003D.C1 — Support action ledger (additive)
-- =============================================================================
-- STATUS: MANUAL SUPABASE APPLY REQUIRED — do not run from CI or auto-deploy.
--
-- PURPOSE:
--   Durable, tenant-scoped ledger for confirmed Support invoice resend.
--   Writes happen only through Netlify mg-support-invoice-resend (service role).
--
-- NOT IN THIS MIGRATION:
--   * Support chat mint / Resend button
--   * owner action history UI
--   * quote resend / device reset
--   * email, Zapier, or notification tables
--
-- DEPENDENCIES:
--   REQUIRED: public.tenants
-- =============================================================================

create table if not exists public.tenant_support_actions (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null
    references public.tenants (id) on delete cascade,

  created_by_user_id uuid null,

  action_type text not null
    check (action_type = 'invoice_resend'),

  related_entity_type text not null
    check (related_entity_type = 'invoice'),

  related_entity_id uuid not null,

  idempotency_key text not null
    check (char_length(trim(idempotency_key)) > 0),

  status text not null
    check (status in ('claimed', 'bridge_accepted', 'submission_unknown')),

  result_code text null
    check (result_code is null or char_length(result_code) <= 80),

  created_at timestamptz not null default timezone('utc', now()),
  claimed_at timestamptz null,
  completed_at timestamptz null,

  constraint tenant_support_actions_idempotency_key
    unique (idempotency_key)
);

comment on table public.tenant_support_actions is
  'MG-SUPPORT-003D.C1 confirmed Support actions. Server writes only. No PII, money, tokens, email copy, or public URLs.';

comment on column public.tenant_support_actions.idempotency_key is
  'Action confirmation nonce. Unique globally. Not PII.';

comment on column public.tenant_support_actions.created_by_user_id is
  'Optional session.u UUID when already present on the owner cookie. No extra lookup.';

comment on column public.tenant_support_actions.status is
  'claimed = in-flight lock; bridge_accepted = confirmed Zapier 2xx and invoice persistence; submission_unknown = network was attempted without a proven success. Never auto-retry unknown/claimed.';

create unique index if not exists tenant_support_actions_inflight_invoice_uidx
  on public.tenant_support_actions (tenant_id, action_type, related_entity_id)
  where status in ('claimed', 'submission_unknown');

alter table public.tenant_support_actions enable row level security;

drop policy if exists "service role full access tenant_support_actions"
  on public.tenant_support_actions;
create policy "service role full access tenant_support_actions"
  on public.tenant_support_actions
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.tenant_support_actions from public;
revoke all on table public.tenant_support_actions from anon;
revoke all on table public.tenant_support_actions from authenticated;
grant all on table public.tenant_support_actions to service_role;
