import { workflow, node, trigger, sticky, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const portalPage = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Portal Page',
    position: [-380, -240],
    parameters: { httpMethod: 'GET', path: 'csp-pricing', responseMode: 'responseNode', options: { ignoreBots: true } }
  },
  output: [{ headers: {}, params: {}, query: {}, body: {} }]
});

const fetchLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Lines',
    position: [-140, -240],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: '__LINES_TABLE_ID__', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', offer_name: 'Microsoft 365 Business Premium', qty: 275, monthly_cost: 28.19, monthly_rrp: 34.55, sync_status: 'pending' }]
});

const fetchMappings = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Mappings',
    position: [100, -240],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: '__MAPPINGS_TABLE_ID__', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', autotask_company_id: 123, autotask_company_name: 'Atlas Outsourcing' }]
});

// The three Autotask queries below each cover every contract on screen in a
// single call, so they are executeOnce: without it they re-run for every item
// Fetch Mappings emits and the duplicate requests trip Autotask's limit of 3
// concurrent API threads (429).
//
// The portal shows what Autotask has RIGHT NOW, not what the last sync
// happened to record - so a description or price edited by hand in Autotask
// shows up on the next page load. One query covers every contract on screen
// (Autotask's `in` operator), and a failure here is non-fatal: the page still
// renders from the stored values.
const fetchLiveServices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Live Services',
    executeOnce: true,
    position: [340, -240],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://webservices31.autotask.net/atservicesrest/v1.0/ContractServices/query',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: (() => { const ids = [...new Set($("Fetch Lines").all().map((i) => i.json.autotask_contract_id).filter((v) => v))]; return ids.length ? [{ op: "in", field: "contractID", value: ids }] : [{ op: "eq", field: "id", value: 0 }]; })() }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// What Autotask has already approved & posted. A BillingItem only exists
// once a charge has been through Approve & Post, so the newest itemDate per
// contract service is that service's last posting, and its invoiceID says
// whether the posting has since been invoiced. One query covers every
// contract on screen; a failure here is non-fatal.
const fetchBillingItems = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Billing Items',
    executeOnce: true,
    position: [400, -240],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://webservices31.autotask.net/atservicesrest/v1.0/BillingItems/query',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: (() => { const ids = [...new Set($("Fetch Lines").all().map((i) => i.json.autotask_contract_id).filter((v) => v))]; return ids.length ? [{ op: "in", field: "contractID", value: ids }] : [{ op: "eq", field: "id", value: 0 }]; })() }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// The invoice each posting landed on. BillingItems carry only an invoiceID,
// and the number a customer actually quotes lives on the Invoice itself.
const fetchInvoices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Invoices',
    executeOnce: true,
    position: [430, -240],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://webservices31.autotask.net/atservicesrest/v1.0/Invoices/query',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: (() => { let bi = []; try { bi = $("Fetch Billing Items").first().json.items || []; } catch (e) {} const ids = [...new Set(bi.map((b) => Number(b.invoiceID)).filter((v) => v > 0))]; return ids.length ? [{ op: "in", field: "id", value: ids }] : [{ op: "eq", field: "id", value: 0 }]; })() }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// The page itself, held as a plain string on a Set node. Keeping it out of
// the Build Portal Page code node means the assembly logic can be changed
// without re-deploying 55KB of HTML, and the page carries no escaping layer.
// Generated from portal/portal.html at build time - edit that file.
const portalTemplate = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Portal Template',
    position: [460, -240],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [{ id: 'portal-html', name: 'html', type: 'string', value: __PORTAL_HTML__ }]
      }
    }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const buildPage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Portal Page',
    position: [340, -240],
    parameters: { mode: 'runOnceForAllItems', jsCode: __BUILD_PORTAL_PAGE__ }
  },
  output: [{ html: '<!DOCTYPE html>...' }]
});

const respondPage = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Portal Page',
    position: [580, -240],
    parameters: {
      respondWith: 'text',
      responseBody: expr('{{ $json.html }}'),
      // No caching: the page carries the current pricing data and the current
      // portal code, so a browser-cached copy would silently show stale lines.
      options: { responseHeaders: { entries: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store, must-revalidate' }
      ] } }
    }
  }
});

const savePricing = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Save Pricing',
    position: [-380, 0],
    parameters: { httpMethod: 'POST', path: 'csp-pricing-save', responseMode: 'responseNode', options: {} }
  },
  output: [{ body: { lines: [{ subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', use_custom_price: true, sell_price: 33, include: true }] } }]
});

const splitSaved = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Split Saved Lines',
    position: [-140, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: __SPLIT_SAVE_LINES__ }
  },
  output: [{ subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', use_custom_price: true, sell_price: 33, include: true }]
});

const updatePricing = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Update Line Pricing',
    position: [100, 0],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: '__LINES_TABLE_ID__', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'subscription_id', condition: 'eq', keyValue: expr('{{ $json.subscription_id }}') },
          { keyName: 'stock_code', condition: 'eq', keyValue: expr('{{ $json.stock_code }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          use_custom_price: expr('{{ $json.use_custom_price }}'),
          sell_price: expr('{{ $json.sell_price }}'),
          include: expr('{{ $json.include }}'),
          price_effective_date: expr('{{ $json.price_effective_date }}'),
          invoice_description: expr('{{ $json.invoice_description }}')
        },
        schema: [
          { id: 'use_custom_price', displayName: 'use_custom_price', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: false },
          { id: 'sell_price', displayName: 'sell_price', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'include', displayName: 'include', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: false },
          { id: 'price_effective_date', displayName: 'price_effective_date', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'invoice_description', displayName: 'invoice_description', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, subscription_id: '2F295B21', sell_price: 33 }]
});

const saveSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Save Summary',
    position: [340, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: __SAVE_SUMMARY__ }
  },
  output: [{ ok: true, updated: 12 }]
});

const respondSave = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Save', position: [580, 0], parameters: { respondWith: 'firstIncomingItem', options: {} } }
});

const saveMapping = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Save Mapping',
    position: [-380, 240],
    parameters: { httpMethod: 'POST', path: 'csp-pricing-mapping', responseMode: 'responseNode', options: {} }
  },
  output: [{ body: { tenant_name: 'Galilee Solicitors', autotask_company_id: 456, autotask_company_name: 'Galilee Solicitors Pty Ltd' } }]
});

const upsertMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Upsert Mapping',
    position: [-140, 240],
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: '__MAPPINGS_TABLE_ID__', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'tenant_name', condition: 'eq', keyValue: expr('{{ $(\'Save Mapping\').first().json.body.tenant_name }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          tenant_name: expr('{{ $(\'Save Mapping\').first().json.body.tenant_name }}'),
          autotask_company_id: expr('{{ $(\'Save Mapping\').first().json.body.autotask_company_id }}'),
          autotask_company_name: expr('{{ $(\'Save Mapping\').first().json.body.autotask_company_name }}')
        },
        schema: [
          { id: 'tenant_name', displayName: 'tenant_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'autotask_company_id', displayName: 'autotask_company_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_company_name', displayName: 'autotask_company_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, tenant_name: 'Galilee Solicitors', autotask_company_id: 456 }]
});

const respondMapping = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Mapping', position: [100, 240], parameters: { respondWith: 'firstIncomingItem', options: {} } }
});

const companySearch = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Company Search',
    position: [-380, 480],
    parameters: { httpMethod: 'GET', path: 'csp-pricing-companies', responseMode: 'responseNode', options: {} }
  },
  output: [{ query: { q: 'galilee' } }]
});

const portalConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Portal Autotask Config',
    position: [-140, 480],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'cfg-base-url', name: 'base_url', type: 'string', value: 'https://webservices31.autotask.net/atservicesrest/v1.0' }
        ]
      }
    }
  },
  output: [{ base_url: 'https://webservices31.autotask.net/atservicesrest/v1.0', query: { q: 'galilee' } }]
});

const queryCompanies = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Query Companies',
    position: [100, 480],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr('{{ $json.base_url }}/Companies/query'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 25, Filter: [{ op: "contains", field: "companyName", value: $("Company Search").first().json.query.q || "" }, { op: "eq", field: "isActive", value: true }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [{ id: 456, companyName: 'Galilee Solicitors Pty Ltd' }], pageDetails: { count: 1 } }]
});

const companiesResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Companies Response',
    position: [340, 480],
    parameters: { mode: 'runOnceForAllItems', jsCode: __COMPANIES_RESPONSE__ }
  },
  output: [{ companies: [{ id: 456, name: 'Galilee Solicitors Pty Ltd' }] }]
});

const respondCompanies = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Companies', position: [580, 480], parameters: { respondWith: 'firstIncomingItem', options: {} } }
});

const importRedirect = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Import Redirect',
    position: [-380, 720],
    parameters: { httpMethod: 'GET', path: 'csp-import', responseMode: 'responseNode', options: {} }
  },
  output: [{ headers: {}, query: {} }]
});

const redirectToForm = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Redirect To Form',
    position: [-140, 720],
    parameters: {
      respondWith: 'redirect',
      redirectURL: 'https://gayleai.app.n8n.cloud/form/csp-monthly-upload',
      options: {}
    }
  }
});

// The uploaded tabs, served verbatim. ?sheet=annuity | invoice.
//
// NOT plain "csp-report": something else on this instance already holds that
// path and n8n refuses to publish a second workflow claiming it. Namespacing
// under csp-pricing- keeps it with the portal's other routes, which is where
// it belongs anyway.
const reportView = node({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: {
    name: 'Report View',
    position: [-360, 960],
    webhookId: 'csp-report-view',
    parameters: { httpMethod: 'GET', path: 'csp-pricing-source', responseMode: 'responseNode', options: { ignoreBots: true } }
  },
  output: [{ query: { sheet: 'annuity' } }]
});

const fetchReportRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Report Rows',
    position: [-140, 960],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: '__REPORT_TABLE_ID__', cachedResultName: 'csp_report_rows' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, sheet: 'annuity', row_no: 1, data: '{"TENANT ID":"211C4C89-…"}', source_file: 'Annuity_Information.xlsx', imported_at: '2026-08-29T08:14:15.039Z' }]
});

const reportTemplate = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Report Template',
    position: [80, 960],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [{ id: 'report-html', name: 'html', type: 'string', value: __REPORT_HTML__ }]
      }
    }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const buildReport = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Report Page',
    position: [300, 960],
    parameters: { mode: 'runOnceForAllItems', jsCode: __BUILD_REPORT_PAGE__ }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const respondReport = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Report Page',
    position: [520, 960],
    parameters: {
      respondWith: 'text',
      responseBody: expr('{{ $json.html }}'),
      options: {
        responseHeaders: { entries: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store, must-revalidate' }
        ] }
      }
    }
  }
});


/* ============================================================
   Access gates
   ------------------------------------------------------------
   Every endpoint calls the same Access Check sub-workflow in
   workflow 00 before it touches any data. The check sits BEFORE
   the fetches deliberately: an anonymous request should not cost
   an Autotask API call, and should not read a customer's prices
   only to throw the page away afterwards.

   Pages fall back to the sign-in screen, so signing in and
   reloading lands on the page that was asked for. The JSON
   endpoints answer 401 instead, which the portal turns into
   "your session has expired".
   ============================================================ */

const checkAccessPortal = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Portal',
    position: [-600, -240],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { cookie: expr('{{ $json.headers.cookie || \'\' }}') },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedPortal = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Portal?',
    position: [-480, -240],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessSave = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Save',
    position: [-600, 0],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { cookie: expr('{{ $json.headers.cookie || \'\' }}') },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedSave = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Save?',
    position: [-480, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessMapping = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Mapping',
    position: [-600, 240],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { cookie: expr('{{ $json.headers.cookie || \'\' }}') },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedMapping = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Mapping?',
    position: [-480, 240],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessCompanies = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Companies',
    position: [-600, 480],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { cookie: expr('{{ $json.headers.cookie || \'\' }}') },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedCompanies = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Companies?',
    position: [-480, 480],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessReport = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Report',
    position: [-600, 620],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { cookie: expr('{{ $json.headers.cookie || \'\' }}') },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedReport = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Report?',
    position: [-480, 620],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessImport = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Import',
    position: [-600, 720],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { cookie: expr('{{ $json.headers.cookie || \'\' }}') },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedImport = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Import?',
    position: [-480, 720],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

// Served in place of any protected PAGE when there is no session.
// Generated from portal/signin.html at build time - edit that file.
const signinTemplate = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Sign-in Template',
    position: [-140, -120],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [{ id: 'signin-html', name: 'html', type: 'string', value: __SIGNIN_HTML__ }]
      }
    }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const respondSignin = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Sign-in',
    position: [80, -120],
    parameters: {
      respondWith: 'text',
      responseBody: expr('{{ $json.html }}'),
      options: { responseCode: 200, responseHeaders: { entries: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store, must-revalidate' }
      ] } }
    }
  }
});

// The JSON endpoints get a 401 rather than a login page - they are called by
// fetch() from a page that is already open, so the useful thing to say is
// "reload", not "here is a form you cannot see".
const respondUnauthorised = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Unauthorised',
    position: [-140, 900],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ ok: false, error: 'Not signed in', message: 'Your session has expired. Reload the page and sign in again.' }) }}"),
      options: { responseCode: 401, responseHeaders: { entries: [
        { name: 'Cache-Control', value: 'no-store' }
      ] } }
    }
  }
});

const notePortal = sticky(
  '## 02 · Pricing Portal\nOpen GET /webhook/csp-pricing in a browser.\n- Sell price defaults to the monthly RRP from the annuity file; tick Custom to override per line.\n- Map each Dicker tenant to an Autotask company before syncing.\n- The Sync button POSTs to workflow 03 (path csp-autotask-sync).\n\nSet your Autotask zone URL in "Portal Autotask Config".',
  [portalPage, fetchLines],
  { color: 5 }
);

export default workflow('kantanna-csp-02-portal', '02 · CSP Pricing Portal')
  .add(portalPage)
  .to(checkAccessPortal)
  .to(authedPortal.onTrue(fetchLines).onFalse(signinTemplate))
  .add(fetchLines)
  .to(fetchMappings)
  .to(fetchLiveServices)
  .to(fetchBillingItems)
  .to(fetchInvoices)
  .to(portalTemplate)
  .to(buildPage)
  .to(respondPage)
  .add(signinTemplate)
  .to(respondSignin)
  .add(savePricing)
  .to(checkAccessSave)
  .to(authedSave.onTrue(splitSaved).onFalse(respondUnauthorised))
  .add(splitSaved)
  .to(updatePricing)
  .to(saveSummary)
  .to(respondSave)
  .add(saveMapping)
  .to(checkAccessMapping)
  .to(authedMapping.onTrue(upsertMapping).onFalse(respondUnauthorised))
  .add(upsertMapping)
  .to(respondMapping)
  .add(companySearch)
  .to(checkAccessCompanies)
  .to(authedCompanies.onTrue(portalConfig).onFalse(respondUnauthorised))
  .add(portalConfig)
  .to(queryCompanies)
  .to(companiesResponse)
  .to(respondCompanies)
  .add(reportView)
  .to(checkAccessReport)
  .to(authedReport.onTrue(fetchReportRows).onFalse(signinTemplate))
  .add(fetchReportRows)
  .to(reportTemplate)
  .to(buildReport)
  .to(respondReport)
  .add(importRedirect)
  .to(checkAccessImport)
  .to(authedImport.onTrue(redirectToForm).onFalse(signinTemplate))
  .add(notePortal);
