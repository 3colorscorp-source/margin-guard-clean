# Dashboard (Financial Command Center)

**Page:** `/dashboard` (`public/dashboard.html`)  
**Who:** authenticated owner shell

## What it is

The owner Dashboard is labeled **Financial Command Center**. It is an executive owner view of cash, runway, protected accounts, and business health. It is not Invoice Hub and not the quote builder.

## Major sections that exist

- **Hero:** “Financial Command Center”, account email, a **Business health** chip, and a month-view date pill.
- **Executive snapshot:** cash, runway, buckets, and health KPIs. A badge can show **Manual mode** when balances are entered/saved locally rather than live-synced.
- **Account treasury:** protected business account balances shown as a “skyline” chart, plus total cash on hand.
- **Quick actions** on the treasury panel: links to **Invoice Hub**, **Banking & Stripe**, and **Business Settings**.
- **Owner Financial Advisor:** a dedicated region on this same page (`Owner Financial Advisor`). See `financial-advisor.md`. It is a rules-based card on the Dashboard, not a separate ChatGPT product.
- **AI Closer Leads:** a secondary card that links to `/ai-closer-owner.html` for reviewing starter pre-quotes. Copy on that card states draft only — no send, no invoice, no payment from that card.
- **Secondary tools:** buttons for **Financial performance** (modal) and **Banking & Stripe** (modal). Banking can include Stripe connection and saved/manual balances. There is a **Reset balances** / **Guardar monitor** path in the banking modal for saved dashboard figures.

## Where information comes from

Dashboard figures come from saved owner snapshot/manual balances and, when connected, banking/Stripe tools on this page. Support AI Stage 1 **cannot read** those balances for a specific account.

## What this page is not

- It does not create quotes (use Dueno `/owner` or Vendedor `/sales`).
- It does not send invoices (use Invoice Hub).
- Owner Financial Advisor on this page is **not** an LLM and does not change invoices, payroll, or bank records.
