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
          { id: 'cfg-service-period', name: 'service_period_type', type: 'number', value: 2 },
          // Line of Business (Billing) = General > SaaS and Cloud Services.
          // Autotask calls this organizationalLevelAssociationID; 18 is the id
          // the hand-made SaaS contracts (Bitwarden, Arcserve) already use.
          { id: 'cfg-line-of-business', name: 'line_of_business_id', type: 'number', value: 18 }
        ]
      }
    }
  },
  output: [{ base_url: 'https://webservices31.autotask.net/atservicesrest/v1.0', billing_code_id: 29683278, contract_type: 7, contract_status: 1, contract_period_type: 2, service_period_type: 2, line_of_business_id: 18 }]
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
      dataTableId: { __rl: true, mode: 'id', value: '__LINES_TABLE_ID__', cachedResultName: 'csp_subscription_lines' },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __PREPARE_LINES__ }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __SYNC_DONE__ }
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
      dataTableId: { __rl: true, mode: 'id', value: '__MAPPINGS_TABLE_ID__', cachedResultName: 'csp_customer_mappings' },
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
      dataTableId: { __rl: true, mode: 'id', value: '__LINES_TABLE_ID__', cachedResultName: 'csp_subscription_lines' },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __SERVICE_DECISION__ }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __SERVICE_FROM_CREATE__ }
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
      dataTableId: { __rl: true, mode: 'id', value: '__SERVICES_TABLE_ID__', cachedResultName: 'csp_sku_services' },
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
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 100, Filter: [{ op: "eq", field: "companyID", value: $("Lookup Mapping").first().json.autotask_company_id }, { op: "eq", field: "contractName", value: $("Current Line").first().json.contract_name }] }) }}'),
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __CONTRACT_DECISION__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: null, need_contract: true, need_date_fix: false, contract_end_needed: '2026-12-28', contract_end_found: '', query_error: '' }]
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
      jsonBody: expr('{{ JSON.stringify({ companyID: $("Lookup Mapping").first().json.autotask_company_id, contractName: $("Current Line").first().json.contract_name, contractType: Number($("Autotask Config").first().json.contract_type), status: Number($("Autotask Config").first().json.contract_status), startDate: $("Current Line").first().json.contract_start, endDate: $("Current Line").first().json.contract_end, contractPeriodType: Number($("Autotask Config").first().json.contract_period_type), timeReportingRequiresStartAndStopTimes: 0, setupFee: 0, organizationalLevelAssociationID: Number($("Autotask Config").first().json.line_of_business_id), description: ("Dicker Data CSP - " + $("Current Line").first().json.billing_label + ". Every subscription co-termed to " + $("Current Line").first().json.contract_end + " bills on this contract; each Subscription ID is on its service line. Managed by the Kantanna n8n automation.").slice(0, 1900) }) }}'),
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __CONTRACT_FROM_CREATE__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, contract_created: true, create_error: '' }]
});

// An existing contract whose endDate predates this import's term end would
// make Autotask reject every adjustment dated after it ("effectiveDate must
// be between the start date and end date of the Contract"), so extend it
// first. Happens on annual renewals and on contracts created before the
// term dates were known.
const needDateFix = ifElse({
  version: 2.2,
  config: {
    name: 'Extend Contract Dates?',
    position: [3160, 160],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.need_date_fix }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const extendContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Extend Contract',
    position: [3380, 160],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'PATCH',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ id: $json.contract_id, endDate: $json.contract_end_needed }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 7001 }]
});

const contractExtended = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contract Extended',
    position: [3580, 160],
    parameters: { mode: 'runOnceForAllItems', jsCode: __CONTRACT_EXTENDED__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, extended_from: '2024-08-17', extended_to: '2026-12-28', extend_error: '' }]
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __CS_DECISION__ }
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
      jsonBody: expr('{{ JSON.stringify({ contractID: $json.contract_id, serviceID: $json.service_id, adjustedPrice: $json.sell, invoiceDescription: $("Current Line").first().json.service_invoice_description, internalDescription: $("Current Line").first().json.service_invoice_description }) }}'),
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __CS_FROM_CREATE__ }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __CS_AFTER_PATCH__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'patch', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 33, old_price: 34.55, patch_error: '' }]
});

// Only an EXISTING contract service needs a description patch - a new one
// is created with its description already set.
const needDesc = ifElse({
  version: 2.2,
  config: {
    name: 'Need Description Change?',
    position: [4700, -80],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $("CS Decision").first().json.desc_change }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } },
          { leftValue: expr('{{ $("CS Decision").first().json.cs_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

// Autotask patches a child collection by PATCHing the parent's collection
// URL with the child's own id in the body.
const patchDesc = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Patch CS Description',
    position: [4920, -180],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'PATCH',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $('CS Decision').first().json.contract_id }}/Services"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ id: $("CS Decision").first().json.cs_id, invoiceDescription: $("Current Line").first().json.service_invoice_description, internalDescription: $("Current Line").first().json.service_invoice_description }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 8001 }]
});

const descResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Desc Result',
    position: [5140, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: __DESC_RESULT__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'none', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, desc_from: 'Microsoft 365 Business Premium - sub 2F295B21', desc_to: 'M365 Business Premium licences', desc_updated: true, desc_error: '' }]
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __UNITS_DECISION__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, current_units: 0, target_units: 275, delta: 275 }]
});

// What has been approved & posted so far: BillingItems only exist once a
// charge is posted, so the latest item date shows the last posted period
// and its absence means nothing has been through Approve & Post yet.
const fetchBillingItems = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Billing Items',
    position: [5000, 160],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/BillingItems/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: [{ op: "eq", field: "contractID", value: $json.contract_id || 0 }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const billingSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Billing Summary',
    position: [5070, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: __BILLING_SUMMARY__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, cs_id: 8001, plan: [], plan_count: 0, billing_last: '2026-07-31 · $9501.25 · posted', billing_next: '2026-08-31 · $9501.25 (275 × 34.55/mo)' }]
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __SPLIT_PLAN__ }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: __ADJUST_RESULT__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', adjust_ok: true, adjust_error: '' }]
});

const syncResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sync Result',
    position: [5800, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: __SYNC_RESULT__ }
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
          sync_status: expr('{{ $json.sync_status }}'),
          sync_message: expr('{{ $json.sync_message }}'),
          autotask_service_id: expr('{{ $json.autotask_service_id }}'),
          autotask_contract_id: expr('{{ $json.autotask_contract_id }}'),
          autotask_contract_service_id: expr('{{ $json.autotask_contract_service_id }}'),
          billing_last: expr('{{ $json.billing_last }}'),
          billing_next: expr('{{ $json.billing_next }}'),
          contract_price: expr('{{ $json.contract_price }}'),
          contract_invoice_description: expr('{{ $json.contract_invoice_description }}')
        },
        schema: [
          { id: 'sync_status', displayName: 'sync_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sync_message', displayName: 'sync_message', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'autotask_service_id', displayName: 'autotask_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_id', displayName: 'autotask_contract_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_service_id', displayName: 'autotask_contract_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'billing_last', displayName: 'billing_last', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'billing_next', displayName: 'billing_next', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'contract_price', displayName: 'contract_price', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'contract_invoice_description', displayName: 'contract_invoice_description', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
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
    .onFalse(needDateFix
      .onTrue(extendContract.to(contractExtended.to(fetchContractServices)))
      .onFalse(fetchContractServices)))
  .add(fetchContractServices)
  .to(csDecision)
  .to(csRoute
    .onCase(0, createCS.to(csFromCreate.to(needDesc)))
    .onCase(1, patchCS.to(csAfterPatch.to(needDesc)))
    .onCase(2, needDesc))
  .add(needDesc
    .onTrue(patchDesc.to(descResult.to(fetchUnits)))
    .onFalse(fetchUnits))
  .add(fetchUnits)
  .to(unitsDecision)
  .to(fetchBillingItems)
  .to(billingSummary)
  .to(needAdjust
    .onTrue(splitPlan.to(adjustUnits.to(adjustResult.to(syncResult))))
    .onFalse(syncResult))
  .add(syncResult)
  .to(markSynced)
  .to(nextBatch(syncLoop))
  .add(noteSync);
