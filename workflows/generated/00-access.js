import { workflow, node, trigger, sticky, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

/* ============================================================
   Chain A - ask for a sign-in code
   ============================================================ */
const authRequest = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Auth Request',
    position: [-420, -300],
    parameters: { httpMethod: 'POST', path: 'csp-auth-request', responseMode: 'responseNode', options: {} }
  },
  output: [{ body: { email: 'sop@kantanna.com.au' }, headers: {} }]
});

// Every outstanding code, for two reasons: the rate limiter counts recent
// requests, and codes older than the window get pruned below.
const fetchCodes = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Codes',
    position: [-200, -300],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'Am9KrzhbyWdKOEeY', cachedResultName: 'csp_auth_codes' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, email: 'sop@kantanna.com.au', requested_at: '2026-08-31T00:00:00.000Z' }]
});

const prepareCode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Code',
    position: [20, -300],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Step one of email OTP sign-in: decide whether this request earns a code,\n// and if so, mint one.\n//\n// The reply is deliberately identical whether or not we would send to this\n// address, so the endpoint cannot be used to discover who works at Kantanna.\n// `send` decides what the workflow does; `message` is what the caller is\n// told, and it never varies.\nconst crypto = require('crypto');\n\n// Only these domains may sign in. Compared against the part after the LAST\n// \"@\", lowercased, as a WHOLE string. Never endsWith() - that would also\n// accept someone@not-kantanna.ph and someone@evil-kantanna.com.\nconst ALLOWED_DOMAINS = ['kantanna.com', 'kantanna.com.au', 'kantanna.ph'];\nconst CODE_TTL_MINUTES = 10;\n// Ceilings over a rolling hour, so codes cannot be requested in a loop to\n// flood an inbox or to churn the code space.\nconst MAX_PER_EMAIL_PER_HOUR = 5;\nconst MAX_PER_IP_PER_HOUR = 15;\n\nconst req = $('Auth Request').first().json || {};\nconst headers = req.headers || {};\nconst body = req.body || {};\nconst email = String(body.email || '').trim().toLowerCase();\nconst ip = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '')\n  .split(',')[0].trim();\n// Where to land after signing in; validated where it is used, never here.\nconst next = String(body.next || '').trim();\n\nconst now = new Date();\n\nfunction domainOf(addr) {\n  const at = addr.lastIndexOf('@');\n  if (at < 1 || at === addr.length - 1) return '';\n  return addr.slice(at + 1);\n}\n// One @, something either side, a dot in the domain. Deliberately strict:\n// anything unusual simply is not a Kantanna address.\nconst shapeOk = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email);\nconst allowed = shapeOk && ALLOWED_DOMAINS.indexOf(domainOf(email)) >= 0;\n\nconst existing = $input.all().map((i) => i.json).filter((r) => r && r.email);\nconst hourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();\nconst recent = existing.filter((r) => String(r.requested_at || '') > hourAgo);\nconst perEmail = recent.filter((r) => String(r.email) === email).length;\nconst perIp = ip ? recent.filter((r) => String(r.request_ip || '') === ip).length : 0;\nconst rateOk = perEmail < MAX_PER_EMAIL_PER_HOUR && perIp < MAX_PER_IP_PER_HOUR;\n\nconst send = allowed && rateOk;\n\n// Rejection sampling over 32 random bits: draw again whenever the value\n// falls in the short final bucket, so every one of the million codes is\n// exactly as likely as any other. Math.random() would be predictable enough\n// to matter for something that is, briefly, a credential.\nfunction sixDigits() {\n  const span = 1000000;\n  const limit = Math.floor(4294967296 / span) * span;\n  for (;;) {\n    const n = crypto.randomBytes(4).readUInt32BE(0);\n    if (n < limit) return String(n % span).padStart(6, '0');\n  }\n}\n\nconst code = send ? sixDigits() : '';\n\n// Built here rather than in an n8n expression so the markup stays readable\n// and reviewable. Plain, high-contrast, and the code is selectable as text\n// so it can be copied on a phone.\nconst emailHtml =\n  '<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +\n  'font-size:15px;line-height:1.5;color:#0f172a\">' +\n  '<p>Here is your sign-in code for the Kantanna CSP pricing portal:</p>' +\n  '<p style=\"font-size:32px;font-weight:700;letter-spacing:.28em;' +\n  'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +\n  'margin:22px 0;color:#0d1b30\">' + code + '</p>' +\n  '<p>It expires in ' + CODE_TTL_MINUTES + ' minutes and can only be used once.</p>' +\n  '<p style=\"color:#64748b;font-size:13px;margin-top:24px\">' +\n  'If you did not ask to sign in, you can ignore this email - nobody can get in ' +\n  'without this code. Do not forward it to anyone.</p></div>';\n\nreturn [{ json: {\n  send: send,\n  email: email,\n  next: next,\n  email_subject: code + ' is your CSP pricing sign-in code',\n  email_html: emailHtml,\n  // The plaintext code goes to the email node and nowhere else. Only its\n  // hash is stored, so the data table never holds anything sign-in-able.\n  code: code,\n  code_hash: code ? crypto.createHash('sha256').update(code).digest('hex') : '',\n  expires_at: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),\n  attempts: 0,\n  requested_at: now.toISOString(),\n  request_ip: ip,\n  ttl_minutes: CODE_TTL_MINUTES,\n  // Always the same sentence, whatever was decided above.\n  message: 'If that is a Kantanna address, a sign-in code is on its way.'\n} }];\n" }
  },
  output: [{ send: true, email: 'sop@kantanna.com.au', code: '123456', code_hash: 'abc', message: 'If that is a Kantanna address, a sign-in code is on its way.' }]
});

const shouldSend = ifElse({
  version: 2.2,
  config: {
    name: 'Send Code?',
    position: [240, -300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.send }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

// Codes older than the rate-limit window are of no further use: the newest
// one is the only one verify will look at, and the limiter only counts the
// last hour. Pruning here keeps the table from growing without bound while
// leaving every row the limiter still needs.
const pruneCodes = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Prune Old Codes',
    position: [460, -380],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: 'Am9KrzhbyWdKOEeY', cachedResultName: 'csp_auth_codes' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'requested_at', condition: 'lt', keyValue: expr('{{ new Date(Date.now() - 3600000).toISOString() }}') }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const storeCode = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Store Code',
    position: [680, -380],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: 'Am9KrzhbyWdKOEeY', cachedResultName: 'csp_auth_codes' },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          email: expr('{{ $(\'Prepare Code\').first().json.email }}'),
          // The hash, never the code itself.
          code_hash: expr('{{ $(\'Prepare Code\').first().json.code_hash }}'),
          expires_at: expr('{{ $(\'Prepare Code\').first().json.expires_at }}'),
          attempts: expr('{{ $(\'Prepare Code\').first().json.attempts }}'),
          requested_at: expr('{{ $(\'Prepare Code\').first().json.requested_at }}'),
          request_ip: expr('{{ $(\'Prepare Code\').first().json.request_ip }}')
        },
        schema: [
          { id: 'email', displayName: 'email', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'code_hash', displayName: 'code_hash', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'expires_at', displayName: 'expires_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'attempts', displayName: 'attempts', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'requested_at', displayName: 'requested_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'request_ip', displayName: 'request_ip', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const sendCodeEmail = node({
  type: 'n8n-nodes-base.microsoftOutlook',
  version: 2,
  config: {
    name: 'Send Code Email',
    position: [900, -380],
    // A mail failure must not hand the caller a different answer from a
    // success - that would turn the send/do-not-send decision into an
    // address oracle. Carry on and respond the same either way.
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'send',
      toRecipients: expr('{{ $(\'Prepare Code\').first().json.email }}'),
      subject: expr('{{ $(\'Prepare Code\').first().json.email_subject }}'),
      bodyContent: expr('{{ $(\'Prepare Code\').first().json.email_html }}'),
      additionalFields: { bodyContentType: 'html', saveToSentItems: false }
    },
    // Codes come FROM a Kantanna mailbox on purpose: a sign-in code arriving
    // from another company's domain reads as phishing and lands in junk.
    credentials: { microsoftOutlookOAuth2Api: newCredential('Sop Kantanna Email') }
  },
  output: [{ success: true }]
});


// Sign-in is a sequence of real form POSTs, so each step is a page the server
// renders. Generated from portal/signin-code.html at build time.
const signinCodeTemplate = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Sign-in Code Template',
    position: [900, -220],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [{ id: 'signin-code-html', name: 'html', type: 'string', value: "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Enter your code &middot; CSP Pricing</title>\n<style>\n  :root {\n    --bg:#f1f4f8; --card:#fff; --ink:#0f172a; --ink2:#334155; --muted:#64748b;\n    --line:#e2e8f0; --brand:#2563eb; --bad:#b91c1c; --badbg:#fef2f2;\n    --ok:#166534; --okbg:#f0fdf4;\n  }\n  * { box-sizing:border-box; }\n  body {\n    margin:0; min-height:100vh; background:var(--bg); color:var(--ink);\n    font:15px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;\n    display:grid; place-items:center; padding:24px;\n  }\n  .card {\n    width:100%; max-width:400px; background:var(--card); border:1px solid var(--line);\n    border-radius:14px; padding:30px 30px 26px;\n    box-shadow:0 1px 2px rgba(15,23,42,.05), 0 8px 28px rgba(15,23,42,.08);\n  }\n  .logo {\n    width:40px; height:40px; border-radius:10px; background:#0d1b30; color:#fff;\n    display:grid; place-items:center; font-size:13px; font-weight:700;\n    letter-spacing:.06em; margin-bottom:18px;\n  }\n  h1 { margin:0 0 6px; font-size:19px; font-weight:600; letter-spacing:-.015em; }\n  .sub { margin:0 0 22px; font-size:13.5px; color:var(--muted); }\n  .sub b { color:var(--ink2); font-weight:600; }\n  label { display:block; font-size:12px; font-weight:600; color:var(--ink2);\n    text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }\n  input[type=email], input[type=text] {\n    width:100%; padding:10px 12px; font:inherit; font-size:14.5px;\n    border:1px solid var(--line); border-radius:9px; background:#fff; color:var(--ink);\n  }\n  input:focus { outline:2px solid #bfdbfe; outline-offset:-1px; border-color:var(--brand); }\n  /* The code is six digits and gets pasted out of an email - give it room\n     and tabular figures so a transposed digit is easy to spot. */\n  input.code {\n    font-size:23px; letter-spacing:.34em; text-align:center; font-variant-numeric:tabular-nums;\n    padding:12px; font-weight:600;\n  }\n  button {\n    width:100%; margin-top:14px; padding:11px 16px; font:inherit; font-size:14.5px;\n    font-weight:600; color:#fff; background:var(--brand); border:0; border-radius:9px;\n    cursor:pointer;\n  }\n  button:hover { background:#1d4ed8; }\n  .linkrow { margin-top:16px; font-size:13px; color:var(--muted); text-align:center; }\n  .linkrow a, .linkrow button.link {\n    color:var(--brand); text-decoration:none; cursor:pointer; background:none;\n    border:0; padding:0; margin:0; width:auto; font:inherit; font-size:13px;\n  }\n  .linkrow a:hover, .linkrow button.link:hover { text-decoration:underline; background:none; }\n  .msg { margin-top:14px; padding:9px 12px; border-radius:8px; font-size:13px; }\n  .msg.bad { background:var(--badbg); color:var(--bad); border:1px solid #fecaca; }\n  .msg.ok { background:var(--okbg); color:var(--ok); border:1px solid #bbf7d0; }\n  .foot { margin-top:22px; padding-top:16px; border-top:1px solid var(--line);\n    font-size:12px; color:var(--muted); line-height:1.5; }\n</style>\n</head>\n<body>\n<!--\n  Step two. Like step one this is a real form POST so the top-level window\n  navigates: the response to csp-auth-verify carries the session cookie, and\n  only a first-party navigation gets to keep it under n8n Cloud's sandbox.\n-->\n<div class=\"card\">\n  <div class=\"logo\">CSP</div>\n  <h1>Enter your code</h1>\n  <p class=\"sub\">We sent a six-digit code to <b>__EMAIL__</b>. It expires in 10 minutes.</p>\n\n  <form method=\"POST\" action=\"csp-auth-verify\">\n    <label for=\"code\">Sign-in code</label>\n    <input id=\"code\" class=\"code\" name=\"code\" type=\"text\" inputmode=\"numeric\"\n           autocomplete=\"one-time-code\" pattern=\"[0-9]*\" maxlength=\"6\"\n           placeholder=\"000000\" required autofocus>\n    <input type=\"hidden\" name=\"email\" value=\"__EMAIL__\">\n    <input type=\"hidden\" name=\"next\" value=\"__NEXT__\">\n    <button type=\"submit\">Sign in</button>\n  </form>\n\n  <div class=\"msg __KIND__\">__MESSAGE__</div>\n\n  <div class=\"linkrow\">\n    <form method=\"POST\" action=\"csp-auth-request\" style=\"display:inline\">\n      <input type=\"hidden\" name=\"email\" value=\"__EMAIL__\">\n      <input type=\"hidden\" name=\"next\" value=\"__NEXT__\">\n      <button type=\"submit\" class=\"link\">Send another code</button>\n    </form>\n    &middot; <a href=\"__NEXT__\">Use a different address</a>\n  </div>\n\n  <p class=\"foot\">\n    Access is limited to kantanna.com, kantanna.com.au and kantanna.ph addresses.\n    Signing in keeps you signed in on this browser for 14 days.\n  </p>\n</div>\n</body>\n</html>\n" }]
      }
    }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const buildCodePage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Code Page',
    position: [1020, -300],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Render the \"enter your code\" page. It is served in two situations: after a\n// code has been requested, and after a wrong code has been handed back - the\n// second just carries a different message, so there is one page, not two.\n//\n// This exists because sign-in is a sequence of real form POSTs rather than\n// fetch() calls: n8n Cloud sandboxes webhook responses into an opaque origin\n// where cookies cannot be stored, and only a top-level navigation gets to set\n// one. Server-rendered steps are the price of that.\nfunction grab(name) {\n  try { return $(name).first().json; } catch (e) { return null; }\n}\n// Only one of these exists per execution: the request chain and the verify\n// chain have different triggers.\nconst asked = grab('Prepare Code');\nconst checked = grab('Check Code');\nconst src = checked\n  ? { email: checked.email, next: checked.next, message: checked.message, kind: 'bad' }\n  : { email: asked.email, next: asked.next, message: asked.message, kind: 'ok' };\n\nconst tmpl = $('Sign-in Code Template').first().json.html;\n\nfunction esc(s) {\n  return String(s === null || s === undefined ? '' : s)\n    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')\n    .replace(/\"/g, '&quot;').replace(/'/g, '&#39;');\n}\n\n// `next` comes from the browser, and it ends up in a Location header and an\n// href, so it is never trusted. Only our own routes are allowed: no scheme,\n// no host, no protocol-relative \"//evil\", no traversal. Anything else falls\n// back to the portal.\nfunction safeNext(v) {\n  const s = String(v || '').trim();\n  return /^csp-[a-z-]+(\\?[A-Za-z0-9=&%._-]*)?$/.test(s) ? s : 'csp-pricing';\n}\n\nconst html = tmpl\n  .replace(/__EMAIL__/g, esc(src.email))\n  .replace(/__NEXT__/g, esc(safeNext(src.next)))\n  .replace(/__KIND__/g, src.kind === 'bad' ? 'bad' : 'ok')\n  .replace(/__MESSAGE__/g, esc(src.message));\n\nreturn [{ json: { html: html } }];\n" }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const respondCodePage = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Code Page',
    position: [1260, -300],
    parameters: {
      respondWith: 'text',
      responseBody: expr('{{ $json.html }}'),
      options: { responseHeaders: { entries: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store, must-revalidate' }
      ] } }
    }
  }
});

/* ============================================================
   Chain B - hand back a code and get a session
   ============================================================ */
const authVerify = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Auth Verify',
    position: [-420, 0],
    parameters: { httpMethod: 'POST', path: 'csp-auth-verify', responseMode: 'responseNode', options: {} }
  },
  output: [{ body: { email: 'sop@kantanna.com.au', code: '123456' }, headers: {} }]
});

const fetchCodesForCheck = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Codes To Check',
    position: [-200, 0],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'Am9KrzhbyWdKOEeY', cachedResultName: 'csp_auth_codes' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, email: 'sop@kantanna.com.au', code_hash: 'abc', expires_at: '2026-08-31T00:10:00.000Z', attempts: 0 }]
});

const checkCode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Check Code',
    position: [20, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Step two of email OTP sign-in: check the code, and on success mint the\n// session token that every other endpoint will be gated on.\n//\n// A wrong code costs an attempt. Five wrong attempts burn the code entirely,\n// which is what keeps six digits from being brute-forceable: a million\n// guesses at five per code is not a route in.\nconst crypto = require('crypto');\n\nconst SESSION_DAYS = 14;\nconst MAX_ATTEMPTS = 5;\n\nconst req = $('Auth Verify').first().json || {};\nconst headers = req.headers || {};\nconst body = req.body || {};\nconst email = String(body.email || '').trim().toLowerCase();\nconst code = String(body.code || '').trim();\nconst ip = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '')\n  .split(',')[0].trim();\nconst next = String(body.next || '').trim();\n// This goes straight into a Location header on success, so it is validated\n// here rather than trusted: our own routes only - no scheme, no host, no\n// protocol-relative \"//evil\", no traversal.\nconst nextSafe = /^csp-[a-z-]+(\\?[A-Za-z0-9=&%._-]*)?$/.test(next) ? next : 'csp-pricing';\n\n// n8n's Respond to Webhook treats a bare \"csp-pricing\" as a HOSTNAME and\n// redirects to https://csp-pricing/, so the Location has to be absolute.\n// Build it from the URL this request actually arrived on rather than\n// hard-coding the instance, and keep a fallback for the odd case where the\n// trigger does not report one.\nconst arrivedAt = String(req.webhookUrl || '');\nconst base = /^https?:\\/\\/[^/]+\\/.*\\//.test(arrivedAt)\n  ? arrivedAt.replace(/[^/]*$/, '')\n  : 'https://gayleai.app.n8n.cloud/webhook/';\nconst redirectUrl = base + nextSafe;\n\nconst now = new Date();\nconst nowIso = now.toISOString();\n\n// Newest code for this address wins; asking for a second code invalidates\n// nothing, but only the latest is checked.\nconst rows = $input.all().map((i) => i.json)\n  .filter((r) => r && String(r.email || '').toLowerCase() === email);\nrows.sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || '')));\nconst row = rows[0] || null;\n\nconst live = !!row && String(row.expires_at || '') > nowIso;\nconst attemptsBefore = row ? Number(row.attempts || 0) : 0;\nconst spent = attemptsBefore >= MAX_ATTEMPTS;\n\nlet ok = false;\nif (live && !spent && /^[0-9]{6}$/.test(code)) {\n  const given = crypto.createHash('sha256').update(code).digest();\n  const want = Buffer.from(String(row.code_hash || ''), 'hex');\n  // timingSafeEqual throws on a length mismatch, so check that first. Both\n  // sides are SHA-256 digests, so in practice they always match.\n  ok = want.length === given.length && crypto.timingSafeEqual(given, want);\n}\n\nconst attemptsAfter = ok ? attemptsBefore : attemptsBefore + 1;\n// One message for every kind of failure, so a wrong code and an unknown\n// address are indistinguishable from outside.\nlet message = 'That code is not right, or it has expired. Ask for a new one.';\nif (!ok && (spent || attemptsAfter >= MAX_ATTEMPTS)) {\n  message = 'Too many attempts on that code. Ask for a new one.';\n}\n\n// 32 random bytes: the session token is the credential from here on, so it\n// is generated the same way a password reset token would be. Only its hash\n// is stored, so the sessions table cannot be replayed if it ever leaks.\nconst token = ok ? crypto.randomBytes(32).toString('hex') : '';\n\nreturn [{ json: {\n  ok: ok,\n  email: email,\n  next: next,\n  next_safe: nextSafe,\n  redirect_url: redirectUrl,\n  message: ok ? 'Signed in.' : message,\n  token: token,\n  token_hash: ok ? crypto.createHash('sha256').update(token).digest('hex') : '',\n  session_expires_at: new Date(now.getTime() + SESSION_DAYS * 86400 * 1000).toISOString(),\n  session_max_age: SESSION_DAYS * 86400,\n  created_at: nowIso,\n  sign_in_ip: ip,\n  // Row bookkeeping: a used code is deleted, a failed one has its attempt\n  // count written back. row_id is 0 when no code row existed at all, which\n  // the workflow uses to skip the write rather than update every row.\n  row_id: row && row.id !== undefined && row.id !== null ? Number(row.id) : 0,\n  attempts_after: attemptsAfter\n} }];\n" }
  },
  output: [{ ok: true, email: 'sop@kantanna.com.au', token: 'abc', token_hash: 'def', row_id: 1, attempts_after: 0 }]
});

const signedIn = ifElse({
  version: 2.2,
  config: {
    name: 'Code Accepted?',
    position: [240, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.ok }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

// Single use: the code is gone the moment it works, so a code read over
// someone's shoulder is worthless once they have used it.
const deleteUsedCode = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Delete Used Code',
    position: [460, -80],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: 'Am9KrzhbyWdKOEeY', cachedResultName: 'csp_auth_codes' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'id', condition: 'eq', keyValue: expr('{{ $json.row_id }}') }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const createSession = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Create Session',
    position: [680, -80],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: 'dejMhLWVWTKdyYpo', cachedResultName: 'csp_sessions' },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          token_hash: expr('{{ $(\'Check Code\').first().json.token_hash }}'),
          email: expr('{{ $(\'Check Code\').first().json.email }}'),
          expires_at: expr('{{ $(\'Check Code\').first().json.session_expires_at }}'),
          created_at: expr('{{ $(\'Check Code\').first().json.created_at }}'),
          last_seen: expr('{{ $(\'Check Code\').first().json.created_at }}'),
          sign_in_ip: expr('{{ $(\'Check Code\').first().json.sign_in_ip }}')
        },
        schema: [
          { id: 'token_hash', displayName: 'token_hash', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'email', displayName: 'email', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'expires_at', displayName: 'expires_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'created_at', displayName: 'created_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'last_seen', displayName: 'last_seen', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sign_in_ip', displayName: 'sign_in_ip', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

// HttpOnly so page scripts can never read it; Secure so it never crosses
// plain HTTP; SameSite=Lax so another site cannot make the browser spend it
// on a state-changing POST. Path is scoped to /webhook/ so it is not sent to
// the n8n app itself.
const respondSignedIn = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Signed In',
    position: [900, -80],
    parameters: {
      respondWith: 'redirect',
      // Absolute: n8n reads a relative value as a hostname and would send
      // the browser to https://csp-pricing/. Built in auth-check-code.js.
      redirectURL: expr('{{ $(\'Check Code\').first().json.redirect_url }}'),
      options: { responseHeaders: { entries: [
        { name: 'Set-Cookie', value: expr('{{ "csp_session=" + $(\'Check Code\').first().json.token + "; Path=/webhook/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + $(\'Check Code\').first().json.session_max_age }}') },
        { name: 'Cache-Control', value: 'no-store' }
      ] } }
    }
  }
});

// A wrong code costs an attempt. row_id is 0 when there was no code row at
// all, and no row has id 0, so the update simply matches nothing.
const bumpAttempts = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Bump Attempts',
    position: [460, 100],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: 'Am9KrzhbyWdKOEeY', cachedResultName: 'csp_auth_codes' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'id', condition: 'eq', keyValue: expr('{{ $json.row_id }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: { attempts: expr('{{ $json.attempts_after }}') },
        schema: [
          { id: 'attempts', displayName: 'attempts', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

/* ============================================================
   Chain C - sign out
   ============================================================ */
const authSignout = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Auth Signout',
    position: [-420, 300],
    parameters: { httpMethod: 'POST', path: 'csp-auth-signout', responseMode: 'responseNode', options: {} }
  },
  output: [{ headers: { cookie: 'csp_session=abc' } }]
});

// Read Session Token expects a `cookie` field, the same shape the gate
// sub-workflow is called with, so both use the one parser.
const signoutCookie = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Signout Cookie',
    position: [-200, 300],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'cookie', name: 'cookie', type: 'string', value: expr('{{ $json.headers.cookie || "" }}') }
        ]
      }
    }
  },
  output: [{ cookie: 'csp_session=abc' }]
});

const readSignoutToken = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Read Signout Token',
    position: [20, 300],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Gate, part one: work out which session, if any, this request is for, and\n// hash it - the table stores hashes, so a leaked backup hands nobody a live\n// session.\n//\n// Two ways in, because n8n Cloud sandboxes webhook responses into an opaque\n// origin:\n//   - `cookie`, for top-level navigations. Those are first-party requests, so\n//     the browser does send the session cookie.\n//   - `token`, for the portal's own background calls. Those count as\n//     third-party from an opaque origin and carry no cookies at all, so the\n//     page passes the token explicitly instead.\n// An explicit token wins when both are present; it is the more specific of\n// the two, and only our own pages ever send it.\n//\n// This runs as a sub-workflow so the protected endpoints share one copy of\n// the check. Duplicated auth logic drifts, and a gate that is subtly\n// different on one endpoint is the endpoint that gets used.\nconst crypto = require('crypto');\n\nconst COOKIE_NAME = 'csp_session';\nconst input = $input.first().json || {};\n\nfunction fromCookie(raw) {\n  for (const part of String(raw || '').split(';')) {\n    const s = part.trim();\n    if (s.slice(0, COOKIE_NAME.length + 1) === COOKIE_NAME + '=') {\n      return s.slice(COOKIE_NAME.length + 1);\n    }\n  }\n  return '';\n}\n\nconst token = String(input.token || '').trim() || fromCookie(input.cookie);\n\n// Only ever hash something shaped like one of our tokens. Anything else is\n// not worth a lookup, and 'none' is a value the table can never hold, so the\n// query returns empty rather than being skipped.\nconst looksRight = /^[0-9a-f]{64}$/.test(token);\nreturn [{ json: {\n  token_hash: looksRight ? crypto.createHash('sha256').update(token).digest('hex') : 'none',\n  // Handed back to the caller so a page can pass it to its own fetches.\n  token: looksRight ? token : ''\n} }];\n" }
  },
  output: [{ token_hash: 'abc' }]
});

const deleteSession = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Delete Session',
    position: [240, 300],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: 'dejMhLWVWTKdyYpo', cachedResultName: 'csp_sessions' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'token_hash', condition: 'eq', keyValue: expr('{{ $json.token_hash }}') }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const respondSignedOut = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Signed Out',
    position: [460, 300],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify({ ok: true }) }}',
      options: { responseHeaders: { entries: [
        { name: 'Set-Cookie', value: 'csp_session=; Path=/webhook/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' },
        { name: 'Cache-Control', value: 'no-store' }
      ] } }
    }
  }
});

/* ============================================================
   Chain D - the gate every protected endpoint calls
   ============================================================ */
const accessCheck = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.2,
  config: {
    name: 'Access Check',
    position: [-420, 600],
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: { values: [
        { name: 'cookie', type: 'string' },
        // Page navigations send the cookie; the portal's own background calls
        // cannot, and pass the token instead. See auth-read-cookie.js.
        { name: 'token', type: 'string' }
      ] }
    }
  },
  output: [{ cookie: 'csp_session=abc' }]
});

const readCookie = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Read Cookie',
    position: [-200, 600],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Gate, part one: work out which session, if any, this request is for, and\n// hash it - the table stores hashes, so a leaked backup hands nobody a live\n// session.\n//\n// Two ways in, because n8n Cloud sandboxes webhook responses into an opaque\n// origin:\n//   - `cookie`, for top-level navigations. Those are first-party requests, so\n//     the browser does send the session cookie.\n//   - `token`, for the portal's own background calls. Those count as\n//     third-party from an opaque origin and carry no cookies at all, so the\n//     page passes the token explicitly instead.\n// An explicit token wins when both are present; it is the more specific of\n// the two, and only our own pages ever send it.\n//\n// This runs as a sub-workflow so the protected endpoints share one copy of\n// the check. Duplicated auth logic drifts, and a gate that is subtly\n// different on one endpoint is the endpoint that gets used.\nconst crypto = require('crypto');\n\nconst COOKIE_NAME = 'csp_session';\nconst input = $input.first().json || {};\n\nfunction fromCookie(raw) {\n  for (const part of String(raw || '').split(';')) {\n    const s = part.trim();\n    if (s.slice(0, COOKIE_NAME.length + 1) === COOKIE_NAME + '=') {\n      return s.slice(COOKIE_NAME.length + 1);\n    }\n  }\n  return '';\n}\n\nconst token = String(input.token || '').trim() || fromCookie(input.cookie);\n\n// Only ever hash something shaped like one of our tokens. Anything else is\n// not worth a lookup, and 'none' is a value the table can never hold, so the\n// query returns empty rather than being skipped.\nconst looksRight = /^[0-9a-f]{64}$/.test(token);\nreturn [{ json: {\n  token_hash: looksRight ? crypto.createHash('sha256').update(token).digest('hex') : 'none',\n  // Handed back to the caller so a page can pass it to its own fetches.\n  token: looksRight ? token : ''\n} }];\n" }
  },
  output: [{ token_hash: 'abc' }]
});

const findSession = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Find Session',
    position: [20, 600],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'dejMhLWVWTKdyYpo', cachedResultName: 'csp_sessions' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'token_hash', condition: 'eq', keyValue: expr('{{ $json.token_hash }}') }
        ]
      },
      returnAll: true
    }
  },
  output: [{ id: 1, token_hash: 'abc', email: 'sop@kantanna.com.au', expires_at: '2026-09-14T00:00:00.000Z' }]
});

const checkSession = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Check Session',
    position: [240, 600],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Gate, part two: decide whether the row the query found is a live session.\n//\n// The query already filtered on the token hash; expiry is checked here so\n// that an expired row can never authorise anything, however it was matched.\n// Returns a plain verdict - the caller branches on `authed` and nothing else.\nconst wanted = String($('Read Cookie').first().json.token_hash || '');\nconst nowIso = new Date().toISOString();\n\nlet hit = null;\nfor (const item of $input.all()) {\n  const r = item.json;\n  if (!r || !r.token_hash) continue;\n  if (String(r.token_hash) !== wanted) continue;\n  if (String(r.expires_at || '') <= nowIso) continue;\n  hit = r;\n  break;\n}\n\nreturn [{ json: {\n  authed: !!hit,\n  email: hit ? String(hit.email || '') : '',\n  expires_at: hit ? String(hit.expires_at || '') : '',\n  // Echoed back only when the session is real, so the portal can hand it to\n  // its own background calls - they cannot send the cookie from inside n8n\n  // Cloud's sandbox.\n  token: hit ? String($('Read Cookie').first().json.token || '') : ''\n} }];\n" }
  },
  output: [{ authed: true, email: 'sop@kantanna.com.au', expires_at: '2026-09-14T00:00:00.000Z' }]
});

const noteAccess = sticky(
  '## Sign-in for the CSP portal\n\n' +
  'Email OTP, limited to **kantanna.com**, **kantanna.com.au** and **kantanna.ph** ' +
  '(exact match on the part after the last @ - see `auth-prepare-code.js`).\n\n' +
  '**Codes** are six digits, good for 10 minutes, single use, five attempts, ' +
  'rate limited to 5/hour per address and 15/hour per IP. Only the SHA-256 hash ' +
  'is stored, so `csp_auth_codes` never holds anything sign-in-able.\n\n' +
  '**Sessions** are 32 random bytes in an HttpOnly cookie, stored hashed in ' +
  '`csp_sessions`, valid 14 days. `Access Check` is the sub-workflow every ' +
  'protected endpoint in workflow 02 and 03 calls - one copy of the check, so ' +
  'it cannot drift between endpoints.\n\n' +
  'The reply to a code request never varies, so this cannot be used to find out ' +
  'who works at Kantanna.',
  [authRequest, fetchCodes, prepareCode, shouldSend, pruneCodes, storeCode, sendCodeEmail, signinCodeTemplate, buildCodePage, respondCodePage],
  { color: 4 }
);

export default workflow('kantanna-csp-00-access', '00 · CSP Access')
  .add(authRequest)
  .to(fetchCodes)
  .to(prepareCode)
  .to(shouldSend
    .onTrue(pruneCodes.to(storeCode.to(sendCodeEmail.to(signinCodeTemplate))))
    .onFalse(signinCodeTemplate))
  .add(signinCodeTemplate)
  .to(buildCodePage)
  .to(respondCodePage)
  .add(authVerify)
  .to(fetchCodesForCheck)
  .to(checkCode)
  .to(signedIn
    .onTrue(deleteUsedCode.to(createSession.to(respondSignedIn)))
    .onFalse(bumpAttempts.to(signinCodeTemplate)))
  .add(authSignout)
  .to(signoutCookie)
  .to(readSignoutToken)
  .to(deleteSession)
  .to(respondSignedOut)
  .add(accessCheck)
  .to(readCookie)
  .to(findSession)
  .to(checkSession)
  .add(noteAccess);
