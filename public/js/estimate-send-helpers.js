(function () {
  "use strict";
  function safeTrim(value) {
    return String(value == null ? "" : value).trim();
  }
  const INVALID_PUBLISH_BUSINESS_TOKENS = new Set([
    "gmail", "googlemail", "yahoo", "ymail", "outlook", "hotmail", "live", "msn",
    "icloud", "aol", "protonmail", "proton", "zoho", "fastmail", "gmx", "yandex", "hey"
  ]);
  function looksLikePublishEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }
  function isInvalidPublishBusinessNameCandidate(value) {
    const t = safeTrim(value);
    if (!t) return true;
    if (/^business$/i.test(t)) return true;
    if (t.includes("@") || looksLikePublishEmail(t)) return true;
    if (INVALID_PUBLISH_BUSINESS_TOKENS.has(t.toLowerCase())) return true;
    return false;
  }
  function resolvePublishBusinessName(branding, payload, settings) {
    const b = branding && typeof branding === "object" ? branding : {};
    const p = payload && typeof payload === "object" ? payload : {};
    const s = settings && typeof settings === "object" ? settings : {};
    const candidates = [
      b.businessName, b.business_name, p.businessName, p.business_name,
      s.bizName, s.businessName, s.business_name, s.companyName, s.company_name
    ];
    for (const c of candidates) {
      if (!isInvalidPublishBusinessNameCandidate(c)) return safeTrim(c);
    }
    return "";
  }
  function hexToRgbTuple(value, fallback) {
    const clean = safeTrim(value).replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  }
  function formatUsd(amount) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount || 0));
  }

  async function buildEstimatePdfPayload(data) {
  const jspdf = window.jspdf;
  if (!jspdf?.jsPDF) return null;

  const doc = new jspdf.jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const left = 40;
  const right = pageWidth - 40;
  const contentWidth = right - left;
  const top = 50;
  const bottom = 48;

  const textDark = [0, 0, 0];
  const textMuted = [55, 65, 81];
  const lineSoft = [156, 163, 175];
  const panelFill = [255, 255, 255];
  const buttonFill = [37, 99, 235];
  const buttonFillGreen = [22, 163, 74];

  /** Tenant / business identity only — never use generic data.email, data.phone, or data.address (client fields). */
  function pickTenantString(...candidates) {
    for (let i = 0; i < candidates.length; i += 1) {
      const v = candidates[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
    return '';
  }

  const branding =
    data.branding && typeof data.branding === 'object' ? data.branding : null;
  const settings =
    data.settings && typeof data.settings === 'object' ? data.settings : null;

  const businessName = String(
    data.businessName ||
      data.business_name ||
      data.bizName ||
      data.biz_name ||
      data.company_name ||
      data.companyName ||
      (data.branding &&
        (data.branding.businessName ||
          data.branding.business_name ||
          data.branding.bizName ||
          data.branding.biz_name ||
          data.branding.company_name ||
          data.branding.companyName)) ||
      (data.settings &&
        (data.settings.businessName ||
          data.settings.business_name ||
          data.settings.bizName ||
          data.settings.biz_name ||
          data.settings.company_name ||
          data.settings.companyName)) ||
      data.tenantName ||
      data.tenant_name ||
      'Business Name'
  ).trim();

  const blockedGenericBusinessNames = new Set([
    'gmail',
    'yahoo',
    'outlook',
    'hotmail',
    'icloud',
    'mail'
  ]);

  let safeBusinessName = String(businessName || '').trim();

  if (blockedGenericBusinessNames.has(safeBusinessName.toLowerCase())) {
    const fallbackBusinessName = String(
      (data.settings &&
        (data.settings.bizName ||
          data.settings.biz_name ||
          data.settings.businessName ||
          data.settings.business_name ||
          data.settings.companyName ||
          data.settings.company_name)) ||
        (data.branding &&
          (data.branding.bizName ||
            data.branding.biz_name ||
            data.branding.businessName ||
            data.branding.business_name ||
            data.branding.companyName ||
            data.branding.company_name)) ||
        'Business Name'
    ).trim();

    if (fallbackBusinessName) {
      safeBusinessName = fallbackBusinessName;
    }
  }

  const preparedBy = pickTenantString(
    data.preparedBy,
    data.prepared_by,
    branding?.email_signature_name,
    branding?.preparedBy,
    branding?.prepared_by,
    settings?.email_signature_name,
    settings?.preparedBy,
    settings?.prepared_by
  );

  const businessPhone = pickTenantString(
    data.businessPhone,
    data.business_phone,
    data.bizPhone,
    data.biz_phone,
    branding?.businessPhone,
    branding?.business_phone,
    branding?.bizPhone,
    branding?.biz_phone,
    branding?.phone,
    branding?.contact_phone,
    settings?.businessPhone,
    settings?.business_phone,
    settings?.bizPhone,
    settings?.biz_phone,
    settings?.phone
  );

  const businessEmail = pickTenantString(
    data.businessEmail,
    data.business_email,
    data.bizEmail,
    data.biz_email,
    branding?.businessEmail,
    branding?.business_email,
    branding?.bizEmail,
    branding?.biz_email,
    branding?.email,
    branding?.support_email,
    branding?.contact_email,
    branding?.reply_to_email,
    settings?.businessEmail,
    settings?.business_email,
    settings?.bizEmail,
    settings?.biz_email,
    settings?.email
  );

  const businessServiceArea = pickTenantString(
    data.businessServiceArea,
    data.business_service_area,
    data.businessAddress,
    data.business_address,
    data.bizAddress,
    data.biz_address,
    data.company_address,
    branding?.businessAddress,
    branding?.business_address,
    branding?.bizAddress,
    branding?.biz_address,
    branding?.address,
    branding?.mailing_address,
    branding?.office_address,
    settings?.businessAddress,
    settings?.business_address,
    settings?.bizAddress,
    settings?.biz_address,
    settings?.address,
    settings?.companyAddress
  );

  const businessAddress = pickTenantString(
    data.businessAddress,
    data.business_address,
    data.bizAddress,
    data.biz_address,
    branding?.businessAddress,
    branding?.business_address,
    branding?.bizAddress,
    branding?.biz_address,
    settings?.businessAddress,
    settings?.business_address,
    settings?.bizAddress,
    settings?.biz_address,
    settings?.address,
    settings?.companyAddress
  );

  const clientName = String(
    data.clientName ||
    data.client_name ||
    data.customer_name ||
    ''
  ).trim();

  const projectName = String(
    data.projectName ||
    data.project_name ||
    ''
  ).trim();

  const projectAddress = String(
    data.projectAddress ||
    data.project_address ||
    data.location ||
    ''
  ).trim();

  const clientPhone = String(
    data.clientPhone ||
    data.client_phone ||
    data.customerPhone ||
    ''
  ).trim();

  const clientEmail = String(
    data.clientEmail ||
    data.client_email ||
    data.customerEmail ||
    data.customer_email ||
    ''
  ).trim();

  const estimateNo = String(
    data.estimateNumber ||
    data.estimate_no ||
    data.quoteNumber ||
    data.quote_number ||
    data.id ||
    ''
  ).trim();

  const preparedOn = String(
    data.preparedOn ||
    data.prepared_on ||
    data.sentOn ||
    data.sent_on ||
    data.created_at_formatted ||
    ''
  ).trim();

  const validThrough = String(
    data.validThrough ||
    data.valid_through ||
    data.expires_on ||
    data.expiresOn ||
    ''
  ).trim();

  const totalAmtNum = Number(
    data.totalAmount ??
    data.total_amount ??
    data.total ??
    0
  );

  const depositAmtNum = Number(
    data.depositRequired ??
    data.deposit_required ??
    data.deposit ??
    0
  );

  const balanceAmtNum = Math.max(0, totalAmtNum - depositAmtNum);

  const money = (n) => {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(Number(n || 0));
    } catch (_e) {
      return `$${Number(n || 0).toFixed(2)}`;
    }
  };

  const fullAmount = String(data.totalFormatted || money(totalAmtNum)).trim();
  const depositAmount = String(data.depositFormatted || money(depositAmtNum)).trim();
  const balanceAfterDeposit = money(balanceAmtNum);

  const scopeItems = (() => {
    const raw =
      data.scopeItems ||
      data.scope_of_work ||
      data.scopeOfWork ||
      data.scopeSummary ||
      data.scope_summary ||
      data.projectNotes ||
      data.quoteNotes ||
      data.notes ||
      data.messageText ||
      data.message_to_client ||
      '';

    if (Array.isArray(raw)) {
      return raw.map(v => String(v || '').trim()).filter(Boolean);
    }

    return String(raw || '')
      .split(/\r?\n+/)
      .map(v => v.replace(/^[\-\u2022\s]+/, '').trim())
      .filter(Boolean);
  })();

  const approvePayUrl = String(
    data.payment_link ||
    data.paymentLink ||
    data.publicQuoteUrl ||
    data.public_quote_url ||
    ''
  ).trim();

  const publicQuoteUrl = String(
    data.publicQuoteUrl ||
    data.public_quote_url ||
    ''
  ).trim();

  function appendStepToPublicQuoteUrl(url, stepNum) {
    const u = String(url || '').trim();
    if (!u) return '';
    const sn = String(stepNum);
    try {
      const base = /^https?:\/\//i.test(u) ? u : new URL(u, window.location.origin).href;
      const parsed = new URL(base);
      parsed.searchParams.set('step', sn);
      if (/^https?:\/\//i.test(u)) return parsed.href;
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (_e) {
      const noHash = u.replace(/#.*$/, '');
      const sep = noHash.includes('?') ? '&' : '?';
      return `${noHash}${sep}step=${encodeURIComponent(sn)}`;
    }
  }

  const exclusionsInitialsUrl = String(
    data.exclusionsInitialsUrl ||
    data.exclusions_initials_url ||
    (publicQuoteUrl ? appendStepToPublicQuoteUrl(publicQuoteUrl, 2) : '')
  ).trim();

  const addonRequestUrl = String(
    data.addonRequestUrl ||
    data.add_on_request_url ||
    (publicQuoteUrl ? appendStepToPublicQuoteUrl(publicQuoteUrl, 3) : '')
  ).trim();

  let y = top;

  function ensureSpace(heightNeeded) {
    if (y + heightNeeded <= pageHeight - bottom) return;
    doc.addPage();
    y = top;
  }

  function drawSectionTitle(title) {
    ensureSpace(28);
    doc.setTextColor(...textDark);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(String(title || '').toUpperCase(), left, y);
    y += 6;
    doc.setDrawColor(...lineSoft);
    doc.setLineWidth(0.75);
    doc.line(left, y, right, y);
    y += 18;
  }

  function drawWrapped(text, x, width, opts = {}) {
    const font = opts.font || 'helvetica';
    const style = opts.style || 'normal';
    const size = opts.size || 10.5;
    const leading = opts.leading || 14;
    const color = opts.color || textDark;

    doc.setFont(font, style);
    doc.setFontSize(size);
    doc.setTextColor(...color);

    const lines = doc.splitTextToSize(String(text || ''), width);
    ensureSpace(lines.length * leading + 4);
    doc.text(lines, x, y);
    y += lines.length * leading;
    return lines.length;
  }

  function drawBullets(items, x, width) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...textDark);

    items.forEach((item) => {
      const lines = doc.splitTextToSize(`- ${String(item || '').trim()}`, width);
      ensureSpace(lines.length * 14 + 4);
      doc.text(lines, x, y);
      y += lines.length * 14 + 2;
    });
  }

  function drawCtaButton(x, topY, w, h, label, url, fillColor) {
    doc.setFillColor(...fillColor);
    doc.rect(x, topY, w, h, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(label, x + w / 2, topY + 15, { align: 'center' });
    if (url) {
      try {
        doc.link(x, topY, w, h, { url });
      } catch (_e) {}
    }
  }

  console.log('PDF final header businessName', {
    businessName,
    safeBusinessName,
    directBusinessName: data.businessName,
    directBizName: data.bizName,
    directCompanyName: data.companyName,
    directTenantName: data.tenantName
  });

  // =========================
  // PAGE 1 — QUOTE / PROPOSAL
  // =========================
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(...textDark);
  doc.text(safeBusinessName || 'Business Name', left, y);

  const subY = y + 24;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(...textMuted);
  doc.text('Professional Tile Installation Proposal', left, subY);

  const bizLines = [];
  if (preparedBy) {
    bizLines.push(`Prepared by: ${preparedBy}`);
  }
  if (businessPhone) {
    bizLines.push(`Phone: ${businessPhone}`);
  }
  if (businessEmail) {
    bizLines.push(`Email: ${businessEmail}`);
  }
  const locationLine = businessServiceArea || businessAddress;

  if (locationLine) {
    bizLines.push(`Address: ${locationLine}`);
  }

  let bizY = subY + 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...textDark);

  bizLines.forEach((line) => {
    doc.text(line, left, bizY);
    bizY += 14;
  });

  const rightX = pageWidth * 0.58;
  let rightY = y + 6;

  [
    clientName ? `Client: ${clientName}` : '',
    projectName ? `Project: ${projectName}` : '',
    projectAddress ? `Project Address: ${projectAddress}` : '',
    clientPhone ? `Client Phone: ${clientPhone}` : '',
    clientEmail ? `Client Email: ${clientEmail}` : ''
  ].filter(Boolean).forEach((line) => {
    doc.text(line, rightX, rightY);
    rightY += 14;
  });

  rightY += 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('QUOTE DETAILS', rightX, rightY);
  rightY += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  [
    estimateNo ? `Estimate No: ${estimateNo}` : '',
    preparedOn ? `Prepared On: ${preparedOn}` : '',
    validThrough ? `Valid Through: ${validThrough}` : ''
  ].filter(Boolean).forEach((line) => {
    doc.text(line, rightX, rightY);
    rightY += 14;
  });

  const headerBottom = Math.max(bizY, rightY) + 8;
  doc.setDrawColor(...lineSoft);
  doc.setLineWidth(0.8);
  doc.line(left, headerBottom, right, headerBottom);

  y = headerBottom + 24;

  drawSectionTitle('Scope of Work');
  drawBullets(scopeItems.length ? scopeItems : ['Scope details will appear here.'], left, contentWidth);

  y += 8;
  drawSectionTitle('Project Investment');

  const invTop = y;
  const invH = 110;
  const invLx = left + 12;
  const invRx = right - 12;

  ensureSpace(invH + 24);

  doc.setFillColor(...panelFill);
  doc.setDrawColor(...lineSoft);
  doc.rect(left, invTop, contentWidth, invH, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...textMuted);
  doc.text('FULL AMOUNT', invLx, invTop + 14);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(...textDark);
  doc.text(fullAmount, invRx, invTop + 30, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...textMuted);
  doc.text('DEPOSIT', invLx, invTop + 44);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(...textDark);
  doc.text(depositAmount, invRx, invTop + 60, { align: 'right' });

  doc.setDrawColor(...lineSoft);
  doc.line(invLx, invTop + 70, invRx, invTop + 70);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...textMuted);
  doc.text('BALANCE AFTER DEPOSIT', invLx, invTop + 84);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(...textDark);
  doc.text(balanceAfterDeposit, invRx, invTop + 100, { align: 'right' });

  y = invTop + invH + 10;

  drawSectionTitle('Next Step');
  drawWrapped(
    'To secure your project schedule, approve this proposal and complete the initial deposit.',
    left,
    contentWidth
  );
  y += 14;

  if (approvePayUrl) {
    const btnLabel = 'APPROVE PROJECT & PAY DEPOSIT';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const textW = doc.getTextWidth(btnLabel);
    const btnW = textW + 36;
    const btnH = 24;
    const btnX = left + (contentWidth - btnW) / 2;
    const btnY = y;

    drawCtaButton(btnX, btnY, btnW, btnH, btnLabel, approvePayUrl, buttonFill);
  }

  // =========================
  // PAGE 2 — EXCLUSIONS
  // =========================
  doc.addPage();
  y = 60;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...textDark);
  doc.text('SCOPE CLARIFICATIONS & EXCLUSIONS', pageWidth / 2, y, { align: 'center' });
  y += 28;

  const exclusionsIntro =
    'This proposal includes only the work specifically described in the written Scope of Work. Any labor, materials, repairs, corrections, finishes, demolition, preparation, hauling, waterproofing, framing, plumbing, electrical, or additional work not explicitly written in this proposal is not included unless added by written change order.';

  drawWrapped(exclusionsIntro, left, contentWidth);
  y += 14;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...textDark);
  doc.text('EXCLUSIONS', left, y);
  y += 18;

  drawBullets([
    'Any work not specifically written in the Scope of Work',
    'Hidden conditions behind walls, floors, or existing finishes',
    'Repairs to framing, plumbing, electrical, or structural issues unless written',
    'Additional prep discovered after demolition unless written',
    'Material upgrades, design changes, or layout changes unless written',
    'Haul-away, patching, painting, texture, or finish work unless written',
    'Waterproofing, membranes, trims, niches, specialty cuts, or custom details unless written',
    'Permit fees, inspections, engineering, or third-party costs unless written',
    'Any assumption by client or contractor not supported in writing'
  ], left, contentWidth);

  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...textDark);
  doc.text('ACKNOWLEDGMENT', left, y);
  y += 18;

  drawWrapped(
    'Client acknowledges that only the written scope is included. No additional work should be assumed unless it is clearly written in this proposal or added by signed change order.',
    left,
    contentWidth
  );
  y += 22;

  const boxX = left;
  const boxY = y;
  const boxW = contentWidth;
  const boxH = 98;

  doc.setDrawColor(...textDark);
  doc.setLineWidth(1);
  doc.rect(boxX, boxY, boxW, boxH);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...textDark);
  doc.text('CLIENT ACKNOWLEDGMENT REQUIRED', pageWidth / 2, boxY + 20, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const calloutLines = doc.splitTextToSize(
    'To confirm understanding of scope exclusions and non-included work, review and initial digitally using the secure link below.',
    boxW - 36
  );
  doc.text(calloutLines, boxX + 18, boxY + 40);

  if (exclusionsInitialsUrl) {
    const btn2Label = 'REVIEW EXCLUSIONS & INITIAL DIGITALLY';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const textW2 = doc.getTextWidth(btn2Label);
    const btn2W = textW2 + 40;
    const btn2H = 24;
    const btn2X = left + (contentWidth - btn2W) / 2;
    const btn2Y = boxY + 64;

    drawCtaButton(btn2X, btn2Y, btn2W, btn2H, btn2Label, exclusionsInitialsUrl, buttonFill);
  }

  // =========================
  // PAGE 3 — ADDITIONAL WORK
  // =========================
  doc.addPage();
  y = 60;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...textDark);
  doc.text('REQUEST ADDITIONAL WORK', pageWidth / 2, y, { align: 'center' });
  y += 28;

  drawWrapped(
    'If you would like to add work to your current project, please submit your request using the secure link below. All requests will be reviewed by the project supervisor or business owner before any work is approved.',
    left,
    contentWidth
  );
  y += 16;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...textDark);
  doc.text('HOW IT WORKS', left, y);
  y += 18;

  drawBullets([
    'Submit your request with a clear description of the additional work',
    'Our team will review feasibility and scope',
    'You will receive a separate quote or add-on proposal',
    'No additional work will begin without written approval'
  ], left, contentWidth);

  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...textDark);
  doc.text('IMPORTANT', left, y);
  y += 18;

  drawWrapped(
    'All additional work must be approved through a separate written quote. Verbal requests or assumptions will not be considered part of the original agreement.',
    left,
    contentWidth
  );
  y += 24;

  if (addonRequestUrl) {
    const btn3Label = 'SUBMIT ADDITIONAL WORK REQUEST';
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    const textW3 = doc.getTextWidth(btn3Label);
    const btn3W = textW3 + 42;
    const btn3H = 26;
    const btn3X = left + (contentWidth - btn3W) / 2;
    const btn3Y = y;

    drawCtaButton(btn3X, btn3Y, btn3W, btn3H, btn3Label, addonRequestUrl, buttonFillGreen);
  }

  const base64 = doc.output('datauristring').split(',')[1];
  return {
    fileName: `Estimate-${estimateNo || 'Quote'}.pdf`,
    mimeType: 'application/pdf',
    contentBase64: base64
  };
}
  function pickFirstNonEmpty(...candidates) {
    for (let i = 0; i < candidates.length; i += 1) {
      const v = candidates[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
    return '';
  }
  function buildEstimateTenantPayload(branding, settings, base) {
    const b = branding && typeof branding === 'object' ? branding : {};
    const s = settings && typeof settings === 'object' ? settings : {};
    const e = base && typeof base === 'object' ? base : {};

    const businessName = pickFirstNonEmpty(
      b.businessName,
      b.business_name,
      b.bizName,
      b.biz_name,
      b.companyName,
      b.company_name,
      s.businessName,
      s.business_name,
      s.bizName,
      s.biz_name,
      s.companyName,
      s.company_name,
      e.businessName,
      e.business_name,
      e.bizName,
      e.companyName,
      e.company_name,
      ''
    );

    const businessPhone = pickFirstNonEmpty(
      b.businessPhone,
      b.business_phone,
      b.bizPhone,
      b.biz_phone,
      b.phone,
      b.contact_phone,
      s.businessPhone,
      s.business_phone,
      s.bizPhone,
      s.biz_phone,
      s.phone,
      e.businessPhone,
      e.business_phone
    );

    const businessEmail = pickFirstNonEmpty(
      b.businessEmail,
      b.business_email,
      b.bizEmail,
      b.biz_email,
      b.email,
      b.support_email,
      b.contact_email,
      b.reply_to_email,
      s.businessEmail,
      s.business_email,
      s.bizEmail,
      s.biz_email,
      s.email,
      e.businessEmail,
      e.business_email
    );

    const businessAddress = pickFirstNonEmpty(
      b.businessAddress,
      b.business_address,
      b.bizAddress,
      b.biz_address,
      b.mailing_address,
      b.office_address,
      s.businessAddress,
      s.business_address,
      s.bizAddress,
      s.biz_address,
      s.address,
      s.companyAddress,
      e.businessAddress,
      e.business_address
    );

    const businessServiceArea = pickFirstNonEmpty(
      b.businessServiceArea,
      b.business_service_area,
      b.service_area,
      s.businessServiceArea,
      s.business_service_area,
      s.service_area,
      e.businessServiceArea,
      businessAddress,
      e.businessAddress
    );

    const preparedBy = pickFirstNonEmpty(
      b.preparedBy,
      b.prepared_by,
      b.email_signature_name,
      s.preparedBy,
      s.prepared_by,
      s.email_signature_name,
      e.preparedBy,
      e.prepared_by,
      e.email_signature_name
    );

    const serviceLine = pickFirstNonEmpty(
      b.serviceLine,
      b.service_line,
      s.serviceLine,
      s.service_line,
      e.serviceLine
    );

    const signatureLine = pickFirstNonEmpty(
      b.signatureLine,
      b.signature_line,
      s.signatureLine,
      s.signature_line,
      e.signatureLine
    );

    const accentHex =
      pickFirstNonEmpty(
        b.accentHex,
        b.accent_color,
        s.publicAccentColor,
        s.accentHex,
        e.accentHex
      ) || '#8f8a5f';

    const accentRgb = hexToRgbTuple(accentHex, [143, 138, 95]);

    return {
      businessName,
      businessPhone,
      businessEmail,
      businessAddress,
      businessServiceArea,
      preparedBy,
      serviceLine: serviceLine || 'Professional Service Estimate',
      signatureLine: signatureLine || 'Professional Estimate Delivery',
      accentHex,
      accentRgb
    };
  }

  window.__MG_ESTIMATE_SEND_HELPERS__ = {
    buildEstimatePdfPayload,
    buildEstimateTenantPayload,
    formatUsd,
    resolvePublishBusinessName,
    hexToRgbTuple,
    isInvalidPublishBusinessNameCandidate
  };
})();
