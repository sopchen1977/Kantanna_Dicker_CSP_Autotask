// Merge the annuity DETAILS rows with TERM START/END from the invoice
// "Invoice Details" rows and emit one normalised item per subscription line.
//
// ==== CONFIG: pilot customers. Empty array = import every customer. ====
const PILOT_CUSTOMERS = ['ATLAS OUTSOURCING PTY LTD', 'Galilee Solicitors'];
// =======================================================================

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

function toIso(d) {
  if (!d) return '';
  const m = String(d).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return String(d).trim();
  return m[3] + '-' + (MONTHS[m[2].toUpperCase()] || '01') + '-' + m[1].padStart(2, '0');
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// "P1Y:CFQ7TTC0LCHC:0002:1:" -> term P1Y (12 months), sku CFQ7TTC0LCHC
// "DZH318Z0BPS6:0001" (Azure) -> sku DZH318Z0BPS6, monthly
function parseStock(code) {
  const parts = String(code || '').split(':');
  if (/^P\d+[YM]$/i.test(parts[0] || '')) {
    const n = parseInt(parts[0].slice(1, -1), 10) || 1;
    const months = /y/i.test(parts[0].slice(-1)) ? n * 12 : n;
    return { sku: parts[1] || parts[0], term: parts[0].toUpperCase(), months: months };
  }
  return { sku: parts[0] || '', term: '', months: 1 };
}

const annuityRows = $('Extract Annuity Details').all().map((i) => i.json);
const invoiceRows = $('Extract Invoice Details').all().map((i) => i.json);

// Latest TERM START/END per subscription + stock code from the invoice report.
const terms = {};
for (const r of invoiceRows) {
  const key = String(r['SUBSCRIPTION ID'] || '').trim() + '|' + String(r['STOCK CODE'] || '').trim();
  const te = toIso(r['TERM END']);
  if (!te) continue;
  if (!terms[key] || te > terms[key].term_end) {
    terms[key] = { term_start: toIso(r['TERM START']), term_end: te };
  }
}

const importedAt = new Date().toISOString();
const sourceFile = $('Normalize Uploads').first().json.annuity_name || 'annuity.xlsx';
const out = [];

for (const r of annuityRows) {
  const tenant = String(r['TENANT NAME'] || '').trim();
  const subId = String(r['SUBSCRIPTION ID'] || '').trim();
  if (!tenant || !subId) continue;
  if (PILOT_CUSTOMERS.length &&
      !PILOT_CUSTOMERS.some((c) => c.toLowerCase() === tenant.toLowerCase())) {
    continue;
  }
  const stockCode = String(r['STOCK CODE'] || '').trim();
  const s = parseStock(stockCode);
  const unitCost = num(r['UNIT PRICE']);
  const unitRrp = num(r['UNIT RRP']);
  const t = terms[subId + '|' + stockCode] || {};

  out.push({ json: {
    tenant_id: String(r['TENANT ID'] || '').trim(),
    tenant_name: tenant,
    subscription_id: subId,
    stock_code: stockCode,
    sku: s.sku,
    offer_name: String(r['REFERENCE'] || r['STOCK DESCRIPTION'] || '').trim(),
    stock_description: String(r['STOCK DESCRIPTION'] || '').trim(),
    qty: num(r['QTY']),
    charge_type: String(r['CHARGE TYPE'] || '').trim(),
    status: String(r['STATUS'] || '').trim(),
    unit_cost: unitCost,
    unit_rrp: unitRrp,
    revaluation_period: toIso(r['REVALUATION PERIOD']),
    usage_start: toIso(r['START USAGE']),
    usage_end: toIso(r['END USAGE']),
    term_months: s.months,
    monthly_cost: Math.round((unitCost / s.months) * 10000) / 10000,
    monthly_rrp: Math.round((unitRrp / s.months) * 10000) / 10000,
    term_start: t.term_start || '',
    term_end: t.term_end || '',
    imported_at: importedAt,
    source_file: sourceFile,
    sync_status: 'pending',
    sync_message: '',
  } });
}

if (!out.length) {
  throw new Error('No matching subscription rows found in the DETAILS sheet. Check the PILOT_CUSTOMERS filter in this node.');
}
return out;
