# Contract Hub, Contract Signing, and Contract Builder

## Navigation vs real pages (important)

The owner sidebar **does not** list a link labeled “Contract Hub”.

- **Contract Signing** in the sidebar opens **`/signature-workspace`** (page title: Contract Workflow). That is the signing/workspace surface.
- **Contract Hub™** is a real page at **`/contract-hub`**. Owners typically reach it from **Sales Admin** after a quote is approved: “Open Contract Hub”. Contract Hub itself has **Back to Sales Admin**.

Do not tell owners that Contract Hub is a sidebar item named Contract Hub. Tell them the URL/workflow above.

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

## What Support AI cannot do

It cannot send a signing invitation, freeze a contract, or inspect whether a customer signed. It can only explain these owner workflows.
