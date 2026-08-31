// Gate, part one: work out which session, if any, this request is for, and
// hash it - the table stores hashes, so a leaked backup hands nobody a live
// session.
//
// Two ways in, because n8n Cloud sandboxes webhook responses into an opaque
// origin:
//   - `cookie`, for top-level navigations. Those are first-party requests, so
//     the browser does send the session cookie.
//   - `token`, for the portal's own background calls. Those count as
//     third-party from an opaque origin and carry no cookies at all, so the
//     page passes the token explicitly instead.
// An explicit token wins when both are present; it is the more specific of
// the two, and only our own pages ever send it.
//
// This runs as a sub-workflow so the protected endpoints share one copy of
// the check. Duplicated auth logic drifts, and a gate that is subtly
// different on one endpoint is the endpoint that gets used.
const crypto = require('crypto');

const COOKIE_NAME = 'csp_session';
const input = $input.first().json || {};

function fromCookie(raw) {
  for (const part of String(raw || '').split(';')) {
    const s = part.trim();
    if (s.slice(0, COOKIE_NAME.length + 1) === COOKIE_NAME + '=') {
      return s.slice(COOKIE_NAME.length + 1);
    }
  }
  return '';
}

const token = String(input.token || '').trim() || fromCookie(input.cookie);

// Only ever hash something shaped like one of our tokens. Anything else is
// not worth a lookup, and 'none' is a value the table can never hold, so the
// query returns empty rather than being skipped.
const looksRight = /^[0-9a-f]{64}$/.test(token);
return [{ json: {
  token_hash: looksRight ? crypto.createHash('sha256').update(token).digest('hex') : 'none',
  // Handed back to the caller so a page can pass it to its own fetches.
  token: looksRight ? token : ''
} }];
