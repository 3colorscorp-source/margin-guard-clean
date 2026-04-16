/**
 * Structured ops logs for Netlify Functions (filter: mg_ops === true).
 * Do not pass secrets, full emails, base64, or raw webhook URLs — only IDs and short details.
 */

const DETAIL_MAX = 400;
const TOKEN_PREFIX_LEN = 12;

function makeReqId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function truncatePublicToken(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length <= TOKEN_PREFIX_LEN ? s : `${s.slice(0, TOKEN_PREFIX_LEN)}…`;
}

function truncateDetail(value) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  if (s.length <= DETAIL_MAX) return s;
  return `${s.slice(0, DETAIL_MAX)}…`;
}

/**
 * @param {object} entry
 * @param {string} entry.req_id
 * @param {string} entry.fn
 * @param {string} entry.event
 * @param {"info"|"warn"|"error"} entry.level
 * @param {"ok"|"fail"|"warn"} entry.outcome
 * @param {string|null} [entry.tenant_id]
 * @param {string|null} [entry.quote_id]
 * @param {string|null} [entry.public_token] already truncated or short id
 * @param {number|null} [entry.http_status]
 * @param {string|null} [entry.detail]
 */
function logOps(entry) {
  const payload = {
    mg_ops: true,
    req_id: entry.req_id,
    fn: entry.fn,
    event: entry.event,
    level: entry.level,
    outcome: entry.outcome
  };
  if (entry.tenant_id != null && entry.tenant_id !== "") {
    payload.tenant_id = String(entry.tenant_id);
  }
  if (entry.quote_id != null && entry.quote_id !== "") {
    payload.quote_id = String(entry.quote_id);
  }
  if (entry.public_token != null && entry.public_token !== "") {
    payload.public_token = String(entry.public_token);
  }
  if (entry.http_status != null && Number.isFinite(Number(entry.http_status))) {
    payload.http_status = Number(entry.http_status);
  }
  const detail = truncateDetail(entry.detail);
  if (detail) payload.detail = detail;

  const line = JSON.stringify(payload);
  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  makeReqId,
  logOps,
  truncatePublicToken,
  truncateDetail
};
