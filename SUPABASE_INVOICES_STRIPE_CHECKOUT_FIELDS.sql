-- Invoice Stripe checkout completion fields (safe additive migration).
-- Run in Supabase SQL editor.

alter table public.invoices
add column if not exists stripe_session_id text;

alter table public.invoices
add column if not exists stripe_payment_intent_id text;

alter table public.invoices
add column if not exists amount_paid numeric;

alter table public.invoices
add column if not exists paid_at timestamptz;

comment on column public.invoices.stripe_session_id is 'Stripe Checkout Session id for invoice payment.';
comment on column public.invoices.stripe_payment_intent_id is 'Stripe PaymentIntent id for invoice payment.';
comment on column public.invoices.amount_paid is 'Amount paid from Stripe invoice checkout completion.';
comment on column public.invoices.paid_at is 'Timestamp when invoice was marked as paid.';
