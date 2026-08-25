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

From the owner/seller builders, sending/publishing creates a **public estimate** the client can open (`/estimate-public`). Ask Margin Guard can report compact Sales Admin lifecycle status for an **exact Estimate #** (for example `2026-0001`). It cannot prove that a customer received email, viewed the estimate, signed a contract, or paid. It cannot inspect quote pricing or Minimum Floor for a specific quote.

## Public estimate page

Support can check whether an **exact Estimate #** or quote UUID currently has a **configured public estimate reference**.

That check is read-only. It does not open the public link, reveal the public token or URL, publish a quote, or regenerate a link. It does **not** prove that the public endpoint successfully loaded.

Current public estimate behavior:

- A public estimate reference is configured only when Margin Guard has stored a public token for that quote.
- Support may say whether that stored reference has the expected format. Format validity does not prove uniqueness and does not prove a successful public load.
- Expiration by itself does **not** disable the public estimate endpoint. An expired quote can still have a configured public estimate reference.
- Quote status (including accepted or approved) does not by itself remove that configured reference.
- After the quote is accepted or approved, accept/decline is no longer available **because of that quote state**, not because the expiration date passed.
- Do not describe the public estimate reference as expired. The quote expiration date can pass while the reference remains configured.

If the owner asks whether the link works, opens, or loads, say Support did not probe the public endpoint and cannot confirm that the page successfully loads for the client.

Support should distinguish:

1. no public estimate reference is currently configured
2. a public estimate reference is configured
3. the stored reference has (or does not have) the expected format
4. the quote state would no longer allow accept/decline (for example already accepted)
5. the quote expiration date has passed, separately from the configured reference
6. Support cannot verify a successful public-page load

Do not say “the link definitely works,” “the link is set up correctly,” “the page successfully loads,” “I verified the customer can open it,” or “I tested the public page.” Prefer: “A public estimate reference is configured.” Never call the reference/token/link itself expired.
