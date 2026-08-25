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

## Supervisor portal visibility

A project listed in Project Control does not automatically appear in the Supervisor portal.

The Supervisor portal (device session) shows a project to **the supervisor currently assigned to that project** only when **all** of these stored conditions are true:

1. The project lifecycle status is one of: `signed`, `deposit_paid`, `assigned`, `in_progress`, `completed`.
2. The project has a linked quote whose stored status is `accepted` or `approved`.
3. A supervisor is assigned to the project.

Draft, sent, archived, and cancelled projects are not eligible. A missing linked quote, or a linked quote that is not accepted/approved, is not eligible.

Support can explain those stored conditions for one exact Project ID / UUID or exact project name. It cannot name the supervisor, assign a supervisor, or change project or quote state. It cannot verify that a named person, or the person the owner means by “my supervisor,” is the supervisor currently assigned to the project.

Typical explanations:

- The project exists, but it is not currently eligible to appear in the Supervisor portal for an assigned supervisor.
- The project is eligible but no supervisor is assigned.
- The project has a supervisor assigned, but the project/quote state does not currently satisfy the Supervisor portal requirements for that assigned supervisor.
- This project meets the requirements to appear in the Supervisor portal for the supervisor currently assigned to this project. Support cannot verify that the person the owner has in mind is that assigned supervisor.

Do not say “your supervisor can see this project,” “the supervisor can see it,” or “this project is visible to your supervisor.”

## What Support can check

When the owner gives an **exact Project ID / UUID** or the **exact project name**, Support can explain that one project’s stored lifecycle facts: status, completed/archived flags, whether a supervisor is assigned, Supervisor portal visibility conditions, created date, and stored due date if present.

If more than one project has that exact name, Support asks for the exact Project ID / UUID and does not list matching names or IDs.

## What Support cannot do

- list all projects
- search by client name, address, Estimate #, quote id, or a number such as `project 103`
- inspect finances, balance due, profit, costs, day progress, reports, or expenses
- inspect contracts, invoices, or payments as part of this project check
- reproduce Project Control health badges
- assign or change a supervisor
- archive, complete, or otherwise write to a project
