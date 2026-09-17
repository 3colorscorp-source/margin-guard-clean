/**
 * CH-084 — Frozen signing-party policy.
 * Customer-only remains the missing-field / false default.
 * Dual freeze always stores contractor_first. "Both" is a customer method, not two parties.
 */

"use strict";

const CUSTOMER_ONLY = {
  require_contractor_signature: false,
  signature_order: "customer_first",
  parties: "customer_only",
};

const CONTRACTOR_AND_CUSTOMER = {
  require_contractor_signature: true,
  signature_order: "contractor_first",
  parties: "contractor_and_customer",
};

function trimRole(value) {
  return String(value ?? "").trim().toLowerCase();
}

function trimStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function signingPolicyFromPreferences(prefs) {
  if (prefs && prefs.require_contractor_signature === true) {
    return { ...CONTRACTOR_AND_CUSTOMER };
  }
  return { ...CUSTOMER_ONLY };
}

function resolveSigningPolicyFromSnapshot(snapshot) {
  const raw =
    snapshot && typeof snapshot === "object" ? snapshot.signing_policy : null;
  if (!raw || typeof raw !== "object") return { ...CUSTOMER_ONLY };
  if (raw.require_contractor_signature !== true) return { ...CUSTOMER_ONLY };
  const order = String(raw.signature_order || "").trim().toLowerCase();
  return {
    require_contractor_signature: true,
    signature_order:
      order === "any_order" || order === "customer_first"
        ? order
        : "contractor_first",
    parties: "contractor_and_customer",
  };
}

function contractorMustSignFirst(policy) {
  return Boolean(
    policy &&
      policy.require_contractor_signature === true &&
      policy.signature_order === "contractor_first"
  );
}

function partiesLabel(policy) {
  return policy && policy.require_contractor_signature === true
    ? "Contractor + Customer"
    : "Customer only";
}

function isRequiredOwnerSigner(signer) {
  if (!signer) return false;
  if (signer.is_required === false) return false;
  return trimRole(signer.role) === "owner";
}

function findRequiredContractor(signers) {
  return (signers || []).find(isRequiredOwnerSigner) || null;
}

function contractorHasSigned(signers) {
  const row = findRequiredContractor(signers);
  return Boolean(row && trimStatus(row.status) === "signed");
}

function contractorSendBlockers(policy, signers) {
  if (!policy || policy.require_contractor_signature !== true) return [];
  const contractor = findRequiredContractor(signers);
  if (!contractor) {
    return [
      {
        code: "missing_contractor_signer",
        message: "A required contractor signer is required",
      },
    ];
  }
  if (trimStatus(contractor.status) !== "signed") {
    return [
      {
        code: "contractor_not_signed",
        message: "The contractor must sign before sending to the customer",
      },
    ];
  }
  return [];
}

function customerBlockedUntilContractor({ policy, signerRole, signers }) {
  if (!contractorMustSignFirst(policy)) return false;
  if (trimRole(signerRole) === "owner") return false;
  return !contractorHasSigned(signers);
}

function contractorProposalFromSnapshot(snapshot) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const settings =
    snap.business_settings && typeof snap.business_settings === "object"
      ? snap.business_settings
      : {};
  const lp =
    settings.legal_profile && typeof settings.legal_profile === "object"
      ? settings.legal_profile
      : {};
  const branding =
    settings.branding && typeof settings.branding === "object"
      ? settings.branding
      : {};
  return {
    party_name: String(lp.authorized_signer_name || "").trim(),
    title: String(lp.authorized_signer_title || "").trim(),
    email: String(lp.business_email || branding.business_email || "").trim(),
  };
}

function shouldMintCustomerToken(signer) {
  if (!signer) return false;
  if (trimStatus(signer.status) === "signed") return false;
  const role = trimRole(signer.role);
  const method = String(signer.auth_method || "").trim().toLowerCase();
  if (role === "owner" && method === "in_app") return false;
  return true;
}

module.exports = {
  CUSTOMER_ONLY,
  CONTRACTOR_AND_CUSTOMER,
  signingPolicyFromPreferences,
  resolveSigningPolicyFromSnapshot,
  contractorMustSignFirst,
  partiesLabel,
  isRequiredOwnerSigner,
  findRequiredContractor,
  contractorHasSigned,
  contractorSendBlockers,
  customerBlockedUntilContractor,
  contractorProposalFromSnapshot,
  shouldMintCustomerToken,
};
