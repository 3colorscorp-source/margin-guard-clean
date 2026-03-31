const { clearSessionCookie } = require("./_lib/session");

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(),
    },
    body: JSON.stringify({ ok: true }),
  };
};
