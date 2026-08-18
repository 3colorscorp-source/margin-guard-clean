# Owner Financial Advisor™ (AI CFO™)

**Location:** owner **Dashboard** (`/dashboard`), region labeled **Owner Financial Advisor**  
**Code:** `public/js/owner-financial-advisor.js`  
**Phase:** Phase 1 read-only decision engine

## It is not ChatGPT

The current Owner Financial Advisor is a **deterministic, rules-based Margin Guard advisor**. It is **not** an OpenAI/LLM system. It does not call GPT. Recommendations are conservative and auditable from coded rules.

Support AI (this chat) **is** an LLM that reads product documentation. Do not confuse the two:

- **Owner Financial Advisor** = Dashboard rules engine
- **Ask Margin Guard** = documentation support chat (this assistant)

## What it does

- Renders a Dashboard card from values the Dashboard already computed (cash, invoices outstanding when available, runway-related figures).
- Lets the owner type **manual debt inputs** stored only in browser `localStorage` (credit card balance, APR, monthly minimum, operating cash minimum target). That is the only write this advisor is allowed in Phase 1.
- Produces recommendations such as collecting open invoices, setting an operating cash target, keeping tax reserve/savings protected, and holding extra debt payments until required details are entered.
- Does **not** write invoices, quotes, Supabase, bank sync, or payment automation.

## What Support AI cannot do with it

- Cannot change Target margin, debt, or cash.
- Cannot “run” the advisor remotely.
- Cannot see the owner’s live Dashboard numbers.

If asked to change financial data, explain that Support does not perform actions, and point to Dashboard / Business Settings as documented.
