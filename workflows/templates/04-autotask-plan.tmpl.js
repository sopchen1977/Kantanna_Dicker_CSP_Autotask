import { workflow, node, trigger, sticky, newCredential, ifElse, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';

/* ============================================================
   04 · Autotask Plan
   ------------------------------------------------------------
   What WOULD the sync do? This is workflow 03 with every write
   taken out: the same four decision Code nodes, fed by the same
   four Autotask queries, with nothing created, patched or posted.

   It exists because "press Sync and find out" is not a thing you
   can ask of a screen that decides what a customer gets billed.
   The decisions are the shared runtime files rather than a second
   implementation - a preview that disagreed with the sync would
   be worse than no preview at all.

   Two short circuits replace the writes. During a sync, by the
   time the contract services are queried the contract exists,
   because it was just created. Here it may not exist at all, so
   there is nothing to query: an empty result stands in, and the
   decisions read it exactly as they read an empty query - as
   "not there", which is the truth.
   ============================================================ */

const startPlan = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Start Plan',
    position: [-620, 0],
    parameters: { httpMethod: 'POST', path: 'csp-autotask-plan', responseMode: 'onReceived', options: {} }
  },
  output: [{ body: {} }]
});

// Reading a customer's contracts and prices out of Autotask is not public
// information, so this endpoint is gated exactly like the others.
const checkAccessPlan = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Plan',
    position: [-460, 0],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          cookie: expr('{{ $json.headers.cookie || \'\' }}'),
          token: expr('{{ ($json.query && $json.query.t) || ($json.body && $json.body.t) || \'\' }}')
        },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'token', displayName: 'token', required: false, defaultMatch: false, display: true, canBeUsedToMatch: false, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedPlan = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Plan?',
    position: [-300, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const refusedPlan = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Refused - Not Signed In', position: [-140, 160], parameters: {} },
  output: [{}]
});

// The import calls the plan as a sub-workflow rather than over its webhook.
// The webhook is gated, and rightly so - but an internal call carries no
// session cookie, so it would be refused by the gate rather than weakening
// it. The caller is workflow 01, whose upload form is itself behind sign-in,
// so whoever set this run going was signed in before a file was read.
//
// It joins the chain at Autotask Config, past the gate, because the gate is
// the only thing being skipped. Everything after it is the same run the
// portal's Check Autotask button gets.
const planFromImport = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.2,
  config: {
    name: 'Plan From Import',
    position: [-620, 200],
    parameters: {
      inputSource: 'workflowInputs',
      // Nothing here is read - the plan is made over the whole table, exactly
      // as the webhook run makes it. It says who asked, so the execution list
      // tells an import-triggered run from a button press at a glance.
      workflowInputs: { values: [{ name: 'source', type: 'string' }] }
    }
  },
  output: [{ source: 'import' }]
});

const autotaskConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Autotask Config',
    position: [-140, 0],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'cfg-base-url', name: 'base_url', type: 'string', value: 'https://webservices31.autotask.net/atservicesrest/v1.0' }
        ]
      }
    }
  },
  output: [{ base_url: 'https://webservices31.autotask.net/atservicesrest/v1.0' }]
});

const fetchPlanLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Plan Lines',
    position: [20, 0],
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
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', qty: 275 }]
});

// The same derivation the sync runs, so the plan is made against exactly the
// service key, contract reference and co-term window the sync would use.
const prepareLines = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Lines',
    position: [180, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: __PREPARE_LINES__ }
  },
  output: [{ tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_key: 'ANN-MO:CFQ7TTC0LCHC:0002', qty: 275 }]
});

const planLoop = splitInBatches({
  version: 3,
  config: { name: 'Plan Loop', position: [340, 0], parameters: { batchSize: 1, options: {} } }
});

const planDone = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Plan Done',
    position: [560, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: __PLAN_DONE__ }
  },
  output: [{ done: true }]
});

const currentLine = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Current Line',
    position: [560, 120],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'cl-marker', name: 'in_plan', type: 'boolean', value: true }
        ]
      }
    }
  },
  output: [{ in_plan: true, tenant_name: 'ATLAS OUTSOURCING PTY LTD', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:' }]
});

const lookupMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Lookup Mapping',
    position: [720, 120],
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
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', autotask_company_id: 123 }]
});

const isMapped = ifElse({
  version: 2.2,
  config: {
    name: 'Is Mapped?',
    position: [880, 120],
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

// Nothing about this customer can be planned until the tenant is tied to an
// Autotask company: there is no company to look contracts up against.
const markUnmapped = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Mark Unmapped',
    position: [1040, 320],
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
          plan_status: 'needs_mapping',
          plan_summary: 'Map this customer to an Autotask company, then check again.',
          plan_checked_at: expr('{{ $now.toISO() }}')
        },
        schema: [
          { id: 'plan_status', displayName: 'plan_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_summary', displayName: 'plan_summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_checked_at', displayName: 'plan_checked_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, plan_status: 'needs_mapping' }]
});

/* ---- 1. Does the service exist? ------------------------------------- */
const findService = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Service',
    position: [1040, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Services/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 25, Filter: [{ op: "or", items: [{ op: "eq", field: "sku", value: $("Current Line").first().json.service_key }, { op: "eq", field: "name", value: $("Current Line").first().json.service_name }] }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
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
    position: [1200, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: __SERVICE_DECISION__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_id: null, need_service: true }]
});

// CS Decision reads the service id off a node called Record Service, which in
// the sync is the data-table row written after the service was created. There
// is nothing to record here, so this stands in with the id the lookup found -
// or null, which is what makes the contract service read as "would be added".
const recordService = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Record Service',
    position: [1360, 20],
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rs-sku', name: 'sku', type: 'string', value: expr("{{ $('Current Line').first().json.service_key }}") },
          { id: 'rs-id', name: 'autotask_service_id', type: 'number', value: expr('{{ $json.service_id }}') }
        ]
      }
    }
  },
  output: [{ sku: 'ANN-MO:CFQ7TTC0LCHC:0002', autotask_service_id: 9001 }]
});

/* ---- 2. Does the contract exist? ------------------------------------ */
const findContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Contract',
    position: [1520, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: [{ op: "and", items: [{ op: "eq", field: "companyID", value: $("Lookup Mapping").first().json.autotask_company_id }, { op: "or", items: [{ op: "beginsWith", field: "contractNumber", value: "CSP-" }, { op: "beginsWith", field: "contractName", value: "CSP Microsoft " }] }] }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
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
    position: [1680, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: __CONTRACT_DECISION__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: null, need_contract: true }]
});

const contractExists = ifElse({
  version: 2.2,
  config: {
    name: 'Contract Exists?',
    position: [1840, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.contract_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

/* ---- 3. Is the service already on that contract, and at what price? -- */
const fetchContractServices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Contract Services',
    position: [2000, -80],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServices/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 200, Filter: [{ op: "eq", field: "contractID", value: $json.contract_id || 0 }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// No contract means no contract services to fetch. An empty result is not a
// fudge here - it is the literal answer, and CS Decision reads it the same
// way it reads an empty query against a contract that does exist.
const noContractServices = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No Contract Services',
    position: [2000, 140],
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'ncs-items', name: 'items', type: 'array', value: [] }
        ]
      }
    }
  },
  output: [{ items: [] }]
});

const csDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS Decision',
    position: [2160, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: __CS_DECISION__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'create', cs_id: null, sell: 34.55 }]
});

const csExists = ifElse({
  version: 2.2,
  config: {
    name: 'CS Exists?',
    position: [2320, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.cs_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

/* ---- 4. What units does Autotask already hold, and from when? -------- */
const fetchUnits = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch CS Units',
    position: [2480, -80],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServiceUnits/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 100, Filter: [{ op: "eq", field: "contractServiceID", value: $json.cs_id || 0 }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// A contract service that does not exist has no unit history, so the replay
// starts from nothing - which is exactly the plan for a brand new service.
const noUnits = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No CS Units',
    position: [2480, 140],
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'nu-items', name: 'items', type: 'array', value: [] }
        ]
      }
    }
  },
  output: [{ items: [] }]
});

const unitsDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Units Decision',
    position: [2640, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: __UNITS_DECISION__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', plan: [], plan_summary: '' }]
});

const planResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Plan Result',
    position: [2800, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: __PLAN_RESULT__ }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', plan_status: 'ok', plan_summary: 'create contract; add to contract @ 34.55' }]
});

const savePlan = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Save Plan',
    position: [2960, 20],
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
          plan_status: expr('{{ $json.plan_status }}'),
          plan_summary: expr('{{ $json.plan_summary }}'),
          plan_service_action: expr('{{ $json.plan_service_action }}'),
          plan_contract_action: expr('{{ $json.plan_contract_action }}'),
          plan_cs_action: expr('{{ $json.plan_cs_action }}'),
          plan_contract_end: expr('{{ $json.plan_contract_end }}'),
          plan_units: expr('{{ $json.plan_units }}'),
          plan_units_summary: expr('{{ $json.plan_units_summary }}'),
          plan_current_units: expr('{{ $json.plan_current_units }}'),
          plan_target_units: expr('{{ $json.plan_target_units }}'),
          plan_error: expr('{{ $json.plan_error }}'),
          plan_checked_at: expr('{{ $json.plan_checked_at }}'),
          autotask_service_id: expr('{{ $json.autotask_service_id }}'),
          autotask_contract_id: expr('{{ $json.autotask_contract_id }}'),
          autotask_contract_service_id: expr('{{ $json.autotask_contract_service_id }}'),
          contract_price: expr('{{ $json.contract_price }}'),
          plan_sell: expr('{{ $json.plan_sell }}'),
          contract_invoice_description: expr('{{ $json.contract_invoice_description }}')
        },
        schema: [
          { id: 'plan_status', displayName: 'plan_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_summary', displayName: 'plan_summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_service_action', displayName: 'plan_service_action', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_contract_action', displayName: 'plan_contract_action', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_cs_action', displayName: 'plan_cs_action', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_contract_end', displayName: 'plan_contract_end', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_units', displayName: 'plan_units', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_units_summary', displayName: 'plan_units_summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_current_units', displayName: 'plan_current_units', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'plan_target_units', displayName: 'plan_target_units', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'plan_error', displayName: 'plan_error', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_checked_at', displayName: 'plan_checked_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'autotask_service_id', displayName: 'autotask_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_id', displayName: 'autotask_contract_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_service_id', displayName: 'autotask_contract_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'contract_price', displayName: 'contract_price', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'plan_sell', displayName: 'plan_sell', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'contract_invoice_description', displayName: 'contract_invoice_description', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, plan_status: 'ok' }]
});

const notePlan = sticky(
  '## 04 · Autotask Plan (read only)\nTwo ways in, one run. **Plan From Import** is called as a sub-workflow at the end of the import; POST /webhook/csp-autotask-plan is the portal\'s **Check Autotask** button, behind the sign-in gate. The import joins past the gate because an internal call carries no session cookie - its own caller was signed in to reach the upload form.\n\nRuns the sync\'s four decisions without any of its writes, and stores per line what WOULD happen: create/rename the service, create/extend the contract, add or re-price the contract service, and the unit adjustments with their dates.\n\n**Nothing in this workflow creates, patches or posts anything.** Every HTTP node is a `/query`. If you are adding a node here and it is not a query, it belongs in 03.',
  [startPlan, planFromImport, autotaskConfig],
  { color: 4 }
);

export default workflow('kantanna-csp-04-plan', '04 · Autotask Plan')
  .add(startPlan)
  .to(checkAccessPlan)
  .to(authedPlan.onTrue(autotaskConfig).onFalse(refusedPlan))
  .add(planFromImport)
  .to(autotaskConfig)
  .add(autotaskConfig)
  .to(fetchPlanLines)
  .to(prepareLines)
  .to(planLoop
    .onDone(planDone)
    .onEachBatch(currentLine
      .to(lookupMapping)
      .to(isMapped
        .onTrue(findService)
        .onFalse(markUnmapped.to(nextBatch(planLoop))))))
  .add(findService)
  .to(serviceDecision)
  .to(recordService)
  .to(findContract)
  .to(contractDecision)
  .to(contractExists
    .onTrue(fetchContractServices.to(csDecision))
    .onFalse(noContractServices.to(csDecision)))
  .add(csDecision)
  .to(csExists
    .onTrue(fetchUnits.to(unitsDecision))
    .onFalse(noUnits.to(unitsDecision)))
  .add(unitsDecision)
  .to(planResult)
  .to(savePlan)
  .to(nextBatch(planLoop))
  .add(notePlan);
