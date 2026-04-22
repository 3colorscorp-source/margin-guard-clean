/**
 * Shared public-quote send pipeline (Sales + Owner).
 * Order: publish-public-quote → validate → replace link → rebuild PDF → send-quote-zapier
 */
(function () {
  "use strict";

  let registeredHelpers = null;

  function getHelpers(override) {
    const h = override || registeredHelpers || window.__MG_ESTIMATE_SEND_HELPERS__;
    if (
      !h ||
      typeof h.buildEstimatePdfPayload !== "function" ||
      typeof h.formatUsd !== "function" ||
      typeof h.buildEstimateTenantPayload !== "function" ||
      typeof h.resolvePublishBusinessName !== "function" ||
      typeof h.hexToRgbTuple !== "function" ||
      typeof h.isInvalidPublishBusinessNameCandidate !== "function"
    ) {
      throw new Error("Margin Guard: estimate send helpers not registered. Load estimate-send-helpers.js before app.");
    }
    return h;
  }

  /**
   * @param {object} args
   * @param {object} args.payload - modal dataset payload (same shape as Sales)
   * @param {string} args.message - email body with optional [PUBLIC_QUOTE_URL]
   * @param {object} args.sendData
   * @param {object} args.sendData.state - sales-shaped state
   * @param {object} args.sendData.settings
   * @param {object} args.sendData.branding
   * @param {string} args.sendData.toEmail
   * @param {string} args.sendData.toName
   * @param {string} args.sendData.salesRepInitials
   * @param {string} args.sendData.subject
   * @param {string} args.sendData.scope
   * @param {string} args.sendData.customerPhone
   * @param {string} args.sendData.projectAddress
   * @param {number} args.sendData.estimateTotal
   * @param {number} args.sendData.depositRequired
   * @param {object} [args.sendData.helpers] - optional per-call helpers
   * @returns {Promise<{ publishData: object, publicQuoteUrl: string, messageWithLink: string, rebuiltPdf: object, zapierPayload: object }>}
   */
  async function runPublicQuoteSendPipeline({ payload, message, sendData }) {
    const {
      state,
      settings,
      branding,
      toEmail,
      toName,
      salesRepInitials,
      subject,
      scope,
      customerPhone,
      projectAddress,
      estimateTotal,
      depositRequired,
      helpers: helpersOverride
    } = sendData;

    const H = getHelpers(helpersOverride);

    const bn = H.resolvePublishBusinessName(branding, payload, settings);
    const publishResponse = await fetch("/.netlify/functions/publish-public-quote", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: payload.projectName || state.projectName || "",
        title: payload.projectName || state.projectName || "",
        client_name: toName || payload.clientName || state.clientName || "",
        client_email: toEmail || payload.customerEmail || state.customerEmail || "",
        client_phone: customerPhone,
        customer_phone: customerPhone,
        phone: customerPhone,
        project_address: projectAddress,
        customer_address: projectAddress,
        job_site: projectAddress,
        address: projectAddress,
        workers: Array.isArray(state.workers) ? state.workers : [],
        price: state.price,
        _manualPriceTouched: state._manualPriceTouched,
        offeredPrice: state.offeredPrice,
        total: estimateTotal,
        recommended_total: estimateTotal,
        deposit_required: depositRequired,
        notes: message,
        public_message: payload.scopeSummary || scope || "",
        currency: "USD",
        status: "READY_TO_SEND",
        business_name: bn,
        company_name: bn,
        business_email: branding.businessEmail || payload.businessEmail || settings.businessEmail || settings.email || "",
        business_phone: branding.businessPhone || payload.businessPhone || settings.businessPhone || settings.phone || "",
        business_address: branding.businessAddress || payload.businessAddress || settings.address || settings.companyAddress || ""
      })
    });

    const publishRaw = await publishResponse.text();
    let publishData = {};
    try {
      publishData = publishRaw ? JSON.parse(publishRaw) : {};
    } catch (_e) {}

    if (!publishResponse.ok || !publishData?.quote_id || !publishData?.public_token || !publishData?.public_url) {
      throw new Error(publishData.error || publishRaw || "Unable to create public quote link.");
    }

    const finPub = publishData.financials && typeof publishData.financials === "object" ? publishData.financials : {};
    const rowPub = publishData.row && typeof publishData.row === "object" ? publishData.row : {};
    const persistedT = Number(finPub.total != null ? finPub.total : rowPub.total);
    if (
      Number.isFinite(persistedT) &&
      persistedT > 0 &&
      Math.abs(persistedT - Number(estimateTotal)) > 0.009
    ) {
      console.error("[MG Publish vs session TOTAL MISMATCH — aborting shared PDF/email pipeline]", {
        estimateTotal: Number(estimateTotal),
        persistedT
      });
      throw new Error("Published total does not match the send modal.");
    }
    const persistedD = Number(finPub.deposit_required != null ? finPub.deposit_required : rowPub.deposit_required);
    if (
      Number.isFinite(persistedD) &&
      Number.isFinite(depositRequired) &&
      Math.abs(persistedD - Number(depositRequired)) > 0.009
    ) {
      console.warn("[MG Publish vs session] deposit differs (persisted row is source of truth for PDF)", {
        depositRequired: Number(depositRequired),
        persistedD
      });
    }

    const publicQuoteUrl = publishData.public_url;
    const messageWithLink = (message || "").replace("[PUBLIC_QUOTE_URL]", publicQuoteUrl);

    const savedRow = publishData.row && typeof publishData.row === "object" ? publishData.row : null;
    const savedName = savedRow ? String(savedRow.business_name || savedRow.company_name || "").trim() : "";
    const savedEmail = savedRow ? String(savedRow.business_email || "").trim() : "";
    const savedPhone = savedRow ? String(savedRow.business_phone || "").trim() : "";
    const savedAddr = savedRow ? String(savedRow.business_address || "").trim() : "";
    const fromRowT = savedRow != null ? Number(savedRow.total) : NaN;
    const fromRowD = savedRow != null ? Number(savedRow.deposit_required) : NaN;
    const fromFinT = Number(finPub.total);
    const fromFinD = Number(finPub.deposit_required);
    let rowTotal = Number.isFinite(fromRowT) && fromRowT > 0 ? fromRowT : NaN;
    let rowDeposit = Number.isFinite(fromRowD) && fromRowD > 0 ? fromRowD : NaN;
    if (!Number.isFinite(rowTotal) || rowTotal <= 0) {
      rowTotal = Number.isFinite(fromFinT) && fromFinT > 0 ? fromFinT : Number(payload.totalAmount ?? estimateTotal) || 0;
    }
    if (!Number.isFinite(rowDeposit) || rowDeposit <= 0) {
      rowDeposit =
        Number.isFinite(fromFinD) && fromFinD > 0 ? fromFinD : Number(payload.depositRequired ?? depositRequired) || 0;
    }
    const usedRowFirst =
      Number.isFinite(fromRowT) && fromRowT > 0 && Number.isFinite(fromRowD) && fromRowD > 0;
    console.info("[MG Seller PDF Financials]", {
      quote_id: publishData.quote_id,
      public_token: publishData.public_token,
      rowTotal,
      rowDeposit,
      payloadTotal: Number(payload.totalAmount ?? estimateTotal) || 0,
      payloadDeposit: Number(payload.depositRequired ?? depositRequired) || 0,
      usedRowFirst
    });

    const savedTenantOverlay = {};
    if (savedName) {
      savedTenantOverlay.businessName = savedName;
      savedTenantOverlay.business_name = savedName;
    }
    if (savedPhone) {
      savedTenantOverlay.businessPhone = savedPhone;
      savedTenantOverlay.business_phone = savedPhone;
    }
    if (savedEmail) {
      savedTenantOverlay.businessEmail = savedEmail;
      savedTenantOverlay.business_email = savedEmail;
    }
    if (savedAddr) {
      savedTenantOverlay.businessAddress = savedAddr;
      savedTenantOverlay.business_address = savedAddr;
    }

    const tenantForRebuild = H.buildEstimateTenantPayload({ ...branding, ...savedTenantOverlay }, settings, payload);

    const quoteNumberDisplay = String(
      publishData.quote_number_display || (savedRow && savedRow.quote_number_display) || ""
    ).trim();

    const pdfPayloadWithLink = {
      ...payload,
      ...tenantForRebuild,
      branding,
      settings,
      customerEmail: toEmail || payload.customerEmail || state.customerEmail || "",
      customerPhone,
      clientEmail: toEmail || payload.customerEmail || state.customerEmail || "",
      clientPhone: customerPhone,
      location: projectAddress,
      marketLine: branding.marketLine || payload.marketLine || "",
      messageText: messageWithLink,
      publicQuoteUrl,
      totalAmount: rowTotal,
      totalFormatted: H.formatUsd(rowTotal),
      depositRequired: rowDeposit,
      depositFormatted: H.formatUsd(rowDeposit),
      estimateNumber: quoteNumberDisplay || payload.estimateNumber || state.estimateNumber || ""
    };

    console.log("PDF payload before rebuild", {
      pdfPayloadBusinessName: pdfPayloadWithLink.businessName,
      pdfPayloadBizName: pdfPayloadWithLink.bizName,
      pdfPayloadCompanyName: pdfPayloadWithLink.companyName,
      pdfPayloadTenantName: pdfPayloadWithLink.tenantName
    });

    const rebuiltPdf = await H.buildEstimatePdfPayload(pdfPayloadWithLink);

    if (!rebuiltPdf || !rebuiltPdf.contentBase64) {
      console.error("PDF rebuild failed — tenant data not applied");
      throw new Error("PDF generation failed after publish");
    }

    const clientName = toName || payload.clientName || state.clientName || "";
    const clientEmail = toEmail || payload.customerEmail || state.customerEmail || "";
    const projectName = payload.projectName || state.projectName || "";
    const publicToken = publishData.public_token;

    const zapierPayload = {
      toName: clientName,
      toEmail: clientEmail,
      projectName,
      subject,
      publicToken,
      publicQuoteUrl,
      salesRepInitials,
      messageLanguage: "bilingual",
      messageText: messageWithLink,
      scopeOfWork: payload.scopeSummary || scope,
      depositRequired,
      clientName: clientName,
      location: projectAddress,
      businessName:
        (!H.isInvalidPublishBusinessNameCandidate(savedName) ? savedName : "") ||
        H.resolvePublishBusinessName(branding, payload, settings) ||
        "",
      businessPhone:
        savedPhone || branding.businessPhone || payload.businessPhone || settings.businessPhone || settings.phone || "",
      businessEmail:
        savedEmail || branding.businessEmail || payload.businessEmail || settings.businessEmail || settings.email || "",
      businessAddress:
        savedAddr ||
        branding.businessAddress ||
        payload.businessAddress ||
        settings.businessAddress ||
        settings.address ||
        settings.companyAddress ||
        "",
      accentHex: branding.accentHex || payload.accentHex || "#8f8a5f",
      accentRgb: H.hexToRgbTuple(branding.accentHex || payload.accentHex || "#8f8a5f", [143, 138, 95]),
      serviceLine: branding.serviceLine || payload.serviceLine || "Professional Service Estimate",
      marketLine: branding.marketLine || payload.marketLine || "",
      signatureLine: branding.signatureLine || payload.signatureLine || "Professional Estimate Delivery",
      currency: "USD",
      recommendedTotal: rowTotal,
      estimateNumber: quoteNumberDisplay || payload.estimateNumber || state.estimateNumber || "",
      issueDate: payload.issueDate || state.issueDate || "",
      expirationDate: payload.expirationDate || state.expirationDate || "",
      customerPhone,
      quoteId: publishData.quote_id,
      pdfFileName: rebuiltPdf.fileName || "",
      pdfMimeType: rebuiltPdf.mimeType || "application/pdf",
      pdfBase64: rebuiltPdf.contentBase64 || ""
    };

    console.log("ZAPIER BODY", zapierPayload);

    const response = await fetch("/.netlify/functions/send-quote-zapier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(zapierPayload)
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_e) {}

    if (!response.ok) {
      throw new Error(data.error || raw || "Unable to send estimate.");
    }

    return {
      publishData,
      publicQuoteUrl,
      messageWithLink,
      rebuiltPdf,
      zapierPayload
    };
  }

  function registerEstimateSendHelpers(helpers) {
    registeredHelpers = helpers;
    window.__MG_ESTIMATE_SEND_HELPERS__ = helpers;
  }

  window.MarginGuardEstimatePublicSend = {
    runPublicQuoteSendPipeline,
    registerEstimateSendHelpers
  };
})();
