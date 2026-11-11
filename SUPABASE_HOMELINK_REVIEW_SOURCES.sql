-- HomeLink review links for one contractor account.
-- Run once in the Supabase SQL editor. Does not store review counts.

alter table public.tenant_branding
  add column if not exists google_review_url text not null default '',
  add column if not exists yelp_review_url text not null default '',
  add column if not exists website_url text not null default '';
