// Gate, part one: pull the session token out of the Cookie header and hash
// it, so what goes into the query is what the table actually stores.
//
// This runs as a sub-workflow so the six protected endpoints share one copy
// of the check. Duplicated auth logic drifts, and a gate that is subtly
// different on one endpoint is the endpoint that gets used.
const crypto = require('crypto');

const COOKIE_NAME = 'csp_session';

const raw = String(($input.first().json || {}).cookie || '');
let token = '';
for (const part of raw.split(';')) {
  const s = part.trim();
  if (s.slice(0, COOKIE_NAME.length + 1) === COOKIE_NAME + '=') {
    token = s.slice(COOKIE_NAME.length + 1);
    break;
  }
}

// Only ever hash something that looks like one of our tokens. Anything else
// is not worth a lookup, and 'none' is a value the table can never hold, so
// the query returns empty rather than being skipped.
const looksRight = /^[0-9a-f]{64}$/.test(token);
return [{ json: {
  token_hash: looksRight
    ? crypto.createHash('sha256').update(token).digest('hex')
    : 'none'
} }];
