import { workflow, node, trigger, sticky, newCredential, ifElse, switchCase, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';

const startSync = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Start Sync',
    position: [-620, 0],
    parameters: { httpMethod: 'POST', path: 'csp-autotask-sync', responseMode: 'onReceived', options: {} }
  },
  output: [{ body: {} }]
});

const autotaskConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Autotask Config',
    position: [-400, 0],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'cfg-base-url', name: 'base_url', type: 'string', value: 'https://webservices31.autotask.net/atservicesrest/v1.0' },
          { id: 'cfg-billing-code', name: 'billing_code_id', type: 'number', value: 29683278 },
          { id: 'cfg-contract-type', name: 'contract_type', type: 'number', value: 7 },
          { id: 'cfg-contract-status', name: 'contract_status', type: 'number', value: 1 },
          { id: 'cfg-contract-period', name: 'contract_period_type', type: 'number', value: 2 },
          { id: 'cfg-service-period', name: 'service_period_type', type: 'number', value: 2 }
        ]
      }
    }
  },
  output: [{ base_url: 'https://webservices31.autotask.net/atservicesrest/v1.0', billing_code_id: 29683278, contract_type: 7, contract_status: 1, contract_period_type: 2, service_period_type: 2 }]
});

const fetchSyncLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Sync Lines',
    position: [-180, 0],
    executeOnce: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'FDGqV46wAYu9bnGe', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', sku: 'CFQ7TTC0LCHC', offer_name: 'Microsoft 365 Business Premium', qty: 275, charge_type: 'NCE', status: 'Active', monthly_cost: 28.19, monthly_rrp: 34.55, use_custom_price: false, sell_price: null, include: null, term_months: 12, term_start: '2025-08-31', term_end: '2026-08-30' }]
});

const prepareLines = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Lines',
    position: [40, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Decide which lines to sync and precompute everything Autotask needs.\n// Default include rule: NCE + Active + has an RRP. Explicit include/exclude\n// saved from the portal always wins.\nconst rows = $input.all().map((i) => i.json).filter((j) => j.subscription_id);\nconst today = new Date().toISOString().slice(0, 10);\n\nfunction addMonths(iso, months) {\n  const d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  d.setUTCMonth(d.getUTCMonth() + months);\n  return d.toISOString().slice(0, 10);\n}\n\n// Billing-type metadata. The Autotask Service is created with a matching\n// period type, so the contract bills it monthly or annually as appropriate.\n// Autotask REST periodType picklist (integers): 2=Monthly, 3=Quarterly,\n// 4=Semi-Annual, 5=Yearly.\n//   annual_monthly -> Annual commit, billed monthly   (periodType 2)\n//   annual_upfront -> Annual commit, billed annually  (periodType 5)\n//   monthly        -> Month-to-month                  (periodType 2)\nconst BILLING = {\n  annual_monthly: { label: 'Annual Commit (Billed Monthly)', period_type: 2, key: 'ANN-MO' },\n  annual_upfront: { label: 'Annual Commit (Billed Annually)', period_type: 5, key: 'ANN-YR' },\n  monthly: { label: 'Month to Month', period_type: 2, key: 'MTM' },\n  usage: { label: 'Usage', period_type: 2, key: 'USAGE' },\n};\n\nconst out = [];\nfor (const l of rows) {\n  const billingType = l.billing_type ||\n    (l.term_months > 1 ? 'annual_monthly' : 'monthly');\n  const billing = BILLING[billingType] || BILLING.monthly;\n  const periodRrp = Number(l.period_rrp !== null && l.period_rrp !== undefined ? l.period_rrp : l.monthly_rrp) || 0;\n  const periodCost = Number(l.period_cost !== null && l.period_cost !== undefined ? l.period_cost : l.monthly_cost) || 0;\n\n  const active = l.status === 'Active';\n  const defInclude = l.charge_type === 'NCE' && active && periodRrp > 0;\n  const inc = l.include === true ? true : (l.include === false ? false : defInclude);\n  if (!inc) continue;\n\n  const serviceKey = billing.key + ':' + (l.sku || 'CSP');\n  // Sell price is per billing period (per month, or per year for upfront).\n  const effectiveSell =\n    l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined\n      ? Number(l.sell_price)\n      : periodRrp;\n\n  const contractStart = l.term_start || l.usage_start || today;\n  const contractEnd = l.term_end || addMonths(contractStart, l.term_months || 12) || contractStart;\n  // Autotask-style \"effective from\" date for price/unit changes,\n  // chosen per line in the pricing portal. Defaults to today.\n  const effectiveDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(l.price_effective_date || ''))\n    ? String(l.price_effective_date) : today;\n\n  out.push({ json: Object.assign({}, l, {\n    line_key: l.subscription_id + '|' + l.stock_code,\n    billing_type: billingType,\n    billing_label: billing.label,\n    service_key: serviceKey,\n    service_name: (String(l.offer_name || 'CSP Service') + ' - ' + billing.label + ' [' + (l.sku || 'CSP') + ']').slice(0, 100),\n    service_period_type: billing.period_type,\n    period_rrp: periodRrp,\n    period_cost: periodCost,\n    // REQUIREMENT: the Subscription ID is always part of the contract name.\n    contract_name: ('CSP - ' + String(l.offer_name || '') + ' - ' + l.subscription_id).slice(0, 250),\n    effective_sell: Math.round(effectiveSell * 100) / 100,\n    contract_start: contractStart,\n    contract_end: contractEnd,\n    price_effective_date: effectiveDate,\n    today: today,\n  }) });\n}\nreturn out;\n" }
  },
  output: [{ tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_key: 'P1Y:CFQ7TTC0LCHC', service_name: 'Microsoft 365 Business Premium [P1Y:CFQ7TTC0LCHC]', contract_name: 'CSP - Microsoft 365 Business Premium - 2F295B21', effective_sell: 34.55, qty: 275, monthly_cost: 28.19, monthly_rrp: 34.55, contract_start: '2025-08-31', contract_end: '2026-08-30', today: '2026-08-26', stock_description: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT' }]
});

const syncLoop = splitInBatches({
  version: 3,
  config: { name: 'Sync Loop', position: [280, 0], parameters: { batchSize: 1, options: {} } }
});

const syncDone = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sync Done',
    position: [520, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// End of the sync loop.\nreturn [{ json: { done: true, finished_at: new Date().toISOString() } }];\n" }
  },
  output: [{ done: true }]
});

const currentLine = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Current Line',
    position: [520, 120],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'cl-marker', name: 'in_sync', type: 'boolean', value: true }
        ]
      }
    }
  },
  output: [{ in_sync: true, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_key: 'P1Y:CFQ7TTC0LCHC', service_name: 'Microsoft 365 Business Premium [P1Y:CFQ7TTC0LCHC]', contract_name: 'CSP - Microsoft 365 Business Premium - 2F295B21', effective_sell: 34.55, qty: 275, monthly_cost: 28.19, monthly_rrp: 34.55, contract_start: '2025-08-31', contract_end: '2026-08-30', today: '2026-08-26', stock_description: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT' }]
});

const lookupMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Lookup Mapping',
    position: [740, 120],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'U7ymd9nAyD0GCLYb', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'tenant_name', condition: 'eq', keyValue: expr('{{ $json.tenant_name }}') }
        ]
      },
      returnAll: false,
      limit: 1
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', autotask_company_id: 123, autotask_company_name: 'Atlas Outsourcing' }]
});

const isMapped = ifElse({
  version: 2.2,
  config: {
    name: 'Is Mapped?',
    position: [960, 120],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.autotask_company_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const markNeedsMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Mark Needs Mapping',
    position: [1180, 320],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: 'FDGqV46wAYu9bnGe', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'subscription_id', condition: 'eq', keyValue: expr("{{ $('Current Line').first().json.subscription_id }}") },
          { keyName: 'stock_code', condition: 'eq', keyValue: expr("{{ $('Current Line').first().json.stock_code }}") }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          sync_status: 'needs_mapping',
          sync_message: 'Customer is not mapped to an Autotask company yet. Map it in the pricing portal.'
        },
        schema: [
          { id: 'sync_status', displayName: 'sync_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sync_message', displayName: 'sync_message', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, sync_status: 'needs_mapping' }]
});

const findService = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Service',
    position: [1180, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Services/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 5, Filter: [{ op: "eq", field: "name", value: $("Current Line").first().json.service_name }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const serviceDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Service Decision',
    position: [1400, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask Services/query response. Decide whether the service exists.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nconst found = items.length ? items[0] : null;\nreturn [{ json: {\n  line_key: line.line_key,\n  service_id: found ? found.id : null,\n  need_service: !found,\n  query_error: resp.error ? String(resp.error.message || resp.error) : '',\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_id: null, need_service: true, query_error: '' }]
});

const needService = ifElse({
  version: 2.2,
  config: {
    name: 'Need Service?',
    position: [1620, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.need_service }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const createService = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Create Service',
    position: [1840, -120],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Services"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ name: $("Current Line").first().json.service_name, description: ("Microsoft CSP subscription service - " + $("Current Line").first().json.billing_label + " - " + $("Current Line").first().json.stock_description).slice(0, 380), sku: String($("Current Line").first().json.service_key || "").slice(0, 50), unitPrice: $("Current Line").first().json.period_rrp, unitCost: $("Current Line").first().json.period_cost, periodType: Number($("Current Line").first().json.service_period_type), billingCodeID: Number($("Autotask Config").first().json.billing_code_id), isActive: true }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 9001 }]
});

const serviceFromCreate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Service From Create',
    position: [2060, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask create-service response ({ itemId }) or an error payload.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nreturn [{ json: {\n  line_key: line.line_key,\n  service_id: resp.itemId || null,\n  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)\n    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_id: 9001, create_error: '' }]
});

const recordService = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Record Service',
    position: [2280, 20],
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: 'ai3p8JIYv082bfjn', cachedResultName: 'csp_sku_services' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'sku', condition: 'eq', keyValue: expr("{{ $('Current Line').first().json.service_key }}") }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          sku: expr("{{ $('Current Line').first().json.service_key }}"),
          service_name: expr("{{ $('Current Line').first().json.service_name }}"),
          autotask_service_id: expr('{{ $json.service_id }}'),
          unit_rrp: expr("{{ $('Current Line').first().json.period_rrp }}")
        },
        schema: [
          { id: 'sku', displayName: 'sku', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'service_name', displayName: 'service_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'autotask_service_id', displayName: 'autotask_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'unit_rrp', displayName: 'unit_rrp', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, sku: 'P1Y:CFQ7TTC0LCHC', service_name: 'Microsoft 365 Business Premium [P1Y:CFQ7TTC0LCHC]', autotask_service_id: 9001, unit_rrp: 34.55 }]
});

const findContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Contract',
    position: [2500, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 10, Filter: [{ op: "eq", field: "companyID", value: $("Lookup Mapping").first().json.autotask_company_id }, { op: "contains", field: "contractName", value: $("Current Line").first().json.subscription_id }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const contractDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contract Decision',
    position: [2720, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask Contracts/query response (matched on companyID + contract\n// name containing the Subscription ID). Decide whether the contract exists.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nconst found = items.length ? items[0] : null;\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: found ? found.id : null,\n  need_contract: !found,\n  query_error: resp.error ? String(resp.error.message || resp.error) : '',\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: null, need_contract: true, query_error: '' }]
});

const needContract = ifElse({
  version: 2.2,
  config: {
    name: 'Need Contract?',
    position: [2940, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.need_contract }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const createContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Create Contract',
    position: [3160, -120],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ companyID: $("Lookup Mapping").first().json.autotask_company_id, contractName: $("Current Line").first().json.contract_name, contractType: Number($("Autotask Config").first().json.contract_type), status: Number($("Autotask Config").first().json.contract_status), startDate: $("Current Line").first().json.contract_start, endDate: $("Current Line").first().json.contract_end, contractPeriodType: Number($("Autotask Config").first().json.contract_period_type), timeReportingRequiresStartAndStopTimes: 0, setupFee: 0, description: ("Dicker Data CSP subscription " + $("Current Line").first().json.subscription_id + " - " + $("Current Line").first().json.offer_name + ". Managed by the Kantanna n8n automation.").slice(0, 1900) }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 7001 }]
});

const contractFromCreate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contract From Create',
    position: [3380, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask create-contract response ({ itemId }) or an error payload.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: resp.itemId || null,\n  contract_created: !!resp.itemId,\n  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)\n    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, contract_created: true, create_error: '' }]
});

const fetchContractServices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Contract Services',
    position: [3600, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServices/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 200, Filter: [{ op: "eq", field: "contractID", value: $json.contract_id || 0 }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const csDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS Decision',
    position: [3820, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask ContractServices/query response for the contract.\n// Decide whether to create the contract service, re-price it, or do nothing.\nconst line = $('Current Line').first().json;\nconst prev = $('Contract Decision').first().json;\nlet cid = prev.line_key === line.line_key ? prev.contract_id : null;\ntry {\n  const created = $('Contract From Create').first().json;\n  if (created.line_key === line.line_key && created.contract_id) cid = created.contract_id;\n} catch (e) { /* create branch did not run this iteration */ }\n\nconst svcRow = $('Record Service').first().json;\nconst serviceId = svcRow.sku === line.service_key ? svcRow.autotask_service_id : null;\n\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nconst cs = items.find((c) => Number(c.serviceID) === Number(serviceId)) || null;\n\nlet action = 'none';\nif (!cid || !serviceId) action = 'none';\nelse if (!cs) action = 'create';\nelse if (Math.abs(Number(cs.adjustedPrice || 0) - Number(line.effective_sell)) > 0.005) action = 'patch';\n\nreturn [{ json: {\n  line_key: line.line_key,\n  action: action,\n  contract_id: cid,\n  service_id: serviceId,\n  cs_id: cs ? cs.id : null,\n  old_price: cs ? Number(cs.adjustedPrice || 0) : null,\n  sell: Number(line.effective_sell),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'create', contract_id: 7001, service_id: 9001, cs_id: null, old_price: null, sell: 34.55 }]
});

const csRoute = switchCase({
  version: 3.2,
  config: {
    name: 'CS Route',
    position: [4040, 20],
    parameters: {
      rules: {
        values: [
          { outputKey: 'create', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'create' }], combinator: 'and' } },
          { outputKey: 'patch', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'patch' }], combinator: 'and' } },
          { outputKey: 'none', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'none' }], combinator: 'and' } }
        ]
      },
      options: {}
    }
  }
});

const createCS = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Create Contract Service',
    position: [4260, -180],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $json.contract_id }}/Services"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ contractID: $json.contract_id, serviceID: $json.service_id, adjustedPrice: $json.sell }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 8001 }]
});

const csFromCreate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS From Create',
    position: [4480, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask create-contract-service response ({ itemId }).\nconst line = $('Current Line').first().json;\nconst dec = $('CS Decision').first().json;\nconst resp = $input.first().json || {};\nreturn [{ json: {\n  line_key: line.line_key,\n  action: 'create',\n  contract_id: dec.contract_id,\n  service_id: dec.service_id,\n  cs_id: resp.itemId || null,\n  sell: dec.sell,\n  cs_created: !!resp.itemId,\n  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)\n    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'create', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, cs_created: true, create_error: '' }]
});

const patchCS = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Patch Contract Service',
    position: [4260, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $json.contract_id }}/ServiceAdjustments"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ contractID: $json.contract_id, serviceID: $json.service_id, unitChange: 0, adjustedUnitPrice: $json.sell, effectiveDate: $("Current Line").first().json.price_effective_date }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 8001 }]
});

const csAfterPatch = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS After Patch',
    position: [4480, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask service-adjustment (re-price) response.\nconst line = $('Current Line').first().json;\nconst dec = $('CS Decision').first().json;\nconst resp = $input.first().json || {};\nreturn [{ json: {\n  line_key: line.line_key,\n  action: 'patch',\n  contract_id: dec.contract_id,\n  service_id: dec.service_id,\n  cs_id: dec.cs_id,\n  sell: dec.sell,\n  old_price: dec.old_price,\n  effective_date: line.price_effective_date || line.today,\n  patch_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)\n    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'patch', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 33, old_price: 34.55, patch_error: '' }]
});

const fetchUnits = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch CS Units',
    position: [4700, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServiceUnits/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 100, Filter: [{ op: "eq", field: "contractServiceID", value: $json.cs_id || 0 }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const unitsDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Units Decision',
    position: [4920, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask ContractServiceUnits/query response. Build a CHRONOLOGICAL\n// unit-adjustment plan by first understanding the BILLING CYCLE from the\n// CSP invoice lines (distinct from the subscription term):\n//   - cycle end   = latest USAGE END across this subscription's lines\n//   - cycle line  = earliest-starting line with that end; its USAGE START\n//                   is the cycle start and its qty is the cycle quantity\n//   - other lines = pro-rata changes (before or within the cycle), each\n//                   effective at its own USAGE START\n// The plan applies pro-rata changes in date order, sets the cycle quantity\n// at cycle start, and finally corrects to the annuity quantity if needed.\n// e.g. Atlas M365 BP: +6 @13-Jul, +10 @27-Jul, +259 @31-Jul (cycle start)\n// = 275. Units never exist before dates shown in the report, so Autotask\n// does not back-bill earlier periods.\nconst line = $('Current Line').first().json;\n\n// Recover the contract-service identifiers from whichever branch ran for\n// THIS line ($() returns the node's most recent run, so verify line_key).\nfunction grab(name) {\n  try {\n    const j = $(name).first().json;\n    return j.line_key === line.line_key ? j : null;\n  } catch (e) { return null; }\n}\nconst carried = grab('CS From Create') || grab('CS After Patch') || grab('CS Decision') || {};\n\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nlet current = 0;\nif (items.length) {\n  let latest = items[0];\n  for (const u of items) {\n    if (String(u.startDate || '') > String(latest.startDate || '')) latest = u;\n  }\n  current = Number(latest.units || 0);\n}\nconst target = Number(line.qty || 0);\n\nlet invLines = [];\ntry { invLines = JSON.parse(line.invoice_lines || '[]'); } catch (e) { /* no invoice detail */ }\ninvLines = invLines.filter((x) => x && x.s).sort((a, b) => String(a.s).localeCompare(String(b.s)));\n\nconst plan = [];\nlet cycleStart = '';\nlet cycleEnd = '';\n\nif (invLines.length) {\n  // Identify the billing cycle.\n  for (const x of invLines) {\n    if (String(x.e || '') > cycleEnd) cycleEnd = String(x.e || '');\n  }\n  const enders = invLines.filter((x) => String(x.e || '') === cycleEnd);\n  cycleStart = String(enders[0].s);\n  for (const x of enders) {\n    if (String(x.s) < cycleStart) cycleStart = String(x.s);\n  }\n  const cycleLines = enders.filter((x) => String(x.s) === cycleStart);\n  const cycleQty = cycleLines.reduce((s, x) => s + Number(x.q || 0), 0);\n  const prorata = invLines.filter((x) => cycleLines.indexOf(x) === -1);\n\n  // Chronological events: pro-rata increments at their usage start, the\n  // cycle quantity set at cycle start ('set' sorts after adds on a tie).\n  const events = [];\n  for (const p of prorata) events.push({ type: 'add', q: Number(p.q || 0), date: String(p.s) });\n  events.push({ type: 'set', q: cycleQty, date: cycleStart });\n  events.sort((a, b) => (a.date === b.date\n    ? (a.type === 'set' ? 1 : -1)\n    : a.date.localeCompare(b.date)));\n\n  let running = current;\n  let lastDate = cycleStart;\n  if (current === 0) {\n    // Fresh contract service: replay the cycle.\n    for (const ev of events) {\n      const change = ev.type === 'set' ? ev.q - running : ev.q;\n      if (change !== 0) { plan.push({ change: change, date: ev.date }); running += change; }\n      if (ev.date > lastDate) lastDate = ev.date;\n    }\n  }\n  // Correct to the annuity quantity (also the single-delta path when the\n  // contract already has unit history).\n  if (running !== target) {\n    plan.push({ change: target - running, date: lastDate || line.price_effective_date || line.today });\n  }\n} else if (target !== current) {\n  // No invoice detail available: single delta at the portal's From date.\n  plan.push({ change: target - current, date: line.price_effective_date || line.today });\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: carried.contract_id || null,\n  service_id: carried.service_id || null,\n  cs_id: carried.cs_id || null,\n  sell: carried.sell,\n  current_units: current,\n  target_units: target,\n  cycle_start: cycleStart,\n  cycle_end: cycleEnd,\n  plan: plan,\n  plan_count: plan.length,\n  plan_summary: plan.map((p) => (p.change > 0 ? '+' : '') + p.change + ' @' + p.date).join(', '),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, current_units: 0, target_units: 275, delta: 275 }]
});

const needAdjust = ifElse({
  version: 2.2,
  config: {
    name: 'Need Unit Change?',
    position: [5140, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.plan_count }}'), operator: { type: 'number', operation: 'gt' }, rightValue: 0 },
          { leftValue: expr('{{ $json.cs_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const splitPlan = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Split Plan',
    position: [5250, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// One item per planned unit adjustment, in chronological order. The\n// downstream HTTP node posts them one at a time (batched, oldest first) so\n// Autotask builds the quantity history exactly as the CSP report shows it.\nconst dec = $input.first().json;\nreturn (dec.plan || []).map((p) => ({ json: {\n  line_key: dec.line_key,\n  contract_id: dec.contract_id,\n  service_id: dec.service_id,\n  cs_id: dec.cs_id,\n  sell: dec.sell,\n  change: p.change,\n  date: p.date,\n} }));\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, change: 259, date: '2025-08-31' }]
});

const adjustUnits = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Adjust Units',
    position: [5360, -120],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $json.contract_id }}/ServiceAdjustments"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ contractID: $json.contract_id, serviceID: $json.service_id, unitChange: $json.change, effectiveDate: $json.date, adjustedUnitPrice: $json.sell }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 400 } } }
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 6001 }]
});

const adjustResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Adjust Result',
    position: [5580, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: one Autotask service-adjustment response per planned change.\nconst line = $('Current Line').first().json;\nconst all = $input.all();\nconst errors = [];\nlet ok = 0;\nfor (const i of all) {\n  const r = i.json || {};\n  if (r.itemId) {\n    ok++;\n  } else {\n    errors.push(String(\n      (r.error && (r.error.message || JSON.stringify(r.error))) ||\n      (r.errors ? JSON.stringify(r.errors) : 'unknown')\n    ).slice(0, 150));\n  }\n}\nreturn [{ json: {\n  line_key: line.line_key,\n  adjust_ok_count: ok,\n  adjust_error: errors.join('; ').slice(0, 300),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', adjust_ok: true, adjust_error: '' }]
});

const syncResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sync Result',
    position: [5800, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Build the final per-line outcome that gets written back to the\n// csp_subscription_lines table. Reads every step's node for THIS line only\n// (guarded by line_key, since $() returns a node's most recent run).\nconst line = $('Current Line').first().json;\n\nfunction grab(name) {\n  try {\n    const j = $(name).first().json;\n    return j.line_key === line.line_key ? j : null;\n  } catch (e) { return null; }\n}\n\nconst svcDec = grab('Service Decision');\nconst svcCreated = grab('Service From Create');\nconst conDec = grab('Contract Decision');\nconst conCreated = grab('Contract From Create');\nconst csCreate = grab('CS From Create');\nconst csPatch = grab('CS After Patch');\nconst csDec = grab('CS Decision');\nconst units = grab('Units Decision');\n\nconst serviceId = (svcCreated && svcCreated.service_id) || (svcDec && svcDec.service_id) || null;\nconst contractId = (conCreated && conCreated.contract_id) || (conDec && conDec.contract_id) || null;\nconst csId = (csCreate && csCreate.cs_id) || (csDec && csDec.cs_id) || null;\n\nconst notes = [];\nconst errors = [];\nif (svcCreated) {\n  if (svcCreated.service_id) notes.push('service created #' + svcCreated.service_id);\n  else errors.push('service create failed: ' + (svcCreated.create_error || 'unknown'));\n}\nif (conCreated) {\n  if (conCreated.contract_id) notes.push('contract created #' + conCreated.contract_id);\n  else errors.push('contract create failed: ' + (conCreated.create_error || 'unknown'));\n}\nif (csCreate) {\n  if (csCreate.cs_id) notes.push('service added to contract @ ' + csCreate.sell);\n  else errors.push('contract service create failed: ' + (csCreate.create_error || 'unknown'));\n}\nif (csPatch) {\n  if (csPatch.patch_error) errors.push('price update failed: ' + csPatch.patch_error);\n  else notes.push('price ' + csPatch.old_price + ' -> ' + csPatch.sell\n    + (csPatch.effective_date ? ' effective ' + csPatch.effective_date : ''));\n}\nif (units && units.plan_count > 0 && csId) {\n  const adj = grab('Adjust Result');\n  if (adj && adj.adjust_error) errors.push('unit adjustment failed: ' + adj.adjust_error);\n  else notes.push('units ' + units.current_units + ' -> ' + units.target_units +\n    ' (' + units.plan_summary + ')');\n}\nif (!serviceId) errors.push('no Autotask service resolved');\nif (!contractId) errors.push('no Autotask contract resolved');\nif (!csId && serviceId && contractId) errors.push('no contract service resolved');\n\nconst status = errors.length ? 'error' : 'synced';\nconst message = (errors.length ? errors : (notes.length ? notes : ['up to date'])).join('; ').slice(0, 500);\n\nreturn [{ json: {\n  subscription_id: line.subscription_id,\n  stock_code: line.stock_code,\n  sync_status: status,\n  sync_message: message,\n  autotask_service_id: serviceId,\n  autotask_contract_id: contractId,\n  autotask_contract_service_id: csId,\n} }];\n" }
  },
  output: [{ subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', sync_status: 'synced', sync_message: 'contract created #7001; service added to contract @ 34.55; units 0 -> 275', autotask_service_id: 9001, autotask_contract_id: 7001, autotask_contract_service_id: 8001 }]
});

const markSynced = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Mark Synced',
    position: [6020, 20],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: 'FDGqV46wAYu9bnGe', cachedResultName: 'csp_subscription_lines' },
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
          sync_status: expr('{{ $json.sync_status }}'),
          sync_message: expr('{{ $json.sync_message }}'),
          autotask_service_id: expr('{{ $json.autotask_service_id }}'),
          autotask_contract_id: expr('{{ $json.autotask_contract_id }}'),
          autotask_contract_service_id: expr('{{ $json.autotask_contract_service_id }}')
        },
        schema: [
          { id: 'sync_status', displayName: 'sync_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sync_message', displayName: 'sync_message', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'autotask_service_id', displayName: 'autotask_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_id', displayName: 'autotask_contract_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_service_id', displayName: 'autotask_contract_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, sync_status: 'synced' }]
});

const noteSync = sticky(
  '## 03 · Autotask Sync\nPOST /webhook/csp-autotask-sync (the portal Sync button calls this).\nPer included line: resolve company mapping -> ensure Service -> ensure Contract (Subscription ID in the name) -> set sell price on the contract service -> adjust units.\n\n**Config ("Autotask Config"):**\n- base_url: Autotask zone REST URL (ww31)\n- billing_code_id: the Autotask Billing (Material) Code for created Services (594 = Cloud and SaaS)',
  [startSync, autotaskConfig],
  { color: 3 }
);

export default workflow('kantanna-csp-03-sync', '03 · Autotask Sync')
  .add(startSync)
  .to(autotaskConfig)
  .to(fetchSyncLines)
  .to(prepareLines)
  .to(syncLoop
    .onDone(syncDone)
    .onEachBatch(currentLine
      .to(lookupMapping)
      .to(isMapped
        .onTrue(findService)
        .onFalse(markNeedsMapping.to(nextBatch(syncLoop))))))
  .add(findService)
  .to(serviceDecision)
  .to(needService
    .onTrue(createService.to(serviceFromCreate.to(recordService)))
    .onFalse(recordService))
  .add(recordService)
  .to(findContract)
  .to(contractDecision)
  .to(needContract
    .onTrue(createContract.to(contractFromCreate.to(fetchContractServices)))
    .onFalse(fetchContractServices))
  .add(fetchContractServices)
  .to(csDecision)
  .to(csRoute
    .onCase(0, createCS.to(csFromCreate.to(fetchUnits)))
    .onCase(1, patchCS.to(csAfterPatch.to(fetchUnits)))
    .onCase(2, fetchUnits))
  .add(fetchUnits)
  .to(unitsDecision)
  .to(needAdjust
    .onTrue(splitPlan.to(adjustUnits.to(adjustResult.to(syncResult))))
    .onFalse(syncResult))
  .add(syncResult)
  .to(markSynced)
  .to(nextBatch(syncLoop))
  .add(noteSync);
