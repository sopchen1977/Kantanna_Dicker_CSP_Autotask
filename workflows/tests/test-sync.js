// Simulate one loop iteration of workflow 03 with mocked Autotask responses.
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

const line = {
  tenant_name: 'Galilee Solicitors', subscription_id: 'SUB-A', stock_code: 'P1Y:SKU1:0002:1:',
  line_key: 'SUB-A|P1Y:SKU1:0002:1:', service_key: 'P1Y:SKU1', service_name: 'Thing [P1Y:SKU1]',
  contract_name: 'CSP - Thing - SUB-A', effective_sell: 34.55, qty: 51,
  monthly_cost: 29.37, monthly_rrp: 34.55, contract_start: '2025-12-29', contract_end: '2026-12-28',
  today: '2026-08-26', stock_description: 'DESC', offer_name: 'Thing',
  price_effective_date: '2026-08-26',
  invoice_lines: JSON.stringify([
    { s: '2026-07-13', e: '2026-07-30', q: 4, u: 16.37 },
    { s: '2026-07-27', e: '2026-07-30', q: 2, u: 3.64 },
    { s: '2026-07-31', e: '2026-08-30', q: 51, u: 29.37 },
  ]),
};
const nodes = { 'Current Line': [{ json: line }] };

// -- Scenario: service not found -> create; contract not found -> create; CS create; units 0 -> 51
let out = runNode('service-decision.js', [{ json: { items: [] } }], nodes);
assert.strictEqual(out[0].json.need_service, true);
nodes['Service Decision'] = out;

nodes['Service From Create'] = runNode('service-from-create.js', [{ json: { itemId: 9001 } }], nodes);
assert.strictEqual(nodes['Service From Create'][0].json.service_id, 9001);

// Record Service upsert row (as the data table would echo it)
nodes['Record Service'] = [{ json: { sku: 'P1Y:SKU1', service_name: line.service_name, autotask_service_id: 9001 } }];

nodes['Contract Decision'] = runNode('contract-decision.js', [{ json: { items: [] } }], nodes);
assert.strictEqual(nodes['Contract Decision'][0].json.need_contract, true);

nodes['Contract From Create'] = runNode('contract-from-create.js', [{ json: { itemId: 7001 } }], nodes);
assert.strictEqual(nodes['Contract From Create'][0].json.contract_id, 7001);

nodes['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [] } }], nodes);
assert.strictEqual(nodes['CS Decision'][0].json.action, 'create');
assert.strictEqual(nodes['CS Decision'][0].json.contract_id, 7001);
assert.strictEqual(nodes['CS Decision'][0].json.service_id, 9001);

nodes['CS From Create'] = runNode('cs-from-create.js', [{ json: { itemId: 8001 } }], nodes);
assert.strictEqual(nodes['CS From Create'][0].json.cs_id, 8001);

nodes['Units Decision'] = runNode('units-decision.js', [{ json: { items: [] } }], nodes);
// Fresh contract: pro-rata first in date order, then adjust up to target
const plan1 = nodes['Units Decision'][0].json.plan;
assert.deepStrictEqual(plan1.map((p) => [p.change, p.date]),
  [[4, '2026-07-13'], [2, '2026-07-27'], [45, '2026-07-31']]);
// Billing cycle derived from the invoice lines (not the subscription term)
assert.strictEqual(nodes['Units Decision'][0].json.cycle_start, '2026-07-31');
assert.strictEqual(nodes['Units Decision'][0].json.cycle_end, '2026-08-30');
assert.strictEqual(nodes['Units Decision'][0].json.cs_id, 8001);

const split = runNode('split-plan.js', nodes['Units Decision'], nodes);
assert.strictEqual(split.length, 3);
assert.strictEqual(split[0].json.change, 4);
assert.strictEqual(split[2].json.date, '2026-07-31');

// A successful ServiceAdjustments POST returns itemId: null — must count as OK
nodes['Adjust Result'] = runNode('adjust-result.js',
  [{ json: { itemId: null } }, { json: { itemId: null } }, { json: { itemId: null } }], nodes);
assert.strictEqual(nodes['Adjust Result'][0].json.adjust_ok_count, 3);
assert.strictEqual(nodes['Adjust Result'][0].json.adjust_error, '');

// ...and a failed one carries the Autotask message from the error details
const adjErr = runNode('adjust-result.js', [
  { json: { itemId: null } },
  { json: {
    error: { message: '500 - "{\\"errors\\":[...]}"', status: 500 },
    details: { httpCode: '500', description: 'The service was not able to process your request',
      body: { errors: ['ContractServiceAdjustment effectiveDate must be between the start date and end date of the Contract referenced by contractID.'] } },
  } },
], nodes)[0].json;
assert.strictEqual(adjErr.adjust_ok_count, 1);
assert.ok(adjErr.adjust_error.includes('effectiveDate must be between'), 'real Autotask error must surface');

const result = runNode('sync-result.js', [{ json: {} }], nodes)[0].json;
console.log('scenario 1 (all created):', result.sync_status, '|', result.sync_message);
assert.strictEqual(result.sync_status, 'synced');
assert.ok(result.sync_message.includes('+4 @2026-07-13') && result.sync_message.includes('+45 @2026-07-31'), 'message should show the chronological plan');
assert.strictEqual(result.autotask_contract_id, 7001);
assert.strictEqual(result.autotask_service_id, 9001);
assert.strictEqual(result.autotask_contract_service_id, 8001);

// -- Scenario 2: everything exists, price differs -> patch; units match
const n2 = { 'Current Line': [{ json: line }] };
n2['Service Decision'] = runNode('service-decision.js', [{ json: { items: [{ id: 9001, name: line.service_name }] } }], n2);
assert.strictEqual(n2['Service Decision'][0].json.need_service, false);
n2['Record Service'] = [{ json: { sku: 'P1Y:SKU1', autotask_service_id: 9001 } }];
n2['Contract Decision'] = runNode('contract-decision.js', [{ json: { items: [{ id: 7001, contractName: 'CSP - Thing - SUB-A' }] } }], n2);
assert.strictEqual(n2['Contract Decision'][0].json.need_contract, false);
// stale Contract From Create from another line must be ignored
n2['Contract From Create'] = [{ json: { line_key: 'OTHER|X', contract_id: 9999 } }];
n2['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [{ id: 8001, serviceID: 9001, adjustedPrice: 30 }] } }], n2);
assert.strictEqual(n2['CS Decision'][0].json.action, 'patch');
assert.strictEqual(n2['CS Decision'][0].json.contract_id, 7001, 'stale create data must not leak');
n2['CS After Patch'] = runNode('cs-after-patch.js', [{ json: {} }], n2);
// The query only returns internalCurrency* fields; the scale factor is
// internalCurrencyUnitPrice / unitPrice. Same price -> no patch (idempotent).
const csSame = runNode('cs-decision.js', [{ json: { items: [
  { id: 8001, serviceID: 9001, internalCurrencyAdjustedPrice: 1382, internalCurrencyUnitPrice: 1382, unitPrice: 34.55 },
] } }], n2)[0].json;
assert.strictEqual(csSame.action, 'none', 'unchanged internal-currency price must not re-patch');
assert.ok(Math.abs(csSame.old_price - 34.55) < 0.005);
// Different price via internal-currency fields -> patch with the real old price
const csDiff = runNode('cs-decision.js', [{ json: { items: [
  { id: 8001, serviceID: 9001, internalCurrencyAdjustedPrice: 1200, internalCurrencyUnitPrice: 1382, unitPrice: 34.55 },
] } }], n2)[0].json;
assert.strictEqual(csDiff.action, 'patch');
assert.ok(Math.abs(csDiff.old_price - 30) < 0.005, '1200/40 = 30');
// $0 line at a $0 sell: read-back is all zeros -> no re-patch
const nZ = { 'Current Line': [{ json: Object.assign({}, line, { effective_sell: 0 }) }],
  'Contract Decision': n2['Contract Decision'], 'Contract From Create': n2['Contract From Create'],
  'Record Service': n2['Record Service'] };
const csZero = runNode('cs-decision.js', [{ json: { items: [
  { id: 8001, serviceID: 9001, internalCurrencyAdjustedPrice: 0, internalCurrencyUnitPrice: 0, unitPrice: 0 },
] } }], nZ)[0].json;
assert.strictEqual(csZero.action, 'none', '$0 price must not re-patch every run');
assert.strictEqual(csZero.old_price, 0);
n2['Units Decision'] = runNode('units-decision.js', [{ json: { items: [{ startDate: '2026-08-01', units: 51 }] } }], n2);
assert.strictEqual(n2['Units Decision'][0].json.plan_count, 0, 'units already match -> no adjustments');
const r2 = runNode('sync-result.js', [{ json: {} }], n2)[0].json;
console.log('scenario 2 (patch price):', r2.sync_status, '|', r2.sync_message);
assert.strictEqual(r2.sync_status, 'synced');
assert.ok(r2.sync_message.includes('price 30 -> 34.55'));

// -- Scenario 3: Autotask error on create -> error status
const n3 = { 'Current Line': [{ json: line }] };
n3['Service Decision'] = runNode('service-decision.js', [{ json: { items: [] } }], n3);
n3['Service From Create'] = runNode('service-from-create.js', [{ json: { error: { message: 'materialCodeID invalid' } } }], n3);
n3['Record Service'] = [{ json: { sku: 'P1Y:SKU1', autotask_service_id: null } }];
n3['Contract Decision'] = runNode('contract-decision.js', [{ json: { items: [] } }], n3);
n3['Contract From Create'] = runNode('contract-from-create.js', [{ json: { error: { message: 'bad company' } } }], n3);
n3['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [] } }], n3);
assert.strictEqual(n3['CS Decision'][0].json.action, 'none');
n3['Units Decision'] = runNode('units-decision.js', [{ json: { items: [] } }], n3);
// existing history with different count -> single delta dated per the report
const n4 = { 'Current Line': [{ json: line }], 'CS Decision': [{ json: { line_key: line.line_key, contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55 } }] };
const ud4 = runNode('units-decision.js', [{ json: { items: [{ startDate: '2026-06-01', units: 45 }] } }], n4)[0].json;
assert.deepStrictEqual(ud4.plan, [{ change: 6, date: '2026-07-31' }], 'existing units -> one delta at the billing cycle start');

// -- Cycle-understanding edge cases --
// (a) In-cycle addition: change made AFTER cycle start, pro-rated to cycle end
const lineB = Object.assign({}, line, {
  qty: 54,
  invoice_lines: JSON.stringify([
    { s: '2026-07-31', e: '2026-08-30', q: 51, u: 29.37 },
    { s: '2026-08-10', e: '2026-08-30', q: 3, u: 19.58 },
  ]),
});
const nB = { 'Current Line': [{ json: lineB }], 'CS Decision': [{ json: { line_key: lineB.line_key, contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55 } }] };
const udB = runNode('units-decision.js', [{ json: { items: [] } }], nB)[0].json;
assert.deepStrictEqual(udB.plan.map((p) => [p.change, p.date]),
  [[51, '2026-07-31'], [3, '2026-08-10']], 'in-cycle addition applies after the cycle quantity');

// (b) Pro-rata qty coincidentally equals the cycle qty (old heuristic broke here)
const lineC = Object.assign({}, line, {
  qty: 2,
  invoice_lines: JSON.stringify([
    { s: '2026-07-20', e: '2026-07-30', q: 1, u: 5 },
    { s: '2026-07-31', e: '2026-08-30', q: 2, u: 29.37 },
  ]),
});
const nC = { 'Current Line': [{ json: lineC }], 'CS Decision': [{ json: { line_key: lineC.line_key, contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55 } }] };
const udC = runNode('units-decision.js', [{ json: { items: [] } }], nC)[0].json;
assert.deepStrictEqual(udC.plan.map((p) => [p.change, p.date]),
  [[1, '2026-07-20'], [1, '2026-07-31']], 'cycle line identified by its window, not by qty match');
// (c) Adjustment dates are clamped into the contract window
const lineD = Object.assign({}, line, {
  qty: 1, invoice_lines: '[]',
  contract_start: '2025-12-29', contract_end: '2026-12-28',
  price_effective_date: '2027-03-01',
});
const nD = { 'Current Line': [{ json: lineD }], 'CS Decision': [{ json: { line_key: lineD.line_key, contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55 } }] };
const udD = runNode('units-decision.js', [{ json: { items: [] } }], nD)[0].json;
assert.deepStrictEqual(udD.plan, [{ change: 1, date: '2026-12-28' }],
  'a date past the contract end must clamp to the contract end');

// -- Existing contract whose endDate predates the current term -> extend it
const nE = { 'Current Line': [{ json: line }] };
const cdE = runNode('contract-decision.js',
  [{ json: { items: [{ id: 7001, contractName: 'CSP - Thing - SUB-A', endDate: '2024-08-17T00:00:00Z' }] } }], nE)[0].json;
assert.strictEqual(cdE.need_contract, false);
assert.strictEqual(cdE.need_date_fix, true, 'stale contract endDate must trigger an extension');
assert.strictEqual(cdE.contract_end_needed, '2026-12-28');
assert.strictEqual(cdE.contract_end_found, '2024-08-17');
nE['Contract Decision'] = [{ json: cdE }];
const ceE = runNode('contract-extended.js', [{ json: { itemId: null } }], nE)[0].json;
assert.strictEqual(ceE.contract_id, 7001);
assert.strictEqual(ceE.extend_error, '');
// ...and a contract that already reaches the term end needs no fix
const cdOk = runNode('contract-decision.js',
  [{ json: { items: [{ id: 7001, contractName: 'CSP - Thing - SUB-A', endDate: '2026-12-28T00:00:00Z' }] } }], nE)[0].json;
assert.strictEqual(cdOk.need_date_fix, false);

// -- Month-to-month: the next billing cycle EXTENDS the same contract --
const lineM = Object.assign({}, line, {
  billing_type: 'monthly',
  contract_name: 'CSP - Thing - SUB-A',
  contract_start: '2026-08-22', contract_end: '2026-09-21',
});
const nM = { 'Current Line': [{ json: lineM }] };
const cdNewCycle = runNode('contract-decision.js',
  [{ json: { items: [{ id: 7005, contractName: 'CSP - Thing - SUB-A', endDate: '2026-08-21T00:00:00Z' }] } }], nM)[0].json;
assert.strictEqual(cdNewCycle.need_contract, false, 'monthly cycle reuses the same contract');
assert.strictEqual(cdNewCycle.contract_id, 7005);
assert.strictEqual(cdNewCycle.need_date_fix, true, 'new cycle end extends the contract');
assert.strictEqual(cdNewCycle.contract_end_needed, '2026-09-21');

// -- Billing summary: last approved & posted + estimated next charge --
const nBill = { 'Current Line': [{ json: line }],
  'Units Decision': [{ json: { line_key: line.line_key, contract_id: 7001, cs_id: 8001, plan: [], plan_count: 0, cycle_start: '2026-07-31' } }] };
// Nothing posted yet -> next charge lands at the current billing cycle
const bs0 = runNode('billing-summary.js', [{ json: { items: [] } }], nBill)[0].json;
assert.strictEqual(bs0.billing_last, 'nothing posted yet');
assert.ok(bs0.billing_next.startsWith('2026-07-31 · $1762.05 (51 × 34.55/mo)'), bs0.billing_next);
assert.strictEqual(bs0.plan_count, 0, 'Units Decision fields must pass through');
// Posted items: pro-rata rows on the latest date are summed; invoiced flagged
const bs1 = runNode('billing-summary.js', [{ json: { items: [
  { itemDate: '2026-06-30T00:00:00Z', totalAmount: 1500, invoiceID: 900 },
  { itemDate: '2026-07-31T00:00:00Z', totalAmount: 1700.5, invoiceID: 901 },
  { itemDate: '2026-07-31T00:00:00Z', totalAmount: 61.55, invoiceID: null },
] } }], nBill)[0].json;
assert.strictEqual(bs1.billing_last, '2026-07-31 · $1762.05 · invoiced');
assert.ok(bs1.billing_next.startsWith('2026-08-31 · '), 'next charge is one period after the last posted');
nBill['Billing Summary'] = [{ json: bs1 }];

const r3 = runNode('sync-result.js', [{ json: {} }], n3)[0].json;
console.log('scenario 3 (API errors):', r3.sync_status, '|', r3.sync_message.slice(0, 120));
assert.strictEqual(r3.sync_status, 'error');
assert.ok(r3.sync_message.includes('materialCodeID invalid'));

console.log('\nALL SYNC TESTS PASSED');
