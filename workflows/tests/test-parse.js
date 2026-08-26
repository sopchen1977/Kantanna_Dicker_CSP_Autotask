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
  { 'TENANT ID': 'T9', 'TENANT NAME': 'Some Other Customer', 'SUBSCRIPTION ID': 'SUB-9',
    'STOCK CODE': 'P1Y:XXXX:0001:1:', 'STOCK DESCRIPTION': 'Other', 'REFERENCE': 'Other',
    'QTY': '1.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '', 'END USAGE': '',
    'REVALUATION PERIOD': '', 'UNIT PRICE': '$1.00', 'UNIT RRP': '$2.00' },
];
const invoice = [
  { 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': 'SUB-1', 'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:',
    'TERM START': '31-AUG-2025', 'TERM END': '30-AUG-2026' },
  { 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': 'SUB-1', 'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:',
    'TERM START': '01-JAN-2025', 'TERM END': '31-DEC-2025' },
];

const nodes = {
  'Extract Annuity Details': annuity.map((j) => ({ json: j })),
  'Extract Invoice Details': invoice.map((j) => ({ json: j })),
  'Normalize Uploads': [{ json: { annuity_name: 'Annuity_Information_test.xlsx' } }],
};
const parsed = runNode('parse-lines.js', [{ json: {} }], nodes);

// Pilot filter keeps only Atlas + Galilee
assert.strictEqual(parsed.length, 3, 'pilot filter should keep 3 lines');
assert.ok(!parsed.some((i) => i.json.tenant_name === 'Some Other Customer'));

const bp = parsed.find((i) => i.json.subscription_id === 'SUB-1').json;
assert.strictEqual(bp.sku, 'CFQ7TTC0LCHC');
assert.strictEqual(bp.term_months, 12);
assert.strictEqual(bp.qty, 275);
assert.ok(Math.abs(bp.monthly_rrp - 34.55) < 0.001, 'annual RRP must convert to monthly');
// Latest term wins when the invoice has multiple rows
assert.strictEqual(bp.term_start, '2025-08-31');
assert.strictEqual(bp.term_end, '2026-08-30');

const bpMonthly = parsed.find((i) => i.json.subscription_id === 'SUB-2').json;
assert.strictEqual(bpMonthly.term_months, 1);
assert.ok(Math.abs(bpMonthly.monthly_rrp - 39.48) < 0.001);

const azure = parsed.find((i) => i.json.subscription_id === 'SUB-3').json;
assert.strictEqual(azure.sku, 'DZH318Z0BPS6');
assert.strictEqual(azure.charge_type, 'MODN');

// prepare-lines: default include rule + subscription id in contract name
const tableRows = parsed.map((i) => ({ json: Object.assign({}, i.json, { include: null, use_custom_price: null, sell_price: null }) }));
const prepared = runNode('prepare-lines.js', tableRows, {});
assert.strictEqual(prepared.length, 2, 'Azure/MODN line must be excluded by default');
for (const i of prepared) {
  assert.ok(i.json.contract_name.includes(i.json.subscription_id), 'Subscription ID must be in contract name');
  assert.strictEqual(i.json.effective_sell, i.json.monthly_rrp, 'default sell price is monthly RRP');
}

// custom price override wins
tableRows[0].json.use_custom_price = true;
tableRows[0].json.sell_price = 99.5;
const prepared2 = runNode('prepare-lines.js', tableRows, {});
assert.strictEqual(prepared2.find((i) => i.json.subscription_id === 'SUB-1').json.effective_sell, 99.5);

console.log('ALL PARSE TESTS PASSED');
