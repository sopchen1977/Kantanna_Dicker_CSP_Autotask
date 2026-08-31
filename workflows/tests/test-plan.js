// Workflow 04 assembles a read-only plan from the SAME four decision files
// the sync runs. These tests drive plan-result.js over decision output, so a
// change to what the sync would do shows up here as a changed plan.
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

// Atlas, as the live data table holds it: three CSP invoice lines, one cycle
// and two mid-cycle changes.
const line = {
  tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:',
  line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_key: 'ANN-MO:CFQ7TTC0LCHC:0002',
  service_name: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT - Annual Commit (Billed Monthly)',
  service_name_suffix: ' - Annual Commit (Billed Monthly)',
  contract_name: 'CSP Microsoft Annual Commit Monthly 31 Aug 2025 to 30 Aug 2026',
  contract_number: 'CSP-ANN-MO-20250831-20260830',
  qty: 275, effective_sell: 34.55, monthly_cost: 28.1925, monthly_rrp: 34.55,
  contract_start: '2025-08-31', contract_end: '2026-08-30', today: '2026-08-31',
  price_effective_date: '2026-08-31', product_name: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT',
  stock_description: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT',
  invoice_lines: JSON.stringify([
    { s: '2026-07-13', e: '2026-07-30', q: 6, u: 16.37 },
    { s: '2026-07-27', e: '2026-07-30', q: 10, u: 3.64 },
    { s: '2026-07-31', e: '2026-08-30', q: 275, u: 28.19 },
  ]),
};

// ---- Nothing exists in Autotask yet: the whole job is ahead of us --------
// Every query comes back empty, and nothing is created, so the ids stay null
// all the way down - which is exactly the state a first-run plan reports.
const fresh = { 'Current Line': [{ json: line }] };
fresh['Service Decision'] = runNode('service-decision.js', [{ json: { items: [] } }], fresh);
fresh['Contract Decision'] = runNode('contract-decision.js', [{ json: { items: [] } }], fresh);
fresh['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: null } }];
fresh['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [] } }], fresh);
fresh['Units Decision'] = runNode('units-decision.js', [{ json: { items: [] } }], fresh);
const p1 = runNode('plan-result.js', fresh['Units Decision'], fresh)[0].json;

assert.strictEqual(p1.plan_status, 'ok');
assert.strictEqual(p1.plan_service_action, 'create', 'no service in Autotask -> create it');
assert.strictEqual(p1.plan_contract_action, 'create', 'no contract in Autotask -> create it');
assert.strictEqual(p1.plan_cs_action, 'create',
  'with no contract or service id yet, CS Decision says "none" - the plan must still say the service gets added');
assert.strictEqual(p1.plan_units_summary, '+6 @2026-07-13, +10 @2026-07-27, +259 @2026-07-31',
  'a new contract service replays the whole cycle from the report');
assert.strictEqual(p1.plan_target_units, 275);
assert.ok(/create contract/.test(p1.plan_summary), 'summary names the contract');
assert.ok(/create service/.test(p1.plan_summary), 'summary names the service');
assert.deepStrictEqual(JSON.parse(p1.plan_units).map((x) => [x.change, x.date]),
  [[6, '2026-07-13'], [10, '2026-07-27'], [259, '2026-07-31']]);

// ---- Everything already exists and matches: nothing to do ---------------
const svcRow = { id: 9001, sku: line.service_key, name: line.service_name };
const conRow = { id: 7001, contractNumber: line.contract_number, contractName: line.contract_name,
  startDate: '2025-08-31T00:00:00', endDate: '2026-08-30T00:00:00' };
const csRow = { id: 8001, serviceID: 9001, adjustedPrice: 34.55, unitPrice: 34.55,
  internalCurrencyUnitPrice: 34.55, internalCurrencyAdjustedPrice: 34.55 };

const done = { 'Current Line': [{ json: line }] };
done['Service Decision'] = runNode('service-decision.js', [{ json: { items: [svcRow] } }], done);
done['Contract Decision'] = runNode('contract-decision.js', [{ json: { items: [conRow] } }], done);
done['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: 9001 } }];
done['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [csRow] } }], done);
// Autotask already carries the two mid-cycle changes and the cycle quantity.
done['Units Decision'] = runNode('units-decision.js', [{ json: { items: [
  { startDate: '2026-06-30', units: 259 },
  { startDate: '2026-07-13', units: 265 },
  { startDate: '2026-07-27', units: 275 },
] } }], done);
const p2 = runNode('plan-result.js', done['Units Decision'], done)[0].json;

assert.strictEqual(p2.plan_service_action, 'ok');
assert.strictEqual(p2.plan_contract_action, 'ok');
assert.strictEqual(p2.plan_cs_action, 'ok');
assert.strictEqual(p2.plan_units_summary, '', 'already at the report quantity -> no adjustments');
assert.strictEqual(p2.plan_summary, 'nothing to do');
assert.strictEqual(p2.autotask_service_id, 9001, 'the plan records the ids it found');
assert.strictEqual(p2.autotask_contract_id, 7001);
assert.strictEqual(p2.autotask_contract_service_id, 8001);
assert.strictEqual(p2.contract_price, 34.55, 'the live contract price is read back without syncing');

// ---- Standing contract, seats moved mid-cycle: the pro-rata case --------
const moved = { 'Current Line': [{ json: line }] };
moved['Service Decision'] = runNode('service-decision.js', [{ json: { items: [svcRow] } }], moved);
moved['Contract Decision'] = runNode('contract-decision.js', [{ json: { items: [conRow] } }], moved);
moved['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: 9001 } }];
moved['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [csRow] } }], moved);
moved['Units Decision'] = runNode('units-decision.js',
  [{ json: { items: [{ startDate: '2026-06-30', units: 259 }] } }], moved);
const p3 = runNode('plan-result.js', moved['Units Decision'], moved)[0].json;

assert.strictEqual(p3.plan_cs_action, 'ok', 'the service is already on the contract at the right price');
assert.strictEqual(p3.plan_units_summary, '+6 @2026-07-13, +10 @2026-07-27',
  'the plan shows both pro-rata changes on the days they happened');
assert.strictEqual(p3.plan_current_units, 259);
assert.strictEqual(p3.plan_target_units, 275);

// ---- A failed lookup is never reported as "does not exist" --------------
const broken = { 'Current Line': [{ json: line }] };
broken['Service Decision'] = runNode('service-decision.js',
  [{ json: { error: { message: 'Autotask 500' } } }], broken);
broken['Contract Decision'] = runNode('contract-decision.js',
  [{ json: { error: { message: 'Autotask 500' } } }], broken);
broken['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: null } }];
broken['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [] } }], broken);
broken['Units Decision'] = runNode('units-decision.js', [{ json: { items: [] } }], broken);
const p4 = runNode('plan-result.js', broken['Units Decision'], broken)[0].json;

assert.strictEqual(p4.plan_status, 'error');
assert.ok(p4.plan_error.length > 0, 'the Autotask message is carried through');
assert.notStrictEqual(p4.plan_service_action, 'create',
  'a query that failed must never plan a duplicate service');
assert.notStrictEqual(p4.plan_contract_action, 'create',
  'a query that failed must never plan a duplicate contract');
assert.notStrictEqual(p4.plan_cs_action, 'create',
  'nor a duplicate contract service');

// ---- Two subscriptions of one product: both rows carry the same plan ----
// prepare-lines.js bills them as ONE contract service, so the plan is made
// once - against the primary - and has to be written back to every sibling,
// or the second row reads as a line nobody has checked.
const mergedLine = Object.assign({}, line, {
  merged_note: 'combined 2 subscriptions of the same product (SUB-13 x3, SUB-14 x5)',
  merged_keys: [
    { subscription_id: 'SUB-13', stock_code: 'P1Y:CFQ7TTC0LH04:0001:1:' },
    { subscription_id: 'SUB-14', stock_code: 'P1Y:CFQ7TTC0LH04:0001:1:' },
  ],
});
const mergedNodes = Object.assign({}, moved, { 'Current Line': [{ json: mergedLine }] });
const pMerged = runNode('plan-result.js', mergedNodes['Units Decision'], mergedNodes);

assert.strictEqual(pMerged.length, 2, 'both subscriptions get a plan row');
assert.deepStrictEqual(pMerged.map((i) => i.json.subscription_id), ['SUB-13', 'SUB-14']);
assert.deepStrictEqual(pMerged.map((i) => i.json.stock_code),
  ['P1Y:CFQ7TTC0LH04:0001:1:', 'P1Y:CFQ7TTC0LH04:0001:1:'],
  'each row is addressed by its OWN key, which is what Save Plan filters on');
for (const i of pMerged) {
  assert.strictEqual(i.json.plan_summary, p3.plan_summary, 'one shared plan, written twice');
  assert.strictEqual(i.json.autotask_contract_service_id, 8001,
    'both rows point at the one shared contract service');
  assert.strictEqual(i.json.plan_target_units, 275);
}

// An unmerged line still produces exactly one row.
assert.strictEqual(runNode('plan-result.js', moved['Units Decision'], moved).length, 1);

console.log('ALL PLAN TESTS PASSED');
