# AI Closer Step 1 — Isolated Lab Module

**Status:** Step 1 lab prototype only — **not production**.

This module is intentionally isolated from Margin Guard production workflows. It does not create real quotes, connect to Supabase, call Netlify functions, or modify existing pages.

## Purpose

Explore an **AI Quoter / AI Closer** client flow and owner briefing using mock `localStorage` data:

1. Client captures scope → budget → starter quote → Zoom → send/print
2. Tenant configures trade presets and pricing guardrails (lab settings)
3. Owner reviews a mock AI seller briefing from the latest lab quote

## Lab pages

| Page | URL | Script |
|------|-----|--------|
| Client flow | `/ai-closer-client.html` | `public/js/ai-closer-client.js` |
| Lab settings | `/ai-closer-settings.html` | `public/js/ai-closer-settings.js` |
| Owner briefing | `/ai-closer-owner.html` | `public/js/ai-closer-owner.js` |

Cross-links between the three pages are provided in each header.

## localStorage keys (lab only)

| Key | Purpose |
|-----|---------|
| `mg_ai_closer_lab_settings_v1` | Mock tenant trade presets, services, guardrails, closing style |
| `mg_ai_closer_lab_quotes_v1` | Array of mock client starter quotes (newest first, max 50) |

Clearing browser storage resets the lab. No server persistence.

## Pricing rule (approved lab formula)

For each service:

```
estimatedDays = ceil(quantity / capacityPerCrewDay)
base         = estimatedDays × protectedPublicCrewDayPrice
rangeLow     = ceil(base / 100) × 100
rangeHigh    = rangeLow + controlled buffer (capped by guardrails)
```

### Floor Tile default example

- Capacity: **90 sq ft / crew day**
- Protected public crew day price: **$1,669.67**
- 395 sq ft → `ceil(395/90) = 5` days
- Base: `5 × 1,669.67 = $8,348.35`
- Client starter range: **~$8,400 – $9,100** (rounded low + small buffer)

## Client-visible vs hidden

**Client sees only:**

- Project / scope summary
- Starter quote **range**
- Estimated crew days (schedule planning)
- Budget fit messaging (no internal math)

**Client never sees:**

- Internal cost, worker pay, overhead, profit, margin, payroll
- Protected minimum internals or formulas

Contact name/email/phone are collected **only at the end** in a modal (Zoom book or send quote).

## Client flow steps

1. **Scope** — project, work type, quantity, notes  
2. **Budget** — min/max range (optional if guardrail off)  
3. **Starter quote** — public range + facts  
4. **Zoom** — mock slot picker; primary CTA: **Book 15-minute Zoom**  
5. **Send / print** — secondary CTA: **Send starter quote**; small action: **Download / print**

## Settings (lab)

Trade presets:

- Tile Contractor (default — Floor Tile + Wall Tile)
- Painter
- Plumber
- Custom Trade

Per service:

- Unit type (sq ft, fixtures, rooms, linear ft)
- Crew capacity per crew day
- Protected public crew day price
- Hours per crew day
- Starter buffer % and max buffer dollars

Guardrails:

- Min/max scope quantity
- Require budget before quote
- Max starter range spread %

Closing style: consultative | direct | educational (feeds owner recommendation copy)

## Owner briefing (lab)

Reads the latest entry from `mg_ai_closer_lab_quotes_v1` and shows:

- Project, client, scope, area, budget, starter range, crew days
- Budget gap analysis
- Zoom status
- Mock AI seller recommendation (closing style + next steps)

Clearly labeled **AI Closer Lab only**.

## Explicit non-goals (Step 1)

- No changes to `public/js/app.js`, sales, owner, dashboard, estimates-invoices, or seller/supervisor portals
- No Netlify functions
- No Supabase tables or migrations
- No real calendar, email, Stripe, or quote creation
- No integration with production pricing engine

## Next steps (future phases — not in Step 1)

- Wire to tenant auth and real quote draft API
- Calendar provider integration
- Production-safe feature flag and routing
- AI-generated scope/closing copy with audit trail

## Quick QA

1. Open `/ai-closer-settings.html` — confirm Tile defaults and 395 sq ft preview (~$8,400–$9,100).
2. Open `/ai-closer-client.html` — walk all 5 steps; verify no internal cost fields.
3. Book Zoom or send quote — enter contact in modal; confirm toast.
4. Open `/ai-closer-owner.html` — briefing shows latest quote and recommendation.
5. Confirm production pages and `app.js` are untouched.
