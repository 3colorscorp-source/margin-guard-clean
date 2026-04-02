const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime. Set Netlify's Node version to 18+.");
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || "https://yaagobzgozzozibublmj.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

async function ensureBucket(bucketName) {
  const { url, key } = getSupabaseConfig();
  const response = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      id: bucketName,
      name: bucketName,
      public: true,
      allowed_mime_types: ['application/pdf']
    })
  });

  if (response.ok || response.status === 409) return;

  const text = await response.text();
  const alreadyExists =
    response.status === 409 ||
    text.includes('"statusCode":"409"') ||
    text.includes('"statusCode":409') ||
    text.includes('Duplicate') ||
    text.includes('The resource already exists');

  if (alreadyExists) return;

  throw new Error(`Unable to ensure PDF bucket: ${text}`);
}

async function uploadPdfToSupabase({ base64, fileName, estimateNumber }) {
  if (!base64 || !fileName) return null;
  const { url, key } = getSupabaseConfig();
  const bucketName = 'estimate-pdfs';
  await ensureBucket(bucketName);

  const safeName = String(fileName || `Estimate-${estimateNumber || Date.now()}.pdf`)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || `Estimate-${Date.now()}.pdf`;
  const filePath = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${safeName}`;
  const objectPath = filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
  const bytes = Buffer.from(base64, 'base64');

  const uploadResponse = await fetch(`${url}/storage/v1/object/${bucketName}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true'
    },
    body: bytes
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Unable to upload estimate PDF: ${text}`);
  }

  return `${url}/storage/v1/object/public/${bucketName}/${filePath}`;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
    const webhook = process.env.ZAPIER_WEBHOOK_URL;
    if (!webhook) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing env ZAPIER_WEBHOOK_URL' }) };
    }

    const body = JSON.parse(event.body || '{}');
    body.depositRequired = 1000;
    if (typeof body.salesRepInitials === 'string') body.salesRepInitials = body.salesRepInitials.trim().slice(0, 6);

    try {
      const pdfUrl = await uploadPdfToSupabase({
        base64: body.pdfBase64,
        fileName: body.pdfFileName,
        estimateNumber: body.estimateNumber
      });
      if (pdfUrl) body.pdfUrl = pdfUrl;
    } catch (pdfError) {
      body.pdfUploadError = pdfError.message;
    }

    const resp = await fetch(webhook, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });
    if(!resp.ok){
      const t = await resp.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Zapier error: ' + t }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok:true, pdfUrl: body.pdfUrl || null, pdfUploadError: body.pdfUploadError || null }) };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
