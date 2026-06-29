# AI Closer Step 5 — Owner Prequote Detail View

**Status:** Read-only UI only. No database or API changes.

## Purpose

Let owner/admin users open a professional detail drawer from `/ai-closer-owner.html` to review a starter pre-quote before taking follow-up action.

## What this step does

- Adds **View Details** on each inbox card
- Opens a slide-over modal/drawer with full safe pre-quote fields already returned by `ai-closer-list-prequotes`
- **Copy client email** — copies `client_email` to clipboard
- **Copy owner review summary** — plain-text summary safe for internal review or client follow-up (no internal cost, margin, overhead, or labor rate)
- Shows warning: *Review manually before creating an official quote. This screen does not create or modify official quotes.*

## What this step does NOT do

- Does **not** create official Margin Guard `quotes`
- Does **not** convert pre-quotes into estimates or invoices
- Does **not** change pricing formula or ranges in the database
- Does **not** add Netlify functions or Supabase schema changes
- Does **not** expose `raw_payload` or protected pricing internals
- Does **not** touch production sales, seller, supervisor, or payment workflows

## Detail fields shown

| Field | Source column |
|-------|----------------|
| Starter Pre-Quote — Not Final | UI label |
| Client name, email, phone, preferred contact | `client_*`, `preferred_contact` |
| Project name, work type, scope size, unit type | `project_name`, `work_type`, `scope_size`, `unit_type` |
| Estimated crew days | `estimated_crew_days` |
| Planning range | `range_low` / `range_high` (display only) |
| Client budget, budget signal | `client_budget`, `budget_signal` |
| Zoom slot, target date | `zoom_slot`, `target_date` |
| Scope notes, client notes | `scope_notes`, `client_notes` |
| Plan / photo filenames | `plan_file_name`, `current_photo_name`, `inspiration_photo_name` |
| Status, created date | `status`, `created_at` |

## Owner review summary

Plain-text block includes project, scope, planning range, client contact, scheduling, notes, filenames, status, and submitted date. It intentionally omits internal cost, margin, overhead, and labor rate.

## Preserved from Step 4

- Status action buttons on cards (unchanged API: `ai-closer-update-prequote-status`)
- Filter tabs with counts
- Refresh button
- Placeholder: *Official quote conversion will come in a later step after owner review.*

If the detail drawer is open when a status action succeeds, the drawer refreshes in place.

## Files

| File | Role |
|------|------|
| `public/ai-closer-owner.html` | Detail modal markup + styles |
| `public/js/ai-closer-owner.js` | Drawer open/close, copy actions, summary builder |
| `docs/AI_CLOSER_STEP5_OWNER_DETAIL_VIEW.md` | This document |

## Test instructions

1. Sign in as owner/admin and open `/ai-closer-owner.html`.
2. Confirm filter tabs and status action buttons still work on cards.
3. Click **View Details** on a pre-quote card.
4. Verify all fields render; planning range shows public starter range only.
5. Click **Copy client email** — clipboard should contain the client email.
6. Click **Copy owner review summary** — clipboard should contain plain-text summary with no internal pricing fields.
7. Close with **Close**, backdrop click, or Escape.
8. Update status from the card while drawer is open — status badge in drawer should update.
9. Confirm no official quote is created and no new network calls beyond existing list/update endpoints.
