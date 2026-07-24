/**
 * CH-004A7B — Canonical Margin Guard legal-notice starting templates.
 * Server-owned only. Never auto-written to tenant rows without Owner action.
 */

const NOTICE_FIELD_KEYS = Object.freeze([
  "contract_notice",
  "payment_notice",
  "change_order_notice",
  "cancellation_notice",
  "warranty_notice",
  "limitation_of_liability",
  "permit_notice",
  "site_conditions_notice",
  "cleanup_notice",
  "material_notice",
  "dispute_notice",
  "force_majeure_notice",
  "governing_law_notice",
  "additional_terms",
]);

const LEGAL_NOTICE_DEFAULTS = Object.freeze({
  contract_notice:
    "This Agreement describes the work, price, payment schedule, responsibilities, and other terms accepted by the Contractor and Customer. Any change to this Agreement must be documented in writing and approved by both parties before that change takes effect.",

  payment_notice:
    "The Customer agrees to make payments according to the payment schedule stated in this Agreement. Due dates, payment methods, and any approved adjustments must be documented in writing. Work progress and payment timing remain subject to the terms of this Agreement.",

  change_order_notice:
    "Work outside the approved scope must be documented and approved in writing before the additional work begins. Approved changes may affect price, materials, allowances, and schedule.",

  cancellation_notice:
    "Either party may request cancellation or early termination of remaining work as permitted by this Agreement and applicable law. Cancellation, unfinished work, amounts owed, and return of materials or deposits must be documented in writing.",

  warranty_notice:
    "Warranty coverage, if any, is limited to the warranty terms stated in this Agreement or in a separate written warranty provided by the Contractor. Warranty terms may exclude misuse, neglect, unauthorized alterations, normal wear, and work or materials provided by others.",

  limitation_of_liability:
    "Except as required by applicable law, each party’s liability under this Agreement is limited to claims arising from that party’s own work, materials, or negligence. Neither party is responsible for consequential or incidental damages to the extent such limitation is permitted by law.",

  permit_notice:
    "Permits, inspections, and related approvals required for the work will be handled as stated in this Agreement. Each party will cooperate with information and access needed for permit and inspection processes that apply to the project.",

  site_conditions_notice:
    "The Customer will provide reasonable access to the property and disclose known site conditions that may affect the work. Concealed, unknown, or changed conditions discovered after work begins may require schedule or price adjustments if documented and approved in writing.",

  cleanup_notice:
    "The Contractor will maintain reasonable jobsite cleanliness during the work and remove related debris upon completion, except for items the Customer asks to keep or conditions outside the Contractor’s control.",

  material_notice:
    "Materials will be furnished as described in the approved scope, allowances, and selections. Substitutions may be used when necessary for availability, safety, or code compliance if communicated to the Customer and documented when they affect price or appearance.",

  dispute_notice:
    "If a disagreement arises under this Agreement, the parties will first attempt to resolve it through good-faith discussion. If unresolved, the parties may pursue mediation or other remedies available under this Agreement and applicable law.",

  force_majeure_notice:
    "Neither party is responsible for delay or failure caused by events outside that party’s reasonable control, including severe weather, supply shortages, labor disruptions, utility outages, government actions, or similar events. Affected schedules may be adjusted by mutual written agreement.",

  governing_law_notice:
    "This Agreement is governed by the laws of the jurisdiction where the project property is located, unless the parties agree otherwise in writing. Venue for disputes will follow applicable law and any venue terms stated in this Agreement.",

  additional_terms:
    "Additional written terms attached to or incorporated into this Agreement form part of the contract. If a conflict exists between documents, the parties will resolve it according to the controlling document order stated in this Agreement, or by written amendment if none is stated.",
});

function cloneDefaults() {
  const out = {};
  for (const key of NOTICE_FIELD_KEYS) {
    out[key] = LEGAL_NOTICE_DEFAULTS[key];
  }
  return out;
}

function normalizeForCompare(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

module.exports = {
  NOTICE_FIELD_KEYS,
  LEGAL_NOTICE_DEFAULTS,
  cloneDefaults,
  normalizeForCompare,
};
