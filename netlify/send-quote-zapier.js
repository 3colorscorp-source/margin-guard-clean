// Netlify Functions run on modern Node (18+), which includes a global `fetch`.
// Using the built-in fetch avoids needing external deps (e.g., node-fetch) that
// would otherwise require a package.json + install step and can cause build failures.
const fetch = globalThis.fetch;
if (!fetch) {
  throw new Error("Global fetch is not available in this runtime. Set Netlify's Node version to 18+.");
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== "POST"){
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    const webhook = process.env.ZAPIER_WEBHOOK_URL;
    if(!webhook){
      return { statusCode: 500, body: "Missing env ZAPIER_WEBHOOK_URL" };
    }
    const body = JSON.parse(event.body || "{}");
    // Enforzar depósito fijo: siempre $1,000
    body.depositRequired = 1000;
    if (typeof body.salesRepInitials === "string") body.salesRepInitials = body.salesRepInitials.trim().slice(0, 6);
    const resp = await fetch(webhook, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    if(!resp.ok){
      const t = await resp.text();
      return { statusCode: 502, body: "Zapier error: " + t };
    }
    return { statusCode: 200, body: JSON.stringify({ok:true}) };
  }catch(err){
    return { statusCode: 500, body: "Server error: " + err.message };
  }
};
