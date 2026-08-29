import { workflow, node, trigger, sticky, merge, expr } from '@n8n/workflow-sdk';

const uploadForm = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Monthly Import Form',
    position: [-380, 0],
    parameters: {
      formTitle: 'Dicker Data CSP Monthly Import',
      formDescription: 'Upload this month’s Annuity Information export and CSP Invoice Report (.xlsx). Only the DETAILS / Invoice Details tabs are read.',
      formFields: {
        values: [
          { fieldLabel: 'Annuity Information (xlsx)', fieldType: 'file', acceptFileTypes: '.xlsx', multipleFiles: false, requiredField: true },
          { fieldLabel: 'CSP Invoice Report (xlsx)', fieldType: 'file', acceptFileTypes: '.xlsx', multipleFiles: false, requiredField: true }
        ]
      },
      options: { appendAttribution: false }
    }
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

const noteImport = sticky(
  '## 01 · Annuity Import\nUpload both monthly Dicker Data files. Lines are matched on Subscription ID + Stock Code and upserted, so custom sell prices and include/exclude choices saved in the portal survive re-imports.\n\n**Pilot filter:** edit PILOT_CUSTOMERS at the top of the "Parse Subscription Lines" node. Currently B E Smart Admin Services + Kantanna Pty Ltd (Kantanna is the in-house test customer). Names are matched as a substring; an empty list = all customers.',
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
  .to(parseLines)
  .to(upsertLine)
  .to(summarizeImport)
  .to(importDone)
  .add(noteImport);
