# Quote builder (estimates)

**Owner quote page:** `/owner` (`public/owner.html`) — nav label **Dueno**  
**Seller / owner-as-seller quote page:** `/sales` (`public/sales.html`) — nav label **Vendedor**  
**Create Estimate shortcut:** `/create-estimate` **redirects to `/sales`**. There is no separate Create Estimate builder.

## How to create a quote

1. Open **Dueno** (`/owner`) for the owner quote builder, or **Vendedor** (`/sales`) for the sales quote builder (owner can also open Vendedor with `?portal=owner`).
2. Enter project/client fields, labor/operational plan, and pricing.
3. Margin Guard shows pricing KPIs including a **recommended** sell price and a **minimum** (protected floor as a dollar amount).
4. Publishing/sending uses the estimate send flow from those builders (public estimate link). Margin Guard **will not allow sending a quote whose price is below the protected minimum**.

`/seller` redirects to `/sales.html?portal=seller` (seller device portal). Stage 1 Support AI is for **owners**, not seller-device sessions.

## Recommended Price vs Minimum Floor

**They are not the same.**

- **Recommended Price** is the protected recommended sell price Margin Guard calculates from job labor, employer payroll burden, allocated overhead, the locked **Reserve (5%)**, and **Target margin (%)** from Business Settings.
- **Minimum Floor** is the **protected pricing floor**. In Business Settings it is configured as **Minimum margin (%)** (hint: “Protected floor — quotes below this need review”). On a quote it appears as a dollar **minimum**. Quotes below that minimum need review; send is blocked if the offered price is below the protected minimum.

Raising target margin raises the recommended price. Minimum margin must be at or below target margin. Do not tell owners they are the same setting.

## How Business Settings affect recommended pricing

Quote economics use the owner’s Business Settings (saved in the tenant snapshot), including:

- Pro and Assistant internal labor cost ($/h) — **not** the customer billing rate
- Quote mode: bill by hour or by crew-day (with work hours per day)
- Payroll burden (Workers Comp, FICA, FUTA, State UI / SUI) applied over W-2 labor
- Monthly overhead allocated using standard hours per worker per month
- Target margin (%), Minimum margin (%), Reserve (fixed 5%)

Server-side secure pricing (`calc-secure-pricing` / publish path) uses the same protected-price idea: labor + burden + overhead, then reserve and profit.

## Sending estimates

From the owner/seller builders, sending/publishing creates a **public estimate** the client can open (`/estimate-public`). Support AI Stage 1 can explain that workflow. It **cannot** confirm whether a specific estimate was viewed, accepted, or paid.
