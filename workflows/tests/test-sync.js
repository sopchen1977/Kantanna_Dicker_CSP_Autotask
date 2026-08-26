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
assert.strictEqual(nodes['Units Decision'][0].json.cs_id, 8001);

const split = runNode('split-plan.js', nodes['Units Decision'], nodes);
assert.strictEqual(split.length, 3);
assert.strictEqual(split[0].json.change, 4);
assert.strictEqual(split[2].json.date, '2026-07-31');

nodes['Adjust Result'] = runNode('adjust-result.js',
  [{ json: { itemId: 6001 } }, { json: { itemId: 6002 } }, { json: { itemId: 6003 } }], nodes);
assert.strictEqual(nodes['Adjust Result'][0].json.adjust_ok_count, 3);
assert.strictEqual(nodes['Adjust Result'][0].json.adjust_error, '');

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
assert.deepStrictEqual(ud4.plan, [{ change: 6, date: '2026-07-31' }], 'existing units -> one delta at the main line usage start');
const r3 = runNode('sync-result.js', [{ json: {} }], n3)[0].json;
console.log('scenario 3 (API errors):', r3.sync_status, '|', r3.sync_message.slice(0, 120));
assert.strictEqual(r3.sync_status, 'error');
assert.ok(r3.sync_message.includes('materialCodeID invalid'));

console.log('\nALL SYNC TESTS PASSED');
