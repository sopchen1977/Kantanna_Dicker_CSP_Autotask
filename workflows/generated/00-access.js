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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Step one of email OTP sign-in: decide whether this request earns a code,\n// and if so, mint one.\n//\n// The reply is deliberately identical whether or not we would send to this\n// address, so the endpoint cannot be used to discover who works at Kantanna.\n// `send` decides what the workflow does; `message` is what the caller is\n// told, and it never varies.\nconst crypto = require('crypto');\n\n// Only these domains may sign in. Compared against the part after the LAST\n// \"@\", lowercased, as a WHOLE string. Never endsWith() - that would also\n// accept someone@not-kantanna.ph and someone@evil-kantanna.com.\nconst ALLOWED_DOMAINS = ['kantanna.com', 'kantanna.com.au', 'kantanna.ph'];\nconst CODE_TTL_MINUTES = 10;\n// Ceilings over a rolling hour, so codes cannot be requested in a loop to\n// flood an inbox or to churn the code space.\nconst MAX_PER_EMAIL_PER_HOUR = 5;\nconst MAX_PER_IP_PER_HOUR = 15;\n\nconst req = $('Auth Request').first().json || {};\nconst headers = req.headers || {};\nconst body = req.body || {};\nconst email = String(body.email || '').trim().toLowerCase();\nconst ip = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '')\n  .split(',')[0].trim();\n\nconst now = new Date();\n\nfunction domainOf(addr) {\n  const at = addr.lastIndexOf('@');\n  if (at < 1 || at === addr.length - 1) return '';\n  return addr.slice(at + 1);\n}\n// One @, something either side, a dot in the domain. Deliberately strict:\n// anything unusual simply is not a Kantanna address.\nconst shapeOk = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email);\nconst allowed = shapeOk && ALLOWED_DOMAINS.indexOf(domainOf(email)) >= 0;\n\nconst existing = $input.all().map((i) => i.json).filter((r) => r && r.email);\nconst hourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();\nconst recent = existing.filter((r) => String(r.requested_at || '') > hourAgo);\nconst perEmail = recent.filter((r) => String(r.email) === email).length;\nconst perIp = ip ? recent.filter((r) => String(r.request_ip || '') === ip).length : 0;\nconst rateOk = perEmail < MAX_PER_EMAIL_PER_HOUR && perIp < MAX_PER_IP_PER_HOUR;\n\nconst send = allowed && rateOk;\n\n// Rejection sampling over 32 random bits: draw again whenever the value\n// falls in the short final bucket, so every one of the million codes is\n// exactly as likely as any other. Math.random() would be predictable enough\n// to matter for something that is, briefly, a credential.\nfunction sixDigits() {\n  const span = 1000000;\n  const limit = Math.floor(4294967296 / span) * span;\n  for (;;) {\n    const n = crypto.randomBytes(4).readUInt32BE(0);\n    if (n < limit) return String(n % span).padStart(6, '0');\n  }\n}\n\nconst code = send ? sixDigits() : '';\n\n// Built here rather than in an n8n expression so the markup stays readable\n// and reviewable. Plain, high-contrast, and the code is selectable as text\n// so it can be copied on a phone.\nconst emailHtml =\n  '<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +\n  'font-size:15px;line-height:1.5;color:#0f172a\">' +\n  '<p>Here is your sign-in code for the Kantanna CSP pricing portal:</p>' +\n  '<p style=\"font-size:32px;font-weight:700;letter-spacing:.28em;' +\n  'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +\n  'margin:22px 0;color:#0d1b30\">' + code + '</p>' +\n  '<p>It expires in ' + CODE_TTL_MINUTES + ' minutes and can only be used once.</p>' +\n  '<p style=\"color:#64748b;font-size:13px;margin-top:24px\">' +\n  'If you did not ask to sign in, you can ignore this email - nobody can get in ' +\n  'without this code. Do not forward it to anyone.</p></div>';\n\nreturn [{ json: {\n  send: send,\n  email: email,\n  email_subject: code + ' is your CSP pricing sign-in code',\n  email_html: emailHtml,\n  // The plaintext code goes to the email node and nowhere else. Only its\n  // hash is stored, so the data table never holds anything sign-in-able.\n  code: code,\n  code_hash: code ? crypto.createHash('sha256').update(code).digest('hex') : '',\n  expires_at: new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),\n  attempts: 0,\n  requested_at: now.toISOString(),\n  request_ip: ip,\n  ttl_minutes: CODE_TTL_MINUTES,\n  // Always the same sentence, whatever was decided above.\n  message: 'If that is a Kantanna address, a sign-in code is on its way.'\n} }];\n" }
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
    // TODO: codes should come FROM a Kantanna mailbox, not gayle.ai - a
    // sign-in code arriving from another company's domain reads as phishing
    // and will hurt deliverability. 'Sop Kantanna Email' is not shared with
    // this n8n project, so it cannot be selected yet; share it, then swap.
    credentials: { microsoftOutlookOAuth2Api: newCredential('info@gayle.ai') }
  },
  output: [{ success: true }]
});

const respondRequested = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Requested',
    position: [1140, -300],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ message: $(\'Prepare Code\').first().json.message }) }}'),
      options: { responseHeaders: { entries: [
        { name: 'Cache-Control', value: 'no-store' }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Step two of email OTP sign-in: check the code, and on success mint the\n// session token that every other endpoint will be gated on.\n//\n// A wrong code costs an attempt. Five wrong attempts burn the code entirely,\n// which is what keeps six digits from being brute-forceable: a million\n// guesses at five per code is not a route in.\nconst crypto = require('crypto');\n\nconst SESSION_DAYS = 14;\nconst MAX_ATTEMPTS = 5;\n\nconst req = $('Auth Verify').first().json || {};\nconst headers = req.headers || {};\nconst body = req.body || {};\nconst email = String(body.email || '').trim().toLowerCase();\nconst code = String(body.code || '').trim();\nconst ip = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '')\n  .split(',')[0].trim();\n\nconst now = new Date();\nconst nowIso = now.toISOString();\n\n// Newest code for this address wins; asking for a second code invalidates\n// nothing, but only the latest is checked.\nconst rows = $input.all().map((i) => i.json)\n  .filter((r) => r && String(r.email || '').toLowerCase() === email);\nrows.sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || '')));\nconst row = rows[0] || null;\n\nconst live = !!row && String(row.expires_at || '') > nowIso;\nconst attemptsBefore = row ? Number(row.attempts || 0) : 0;\nconst spent = attemptsBefore >= MAX_ATTEMPTS;\n\nlet ok = false;\nif (live && !spent && /^[0-9]{6}$/.test(code)) {\n  const given = crypto.createHash('sha256').update(code).digest();\n  const want = Buffer.from(String(row.code_hash || ''), 'hex');\n  // timingSafeEqual throws on a length mismatch, so check that first. Both\n  // sides are SHA-256 digests, so in practice they always match.\n  ok = want.length === given.length && crypto.timingSafeEqual(given, want);\n}\n\nconst attemptsAfter = ok ? attemptsBefore : attemptsBefore + 1;\n// One message for every kind of failure, so a wrong code and an unknown\n// address are indistinguishable from outside.\nlet message = 'That code is not right, or it has expired. Ask for a new one.';\nif (!ok && (spent || attemptsAfter >= MAX_ATTEMPTS)) {\n  message = 'Too many attempts on that code. Ask for a new one.';\n}\n\n// 32 random bytes: the session token is the credential from here on, so it\n// is generated the same way a password reset token would be. Only its hash\n// is stored, so the sessions table cannot be replayed if it ever leaks.\nconst token = ok ? crypto.randomBytes(32).toString('hex') : '';\n\nreturn [{ json: {\n  ok: ok,\n  email: email,\n  message: ok ? 'Signed in.' : message,\n  token: token,\n  token_hash: ok ? crypto.createHash('sha256').update(token).digest('hex') : '',\n  session_expires_at: new Date(now.getTime() + SESSION_DAYS * 86400 * 1000).toISOString(),\n  session_max_age: SESSION_DAYS * 86400,\n  created_at: nowIso,\n  sign_in_ip: ip,\n  // Row bookkeeping: a used code is deleted, a failed one has its attempt\n  // count written back. row_id is 0 when no code row existed at all, which\n  // the workflow uses to skip the write rather than update every row.\n  row_id: row && row.id !== undefined && row.id !== null ? Number(row.id) : 0,\n  attempts_after: attemptsAfter\n} }];\n" }
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
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ ok: true, email: $(\'Check Code\').first().json.email }) }}'),
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

const respondDenied = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Denied',
    position: [680, 100],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ ok: false, message: $(\'Check Code\').first().json.message }) }}'),
      options: {
        responseCode: 401,
        responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }] }
      }
    }
  }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Gate, part one: pull the session token out of the Cookie header and hash\n// it, so what goes into the query is what the table actually stores.\n//\n// This runs as a sub-workflow so the six protected endpoints share one copy\n// of the check. Duplicated auth logic drifts, and a gate that is subtly\n// different on one endpoint is the endpoint that gets used.\nconst crypto = require('crypto');\n\nconst COOKIE_NAME = 'csp_session';\n\nconst raw = String(($input.first().json || {}).cookie || '');\nlet token = '';\nfor (const part of raw.split(';')) {\n  const s = part.trim();\n  if (s.slice(0, COOKIE_NAME.length + 1) === COOKIE_NAME + '=') {\n    token = s.slice(COOKIE_NAME.length + 1);\n    break;\n  }\n}\n\n// Only ever hash something that looks like one of our tokens. Anything else\n// is not worth a lookup, and 'none' is a value the table can never hold, so\n// the query returns empty rather than being skipped.\nconst looksRight = /^[0-9a-f]{64}$/.test(token);\nreturn [{ json: {\n  token_hash: looksRight\n    ? crypto.createHash('sha256').update(token).digest('hex')\n    : 'none'\n} }];\n" }
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
      workflowInputs: { values: [{ name: 'cookie', type: 'string' }] }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Gate, part one: pull the session token out of the Cookie header and hash\n// it, so what goes into the query is what the table actually stores.\n//\n// This runs as a sub-workflow so the six protected endpoints share one copy\n// of the check. Duplicated auth logic drifts, and a gate that is subtly\n// different on one endpoint is the endpoint that gets used.\nconst crypto = require('crypto');\n\nconst COOKIE_NAME = 'csp_session';\n\nconst raw = String(($input.first().json || {}).cookie || '');\nlet token = '';\nfor (const part of raw.split(';')) {\n  const s = part.trim();\n  if (s.slice(0, COOKIE_NAME.length + 1) === COOKIE_NAME + '=') {\n    token = s.slice(COOKIE_NAME.length + 1);\n    break;\n  }\n}\n\n// Only ever hash something that looks like one of our tokens. Anything else\n// is not worth a lookup, and 'none' is a value the table can never hold, so\n// the query returns empty rather than being skipped.\nconst looksRight = /^[0-9a-f]{64}$/.test(token);\nreturn [{ json: {\n  token_hash: looksRight\n    ? crypto.createHash('sha256').update(token).digest('hex')\n    : 'none'\n} }];\n" }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Gate, part two: decide whether the row the query found is a live session.\n//\n// The query already filtered on the token hash; expiry is checked here so\n// that an expired row can never authorise anything, however it was matched.\n// Returns a plain verdict - the caller branches on `authed` and nothing else.\nconst wanted = String($('Read Cookie').first().json.token_hash || '');\nconst nowIso = new Date().toISOString();\n\nlet hit = null;\nfor (const item of $input.all()) {\n  const r = item.json;\n  if (!r || !r.token_hash) continue;\n  if (String(r.token_hash) !== wanted) continue;\n  if (String(r.expires_at || '') <= nowIso) continue;\n  hit = r;\n  break;\n}\n\nreturn [{ json: {\n  authed: !!hit,\n  email: hit ? String(hit.email || '') : '',\n  expires_at: hit ? String(hit.expires_at || '') : ''\n} }];\n" }
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
  [authRequest, fetchCodes, prepareCode, shouldSend, pruneCodes, storeCode, sendCodeEmail, respondRequested],
  { color: 4 }
);

export default workflow('kantanna-csp-00-access', '00 · CSP Access')
  .add(authRequest)
  .to(fetchCodes)
  .to(prepareCode)
  .to(shouldSend
    .onTrue(pruneCodes.to(storeCode.to(sendCodeEmail.to(respondRequested))))
    .onFalse(respondRequested))
  .add(authVerify)
  .to(fetchCodesForCheck)
  .to(checkCode)
  .to(signedIn
    .onTrue(deleteUsedCode.to(createSession.to(respondSignedIn)))
    .onFalse(bumpAttempts.to(respondDenied)))
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
