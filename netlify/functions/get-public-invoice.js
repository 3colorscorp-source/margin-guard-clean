const { supabaseRequest } = require("./_lib/supabase-admin");
const { loadTenantDisplayForTenantId, pickFirst } = require("./_lib/tenant-display");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

/** Columns required by public/invoice-public.html only — no ids or tenant fields. */
const INVOICE_SELECT = [
  "business_name",
  "status",
  "currency",
  "amount",
  "paid_amount",
  "balance_due",
  "accent_color",
  "logo_url",
  "payment_link",
  "invoice_no",
  "due_date",
  "customer_name",
  "customer_email",
  "project_name",
  "invoice_label",
  "issue_date",
  "type",
  "notes"
].join(",");
const INVOICE_INTERNAL_SELECT = "id,tenant_id,quote_id,project_id";

const INVOICE_NUMERIC_KEYS = new Set(["amount", "paid_amount", "balance_due"]);
const SOURCE_INVOICE_RE =
  /\[source_invoice:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/i;
const PROJECT_PAYMENT_CHILD_LABELS = new Set([
  "start payment",
  "progress payment",
  "final payment",
  "remaining balance",
  "change order"
]);

function invoiceLabelLower(row) {
  return String(row?.invoice_label || "").trim().toLowerCase();
}

function invoiceNotesText(row) {
  return String(row?.notes || "");
}

function isMaterialCostInvoiceRow(row) {
  const label = invoiceLabelLower(row);
  const notes = invoiceNotesText(row);
  return label === "material cost" || notes.includes("[invoice_type:unexpected_material_cost]");
}

function isChangeOrderInvoiceRow(row) {
  return invoiceLabelLower(row) === "change order";
}

function isProjectPaymentChildRow(row) {
  if (!row || isMaterialCostInvoiceRow(row)) return false;
  if (PROJECT_PAYMENT_CHILD_LABELS.has(invoiceLabelLower(row))) return true;
  return SOURCE_INVOICE_RE.test(invoiceNotesText(row));
}

function isPublicParentFolderCandidate(row) {
  if (!row) return false;
  if (isMaterialCostInvoiceRow(row)) return false;
  if (isChangeOrderInvoiceRow(row)) return false;
  if (isProjectPaymentChildRow(row)) return false;
  return true;
}

/** Normalize tenant branding logo for public clients (absolute http(s), never scheme-relative). */
function normalizePublicLogoUrl(value) {
  let s = String(value ?? "").trim();
  if (!s) return "";
  if (s.startsWith("//")) s = `https:${s}`;
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch (_e) {
    /* ignore */
  }
  return "";
}

function pickPublicInvoiceFields(row) {
  const keys = INVOICE_SELECT.split(",");
  const out = {};
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) {
      continue;
    }
    const v = row[k];
    if (INVOICE_NUMERIC_KEYS.has(k)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : 0;
      continue;
    }
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method Not Allowed" });
    }

    const raw = event.queryStringParameters?.token;
    if (raw === undefined || raw === null) {
      return json(400, { error: "Missing token" });
    }
    const trimmed = String(raw).trim();
    if (trimmed === "") {
      return json(400, { error: "Missing token" });
    }
    if (trimmed.length < 10 || trimmed.length > 256) {
      return json(400, { error: "Invalid token" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return json(400, { error: "Invalid token" });
    }

    const path = `invoices?public_token=eq.${encodeURIComponent(trimmed)}&tenant_id=not.is.null&select=${INVOICE_SELECT},${INVOICE_INTERNAL_SELECT}&limit=2`;

    let rows;
    try {
      rows = await supabaseRequest(path, { method: "GET" });
    } catch (err) {
      return json(502, { error: err.message || "Failed to read invoice" });
    }

    if (!Array.isArray(rows)) {
      return json(502, { error: "Unexpected response" });
    }

    if (rows.length === 0) {
      return json(404, { error: "Invoice not found" });
    }

    if (rows.length > 1) {
      return json(500, { error: "Invalid invoice reference" });
    }

    const rawRow = rows[0] || {};
    const invoice = pickPublicInvoiceFields(rawRow);
    const tenantId = String(rawRow.tenant_id || "").trim();
    const invoiceId = String(rawRow.id || "").trim();
    const quoteId = String(rawRow.quote_id || "").trim();
    const projectId = String(rawRow.project_id || "").trim();

    const invoiceAmount = Number.isFinite(Number(rawRow.amount)) ? Number(rawRow.amount) : 0;
    const quoteTotal = await loadQuoteTotal(tenantId, quoteId);
    const projectTotal = await loadProjectTotal(tenantId, projectId);
    const contractTotal =
      quoteTotal > 0 ? quoteTotal : projectTotal > 0 ? projectTotal : Math.max(invoiceAmount, 0);

    const isProjectPaymentInvoice = isProjectPaymentChildRow(rawRow);

    // Project payment children stay on the existing invoice/project-payment path.
    // Parent/root accepted project invoices with a billing group use unique folder paid.
    let paidToDate;
    if (isProjectPaymentInvoice) {
      paidToDate = await loadPaidToDate({
        tenantId,
        projectId,
        quoteId,
        preferProject: true
      });
    } else if (isPublicParentFolderCandidate(rawRow)) {
      const members = await loadPublicBillingGroupMembers({
        tenantId,
        current: rawRow,
        projectId,
        quoteId
      });
      if (Array.isArray(members) && members.length >= 2) {
        paidToDate = await loadUniqueFolderPaidToDate(tenantId, members);
      } else {
        paidToDate = await loadPaidToDate({ tenantId, invoiceId, projectId, quoteId, preferProject: false });
      }
    } else {
      paidToDate = await loadPaidToDate({ tenantId, invoiceId, projectId, quoteId, preferProject: false });
    }
    const remainingBalance = Math.max(contractTotal - paidToDate, 0);

    if (tenantId) {
      try {
        const td = await loadTenantDisplayForTenantId(tenantId);
        const tenantBusinessName = pickFirst(td?.business_name);
        const tenantBusinessEmail = pickFirst(td?.business_email);
        const tenantBusinessPhone = pickFirst(td?.business_phone);
        let tenantBusinessAddress = pickFirst(td?.business_address);
        if (!tenantBusinessAddress) {
          tenantBusinessAddress = await loadTenantBusinessAddressFromSnapshot(tenantId);
        }
        if (tenantBusinessName) {
          invoice.business_name = tenantBusinessName;
        }
        if (tenantBusinessEmail) {
          invoice.business_email = tenantBusinessEmail;
        }
        if (tenantBusinessPhone) {
          invoice.business_phone = tenantBusinessPhone;
        }
        if (tenantBusinessAddress) {
          invoice.business_address = tenantBusinessAddress;
        }
        const snapshotLogo = normalizePublicLogoUrl(pickFirst(invoice.logo_url));
        const tenantLogo = normalizePublicLogoUrl(pickFirst(td?.logo_url));
        let resolvedLogo = "";
        if (snapshotLogo) {
          resolvedLogo = snapshotLogo;
        } else if (tenantLogo) {
          resolvedLogo = tenantLogo;
        } else {
          resolvedLogo = normalizePublicLogoUrl(await loadTenantLogoFromSnapshot(tenantId));
        }
        if (resolvedLogo) {
          invoice.logo_url = resolvedLogo;
        }
      } catch (_err) {
        /* keep invoice business_name fallback */
      }
    }

    invoice.invoice_amount = invoiceAmount;
    invoice.contract_total = contractTotal;
    invoice.paid_to_date = paidToDate;
    invoice.remaining_balance = remainingBalance;

    const tenantPayment = await loadTenantPublicPaymentSettings(tenantId);

    return json(200, {
      ok: true,
      invoice,
      tenant_payment: tenantPayment,
    });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};

async function loadInvoicesByField(tenantId, field, value) {
  const tid = String(tenantId || "").trim();
  const val = String(value || "").trim();
  if (!tid || !val || (field !== "project_id" && field !== "quote_id")) return [];
  try {
    const rows = await supabaseRequest(
      `invoices?tenant_id=eq.${encodeURIComponent(tid)}&${field}=eq.${encodeURIComponent(val)}&select=id,invoice_label,notes,project_id,quote_id&limit=100`,
      { method: "GET" }
    );
    return Array.isArray(rows) ? rows : [];
  } catch (_err) {
    return [];
  }
}

async function loadPublicBillingGroupMembers({ tenantId, current, projectId, quoteId }) {
  const members = [];
  const seen = new Set();
  const add = (row) => {
    if (!row) return;
    const id = String(row.id || "").trim().toLowerCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    members.push(row);
  };
  add(current);
  const batches = await Promise.all([
    projectId ? loadInvoicesByField(tenantId, "project_id", projectId) : Promise.resolve([]),
    quoteId ? loadInvoicesByField(tenantId, "quote_id", quoteId) : Promise.resolve([])
  ]);
  batches.forEach((rows) => (rows || []).forEach(add));
  return members;
}

async function loadPaymentsForFilter(tenantId, filterKey, filterValue) {
  const tid = String(tenantId || "").trim();
  const val = String(filterValue || "").trim();
  if (!tid || !val) return [];
  if (!["invoice_id", "project_id", "quote_id"].includes(filterKey)) return [];
  try {
    const params = new URLSearchParams();
    params.set("tenant_id", `eq.${tid}`);
    params.set(filterKey, `eq.${val}`);
    params.set("select", "id,amount,invoice_id,paid_at,created_at");
    params.set("limit", "500");
    const rows = await supabaseRequest(`tenant_project_payments?${params.toString()}`, { method: "GET" });
    return Array.isArray(rows) ? rows : [];
  } catch (_err) {
    return [];
  }
}

function uniquePaymentsById(batches) {
  const seen = new Set();
  const out = [];
  (batches || []).forEach((pays) => {
    (pays || []).forEach((p) => {
      const id = p?.id != null ? String(p.id).trim() : "";
      const key = id || [p?.invoice_id, p?.paid_at, p?.amount, p?.created_at].join("|");
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(p);
    });
  });
  return out;
}

function excludedContractInvoiceIds(members) {
  const out = new Set();
  (members || []).forEach((row) => {
    if (!isMaterialCostInvoiceRow(row) && !isChangeOrderInvoiceRow(row)) return;
    const id = String(row?.id || "").trim().toLowerCase();
    if (id) out.add(id);
  });
  return out;
}

function sumContractPaidFromPayments(payments, excludedInvoiceIds) {
  const excluded = excludedInvoiceIds instanceof Set ? excludedInvoiceIds : new Set();
  let sum = 0;
  (payments || []).forEach((p) => {
    const iid = String(p?.invoice_id || "").trim().toLowerCase();
    if (iid && excluded.has(iid)) return;
    const n = Number(p?.amount);
    if (Number.isFinite(n)) sum += n;
  });
  return Math.round(sum * 100) / 100;
}

async function loadUniqueFolderPaidToDate(tenantId, members) {
  const list = Array.isArray(members) ? members : [];
  const jobs = [];
  const invoiceIds = Array.from(
    new Set(list.map((row) => String(row?.id || "").trim()).filter(Boolean))
  );
  invoiceIds.forEach((iid) => jobs.push(loadPaymentsForFilter(tenantId, "invoice_id", iid)));
  const projectIds = Array.from(
    new Set(list.map((row) => String(row?.project_id || "").trim()).filter(Boolean))
  );
  projectIds.forEach((pid) => jobs.push(loadPaymentsForFilter(tenantId, "project_id", pid)));
  const quoteIds = Array.from(
    new Set(list.map((row) => String(row?.quote_id || "").trim()).filter(Boolean))
  );
  quoteIds.forEach((qid) => jobs.push(loadPaymentsForFilter(tenantId, "quote_id", qid)));
  if (!jobs.length) return 0;
  const batches = await Promise.all(jobs);
  const payments = uniquePaymentsById(batches);
  return sumContractPaidFromPayments(payments, excludedContractInvoiceIds(list));
}

async function loadQuoteTotal(tenantId, quoteId) {
  if (!tenantId || !quoteId) return 0;
  try {
    const rows = await supabaseRequest(
      `quotes?id=eq.${encodeURIComponent(quoteId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=total&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const n = Number(row?.total);
    return Number.isFinite(n) ? Math.max(n, 0) : 0;
  } catch (_err) {
    return 0;
  }
}

async function loadProjectTotal(tenantId, projectId) {
  if (!tenantId || !projectId) return 0;
  try {
    const rows = await supabaseRequest(
      `tenant_projects?id=eq.${encodeURIComponent(projectId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&select=sale_price&limit=1`,
      { method: "GET" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const n = Number(row?.sale_price);
    return Number.isFinite(n) ? Math.max(n, 0) : 0;
  } catch (_err) {
    return 0;
  }
}

async function loadTenantPublicPaymentSettings(tenantId) {
  const empty = { payment_instructions: "", payment_link: "" };
  if (!tenantId) return empty;
  try {
    let rows;
    try {
      rows = await supabaseRequest(
        `owner_settings?tenant_id=eq.${encodeURIComponent(tenantId)}&select=payment_instructions,payment_link&limit=1`,
        { method: "GET" }
      );
    } catch (err) {
      const msg = String(err?.message || "");
      if (!/payment_instructions|payment_link|column/i.test(msg)) throw err;
      return empty;
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return empty;
    const instr =
      row.payment_instructions != null ? String(row.payment_instructions).trim().slice(0, 8000) : "";
    let link = row.payment_link != null ? String(row.payment_link).trim().slice(0, 2000) : "";
    if (link && !/^https?:\/\//i.test(link)) link = "";
    return {
      payment_instructions: instr,
      payment_link: link,
    };
  } catch (_err) {
    return empty;
  }
}

async function loadPaidToDate({ tenantId, invoiceId, projectId, quoteId, preferProject = false }) {
  if (!tenantId) return 0;
  const params = new URLSearchParams();
  params.set("tenant_id", `eq.${tenantId}`);
  params.set("select", "amount");
  params.set("limit", "500");
  if (preferProject) {
    if (projectId) params.set("project_id", `eq.${projectId}`);
    else if (quoteId) params.set("quote_id", `eq.${quoteId}`);
    else if (invoiceId) params.set("invoice_id", `eq.${invoiceId}`);
    else return 0;
  } else if (invoiceId) {
    params.set("invoice_id", `eq.${invoiceId}`);
  } else if (projectId) {
    params.set("project_id", `eq.${projectId}`);
  } else if (quoteId) {
    params.set("quote_id", `eq.${quoteId}`);
  } else {
    return 0;
  }
  try {
    const rows = await supabaseRequest(`tenant_project_payments?${params.toString()}`, { method: "GET" });
    const list = Array.isArray(rows) ? rows : [];
    return list.reduce((sum, row) => {
      const n = Number(row?.amount);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  } catch (_err) {
    return 0;
  }
}

async function loadTenantBusinessAddressFromSnapshot(tenantId) {
  if (!tenantId) return "";
  try {
    const payload = await loadLatestTenantSnapshotPayload(tenantId);
    const storage = payload && typeof payload.storage === "object" ? payload.storage : {};
    const mg = storage && typeof storage.mg_settings_v2 === "object" ? storage.mg_settings_v2 : {};
    return pickFirst(
      mg.businessAddress,
      mg.business_address,
      mg.address,
      mg.companyAddress,
      mg.company_address,
      mg.mailing_address
    );
  } catch (_err) {
    return "";
  }
}

async function loadTenantLogoFromSnapshot(tenantId) {
  if (!tenantId) return "";
  try {
    const payload = await loadLatestTenantSnapshotPayload(tenantId);
    const storage = payload && typeof payload.storage === "object" ? payload.storage : {};
    const brand =
      storage && typeof storage.mg_business_branding_v1 === "object" ? storage.mg_business_branding_v1 : {};
    const mg = storage && typeof storage.mg_settings_v2 === "object" ? storage.mg_settings_v2 : {};
    const settings = payload && typeof payload.settings === "object" ? payload.settings : {};
    const branding = payload && typeof payload.branding === "object" ? payload.branding : {};
    return pickFirst(
      brand.logoUrl,
      brand.logo_url,
      mg.publicLogoUrl,
      mg.logo_url,
      settings.publicLogoUrl,
      branding.logoUrl,
      branding.logo_url
    );
  } catch (_err) {
    return "";
  }
}

async function loadLatestTenantSnapshotPayload(tenantId) {
  const rows = await supabaseRequest(
    `tenant_snapshots?tenant_id=eq.${encodeURIComponent(String(tenantId))}&select=payload&order=created_at.desc&limit=1`,
    { method: "GET" }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return row && typeof row.payload === "object" ? row.payload : null;
}
