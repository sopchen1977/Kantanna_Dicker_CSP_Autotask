// Step two of email OTP sign-in: check the code, and on success mint the
// session token that every other endpoint will be gated on.
//
// A wrong code costs an attempt. Five wrong attempts burn the code entirely,
// which is what keeps six digits from being brute-forceable: a million
// guesses at five per code is not a route in.
const crypto = require('crypto');

const SESSION_DAYS = 14;
const MAX_ATTEMPTS = 5;

const req = $('Auth Verify').first().json || {};
const headers = req.headers || {};
const body = req.body || {};
const email = String(body.email || '').trim().toLowerCase();
const code = String(body.code || '').trim();
const ip = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '')
  .split(',')[0].trim();
const next = String(body.next || '').trim();
// This goes straight into a Location header on success, so it is validated
// here rather than trusted: our own routes only - no scheme, no host, no
// protocol-relative "//evil", no traversal.
const nextSafe = /^csp-[a-z-]+(\?[A-Za-z0-9=&%._-]*)?$/.test(next) ? next : 'csp-pricing';

const now = new Date();
const nowIso = now.toISOString();

// Newest code for this address wins; asking for a second code invalidates
// nothing, but only the latest is checked.
const rows = $input.all().map((i) => i.json)
  .filter((r) => r && String(r.email || '').toLowerCase() === email);
rows.sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || '')));
const row = rows[0] || null;

const live = !!row && String(row.expires_at || '') > nowIso;
const attemptsBefore = row ? Number(row.attempts || 0) : 0;
const spent = attemptsBefore >= MAX_ATTEMPTS;

let ok = false;
if (live && !spent && /^[0-9]{6}$/.test(code)) {
  const given = crypto.createHash('sha256').update(code).digest();
  const want = Buffer.from(String(row.code_hash || ''), 'hex');
  // timingSafeEqual throws on a length mismatch, so check that first. Both
  // sides are SHA-256 digests, so in practice they always match.
  ok = want.length === given.length && crypto.timingSafeEqual(given, want);
}

const attemptsAfter = ok ? attemptsBefore : attemptsBefore + 1;
// One message for every kind of failure, so a wrong code and an unknown
// address are indistinguishable from outside.
let message = 'That code is not right, or it has expired. Ask for a new one.';
if (!ok && (spent || attemptsAfter >= MAX_ATTEMPTS)) {
  message = 'Too many attempts on that code. Ask for a new one.';
}

// 32 random bytes: the session token is the credential from here on, so it
// is generated the same way a password reset token would be. Only its hash
// is stored, so the sessions table cannot be replayed if it ever leaks.
const token = ok ? crypto.randomBytes(32).toString('hex') : '';

return [{ json: {
  ok: ok,
  email: email,
  next: next,
  next_safe: nextSafe,
  message: ok ? 'Signed in.' : message,
  token: token,
  token_hash: ok ? crypto.createHash('sha256').update(token).digest('hex') : '',
  session_expires_at: new Date(now.getTime() + SESSION_DAYS * 86400 * 1000).toISOString(),
  session_max_age: SESSION_DAYS * 86400,
  created_at: nowIso,
  sign_in_ip: ip,
  // Row bookkeeping: a used code is deleted, a failed one has its attempt
  // count written back. row_id is 0 when no code row existed at all, which
  // the workflow uses to skip the write rather than update every row.
  row_id: row && row.id !== undefined && row.id !== null ? Number(row.id) : 0,
  attempts_after: attemptsAfter
} }];
