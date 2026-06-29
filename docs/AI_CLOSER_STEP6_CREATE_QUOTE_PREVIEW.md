# AI Closer Step 6 — Official Quote Conversion Preview

**Status:** UI/read-only preview only. No official quotes are created.

## Purpose

Show owner/admin users what will be required before a future, owner-approved conversion step maps an AI Closer starter pre-quote into the real Margin Guard quote workflow.

## What this step does

- Adds **Create Official Quote** in the detail drawer, labeled **Preview only**
- Opens **Official Quote Conversion Preview** (modal) with safe pre-quote fields
- Shows a **before conversion** checklist (display only — not saved)
- Shows disabled **Create Quote — Disabled** action
- Shows warning: *This preview does not create an official quote. A later owner-approved step will map this pre-quote into the real Margin Guard quote workflow.*

## What this step does NOT do

- Does **not** create official Margin Guard `quotes`
- Does **not** insert into `quotes`, `quote_labor`, `quote_service_lines`, `invoices`, `payments`, `tenant_projects`, or other production tables
- Does **not** call any Netlify function or perform database writes
- Does **not** change AI Closer pricing formula or expose internal cost, margin, overhead, or labor rate
- Does **not** touch production sales, seller, supervisor, or payment workflows

## Preview fields shown

| Field | Pre-quote source |
|-------|------------------|
| Client name, email, phone | `client_name`, `client_email`, `client_phone` |
| Project name | `project_name` |
| Work type | `work_type` |
| Scope size | `scope_size` + `unit_type` |
| Estimated crew days | `estimated_crew_days` |
| Planning range | `range_low` / `range_high` (public starter range only) |
| Scope notes | `scope_notes` |
| Budget signal | `budget_signal` |
| Zoom slot | `zoom_slot` |
| Current prequote status | `status` |

## Before-conversion checklist (display only)

1. Owner reviewed lead
2. Scope confirmed
3. Measurements confirmed
4. Materials/tile status confirmed
5. Start date reviewed
6. Final price to be set by owner

These items are **not** persisted in this step. A later conversion step will require owner confirmation against this list.

## Future mapping (not implemented)

When conversion is built in a later step, these pre-quote fields are expected to seed the official quote workflow (client contact, project title, scope summary, crew-day estimate, and owner-set final price). Internal pricing internals will remain server-side only.

## Preserved behavior

- View Details, copy email, copy owner review summary
- Status actions and filter tabs
- Refresh button
- Detail drawer Escape / backdrop / Close
- Preview closes on Escape, backdrop, or Close (detail drawer stays open)

## Files

| File | Role |
|------|------|
| `public/ai-closer-owner.html` | Preview modal markup + styles |
| `public/js/ai-closer-owner.js` | Preview open/close, field display |
| `docs/AI_CLOSER_STEP6_CREATE_QUOTE_PREVIEW.md` | This document |

## Test instructions

1. Sign in as owner/admin and open `/ai-closer-owner.html`.
2. Open **View Details** on a pre-quote.
3. Click **Create Official Quote** (badge: Preview only).
4. Confirm **Official Quote Conversion Preview** opens with listed fields and checklist.
5. Confirm **Create Quote — Disabled** cannot be clicked.
6. Close preview — detail drawer remains open.
7. Confirm no network requests beyond existing list/status endpoints.
8. Confirm status actions, filters, and copy buttons still work.
