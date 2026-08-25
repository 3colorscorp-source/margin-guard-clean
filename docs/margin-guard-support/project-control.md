# Project Control

**Page:** `/project-control`  
**Who:** authenticated owner  
**Related:** Sales Admin also lists production projects tied to accepted quotes.

## What it is

Project Control is the owner production-project workspace. Each row is a stored **tenant project** with a **lifecycle status**, optional supervisor assignment, and an optional due date.

## Project status vs Project Control health

These are different concepts. Do not treat them as the same thing.

- **Lifecycle status** is the stored project status (examples: `signed`, `deposit_paid`, `assigned`, `in_progress`, `completed`, `archived`). Sales Admin and Project Control can show this as **Status: {stored status}**.
- **Project Control health badges** (On track, At risk, Delayed, Ready to close, Work complete — balance still due) are a separate operational/financial view. They depend on day progress, reports, expenses, and balance due. Support cannot inspect or reproduce those badges.

## Common stored lifecycle statuses

Normalized from the stored status string (trimmed, lowercase):

- `signed`
- `deposit_paid`
- `assigned`
- `in_progress`
- `completed`
- `archived`
- `cancelled` (archive fallback)

Support reports that stored lifecycle status as-is. It does not infer a new status from quotes, contracts, invoices, payments, or day progress.

## Completed

A project is **completed** only when the stored lifecycle status is `completed`.

Not completed:

- an invoice was paid
- a deposit was paid (`deposit_paid` remains `deposit_paid`)
- a quote was accepted
- a contract was signed
- day progress looks finished
- a health badge says Ready to close

## Archived

A project is **archived** when the stored lifecycle status is `archived` or `cancelled`.

Archived/cancelled projects remain findable by exact Project ID / UUID or exact project name. Support does not hide them.

## Supervisor assignment

A project may have a supervisor assigned. Support can only say whether a supervisor **is assigned** or **is not assigned**. It cannot name the supervisor or expose supervisor identifiers.

## Due date

Project Control can store a **due date**. If present, it is the stored due date — not a guaranteed actual completion date and not an “end date” unless qualified as the stored due date.

This Support diagnostic does not have a stored project **start date**.

## What Support can check

When the owner gives an **exact Project ID / UUID** or the **exact project name**, Support can explain that one project’s stored lifecycle facts: status, completed/archived flags, whether a supervisor is assigned, created date, and stored due date if present.

If more than one project has that exact name, Support asks for the exact Project ID / UUID and does not list matching names or IDs.

## What Support cannot do

- list all projects
- search by client name, address, Estimate #, quote id, or a number such as `project 103`
- inspect finances, balance due, profit, costs, day progress, reports, or expenses
- inspect contracts, invoices, or payments as part of this project check
- reproduce Project Control health badges
- assign or change a supervisor
- archive, complete, or otherwise write to a project
