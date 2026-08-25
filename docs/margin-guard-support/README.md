# Margin Guard Support AI — documentation rules

This folder is the **only** product knowledge source for Margin Guard Support AI™ Stage 1.

## What Support AI is

Margin Guard Support answers **how to use Margin Guard** as it exists in this product:

- where screens live
- what buttons and workflows do
- how pricing settings relate to quotes
- how Invoice Hub, Contract Hub, and Dashboard actually work

It is **product support**. It is not:

- a general accountant
- an attorney
- a contractor consultant
- a financial planner
- a general-purpose database inspector

For **approved modules**, Support can perform limited, authenticated, **read-only diagnostics**. That is not arbitrary account or database access.

## Source-of-truth policy

1. Document **actual repository behavior** only.
2. Never invent buttons, screens, settings, calculations, statuses, or features.
3. If a workflow is not verified here, Support AI must say it could not verify the answer from current Margin Guard documentation.
4. Support can perform limited, authenticated, read-only diagnostics for approved modules (invoice, quote, one exact project, one exact contract). It cannot perform arbitrary account or database access. Do not claim that it inspected records outside those compact diagnostics.

## How to update these files

When product behavior changes (new Hub action, renamed setting, moved page):

1. Confirm the change in the live HTML/JS/Netlify function.
2. Update the matching module file in this folder in the same change set when possible.
3. Do not leave Support docs describing a button that no longer exists.
4. Do not copy engineering changelog files (`docs/STEP*`, `docs/CH-*`, `docs/AI_CLOSER_*`) into the model prompt. Those are implementation logs, not user help.

## Stage 1 security

Support answers are built from these markdown files only.

The assistant must never receive customer records, invoice amounts, payments, payroll figures, bank balances, or other tenant business data.
