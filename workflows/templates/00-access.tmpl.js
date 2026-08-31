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
      dataTableId: { __rl: true, mode: 'id', value: '__AUTH_CODES_TABLE_ID__', cachedResultName: 'csp_auth_codes' },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __AUTH_PREPARE_CODE__ }
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
      dataTableId: { __rl: true, mode: 'id', value: '__AUTH_CODES_TABLE_ID__', cachedResultName: 'csp_auth_codes' },
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
      dataTableId: { __rl: true, mode: 'id', value: '__AUTH_CODES_TABLE_ID__', cachedResultName: 'csp_auth_codes' },
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
        assignments: [{ id: 'signin-code-html', name: 'html', type: 'string', value: __SIGNIN_CODE_HTML__ }]
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __AUTH_BUILD_CODE_PAGE__ }
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
      dataTableId: { __rl: true, mode: 'id', value: '__AUTH_CODES_TABLE_ID__', cachedResultName: 'csp_auth_codes' },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __AUTH_CHECK_CODE__ }
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
      dataTableId: { __rl: true, mode: 'id', value: '__AUTH_CODES_TABLE_ID__', cachedResultName: 'csp_auth_codes' },
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
      dataTableId: { __rl: true, mode: 'id', value: '__SESSIONS_TABLE_ID__', cachedResultName: 'csp_sessions' },
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
      redirectURL: expr('{{ $(\'Check Code\').first().json.next_safe }}'),
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
      dataTableId: { __rl: true, mode: 'id', value: '__AUTH_CODES_TABLE_ID__', cachedResultName: 'csp_auth_codes' },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __AUTH_READ_COOKIE__ }
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
      dataTableId: { __rl: true, mode: 'id', value: '__SESSIONS_TABLE_ID__', cachedResultName: 'csp_sessions' },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __AUTH_READ_COOKIE__ }
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
      dataTableId: { __rl: true, mode: 'id', value: '__SESSIONS_TABLE_ID__', cachedResultName: 'csp_sessions' },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __AUTH_CHECK_SESSION__ }
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
