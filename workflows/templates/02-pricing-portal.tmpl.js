import { workflow, node, trigger, sticky, newCredential, expr } from '@n8n/workflow-sdk';

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
          { keyName: 'tenant_name', condition: 'eq', keyValue: expr('{{ $json.body.tenant_name }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          tenant_name: expr('{{ $json.body.tenant_name }}'),
          autotask_company_id: expr('{{ $json.body.autotask_company_id }}'),
          autotask_company_name: expr('{{ $json.body.autotask_company_name }}')
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
      redirectURL: 'https://gayleai.app.n8n.cloud/form/5c4bd81e-8556-4639-835f-4de4a7faefb3',
      options: {}
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
  .to(fetchLines)
  .to(fetchMappings)
  .to(buildPage)
  .to(respondPage)
  .add(savePricing)
  .to(splitSaved)
  .to(updatePricing)
  .to(saveSummary)
  .to(respondSave)
  .add(saveMapping)
  .to(upsertMapping)
  .to(respondMapping)
  .add(companySearch)
  .to(portalConfig)
  .to(queryCompanies)
  .to(companiesResponse)
  .to(respondCompanies)
  .add(importRedirect)
  .to(redirectToForm)
  .add(notePortal);
