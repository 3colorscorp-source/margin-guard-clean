# Business Settings

**Page:** `/business-settings`  
**Who:** authenticated owner (sidebar: Business Setup → Business Settings)

Business Settings store the owner’s pricing economics (tenant snapshot). They drive **recommended** and **minimum** quote prices. Changing a setting here does **not** happen through Support AI — the owner must edit this page and save.

## Margin Protection (primary source for “Minimum Floor”)

Under **Financial Protection → Margin Protection**:

| Setting | Control | Verified meaning |
|---|---|---|
| **Target margin (%)** | `profitPct` | Desired profit margin on protected price calculations. This feeds **Recommended Price**. |
| **Minimum margin (%)** | `minimumMarginPct` | **Protected floor** — quotes below this need review. Must be at or below target margin. This is the settings control behind **Minimum Floor**. |
| **Reserve (%) — fixed** | `reservePct` | Protection reserve applied before profit. **Currently locked at 5%** (read-only). |

**Minimum Floor is not Target margin.** Target margin is the desired profit used in the recommended (protected) sell price. Minimum Floor / Minimum margin is the lower protected bound. Quotes below the protected minimum cannot be sent.

## Payroll burden (employer)

Under **Payroll Burden** — employer payroll taxes applied over W-2 labor. Workers Comp is always manual.

- **Workers Comp (%)** — actual policy rate over W-2 wages; enter 0% if excluded / no applicable policy
- **FICA (%)**
- **FUTA (%)**
- **State UI / SUI (%)**

**State Payroll Defaults:** choose a state and **Apply Payroll Defaults** to fill the form as a reference. Verified presets exist for a listed set of states (including California, Texas, Florida, and others on the helper text). Apply fills the form only — **Save** to persist. These are default reference values, not legal advice. The page tells owners to verify rates with their accountant, payroll provider, or state agency.

## Overhead allocation

- **Monthly overhead ($)**
- **Std hours / worker / mo** — used with monthly overhead to allocate office/fixed cost into each job hour

## Labor, crew, quote mode

- **Pro base cost ($/h)** — internal labor cost for pricing, **not** the customer billing rate
- **Assistant base cost ($/h)** — same, for assistant labor
- **Quote mode:** Bill by hour or Bill by day (crew-day using work hours per day)
- **Work hours per day**
- Workdays and crew-capacity related fields on the same card (capacity: how many active crews/projects)

## Other verified areas on this page

- Business identity / classification for future templates (Phase 1 copy: classification **does not change pricing formulas**)
- Legal profile fields and **Legal Notices** (separate page `/legal-notices`)
- Optional external payment/accounting link (hint: external link only — bank, QuickBooks, Square, etc.)

Support AI will not change Target margin or any other setting. It can only tell the owner **where** to edit it.
