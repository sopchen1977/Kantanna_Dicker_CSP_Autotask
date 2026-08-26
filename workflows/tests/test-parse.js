// Runs the import Code-node scripts against a synthetic Dicker Data dataset
// shaped exactly like the real DETAILS / Invoice Details tabs.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const RUNTIME = path.join(__dirname, '..', 'runtime');

function makeDollar(nodes) {
  return (name) => {
    if (!(name in nodes)) throw new Error('No node data for ' + name);
    const items = nodes[name];
    return { all: () => items, first: () => items[0], item: items[0] };
  };
}
function runNode(file, inputItems, nodes) {
  const code = fs.readFileSync(path.join(RUNTIME, file), 'utf8');
  const fn = new Function('$input', '$', code);
  return fn({ all: () => inputItems, first: () => inputItems[0], item: inputItems[0] }, makeDollar(nodes));
}

const annuity = [
  { 'TENANT ID': 'T1', 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': 'SUB-1',
    'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:', 'STOCK DESCRIPTION': 'MS NCE M365 BP 1YR', 'REFERENCE': 'Microsoft 365 Business Premium',
    'QTY': '275.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '30-AUG-2025', 'END USAGE': '30-AUG-2025',
    'REVALUATION PERIOD': '30-AUG-2026', 'UNIT PRICE': '$338.31', 'UNIT RRP': '$414.60' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-2',
    'STOCK CODE': 'P1M:CFQ7TTC0LCHC:0002:1:', 'STOCK DESCRIPTION': 'MS NCE M365 BP 1MTH', 'REFERENCE': 'Microsoft 365 Business Premium',
    'QTY': '27.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '18-DEC-2025', 'END USAGE': '18-DEC-2025',
    'REVALUATION PERIOD': '', 'UNIT PRICE': '$33.56', 'UNIT RRP': '$39.48' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-3',
    'STOCK CODE': 'DZH318Z0BPS6:0001', 'STOCK DESCRIPTION': 'Microsoft Azure Plan', 'REFERENCE': 'Azure plan',
    'QTY': '1.00', 'CHARGE TYPE': 'MODN', 'STATUS': 'Active', 'START USAGE': '', 'END USAGE': '',
    'REVALUATION PERIOD': '', 'UNIT PRICE': '$0.00', 'UNIT RRP': '$0.00' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-4',
    'STOCK CODE': 'P1Y:CFQ7TTC0LFLZ:0002:Y:', 'STOCK DESCRIPTION': 'MS NCE M365 E5 1YR ANNUAL BILL', 'REFERENCE': 'Microsoft 365 E5',
    'QTY': '10.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '01-JAN-2026', 'END USAGE': '01-JAN-2026',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$835.26', 'UNIT RRP': '$1,000.00' },
  { 'TENANT ID': 'T9', 'TENANT NAME': 'Some Other Customer', 'SUBSCRIPTION ID': 'SUB-9',
    'STOCK CODE': 'P1Y:XXXX:0001:1:', 'STOCK DESCRIPTION': 'Other', 'REFERENCE': 'Other',
    'QTY': '1.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '', 'END USAGE': '',
    'REVALUATION PERIOD': '', 'UNIT PRICE': '$1.00', 'UNIT RRP': '$2.00' },
];
const invoice = [
  { 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': 'SUB-1', 'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:',
    'USAGE START': '31-JUL-2026', 'USAGE END': '30-AUG-2026', 'QTY': '275', 'UNIT PRICE': '28.19',
    'TERM START': '31-AUG-2025', 'TERM END': '30-AUG-2026' },
  { 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': 'SUB-1', 'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:',
    'USAGE START': '13-JUL-2026', 'USAGE END': '30-JUL-2026', 'QTY': '6', 'UNIT PRICE': '16.37',
    'TERM START': '01-JAN-2025', 'TERM END': '31-DEC-2025' },
  { 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': 'SUB-1', 'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:',
    'USAGE START': '27-JUL-2026', 'USAGE END': '30-JUL-2026', 'QTY': '10', 'UNIT PRICE': '3.64',
    'TERM START': '31-AUG-2025', 'TERM END': '30-AUG-2026' },
];

const nodes = {
  'Extract Annuity Details': annuity.map((j) => ({ json: j })),
  'Extract Invoice Details': invoice.map((j) => ({ json: j })),
  'Normalize Uploads': [{ json: { annuity_name: 'Annuity_Information_test.xlsx' } }],
};
const parsed = runNode('parse-lines.js', [{ json: {} }], nodes);

// Pilot filter keeps only Atlas + Galilee
assert.strictEqual(parsed.length, 4, 'pilot filter should keep 4 lines');
assert.ok(!parsed.some((i) => i.json.tenant_name === 'Some Other Customer'));

// Billing type 1: Annual Commit paid Monthly (P1Y:...:1:)
const bp = parsed.find((i) => i.json.subscription_id === 'SUB-1').json;
assert.strictEqual(bp.sku, 'CFQ7TTC0LCHC');
assert.strictEqual(bp.term_months, 12);
assert.strictEqual(bp.billing_type, 'annual_monthly');
assert.strictEqual(bp.billing_months, 1);
assert.strictEqual(bp.qty, 275);
assert.ok(Math.abs(bp.monthly_rrp - 34.55) < 0.001, 'annual RRP must convert to monthly');
assert.ok(Math.abs(bp.period_rrp - 34.55) < 0.001, 'billed monthly -> period price is monthly');
// Latest term wins when the invoice has multiple rows
assert.strictEqual(bp.term_start, '2025-08-31');
assert.strictEqual(bp.term_end, '2026-08-30');
// Invoice lines (incl. pro-rata) captured chronologically for replay
const invLines = JSON.parse(bp.invoice_lines);
assert.strictEqual(invLines.length, 3);
assert.deepStrictEqual(invLines.map((x) => [x.s, x.q]),
  [['2026-07-13', 6], ['2026-07-27', 10], ['2026-07-31', 275]]);

// Billing type 3: Month to Month (P1M:...:1:)
const bpMonthly = parsed.find((i) => i.json.subscription_id === 'SUB-2').json;
assert.strictEqual(bpMonthly.term_months, 1);
assert.strictEqual(bpMonthly.billing_type, 'monthly');
assert.ok(Math.abs(bpMonthly.monthly_rrp - 39.48) < 0.001);
assert.ok(Math.abs(bpMonthly.period_rrp - 39.48) < 0.001);

// Billing type 2: Annual Commit paid Annually upfront (P1Y:...:Y:)
const e5 = parsed.find((i) => i.json.subscription_id === 'SUB-4').json;
assert.strictEqual(e5.billing_type, 'annual_upfront');
assert.strictEqual(e5.billing_months, 12);
assert.ok(Math.abs(e5.period_rrp - 1000) < 0.001, 'upfront billing -> period price is full annual');
assert.ok(Math.abs(e5.monthly_rrp - 1000 / 12) < 0.001);

const azure = parsed.find((i) => i.json.subscription_id === 'SUB-3').json;
assert.strictEqual(azure.sku, 'DZH318Z0BPS6');
assert.strictEqual(azure.billing_type, 'usage');
assert.strictEqual(azure.charge_type, 'MODN');

// prepare-lines: default include rule + subscription id in contract name
const tableRows = parsed.map((i) => ({ json: Object.assign({}, i.json, { include: null, use_custom_price: null, sell_price: null }) }));
const prepared = runNode('prepare-lines.js', tableRows, {});
assert.strictEqual(prepared.length, 3, 'Azure/MODN line must be excluded by default');
for (const i of prepared) {
  assert.ok(i.json.contract_name.includes(i.json.subscription_id), 'Subscription ID must be in contract name');
  assert.strictEqual(i.json.effective_sell, i.json.period_rrp, 'default sell price is the per-period RRP');
}
// Each billing type creates a distinct service with the right period type
const pAnnMo = prepared.find((i) => i.json.subscription_id === 'SUB-1').json;
assert.strictEqual(pAnnMo.service_key, 'ANN-MO:CFQ7TTC0LCHC');
assert.strictEqual(pAnnMo.service_period_type, 2);
assert.ok(pAnnMo.service_name.includes('Annual Commit (Billed Monthly)'));
const pMtm = prepared.find((i) => i.json.subscription_id === 'SUB-2').json;
assert.strictEqual(pMtm.service_key, 'MTM:CFQ7TTC0LCHC');
assert.strictEqual(pMtm.service_period_type, 2);
assert.ok(pMtm.service_name.includes('Month to Month'));
const pAnnYr = prepared.find((i) => i.json.subscription_id === 'SUB-4').json;
assert.strictEqual(pAnnYr.service_key, 'ANN-YR:CFQ7TTC0LFLZ');
assert.strictEqual(pAnnYr.service_period_type, 5, 'upfront billing -> yearly service period (Autotask picklist 5)');
assert.strictEqual(pAnnYr.effective_sell, 1000);
assert.ok(pAnnYr.service_name.includes('Annual Commit (Billed Annually)'));
// No invoice rows -> contract window falls back to the revaluation period,
// not usage start + 12 months (which could date the contract years back)
assert.strictEqual(pAnnYr.contract_end, '2026-12-28');
assert.strictEqual(pAnnYr.contract_start, '2025-12-28');
assert.ok(pAnnYr.price_effective_date >= pAnnYr.contract_start
  && pAnnYr.price_effective_date <= pAnnYr.contract_end,
  'effective date must be clamped into the contract window');

// custom price override wins
tableRows[0].json.use_custom_price = true;
tableRows[0].json.sell_price = 99.5;
const prepared2 = runNode('prepare-lines.js', tableRows, {});
assert.strictEqual(prepared2.find((i) => i.json.subscription_id === 'SUB-1').json.effective_sell, 99.5);

console.log('ALL PARSE TESTS PASSED');
