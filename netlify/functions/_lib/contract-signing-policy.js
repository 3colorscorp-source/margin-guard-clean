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

function isRequiredCustomerSigner(signer) {
  if (!signer) return false;
  if (signer.is_required === false) return false;
  return trimRole(signer.role) === "customer";
}

function findRequiredContractor(signers) {
  return (signers || []).find(isRequiredOwnerSigner) || null;
}

function requiredOwners(signers) {
  return (signers || []).filter(isRequiredOwnerSigner);
}

function requiredCustomers(signers) {
  return (signers || []).filter(isRequiredCustomerSigner);
}

function contractorHasSigned(signers) {
  const row = findRequiredContractor(signers);
  return Boolean(row && trimStatus(row.status) === "signed");
}

function isRequiredSigned(signer) {
  return trimStatus(signer?.status) === "signed";
}

function allRequiredSigned(signers) {
  const required = (signers || []).filter((s) => s.is_required !== false);
  if (!required.length) return false;
  return required.every(isRequiredSigned);
}

/**
 * Dual cardinality: exactly one required owner, at least one required customer.
 * Additional required signers are allowed but cannot substitute for either party.
 */
function evaluateDualRoster(signers) {
  const owners = requiredOwners(signers);
  const customers = requiredCustomers(signers);
  if (owners.length > 1) {
    return {
      ok: false,
      code: "ambiguous_contractor_roster",
      message: "Dual signing allows exactly one required contractor",
      owners,
      customers,
    };
  }
  if (owners.length !== 1) {
    return {
      ok: false,
      code: "missing_contractor_signer",
      message: "A required contractor signer is required",
      owners,
      customers,
    };
  }
  if (customers.length < 1) {
    return {
      ok: false,
      code: "missing_customer_signer",
      message: "A required customer signer is required",
      owners,
      customers,
    };
  }
  return { ok: true, code: null, message: null, owners, customers };
}

function dualPartiesFullySigned(signers) {
  const roster = evaluateDualRoster(signers);
  if (!roster.ok) return false;
  if (!isRequiredSigned(roster.owners[0])) return false;
  if (!roster.customers.every(isRequiredSigned)) return false;
  return allRequiredSigned(signers);
}

/**
 * Customer-only: complete when every required signer is signed.
 * Dual: never complete without exactly one required contractor, at least one
 * required customer, and every required signature including both parties.
 */
function envelopeMayComplete(policy, signers) {
  if (!allRequiredSigned(signers)) return false;
  if (policy && policy.require_contractor_signature === true) {
    return dualPartiesFullySigned(signers);
  }
  return true;
}

function resolveSignatureProgression(policy, signers, { next = null, envStatus = "" } = {}) {
  const status = String(envStatus || "").trim().toLowerCase();
  if (envelopeMayComplete(policy, signers)) {
    return {
      complete: true,
      progression: "completed",
      envelopeStatus: "completed",
    };
  }
  if (policy && policy.require_contractor_signature === true) {
    const roster = evaluateDualRoster(signers);
    if (roster.code === "ambiguous_contractor_roster") {
      return {
        complete: false,
        progression: "ambiguous_contractor_roster",
        envelopeStatus: status,
      };
    }
    if (roster.code === "missing_customer_signer") {
      return {
        complete: false,
        progression: "customer_signer_required",
        envelopeStatus: status,
      };
    }
  }
  if (next) {
    return {
      complete: false,
      progression: "next_signer_pending",
      envelopeStatus: status === "sent" ? "opened" : status,
    };
  }
  return {
    complete: false,
    progression: "next_signer_pending",
    envelopeStatus: status,
  };
}

function contractorSendBlockers(policy, signers) {
  if (!policy || policy.require_contractor_signature !== true) return [];
  const roster = evaluateDualRoster(signers);
  if (roster.code === "ambiguous_contractor_roster") {
    return [{ code: roster.code, message: roster.message }];
  }
  const out = [];
  if (roster.code === "missing_contractor_signer") {
    out.push({ code: roster.code, message: roster.message });
  } else {
    const contractor = roster.owners[0] || findRequiredContractor(signers);
    if (!contractor) {
      out.push({
        code: "missing_contractor_signer",
        message: "A required contractor signer is required",
      });
    } else if (trimStatus(contractor.status) !== "signed") {
      out.push({
        code: "contractor_not_signed",
        message: "The contractor must sign before sending to the customer",
      });
    }
  }
  if (roster.code === "missing_customer_signer") {
    out.push({ code: roster.code, message: roster.message });
  }
  return out;
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
  isRequiredCustomerSigner,
  findRequiredContractor,
  requiredOwners,
  requiredCustomers,
  contractorHasSigned,
  allRequiredSigned,
  evaluateDualRoster,
  dualPartiesFullySigned,
  envelopeMayComplete,
  resolveSignatureProgression,
  contractorSendBlockers,
  customerBlockedUntilContractor,
  contractorProposalFromSnapshot,
  shouldMintCustomerToken,
};
