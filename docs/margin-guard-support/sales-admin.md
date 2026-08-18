# Sales Admin

**Page:** `/sales-admin`  
**Who:** authenticated owner (sidebar: Operations → Sales Admin)

## What it is

Sales Admin is the owner operations console for quotes, production projects tied to accepted quotes, seller performance, and the handoff into **Contract Hub**.

## Verified sections

- **KPI shortcuts** including **All quotes**.
- **Production projects** with accepted quotes (same list idea as Project Control). Empty copy: accepted quotes linked to production projects appear here.
- **Quote pipeline / All quotes** loaded from the tenant quote list.
- **Owner review queue:** seller-submitted quotes that need owner review.
- **Seller performance:** published quote counts, labor sold / estimated commission notes. Commission display is **labor budget × seller commission %**, never contract total, and is **not** a paid commission ledger. Optional **Show test sellers** toggle.
- **Contract Hub™** panel: when a quote is approved, next step copy is to **Open Contract Hub** to complete, freeze, and send the contract for signature. Button goes to `/contract-hub`.

Sellers themselves are managed with Team & Devices (`/team-devices`) for memberships/devices; Sales Admin is where owner **reviews quotes and seller performance**, not the pairing PIN screen.

## Related owner pages

- **Project Control** (`/project-control`) — production projects
- **Team & Devices** (`/team-devices`) — invite/manage team and devices
- **Contract Hub** (`/contract-hub`) — opened from this page after approval
- **Vendedor / Dueno** — where quotes are built

Support AI cannot list this tenant’s sellers or quotes. It can only explain how Sales Admin is used.
