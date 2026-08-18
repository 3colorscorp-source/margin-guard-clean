# Invoice Hub

**Page:** `/estimates-invoices` (`public/estimates-invoices.html`)  
**Nav label:** Invoices Hub  
**Who:** authenticated owner

## What it is

Invoice Hub is the owner list and drawer for invoices. Open a row to see details and **Actions**. Public client view is a separate page (`invoice-public.html` via public token). Download PDF for server invoices opens that public page.

Stage 1 Support AI explains **how the Hub works**. It cannot inspect whether a named invoice was sent, paid, or overdue.

If someone asks “Why didn’t invoice 103 send?”: explain the send workflow, then state that this version of Support cannot inspect that individual invoice’s status yet.

## Create Invoice (manual / standalone)

Hub **Create Invoice** builds a **Manual Invoice** that is **not** forced onto a project. It stays a standalone invoice (client name, email, title, hourly/daily/flat amount). No project folder grouping unless it is later linked by other means (V1 docs: treat Create Invoice as standalone).

## Create Project Payment Invoice (including Remaining Balance)

On a project/parent invoice, Actions → **Create Project Payment Invoice** opens **Create Project Payment Draft Invoice**.

Verified behavior:

- Draft only — **no email** and **no payment recorded** at create time.
- Payment stages: **Start Payment**, **Progress Payment**, **Final Payment**, **Remaining Balance**, **Change Order**.
- Amount: remaining project balance, or a manual amount.
- Due date is required (shortcuts: Today, +7, +14, +30).
- The child invoice is linked to the parent (`[source_invoice:…]`) and does **not** get the parent’s `quote_id` (one invoice per quote). It copies `project_id` when the parent has one.

**Remaining Balance** is one of those stage labels, not a separate product. After create, review the new draft in the Hub, then send if needed.

## Create Material Cost Invoice

Actions → **Create Material Cost Invoice** creates a **draft** extra-billing invoice for unexpected materials on the project. Label is **Material Cost**. It is extra billing and is **not** counted in original contract remaining the same way as Start/Progress/Final/Remaining children.

## Project-linked billing (parent vs child)

When a parent/root accepted project invoice has related children:

- **Parent/root** drawer can show **project-level** paid/remaining (folder ledger), a clean summary, and **Payment History** under Actions (read-only overlay).
- **Child** invoices (project payments, material cost, change order) stay **invoice-scoped** on their public page.
- Material Cost and Change Order are extra billing relative to original contract remaining.

## Send, public link, payments, duplicate, cancel

Actions (availability depends on invoice state) include:

- **Send invoice** / **Resend invoice** (delivery uses the product’s invoice send path; Support cannot confirm a specific send succeeded)
- **Record payment**
- **Payment History** on parent/root project invoices (read-only)
- **Send payment reminder**
- **Open / copy public link**, Share, Download PDF, Print
- **Edit client info**
- **Archive**
- **Duplicate as invoice** (creates a new draft; paid amount starts at zero)
- **Cancel invoice** (archives/voids through the cancel function)

Do not tell the owner an invoice “was sent” unless they can see that in Hub themselves. Support AI does not look it up.
