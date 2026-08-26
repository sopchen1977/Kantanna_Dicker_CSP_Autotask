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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Identify the two uploaded workbooks by file name and expose them under\n// canonical binary keys used by the extract nodes, regardless of what the\n// form trigger called the binary properties.\nconst item = $input.first();\nconst binaries = item.binary || {};\nconst out = { json: {}, binary: {} };\n\nfor (const key of Object.keys(binaries)) {\n  const name = String(binaries[key].fileName || '').toLowerCase();\n  if (name.includes('annuity')) {\n    out.binary.annuity_file = binaries[key];\n  } else if (name.includes('invoice') || name.includes('csp')) {\n    out.binary.invoice_file = binaries[key];\n  }\n}\n\nif (!out.binary.annuity_file) {\n  throw new Error('No uploaded file has \"Annuity\" in its name. Upload the Annuity Information export.');\n}\nif (!out.binary.invoice_file) {\n  throw new Error('No uploaded file has \"Invoice\" or \"CSP\" in its name. Upload the CSP Invoice Report.');\n}\n\nout.json.annuity_name = out.binary.annuity_file.fileName || 'annuity.xlsx';\nout.json.invoice_name = out.binary.invoice_file.fileName || 'invoice.xlsx';\nreturn [out];\n" }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Merge the annuity DETAILS rows with TERM START/END from the invoice\n// \"Invoice Details\" rows and emit one normalised item per subscription line.\n//\n// ==== CONFIG: pilot customers. Empty array = import every customer. ====\nconst PILOT_CUSTOMERS = ['ATLAS OUTSOURCING PTY LTD', 'Galilee Solicitors'];\n// =======================================================================\n\nconst MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',\n  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };\n\nfunction toIso(d) {\n  if (!d) return '';\n  const m = String(d).trim().match(/^(\\d{1,2})-([A-Za-z]{3})-(\\d{4})$/);\n  if (!m) return String(d).trim();\n  return m[3] + '-' + (MONTHS[m[2].toUpperCase()] || '01') + '-' + m[1].padStart(2, '0');\n}\n\nfunction num(v) {\n  if (v === null || v === undefined || v === '') return 0;\n  if (typeof v === 'number') return v;\n  const n = parseFloat(String(v).replace(/[^0-9.\\-]/g, ''));\n  return isNaN(n) ? 0 : n;\n}\n\n// \"P1Y:CFQ7TTC0LCHC:0002:1:\" -> term P1Y (12 months), sku CFQ7TTC0LCHC\n// \"DZH318Z0BPS6:0001\" (Azure) -> sku DZH318Z0BPS6, monthly\nfunction parseStock(code) {\n  const parts = String(code || '').split(':');\n  if (/^P\\d+[YM]$/i.test(parts[0] || '')) {\n    const n = parseInt(parts[0].slice(1, -1), 10) || 1;\n    const months = /y/i.test(parts[0].slice(-1)) ? n * 12 : n;\n    return { sku: parts[1] || parts[0], term: parts[0].toUpperCase(), months: months };\n  }\n  return { sku: parts[0] || '', term: '', months: 1 };\n}\n\nconst annuityRows = $('Extract Annuity Details').all().map((i) => i.json);\nconst invoiceRows = $('Extract Invoice Details').all().map((i) => i.json);\n\n// Latest TERM START/END per subscription + stock code from the invoice report.\nconst terms = {};\nfor (const r of invoiceRows) {\n  const key = String(r['SUBSCRIPTION ID'] || '').trim() + '|' + String(r['STOCK CODE'] || '').trim();\n  const te = toIso(r['TERM END']);\n  if (!te) continue;\n  if (!terms[key] || te > terms[key].term_end) {\n    terms[key] = { term_start: toIso(r['TERM START']), term_end: te };\n  }\n}\n\nconst importedAt = new Date().toISOString();\nconst sourceFile = $('Normalize Uploads').first().json.annuity_name || 'annuity.xlsx';\nconst out = [];\n\nfor (const r of annuityRows) {\n  const tenant = String(r['TENANT NAME'] || '').trim();\n  const subId = String(r['SUBSCRIPTION ID'] || '').trim();\n  if (!tenant || !subId) continue;\n  if (PILOT_CUSTOMERS.length &&\n      !PILOT_CUSTOMERS.some((c) => c.toLowerCase() === tenant.toLowerCase())) {\n    continue;\n  }\n  const stockCode = String(r['STOCK CODE'] || '').trim();\n  const s = parseStock(stockCode);\n  const unitCost = num(r['UNIT PRICE']);\n  const unitRrp = num(r['UNIT RRP']);\n  const t = terms[subId + '|' + stockCode] || {};\n\n  out.push({ json: {\n    tenant_id: String(r['TENANT ID'] || '').trim(),\n    tenant_name: tenant,\n    subscription_id: subId,\n    stock_code: stockCode,\n    sku: s.sku,\n    offer_name: String(r['REFERENCE'] || r['STOCK DESCRIPTION'] || '').trim(),\n    stock_description: String(r['STOCK DESCRIPTION'] || '').trim(),\n    qty: num(r['QTY']),\n    charge_type: String(r['CHARGE TYPE'] || '').trim(),\n    status: String(r['STATUS'] || '').trim(),\n    unit_cost: unitCost,\n    unit_rrp: unitRrp,\n    revaluation_period: toIso(r['REVALUATION PERIOD']),\n    usage_start: toIso(r['START USAGE']),\n    usage_end: toIso(r['END USAGE']),\n    term_months: s.months,\n    monthly_cost: Math.round((unitCost / s.months) * 10000) / 10000,\n    monthly_rrp: Math.round((unitRrp / s.months) * 10000) / 10000,\n    term_start: t.term_start || '',\n    term_end: t.term_end || '',\n    imported_at: importedAt,\n    source_file: sourceFile,\n    sync_status: 'pending',\n    sync_message: '',\n  } });\n}\n\nif (!out.length) {\n  throw new Error('No matching subscription rows found in the DETAILS sheet. Check the PILOT_CUSTOMERS filter in this node.');\n}\nreturn out;\n" }
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
          monthly_cost: expr('{{ $json.monthly_cost }}'),
          monthly_rrp: expr('{{ $json.monthly_rrp }}'),
          term_start: expr('{{ $json.term_start }}'),
          term_end: expr('{{ $json.term_end }}'),
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
          { id: 'monthly_cost', displayName: 'monthly_cost', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'monthly_rrp', displayName: 'monthly_rrp', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'term_start', displayName: 'term_start', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'term_end', displayName: 'term_end', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// One summary item for the form completion page.\nconst items = $input.all();\nconst customers = {};\nfor (const i of items) customers[i.json.tenant_name || ''] = true;\nreturn [{ json: {\n  line_count: items.length,\n  customer_count: Object.keys(customers).length,\n} }];\n" }
  },
  output: [{ line_count: 12, customer_count: 2 }]
});

const importDone = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Import Complete',
    position: [1280, 0],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Import complete',
      completionMessage: expr('Imported {{ $json.line_count }} subscription lines for {{ $json.customer_count }} customer(s). Open the pricing portal to review sell prices and sync to Autotask.')
    }
  }
});

const noteImport = sticky(
  '## 01 · Annuity Import\nUpload both monthly Dicker Data files. Lines are matched on Subscription ID + Stock Code and upserted, so custom sell prices and include/exclude choices saved in the portal survive re-imports.\n\n**Pilot filter:** edit PILOT_CUSTOMERS at the top of the "Parse Subscription Lines" node (currently Atlas + Galilee; empty list = all customers).',
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
