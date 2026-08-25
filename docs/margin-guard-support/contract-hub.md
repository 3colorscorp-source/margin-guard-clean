# Contract Hub, Contract Signing, and Contract Builder

## Navigation vs real pages (important)

The owner sidebar **does not** list a link labeled “Contract Hub”.

- **Contract Signing** in the sidebar opens **`/signature-workspace`** (page title: Contract Workflow). That is the signing/workspace surface.
- **Contract Hub™** is a real page at **`/contract-hub`**. Owners typically reach it from **Sales Admin** after a quote is approved: “Open Contract Hub”. Contract Hub itself has **Back to Sales Admin**.

Do not tell owners that Contract Hub is a sidebar item named Contract Hub. Tell them the URL/workflow above.

## What a contract is in Support

In Margin Guard, a contract belongs to an **approved project**. Support diagnostics use the **exact Project ID** (UUID) as the contract identifier. There is no separate contract number.

The owner-visible contract is the project’s **current frozen contract package** plus the signing envelope Contract Hub would show. A project row, quote, package, or envelope alone is not the complete contract.

## Contract Hub (`/contract-hub`)

Purpose copy on the page: create and manage the **service agreement for an approved project**.

Verified on the page:

- Project, customer, customer email, approved quote, contract total, project status, contract status
- Guided **current stage** (examples in product: Approved Quote → Complete Contract → Freeze Contract → Configure Signing → Customer Signs → Signed Contract)
- **Next Action** / checklist, including items missing before freeze
- Primary CTA such as **Open Contract Builder**
- Opened from Sales Admin when a quote is approved: next step is complete, freeze, and send the contract for signature

## Contract Builder (`/contract-builder`)

Used from Contract Hub’s next action to complete contract content before freeze. It is an authenticated owner shell page (`data-mg-page-title="Contract Builder"`).

## Contract Signing / Signature Workspace (`/signature-workspace`)

Sidebar **Contract Signing** → this page. It is the owner **Contract Workflow** for configuring signing, invitations, and tracking signing — not the same screen as Contract Hub’s project summary.

Client signing uses a separate public signing route (`contract-sign.html`). Stage 1 Support is for **owners**, not the public signer.

## Owner-visible contract statuses Support can explain

When the owner supplies the exact Project ID, Support can report the current Contract Hub lifecycle overlay:

- **Not Frozen** — no current frozen (ready/executed) contract package
- **Frozen Contract Ready** — a frozen package exists, but a preferred signing envelope is not in draft/sent/opened/completed
- **Signing Request Ready** — frozen package with a draft signing envelope
- **Secure Link Ready** — the secure signing request/link has been prepared (`envelope` sent)
- **Waiting for Customer Signature** — the signing envelope has been opened
- **Fully Signed** — the envelope is completed or the frozen package is executed

**Envelope sent does not mean email was delivered.** Contract Hub can show a secure signing request as prepared even when no invitation email has been sent. Support must not say the customer received, opened, or was emailed the contract.

A **completion certificate** and a **signed PDF** may exist as separate final artifacts after signing. Support may not always verify those artifacts in chat. If Support did not verify an artifact, do not claim it does not exist.

## What Support AI cannot do

Support does not freeze a contract, send a signing invitation, or change signing settings.

Support does not inspect signer identities, signing tokens, contract legal text, payment schedules, or contract money. Use Contract Hub, Contract Builder, and Signature Workspace to review those details.
