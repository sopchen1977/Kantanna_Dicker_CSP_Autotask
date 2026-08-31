// Offline tests for the four sign-in Code nodes. These run the real files,
// with $() and $input faked the way n8n presents them, so the domain rule,
// the rate limits, the attempt ceiling and the cookie parsing are checked
// without deploying anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNTIME = path.join(__dirname, '..', 'runtime');
const src = (f) => fs.readFileSync(path.join(RUNTIME, f), 'utf8');

// n8n hands a Code node `$` (previous nodes by name), `$input` and `require`.
function run(file, nodes, inputItems) {
  const $ = (name) => {
    if (!(name in nodes)) throw new Error('no node ' + name);
    const items = nodes[name].map((j) => ({ json: j }));
    return { first: () => items[0], all: () => items };
  };
  const $input = {
    first: () => ({ json: inputItems[0] }),
    all: () => inputItems.map((j) => ({ json: j }))
  };
  return new Function('$', '$input', 'require', src(file))($, $input, require);
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
}
function section(t) { console.log(t); }

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

function request(email, existingRows, headers) {
  return run('auth-prepare-code.js',
    { 'Auth Request': [{ body: { email: email }, headers: headers || {} }] },
    existingRows || [])[0].json;
}

/* ------------------------------------------------------------------ */
section('domain allow-list');

for (const good of ['sop@kantanna.com', 'a.b@kantanna.com.au', 'x@kantanna.ph',
  '  Sop@Kantanna.COM  ']) {
  check('accepts ' + JSON.stringify(good), request(good).send === true);
}

// The whole point of comparing the last @-segment as a whole string.
for (const bad of [
  'x@not-kantanna.ph',          // endsWith() would let this through
  'x@evil-kantanna.com',        // and this
  'x@kantanna.com.evil.com',    // and this
  'x@sub.kantanna.com',         // a subdomain is not the domain
  'x@kantanna.co',
  'x@gmail.com',
  'x@kantanna.com@evil.com',    // lastIndexOf picks evil.com, correctly
  'kantanna.com',               // no @ at all
  '@kantanna.com',              // nothing before the @
  'x@',
  '',
  'x y@kantanna.com'            // whitespace inside
]) {
  check('rejects ' + JSON.stringify(bad), request(bad).send === false);
}

// A rejected request must be indistinguishable from an accepted one.
const accepted = request('sop@kantanna.com');
const rejected = request('someone@gmail.com');
check('same message either way', accepted.message === rejected.message);
check('no code minted when rejected', rejected.code === '' && rejected.code_hash === '');

/* ------------------------------------------------------------------ */
section('code generation');

const minted = request('sop@kantanna.com');
check('six digits', /^[0-9]{6}$/.test(minted.code), minted.code);
check('hash matches code', minted.code_hash === sha(minted.code));
check('expiry ~10 min out',
  Math.abs(new Date(minted.expires_at) - Date.now() - 600000) < 5000);

// Uniform enough that no single value dominates, and every draw is 6 digits.
const seen = {};
for (let i = 0; i < 400; i++) {
  const c = request('sop@kantanna.com').code;
  if (!/^[0-9]{6}$/.test(c)) { check('draw ' + i + ' is six digits', false, c); break; }
  seen[c] = (seen[c] || 0) + 1;
}
check('400 draws are near-unique', Object.keys(seen).length >= 395,
  Object.keys(seen).length + ' distinct');

/* ------------------------------------------------------------------ */
section('rate limits');

const recent = (email, ip, n, ageMs) => {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ email: email, request_ip: ip, requested_at: iso(-(ageMs || 60000)) });
  }
  return rows;
};

check('5th request for an address still sends',
  request('sop@kantanna.com', recent('sop@kantanna.com', '1.1.1.1', 4), {}).send === true);
check('6th request for an address is refused',
  request('sop@kantanna.com', recent('sop@kantanna.com', '1.1.1.1', 5), {}).send === false);
check('refusal still says the same thing',
  request('sop@kantanna.com', recent('sop@kantanna.com', '1.1.1.1', 5), {}).message
    === accepted.message);
check('an hour later the count has rolled off',
  request('sop@kantanna.com',
    recent('sop@kantanna.com', '1.1.1.1', 9, 3700000), {}).send === true);
check('one IP is capped across many addresses',
  request('new@kantanna.com',
    recent('other@kantanna.com', '9.9.9.9', 15), { 'x-forwarded-for': '9.9.9.9' })
    .send === false);
check('a different IP is unaffected',
  request('new@kantanna.com',
    recent('other@kantanna.com', '9.9.9.9', 15), { 'x-forwarded-for': '8.8.8.8' })
    .send === true);
check('x-forwarded-for chain uses the client, not the proxy',
  request('sop@kantanna.com', [], { 'x-forwarded-for': '3.3.3.3, 10.0.0.1' })
    .request_ip === '3.3.3.3');

/* ------------------------------------------------------------------ */
section('code verification');

function verify(email, code, rows, headers, next) {
  return run('auth-check-code.js',
    { 'Auth Verify': [{ body: { email: email, code: code, next: next }, headers: headers || {} }] },
    rows)[0].json;
}
const liveRow = (code, over) => Object.assign({
  id: 7, email: 'sop@kantanna.com', code_hash: sha(code),
  expires_at: iso(300000), attempts: 0, requested_at: iso(-1000)
}, over || {});

const good = verify('sop@kantanna.com', '123456', [liveRow('123456')]);
check('right code signs in', good.ok === true);
check('token is 32 random bytes', /^[0-9a-f]{64}$/.test(good.token));
check('token hash matches token', good.token_hash === sha(good.token));
check('session ~14 days', Math.abs(
  new Date(good.session_expires_at) - Date.now() - 14 * 86400000) < 5000);
check('max-age matches', good.session_max_age === 14 * 86400);

const wrong = verify('sop@kantanna.com', '999999', [liveRow('123456')]);
check('wrong code refused', wrong.ok === false);
check('wrong code issues no token', wrong.token === '' && wrong.token_hash === '');
check('wrong code spends an attempt', wrong.attempts_after === 1);

check('expired code refused',
  verify('sop@kantanna.com', '123456',
    [liveRow('123456', { expires_at: iso(-1000) })]).ok === false);
check('5 attempts already spent, correct code still refused',
  verify('sop@kantanna.com', '123456',
    [liveRow('123456', { attempts: 5 })]).ok === false);
check('burned code says so',
  /Too many attempts/.test(verify('sop@kantanna.com', '123456',
    [liveRow('123456', { attempts: 5 })]).message));
check('code belonging to another address refused',
  verify('other@kantanna.com', '123456', [liveRow('123456')]).ok === false);
check('no code row at all is refused',
  verify('sop@kantanna.com', '123456', []).ok === false);
check('no row means nothing to write back',
  verify('sop@kantanna.com', '123456', []).row_id === 0);
for (const junk of ['', '12345', '1234567', 'abcdef', '12 34 56', '1234-56']) {
  check('junk code ' + JSON.stringify(junk) + ' refused',
    verify('sop@kantanna.com', junk, [liveRow('123456')]).ok === false);
}
// Surrounding whitespace is trimmed - people paste codes out of email.
check('a pasted code with spaces still works',
  verify('sop@kantanna.com', '  123456 ', [liveRow('123456')]).ok === true);
// A blank stored hash must never match a blank guess.
check('empty stored hash cannot be matched',
  verify('sop@kantanna.com', '123456',
    [liveRow('123456', { code_hash: '' })]).ok === false);
// Newest code wins when two are outstanding.
check('newest outstanding code is the one checked',
  verify('sop@kantanna.com', '222222', [
    liveRow('111111', { requested_at: iso(-9000) }),
    liveRow('222222', { requested_at: iso(-100) })
  ]).ok === true);
check('older outstanding code no longer works',
  verify('sop@kantanna.com', '111111', [
    liveRow('111111', { requested_at: iso(-9000) }),
    liveRow('222222', { requested_at: iso(-100) })
  ]).ok === false);

/* ------------------------------------------------------------------ */
section('cookie parsing');

function cookie(raw) {
  return run('auth-read-cookie.js', {}, [{ cookie: raw }])[0].json.token_hash;
}
function viaToken(tok) {
  return run('auth-read-cookie.js', {}, [{ cookie: '', token: tok }])[0].json;
}
const tok = 'a'.repeat(64);
check('reads the token', cookie('csp_session=' + tok) === sha(tok));
check('reads it among others',
  cookie('foo=1; csp_session=' + tok + '; bar=2') === sha(tok));
check('tolerates no spaces', cookie('foo=1;csp_session=' + tok) === sha(tok));
check('no cookie header', cookie('') === 'none');
check('other cookies only', cookie('foo=1; bar=2') === 'none');
check('short token rejected', cookie('csp_session=abc') === 'none');
check('non-hex token rejected', cookie('csp_session=' + 'z'.repeat(64)) === 'none');
// A cookie whose NAME merely ends in our name must not be read as ours.
check('lookalike cookie name ignored',
  cookie('other_csp_session=' + tok) === 'none');
check('prefix cookie name ignored', cookie('csp_session_x=' + tok) === 'none');

// The portal's background calls cannot send the cookie from inside n8n
// Cloud's sandbox, so they pass the token explicitly instead.
check('explicit token is accepted', viaToken(tok).token_hash === sha(tok));
check('explicit token is echoed back', viaToken(tok).token === tok);
check('junk explicit token refused', viaToken('nope').token_hash === 'none');
check('junk explicit token echoes nothing', viaToken('nope').token === '');
check('an explicit token wins over the cookie',
  run('auth-read-cookie.js', {},
    [{ cookie: 'csp_session=' + 'b'.repeat(64), token: tok }])[0].json.token_hash === sha(tok));
check('no token and no cookie is refused',
  run('auth-read-cookie.js', {}, [{}])[0].json.token_hash === 'none');

/* ------------------------------------------------------------------ */
section('session check');

function session(wantedHash, rows, rawToken) {
  return run('auth-check-session.js',
    { 'Read Cookie': [{ token_hash: wantedHash, token: rawToken || '' }] }, rows)[0].json;
}
const h = sha(tok);
check('live session authorises',
  session(h, [{ token_hash: h, email: 'sop@kantanna.com', expires_at: iso(60000) }])
    .authed === true);
check('and carries the email',
  session(h, [{ token_hash: h, email: 'sop@kantanna.com', expires_at: iso(60000) }])
    .email === 'sop@kantanna.com');
check('expired session refused',
  session(h, [{ token_hash: h, email: 'x', expires_at: iso(-60000) }]).authed === false);
check('mismatched hash refused',
  session(h, [{ token_hash: sha('b'), email: 'x', expires_at: iso(60000) }])
    .authed === false);
check('no rows refused', session(h, []).authed === false);
check('"none" never matches a real row',
  session('none', [{ token_hash: h, email: 'x', expires_at: iso(60000) }])
    .authed === false);
check('row with no expiry refused',
  session(h, [{ token_hash: h, email: 'x' }]).authed === false);
check('a live session echoes the token for the page to reuse',
  session(h, [{ token_hash: h, email: 'x', expires_at: iso(60000) }], tok).token === tok);
// A refused request must never be handed a usable token back.
check('a refused session echoes nothing',
  session(h, [{ token_hash: h, email: 'x', expires_at: iso(-60000) }], tok).token === '');

/* ------------------------------------------------------------------ */
section('next-page redirect is not an open redirect');

// The verify step validates separately, because its value lands in a
// Location header rather than an href.
function nextSafeOf(v) {
  return verify('sop@kantanna.com', '123456',
    [liveRow('123456')], {}, v).next_safe;
}
for (const good of ['csp-pricing', 'csp-pricing-source?sheet=invoice']) {
  check('verify keeps ' + JSON.stringify(good), nextSafeOf(good) === good);
}
for (const bad of ['https://evil.com', '//evil.com', 'javascript:alert(1)', '', '../x']) {
  check('verify rejects ' + JSON.stringify(bad), nextSafeOf(bad) === 'csp-pricing');
}

function nextOf(v) {
  const nodes = {
    'Prepare Code': [{ email: 'a@kantanna.com', next: v, message: 'sent' }],
    'Sign-in Code Template': [{ html: 'NEXT=__NEXT__' }]
  };
  return run('auth-build-code-page.js', nodes, [{}])[0].json.html.replace('NEXT=', '');
}
for (const good of ['csp-pricing', 'csp-pricing-source?sheet=annuity', 'csp-import']) {
  check('keeps ' + JSON.stringify(good), nextOf(good) === good);
}
for (const bad of [
  'https://evil.com',        // absolute
  '//evil.com',              // protocol-relative
  '/etc/passwd',
  '../../admin',
  'javascript:alert(1)',
  'csp-pricing?x=<script>',  // angle brackets are not in the allowed set
  '',
  'anything-else'
]) {
  check('rejects ' + JSON.stringify(bad) + ' -> portal', nextOf(bad) === 'csp-pricing');
}

/* ------------------------------------------------------------------ */
if (failures) {
  console.log('\n' + failures + ' AUTH TEST(S) FAILED');
  process.exit(1);
}
console.log('\nALL AUTH TESTS PASSED');
