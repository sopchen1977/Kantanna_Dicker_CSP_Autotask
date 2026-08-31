// Step one of email OTP sign-in: decide whether this request earns a code,
// and if so, mint one.
//
// The reply is deliberately identical whether or not we would send to this
// address, so the endpoint cannot be used to discover who works at Kantanna.
// `send` decides what the workflow does; `message` is what the caller is
// told, and it never varies.
const crypto = require('crypto');

// Only these domains may sign in. Compared against the part after the LAST
// "@", lowercased, as a WHOLE string. Never endsWith() - that would also
// accept someone@not-kantanna.ph and someone@evil-kantanna.com.
const ALLOWED_DOMAINS = ['kantanna.com', 'kantanna.com.au', 'kantanna.ph'];
const CODE_TTL_MINUTES = 10;
// Ceilings over a rolling hour, so codes cannot be requested in a loop to
// flood an inbox or to churn the code space.
const MAX_PER_EMAIL_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 15;

const req = $('Auth Request').first().json || {};
const headers = req.headers || {};
const body = req.body || {};
const email = String(body.email || '').trim().toLowerCase();
const ip = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '')
  .split(',')[0].trim();

const now = new Date();

function domainOf(addr) {
  const at = addr.lastIndexOf('@');
  if (at < 1 || at === addr.length - 1) return '';
  return addr.slice(at + 1);
}
// One @, something either side, a dot in the domain. Deliberately strict:
// anything unusual simply is not a Kantanna address.
const shapeOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
const allowed = shapeOk && ALLOWED_DOMAINS.indexOf(domainOf(email)) >= 0;

const existing = $input.all().map((i) => i.json).filter((r) => r && r.email);
const hourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();
const recent = existing.filter((r) => String(r.requested_at || '') > hourAgo);
const perEmail = recent.filter((r) => String(r.email) === email).length;
const perIp = ip ? recent.filter((r) => String(r.request_ip || '') === ip).length : 0;
const rateOk = perEmail < MAX_PER_EMAIL_PER_HOUR && perIp < MAX_PER_IP_PER_HOUR;

const send = allowed && rateOk;

// Rejection sampling over 32 random bits: draw again whenever the value
// falls in the short final bucket, so every one of the million codes is
// exactly as likely as any other. Math.random() would be predictable enough
// to matter for something that is, briefly, a credential.
function sixDigits() {
  const span = 1000000;
  const limit = Math.floor(4294967296 / span) * span;
  for (;;) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n < limit) return String(n % span).padStart(6, '0');
  }
}

const code = send ? sixDigits() : '';

// Built here rather than in an n8n expression so the markup stays readable
// and reviewable. Plain, high-contrast, and the code is selectable as text
// so it can be copied on a phone.
const emailHtml =
  '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'font-size:15px;line-height:1.5;color:#0f172a">' +
  '<p>Here is your sign-in code for the Kantanna CSP pricing portal:</p>' +
  '<p style="font-size:32px;font-weight:700;letter-spacing:.28em;' +
  'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
  'margin:22px 0;color:#0d1b30">' + code + '</p>' +
  '<p>It expires in ' + CODE_TTL_MINUTES + ' minutes and can only be used once.</p>' +
  '<p style="color:#64748b;font-size:13px;margin-top:24px">' +
  'If you did not ask to sign in, you can ignore this email - nobody can get in ' +
  'without this code. Do not forward it to anyone.</p></div>';

return [{ json: {
  send: send,
  email: email,
  email_subject: code + ' is your CSP pricing sign-in code',
  email_html: emailHtml,
  // The plaintext code goes to the email node and nowhere else. Only its
  // hash is stored, so the data table never holds anything sign-in-able.
  code: code,
  code_hash: code ? crypto.createHash('sha256').update(code).digest('hex') : '',
  expires_at: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
  attempts: 0,
  requested_at: now.toISOString(),
  request_ip: ip,
  ttl_minutes: CODE_TTL_MINUTES,
  // Always the same sentence, whatever was decided above.
  message: 'If that is a Kantanna address, a sign-in code is on its way.'
} }];
