import { workflow, node, trigger, sticky, merge, newCredential, expr } from '@n8n/workflow-sdk';

const uploadForm = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Monthly Import Form',
    position: [-380, 0],
    parameters: {
      // The last anonymous endpoint, and the most destructive one: an upload
      // replaces every subscription line. Basic Auth rather than the portal's
      // OTP sign-in because the n8n Form trigger only offers basicAuth or an
      // n8n account - it renders before any node runs, so there is nowhere to
      // check the session cookie. Rebuilding this as a custom page behind the
      // same sign-in is the follow-up.
      authentication: 'basicAuth',
      formTitle: 'Dicker Data CSP Monthly Import',
      formDescription: 'Upload this month’s Annuity Information export and CSP Invoice Report (.xlsx). Only the DETAILS / Invoice Details tabs are read.',
      formFields: {
        values: [
          { fieldLabel: 'Annuity Information (xlsx)', fieldType: 'file', acceptFileTypes: '.xlsx', multipleFiles: false, requiredField: true },
          { fieldLabel: 'CSP Invoice Report (xlsx)', fieldType: 'file', acceptFileTypes: '.xlsx', multipleFiles: false, requiredField: true }
        ]
      },
      // Without a path the form is served at /form/<webhookId>, a UUID nobody
      // can read out or type. This is the last segment of the URL.
      //
      // NOT plain "csp-upload": the older reconciliation project's "CSP Report
      // Upload Portal" is still active and holds that path, and n8n refuses to
      // publish a second workflow claiming it.
      options: { appendAttribution: false, path: 'csp-monthly-upload' }
    },
    credentials: { httpBasicAuth: newCredential('Kantanna Dicker CSP and Autotask project') }
  },
  output: [{ submittedAt: '2026-08-26T00:00:00.000Z', formMode: 'production' }]
});

const normalizeUploads = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Uploads',
    position: [-140, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: __NORMALIZE_UPLOADS__ }
  },
  output: [{ annuity_name: 'Annuity_Information_354137.xlsx', invoice_name: 'CSPInvoiceReport.xlsx' }]
});

const extractAnnuity = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Extract Annuity Details',
    position: [100, -120],
    parameters: {
      operation: 'xlsx',
      binaryPropertyName: 'annuity_file',
      options: { sheetName: 'DETAILS', headerRow: true, range: 'A3:Q5000' }
    }
  },
  output: [{ 'TENANT ID': '211C4C89', 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': '2F295B21', 'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:', 'STOCK DESCRIPTION': 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT', 'REFERENCE': 'Microsoft 365 Business Premium', 'QTY': '275.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '30-AUG-2025', 'END USAGE': '30-AUG-2025', 'REVALUATION PERIOD': '30-AUG-2026', 'UNIT PRICE': '$338.31', 'UNIT RRP': '$414.60' }]
});

const extractInvoice = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Extract Invoice Details',
    position: [100, 120],
    parameters: {
      operation: 'xlsx',
      binaryPropertyName: 'invoice_file',
      options: { sheetName: 'Invoice Details', headerRow: true, range: 'A2:T5000' }
    }
  },
  output: [{ 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': '2F295B21', 'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:', 'TERM START': '31-AUG-2025', 'TERM END': '30-AUG-2026' }]
});

const importBarrier = merge({
  version: 3.2,
  config: { name: 'Wait For Both Extracts', position: [340, 0], parameters: { mode: 'append' } }
});

const parseLines = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Subscription Lines',
    position: [560, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: __PARSE_LINES__ }
  },
  output: [{ tenant_id: '211C4C89', tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', sku: 'CFQ7TTC0LCHC', offer_name: 'Microsoft 365 Business Premium', stock_description: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT', qty: 275, charge_type: 'NCE', status: 'Active', unit_cost: 338.31, unit_rrp: 414.6, revaluation_period: '2026-08-30', usage_start: '2025-08-30', usage_end: '2025-08-30', term_months: 12, monthly_cost: 28.1925, monthly_rrp: 34.55, term_start: '2025-08-31', term_end: '2026-08-30', imported_at: '2026-08-26T00:00:00.000Z', source_file: 'Annuity_Information.xlsx', sync_status: 'pending', sync_message: '' }]
});

const upsertLine = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Upsert Line',
    position: [800, 0],
    parameters: {
      resource: 'row',
      operation: 'upsert',
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
          tenant_id: expr('{{ $json.tenant_id }}'),
          tenant_name: expr('{{ $json.tenant_name }}'),
          subscription_id: expr('{{ $json.subscription_id }}'),
          stock_code: expr('{{ $json.stock_code }}'),
          sku: expr('{{ $json.sku }}'),
          offer_name: expr('{{ $json.offer_name }}'),
          stock_description: expr('{{ $json.stock_description }}'),
          qty: expr('{{ $json.qty }}'),
          charge_type: expr('{{ $json.charge_type }}'),
          status: expr('{{ $json.status }}'),
          unit_cost: expr('{{ $json.unit_cost }}'),
          unit_rrp: expr('{{ $json.unit_rrp }}'),
          revaluation_period: expr('{{ $json.revaluation_period }}'),
          usage_start: expr('{{ $json.usage_start }}'),
          usage_end: expr('{{ $json.usage_end }}'),
          term_months: expr('{{ $json.term_months }}'),
          billing_months: expr('{{ $json.billing_months }}'),
          billing_type: expr('{{ $json.billing_type }}'),
          monthly_cost: expr('{{ $json.monthly_cost }}'),
          monthly_rrp: expr('{{ $json.monthly_rrp }}'),
          period_cost: expr('{{ $json.period_cost }}'),
          period_rrp: expr('{{ $json.period_rrp }}'),
          term_start: expr('{{ $json.term_start }}'),
          term_end: expr('{{ $json.term_end }}'),
          invoice_lines: expr('{{ $json.invoice_lines }}'),
          imported_at: expr('{{ $json.imported_at }}'),
          source_file: expr('{{ $json.source_file }}'),
          sync_status: expr('{{ $json.sync_status }}'),
          sync_message: expr('{{ $json.sync_message }}')
        },
        schema: [
          { id: 'tenant_id', displayName: 'tenant_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'tenant_name', displayName: 'tenant_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'subscription_id', displayName: 'subscription_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'stock_code', displayName: 'stock_code', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'sku', displayName: 'sku', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'offer_name', displayName: 'offer_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'stock_description', displayName: 'stock_description', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'qty', displayName: 'qty', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'charge_type', displayName: 'charge_type', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'status', displayName: 'status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'unit_cost', displayName: 'unit_cost', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'unit_rrp', displayName: 'unit_rrp', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'revaluation_period', displayName: 'revaluation_period', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'usage_start', displayName: 'usage_start', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'usage_end', displayName: 'usage_end', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'term_months', displayName: 'term_months', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'billing_months', displayName: 'billing_months', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'billing_type', displayName: 'billing_type', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'monthly_cost', displayName: 'monthly_cost', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'monthly_rrp', displayName: 'monthly_rrp', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'period_cost', displayName: 'period_cost', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'period_rrp', displayName: 'period_rrp', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'term_start', displayName: 'term_start', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'term_end', displayName: 'term_end', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'invoice_lines', displayName: 'invoice_lines', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'imported_at', displayName: 'imported_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'source_file', displayName: 'source_file', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sync_status', displayName: 'sync_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sync_message', displayName: 'sync_message', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21' }]
});

const summarizeImport = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Summarize Import',
    position: [1040, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: __SUMMARIZE_IMPORT__ }
  },
  output: [{ line_count: 12, customer_count: 2 }]
});

// With the lines in the table, ask Autotask what the sync would do to them,
// so the portal has a plan to show the moment it is opened rather than after
// a two-minute wait for the Check Autotask button.
//
// waitForSubWorkflow is off, and that is the whole point: the plan is ~4
// Autotask queries per line against a 3-thread limit, so it takes minutes.
// The form must not sit on it - it starts the run and hands straight on to
// the completion page, and the plan lands in the table while you are reading
// it. n8n passes this node's input through untouched when it is not waiting,
// so the summary reaches Import Complete unchanged.
//
// 04's webhook is gated and stays gated; this calls its Execute Sub-workflow
// trigger instead. Whoever is standing here got past the sign-in on the
// upload form to do it.
const runPlan = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Autotask',
    position: [1160, 0],
    executeOnce: true,
    // A plan that fails is a portal without a preview, not a lost import:
    // the lines are already saved, and Check Autotask will run it again.
    onError: 'continueRegularOutput',
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '__PLAN_WORKFLOW_ID__', cachedResultName: '04 · Autotask Plan' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { source: 'import' },
        matchingColumns: [],
        schema: [
          { id: 'source', displayName: 'source', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: false }
    }
  },
  output: [{ line_count: 12, customer_count: 2 }]
});

// The upload is only half the job - the prices still have to be reviewed and
// synced - so the completion page's real purpose is to hand you to the portal.
// respondWith 'showText' renders portal/import-complete.html as the whole page,
// which is what buys a proper link; the plain-text completion screen cannot
// carry one.
const importDone = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Import Complete',
    position: [1280, 0],
    parameters: {
      operation: 'completion',
      respondWith: 'showText',
      responseText: expr(__IMPORT_DONE_HTML__)
    }
  }
});

// The two uploaded tabs, kept verbatim so the portal can show the source
// behind any number. Cleared first: a snapshot is this month's upload, not an
// accumulation, and the rows carry no key to upsert on.
const clearReportRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Clear Report Rows',
    position: [560, 200],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: '__REPORT_TABLE_ID__', cachedResultName: 'csp_report_rows' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'gte', keyValue: '0' }] },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const snapshotReportRows = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Snapshot Report Rows',
    position: [700, 200],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', jsCode: __SNAPSHOT_REPORT_ROWS__ }
  },
  output: [{ sheet: 'annuity', row_no: 1, data: '{"TENANT ID":"211C4C89-…"}', source_file: 'Annuity_Information.xlsx', imported_at: '2026-08-29T08:14:15.039Z' }]
});

const insertReportRow = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Insert Report Row',
    position: [840, 200],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: '__REPORT_TABLE_ID__', cachedResultName: 'csp_report_rows' },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          sheet: expr('{{ $json.sheet }}'),
          row_no: expr('{{ $json.row_no }}'),
          data: expr('{{ $json.data }}'),
          source_file: expr('{{ $json.source_file }}'),
          imported_at: expr('{{ $json.imported_at }}')
        },
        schema: [
          { id: 'sheet', displayName: 'sheet', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'row_no', displayName: 'row_no', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'data', displayName: 'data', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'source_file', displayName: 'source_file', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'imported_at', displayName: 'imported_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, sheet: 'annuity', row_no: 1 }]
});

const noteImport = sticky(
  '## 01 · Annuity Import\nUpload both monthly Dicker Data files. Lines are matched on Subscription ID + Stock Code and upserted, so custom sell prices and include/exclude choices saved in the portal survive re-imports.\n\n**Customer filter:** PILOT_CUSTOMERS at the top of the "Parse Subscription Lines" node is currently empty, so **every customer in the file is imported**. Add names to that list to restrict the import again; names are matched as a substring.\n\n**Check Autotask** starts 04 · Autotask Plan on the way out and does not wait for it - the plan takes minutes, the completion page does not. Open the portal and it fills in.',
  [uploadForm, normalizeUploads],
  { color: 4 }
);

export default workflow('kantanna-csp-01-import', '01 · Annuity Import (Upload)')
  .add(uploadForm)
  .to(normalizeUploads)
  .to(extractAnnuity.to(importBarrier.input(0)))
  .add(normalizeUploads)
  .to(extractInvoice.to(importBarrier.input(1)))
  .add(importBarrier)
  .to(clearReportRows)
  .to(snapshotReportRows)
  .to(insertReportRow)
  .add(importBarrier)
  .to(parseLines)
  .to(upsertLine)
  .to(summarizeImport)
  .to(runPlan)
  .to(importDone)
  .add(noteImport);
