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
  line_key: 'SUB-A|P1Y:SKU1:0002:1:', service_key: 'ANN-MO:SKU1:0002',
  service_name: 'MS NCE THING 1YR COMMIT - Annual Commit (Billed Monthly)',
  service_name_suffix: ' - Annual Commit (Billed Monthly)',
  service_name_suffix_legacy: ' - Annual Commit (Billed Monthly) [SKU1]',
  contract_name: 'CSP - Thing - SUB-A',
  contract_number: 'CSP-ANN-MO-20251229-20261228', effective_sell: 34.55, qty: 51,
  monthly_cost: 29.37, monthly_rrp: 34.55, contract_start: '2025-12-29', contract_end: '2026-12-28',
  today: '2026-08-26', product_name: 'MS NCE THING 1YR COMMIT',
  stock_description: 'MS NCE THING 1YR COMMIT', offer_name: 'DO NOT USE - Thing',
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
nodes['Record Service'] = [{ json: { sku: line.service_key, service_name: line.service_name, autotask_service_id: 9001 } }];

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

const resultItems = runNode('sync-result.js', [{ json: {} }], nodes);
assert.strictEqual(resultItems.length, 1, 'one subscription -> one status row');
const result = resultItems[0].json;
console.log('scenario 1 (all created):', result.sync_status, '|', result.sync_message);
assert.strictEqual(result.sync_status, 'synced');
assert.ok(result.sync_message.includes('+4 @2026-07-13') && result.sync_message.includes('+45 @2026-07-31'), 'message should show the chronological plan');
assert.strictEqual(result.autotask_contract_id, 7001);
assert.strictEqual(result.autotask_service_id, 9001);
assert.strictEqual(result.autotask_contract_service_id, 8001);

// -- The Autotask service is found by its KEY, not by its name ------------
// A service this automation created before the product name was taken from
// the annuity STOCK DESCRIPTION still carries "DO NOT USE - Thing" as its
// name. Matching on the name would miss it and stand a duplicate service up
// beside it; matching on the sku field finds it and renames it in place.
const staleName = 'DO NOT USE - Thing - Annual Commit (Billed Monthly) [SKU1]';
const byKey = runNode('service-decision.js',
  [{ json: { items: [{ id: 9001, sku: line.service_key, name: staleName }] } }], nodes)[0].json;
assert.strictEqual(byKey.need_service, false, 'a renamed service must not be recreated');
assert.strictEqual(byKey.service_id, 9001);
assert.strictEqual(byKey.service_matched_by, 'sku');
assert.strictEqual(byKey.need_service_patch, true);
assert.deepStrictEqual(byKey.service_patch, { id: 9001, name: line.service_name });

// Already correct -> nothing to patch.
const settled = runNode('service-decision.js',
  [{ json: { items: [{ id: 9001, sku: line.service_key, name: line.service_name }] } }], nodes)[0].json;
assert.strictEqual(settled.need_service_patch, false);

// A name somebody typed in Autotask does not end in " - {billing type}
// [{SKU}]", so it was not written by this automation and is left alone.
const handNamed = runNode('service-decision.js',
  [{ json: { items: [{ id: 9001, sku: line.service_key, name: 'Thing, as we sell it' }] } }], nodes)[0].json;
assert.strictEqual(handNamed.service_id, 9001);
assert.strictEqual(handNamed.need_service_patch, false,
  'a hand-written service name is nobody else\'s business');

// A name written before the SKU was dropped still ends in the LEGACY suffix,
// so it is recognised as ours and renamed to drop it.
const withSku = runNode('service-decision.js', [{ json: { items: [
  { id: 9001, sku: line.service_key, name: 'MS NCE THING 1YR COMMIT - Annual Commit (Billed Monthly) [SKU1]' },
] } }], nodes)[0].json;
assert.strictEqual(withSku.service_id, 9001);
assert.deepStrictEqual(withSku.service_patch, { id: 9001, name: line.service_name },
  'dropping the SKU from the name must not freeze the existing names');

// A service created before the key was written to `sku` carries only its
// name. It is adopted once, and the patch stamps the key on.
const legacy = runNode('service-decision.js',
  [{ json: { items: [{ id: 9001, name: line.service_name }] } }], nodes)[0].json;
assert.strictEqual(legacy.service_matched_by, 'name');
assert.deepStrictEqual(legacy.service_patch, { id: 9001, sku: line.service_key });
// ...but never one already claimed by a different key.
const claimed = runNode('service-decision.js',
  [{ json: { items: [{ id: 9002, sku: 'ANN-YR:SKU1:0002', name: line.service_name }] } }], nodes)[0].json;
assert.strictEqual(claimed.service_id, null);
assert.strictEqual(claimed.need_service, true);

// A failed lookup must never read as "no service exists" - that would build a
// second service beside the real one.
const svcQueryErr = runNode('service-decision.js', [{ json: {
  error: { message: '500 - Autotask is unavailable' },
  details: { body: { errors: ['Zone unavailable'] } },
} }], nodes)[0].json;
assert.strictEqual(svcQueryErr.need_service, false, 'a lookup failure must not create a duplicate');
assert.ok(svcQueryErr.query_error.includes('Zone unavailable'));
const rSvcErr = runNode('sync-result.js', [{ json: {} }],
  Object.assign({}, nodes, { 'Service Decision': [{ json: svcQueryErr }] , 'Service From Create': [{ json: { line_key: 'OTHER|X' } }] }))[0].json;
assert.strictEqual(rSvcErr.sync_status, 'error');
assert.ok(rSvcErr.sync_message.includes('service lookup failed'));

// The rename itself, reported back to the portal.
const patched = runNode('service-patched.js', [{ json: {} }],
  Object.assign({}, nodes, { 'Service Decision': [{ json: byKey }] }))[0].json;
assert.strictEqual(patched.service_id, 9001);
assert.strictEqual(patched.patch_error, '');
const rPatched = runNode('sync-result.js', [{ json: {} }],
  Object.assign({}, nodes, { 'Service Decision': [{ json: byKey }], 'Service Patched': [{ json: patched }] }))[0].json;
assert.ok(rPatched.sync_message.includes('service updated (renamed to'), rPatched.sync_message);
const patchFailed = runNode('service-patched.js',
  [{ json: { error: { message: 'name already in use' } } }],
  Object.assign({}, nodes, { 'Service Decision': [{ json: byKey }] }))[0].json;
assert.ok(patchFailed.patch_error.includes('name already in use'));

// -- Scenario 2: everything exists, user is EDITING the price -> patch;
//    units match. (Re-pricing only happens with 'Edit price' ticked.)
const lineEdit = Object.assign({}, line, { use_custom_price: true, sell_price: 34.55 });
const n2 = { 'Current Line': [{ json: lineEdit }] };
n2['Service Decision'] = runNode('service-decision.js',
  [{ json: { items: [{ id: 9001, sku: line.service_key, name: line.service_name }] } }], n2);
assert.strictEqual(n2['Service Decision'][0].json.need_service, false);
n2['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: 9001 } }];
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
// NOT editing: a differing price must be left alone (no revert to RRP),
// and the contract's current price is carried for unit adjustments.
const nNoEdit = { 'Current Line': [{ json: line }],
  'Contract Decision': n2['Contract Decision'], 'Contract From Create': n2['Contract From Create'],
  'Record Service': n2['Record Service'] };
const csNoEdit = runNode('cs-decision.js', [{ json: { items: [
  { id: 8001, serviceID: 9001, adjustedPrice: 30 },
] } }], nNoEdit)[0].json;
assert.strictEqual(csNoEdit.action, 'none', 'without Edit price ticked the contract price stays as is');
assert.strictEqual(csNoEdit.sell, 30, 'unit adjustments carry the existing contract price');
// $0 line at a $0 sell: read-back is all zeros -> no re-patch
const nZ = { 'Current Line': [{ json: Object.assign({}, line, { effective_sell: 0, use_custom_price: true, sell_price: 0 }) }],
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
assert.strictEqual(r2.contract_price, 34.55, 'patched price becomes the stored contract price');

// -- Scenario 3: Autotask error on create -> error status
const n3 = { 'Current Line': [{ json: line }] };
n3['Service Decision'] = runNode('service-decision.js', [{ json: { items: [] } }], n3);
n3['Service From Create'] = runNode('service-from-create.js', [{ json: { error: { message: 'materialCodeID invalid' } } }], n3);
n3['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: null } }];
n3['Contract Decision'] = runNode('contract-decision.js', [{ json: { items: [] } }], n3);
n3['Contract From Create'] = runNode('contract-from-create.js', [{ json: { error: { message: 'bad company' } } }], n3);
n3['CS Decision'] = runNode('cs-decision.js', [{ json: { items: [] } }], n3);
assert.strictEqual(n3['CS Decision'][0].json.action, 'none');
n3['Units Decision'] = runNode('units-decision.js', [{ json: { items: [] } }], n3);
// existing history with different count -> single delta dated per the report
const n4 = { 'Current Line': [{ json: line }], 'CS Decision': [{ json: { line_key: line.line_key, contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55 } }] };
const ud4 = runNode('units-decision.js', [{ json: { items: [{ startDate: '2026-06-01', units: 45 }] } }], n4)[0].json;
assert.deepStrictEqual(ud4.plan, [{ change: 6, date: '2026-07-31' }], 'existing units -> one delta at the billing cycle start');

// A fresh service whose cycle quantity is short of the annuity quantity plans
// the cycle set AND a correction, both dated at the cycle start. Autotask keys
// a contract service period on (service, period start, period end) and rejects
// the second insert with "Attempt to insert duplicate data into
// contract_service_period", so same-day changes must be merged into one.
const nDup = { 'Current Line': [{ json: Object.assign({}, line, {
  qty: 2,
  contract_start: '2025-12-21',
  contract_end: '2026-09-21',
  invoice_lines: JSON.stringify([{ s: '2026-06-22', e: '2026-07-21', q: 1, u: 65.2 }]),
}) }], 'CS Decision': [{ json: { line_key: line.line_key, contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 76.7 } }] };
const udDup = runNode('units-decision.js', [{ json: { items: [] } }], nDup)[0].json;
assert.deepStrictEqual(udDup.plan, [{ change: 2, date: '2026-06-22' }],
  'two same-day changes must post as one adjustment, not two');
assert.strictEqual(udDup.plan_summary, '+2 @2026-06-22');

// Merging must not collapse changes on different dates, and must drop a pair
// that nets to zero.
const nNet = { 'Current Line': [{ json: Object.assign({}, line, {
  qty: 3,
  invoice_lines: JSON.stringify([
    { s: '2026-07-13', e: '2026-08-30', q: 5, u: 16.37 },
    { s: '2026-07-31', e: '2026-08-30', q: 3, u: 29.37 },
  ]),
}) }], 'CS Decision': [{ json: { line_key: line.line_key, contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55 } }] };
const udNet = runNode('units-decision.js', [{ json: { items: [] } }], nNet)[0].json;
assert.strictEqual(udNet.plan.length, 2, 'different dates stay separate');
assert.deepStrictEqual(udNet.plan.map((p) => p.date), ['2026-07-13', '2026-07-31']);
assert.ok(udNet.plan.every((p) => p.change !== 0), 'a no-op change is never posted');

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

// -- Contract identity is the External Contract Number, not the name -------
const nE = { 'Current Line': [{ json: line }] };
const stamped = { id: 7001, contractName: 'Whatever Someone Renamed It To',
  contractNumber: 'CSP-ANN-MO-20251229-20261228', endDate: '2026-12-28T00:00:00Z' };

// A contract carrying the reference is THE contract, whatever it is called.
const cdRef = runNode('contract-decision.js', [{ json: { items: [stamped] } }], nE)[0].json;
assert.strictEqual(cdRef.need_contract, false);
assert.strictEqual(cdRef.contract_id, 7001);
assert.strictEqual(cdRef.contract_matched_by, 'number');
assert.strictEqual(cdRef.need_contract_patch, false,
  'a contract found by reference and reaching the term end needs nothing');

// A contract belonging to a DIFFERENT group is never adopted, even when the
// name happens to line up.
const cdOther = runNode('contract-decision.js', [{ json: { items: [
  { id: 7009, contractName: 'CSP - Thing - SUB-A', contractNumber: 'CSP-ANN-MO-20240101-20241231' },
] } }], nE)[0].json;
assert.strictEqual(cdOther.need_contract, true, 'someone else\'s contract must not be stolen');
assert.strictEqual(cdOther.contract_id, null);

// A contract predating the reference is adopted by name ONCE: the reference
// is stamped on, and its stale endDate is extended in the same PATCH.
const cdE = runNode('contract-decision.js',
  [{ json: { items: [{ id: 7001, contractName: 'CSP - Thing - SUB-A', endDate: '2024-08-17T00:00:00Z' }] } }], nE)[0].json;
assert.strictEqual(cdE.need_contract, false);
assert.strictEqual(cdE.contract_matched_by, 'name');
assert.strictEqual(cdE.need_contract_patch, true);
assert.deepStrictEqual(cdE.contract_patch,
  { id: 7001, endDate: '2026-12-28', contractNumber: 'CSP-ANN-MO-20251229-20261228' });
assert.strictEqual(cdE.contract_end_needed, '2026-12-28');
assert.strictEqual(cdE.contract_end_found, '2024-08-17');
nE['Contract Decision'] = [{ json: cdE }];
const ceE = runNode('contract-patched.js', [{ json: { itemId: null } }], nE)[0].json;
assert.strictEqual(ceE.contract_id, 7001);
assert.strictEqual(ceE.patch_error, '');

// Adoption is also the one moment the name is ours to correct - a month to
// month contract still carrying its old ISO-dated name is renamed.
const lineLegacy = Object.assign({}, line, {
  contract_name: 'CSP Microsoft Month to Month Started 18 Dec 2025',
  contract_name_legacy: 'CSP Microsoft Month to Month Started 2025-12-18',
  contract_number: 'CSP-MTM-D1-20251218',
});
const cdLegacy = runNode('contract-decision.js', [{ json: { items: [
  { id: 7007, contractName: 'CSP Microsoft Month to Month Started 2025-12-18', endDate: '2026-12-28T00:00:00Z' },
] } }], { 'Current Line': [{ json: lineLegacy }] })[0].json;
assert.strictEqual(cdLegacy.contract_id, 7007,
  'a contract named before the rename must still be found');
assert.deepStrictEqual(cdLegacy.contract_patch, { id: 7007,
  contractNumber: 'CSP-MTM-D1-20251218',
  contractName: 'CSP Microsoft Month to Month Started 18 Dec 2025' });

// A failed lookup must never read as "no contract exists".
const cdErr = runNode('contract-decision.js',
  [{ json: { error: { message: 'API thread threshold of 3 threads has been exceeded' } } }], nE)[0].json;
assert.strictEqual(cdErr.need_contract, false, 'a query error must not create a duplicate contract');
assert.ok(cdErr.query_error.includes('thread threshold'));
const errResult = runNode('sync-result.js', [{ json: {} }],
  { 'Current Line': [{ json: line }], 'Contract Decision': [{ json: cdErr }] })[0].json;
assert.strictEqual(errResult.sync_status, 'error');
assert.ok(errResult.sync_message.includes('contract lookup failed'), errResult.sync_message);

// -- Two subscriptions of the same product share one contract service, so
// -- the sync runs once but BOTH table rows get their status written back.
const mergedLine = Object.assign({}, line, {
  merged_note: 'combined 2 subscriptions of the same product (SUB-13 x3, SUB-14 x5)',
  merged_keys: [
    { subscription_id: 'SUB-13', stock_code: 'P1Y:CFQ7TTC0LH04:0001:1:' },
    { subscription_id: 'SUB-14', stock_code: 'P1Y:CFQ7TTC0LH04:0001:1:' },
  ],
});
const nMerged = Object.assign({}, nodes, { 'Current Line': [{ json: mergedLine }] });
const mergedOut = runNode('sync-result.js', [{ json: {} }], nMerged);
assert.strictEqual(mergedOut.length, 2, 'both subscriptions get a status row');
assert.deepStrictEqual(mergedOut.map((i) => i.json.subscription_id), ['SUB-13', 'SUB-14']);
for (const i of mergedOut) {
  assert.strictEqual(i.json.sync_status, 'synced');
  assert.strictEqual(i.json.autotask_contract_service_id, 8001,
    'both rows point at the one shared contract service');
  assert.ok(i.json.sync_message.startsWith('combined 2 subscriptions'), i.json.sync_message);
}

// -- Month-to-month: the next billing cycle EXTENDS the same contract --
const lineM = Object.assign({}, line, {
  billing_type: 'monthly',
  contract_name: 'CSP - Thing - SUB-A',
  contract_start: '2026-08-22', contract_end: '2026-09-21',
});
const nM = { 'Current Line': [{ json: lineM }] };
const cdNewCycle = runNode('contract-decision.js',
  [{ json: { items: [{ id: 7005, contractName: 'anything at all',
    contractNumber: line.contract_number, endDate: '2026-08-21T00:00:00Z' }] } }], nM)[0].json;
assert.strictEqual(cdNewCycle.need_contract, false, 'monthly cycle reuses the same contract');
assert.strictEqual(cdNewCycle.contract_id, 7005);
assert.strictEqual(cdNewCycle.need_contract_patch, true, 'new cycle end extends the contract');
assert.deepStrictEqual(cdNewCycle.contract_patch, { id: 7005, endDate: '2026-09-21' },
  'a contract already carrying its reference is only extended, never renamed');
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

// A co-term group contract carries every member's billing, so items belonging
// to the OTHER services on the contract must not be counted against this line.
const nBillGroup = { 'Current Line': [{ json: line }],
  'Units Decision': [{ json: { line_key: line.line_key, contract_id: 7001, cs_id: 8001, service_id: 650,
    plan: [], plan_count: 0, cycle_start: '2026-07-31' } }] };
const bsGroup = runNode('billing-summary.js', [{ json: { items: [
  { itemDate: '2026-07-31T00:00:00Z', totalAmount: 1762.05, invoiceID: 901, contractServiceID: 8001, serviceID: 650 },
  { itemDate: '2026-08-31T00:00:00Z', totalAmount: 99999, invoiceID: 902, contractServiceID: 8002, serviceID: 651 },
] } }], nBillGroup)[0].json;
assert.strictEqual(bsGroup.billing_last, '2026-07-31 · $1762.05 · invoiced',
  'another service on the shared contract must not become this line\'s last posted');
// Falls back to serviceID when the API omits contractServiceID.
const bsGroup2 = runNode('billing-summary.js', [{ json: { items: [
  { itemDate: '2026-07-31T00:00:00Z', totalAmount: 1762.05, serviceID: 650 },
  { itemDate: '2026-08-31T00:00:00Z', totalAmount: 99999, serviceID: 651 },
] } }], nBillGroup)[0].json;
assert.strictEqual(bsGroup2.billing_last, '2026-07-31 · $1762.05 · posted');

nBill['Billing Summary'] = [{ json: bs1 }];

const r3 = runNode('sync-result.js', [{ json: {} }], n3)[0].json;
console.log('scenario 3 (API errors):', r3.sync_status, '|', r3.sync_message.slice(0, 120));
assert.strictEqual(r3.sync_status, 'error');
assert.ok(r3.sync_message.includes('materialCodeID invalid'));

// -- Invoice description ---------------------------------------------------
// A description is only pushed when the user typed one in the portal, so a
// description edited by hand in Autotask is never silently overwritten.
const csRow = { id: 8001, serviceID: 9001, adjustedPrice: 34.55,
  invoiceDescription: 'Thing - sub SUB-A' };

const nDescOff = { 'Current Line': [{ json: Object.assign({}, line, {
  service_invoice_description: 'Something else entirely',
  invoice_description_custom: false,
}) }] };
nDescOff['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: 9001 } }];
nDescOff['Contract Decision'] = [{ json: { line_key: line.line_key, contract_id: 7001 } }];
const descOff = runNode('cs-decision.js', [{ json: { items: [csRow] } }], nDescOff)[0].json;
assert.strictEqual(descOff.desc_change, false,
  'a generated description must not overwrite what Autotask already has');
assert.strictEqual(descOff.cs_invoice_description, 'Thing - sub SUB-A',
  'the live description is read back for the portal to show');

const nDesc = { 'Current Line': [{ json: Object.assign({}, line, {
  service_invoice_description: 'M365 Business Premium licences',
  invoice_description_custom: true,
}) }] };
nDesc['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: 9001 } }];
nDesc['Contract Decision'] = [{ json: { line_key: line.line_key, contract_id: 7001 } }];
const descOn = runNode('cs-decision.js', [{ json: { items: [csRow] } }], nDesc)[0].json;
assert.strictEqual(descOn.desc_change, true, 'a typed description is pushed');
assert.strictEqual(descOn.action, 'none', 'a description change alone is not a re-price');
assert.strictEqual(descOn.target_invoice_description, 'M365 Business Premium licences');

// Same text already in Autotask -> nothing to do (idempotent).
const descSame = runNode('cs-decision.js', [{ json: { items: [
  Object.assign({}, csRow, { invoiceDescription: 'M365 Business Premium licences' }),
] } }], nDesc)[0].json;
assert.strictEqual(descSame.desc_change, false, 'an unchanged description must not re-patch');

// A brand-new contract service is created with its description, not patched.
const descNew = runNode('cs-decision.js', [{ json: { items: [] } }], nDesc)[0].json;
assert.strictEqual(descNew.action, 'create');
assert.strictEqual(descNew.desc_change, false, 'a create already carries the description');

// The PATCH result must carry the identifiers the units query needs.
nDesc['CS Decision'] = [{ json: descOn }];
const dOk = runNode('desc-result.js', [{ json: { itemId: 8001 } }], nDesc)[0].json;
assert.strictEqual(dOk.desc_updated, true);
assert.strictEqual(dOk.desc_error, '');
assert.strictEqual(dOk.cs_id, 8001, 'Fetch CS Units reads cs_id off this item');
assert.strictEqual(dOk.contract_id, 7001);
assert.strictEqual(dOk.desc_to, 'M365 Business Premium licences');

const dBad = runNode('desc-result.js',
  [{ json: { errors: ['invoiceDescription exceeds maximum length'] } }], nDesc)[0].json;
assert.strictEqual(dBad.desc_updated, false);
assert.ok(dBad.desc_error.includes('exceeds maximum length'));
assert.strictEqual(dBad.cs_id, 8001, 'a failed description patch must not break the units query');

// ...and it reaches the line's status + the portal's stored description.
// A resolved service and contract, so the run has no unrelated errors.
nDesc['Service Decision'] = [{ json: { line_key: line.line_key, service_id: 9001 } }];
const nDescRes = Object.assign({}, nDesc, { 'Desc Result': [{ json: dOk }] });
const rDesc = runNode('sync-result.js', [{ json: {} }], nDescRes)[0].json;
assert.ok(rDesc.sync_message.includes('invoice description -> M365 Business Premium licences'));
assert.strictEqual(rDesc.contract_invoice_description, 'M365 Business Premium licences');

const nDescFail = Object.assign({}, nDesc, { 'Desc Result': [{ json: dBad }] });
const rDescFail = runNode('sync-result.js', [{ json: {} }], nDescFail)[0].json;
assert.strictEqual(rDescFail.sync_status, 'error');
assert.ok(rDescFail.sync_message.includes('invoice description update failed'));
assert.strictEqual(rDescFail.contract_invoice_description, 'Thing - sub SUB-A',
  'a failed patch leaves the live description showing what Autotask still has');

// -- The portal page reads Autotask live ------------------------------------
// A description or price edited by hand in Autotask must show on a plain
// refresh, without waiting for a sync.
function runPortal(nodes) {
  const code = fs.readFileSync(path.join(RUNTIME, 'build-portal-page.js'), 'utf8');
  const fn = new Function('$input', '$', 'Buffer', code);
  const withTemplate = Object.assign({
    'Portal Template': [{ json: { html: '<html>__DATA_PLACEHOLDER__</html>' } }],
  }, nodes);
  return fn({ all: () => [], first: () => ({ json: {} }) }, makeDollar(withTemplate), Buffer);
}
function portalLines(nodes) {
  const html = runPortal(nodes)[0].json.html;
  const b64 = html.replace('<html>', '').replace('</html>', '');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).lines;
}

const storedLine = {
  subscription_id: 'SUB-A', stock_code: 'P1Y:SKU1:0002:1:', tenant_name: 'Galilee Solicitors',
  autotask_contract_id: 7001, autotask_contract_service_id: 8001,
  contract_price: 34.55, contract_invoice_description: 'Thing - sub SUB-A',
};
const portalNodes = {
  'Fetch Lines': [{ json: storedLine }],
  'Fetch Mappings': [{ json: { tenant_name: 'Galilee Solicitors', autotask_company_id: 405 } }],
  'Fetch Live Services': [{ json: { items: [{
    id: 8001, serviceID: 9001, invoiceDescription: 'Edited by hand in Autotask',
    internalCurrencyAdjustedPrice: 1200, internalCurrencyUnitPrice: 1382, unitPrice: 34.55,
  }] } }],
  'Fetch Billing Items': [{ json: { items: [] } }],
  'Fetch Invoices': [{ json: { items: [] } }],
};
const shown = portalLines(portalNodes)[0];
assert.strictEqual(shown.contract_invoice_description, 'Edited by hand in Autotask',
  'a hand-edited Autotask description must show on refresh');
assert.ok(Math.abs(shown.contract_price - 30) < 0.005,
  'the live price is converted out of internal currency: ' + shown.contract_price);

// Autotask unreachable, or the line has no contract service yet: the page
// still renders from what was stored.
const noLive = Object.assign({}, portalNodes, { 'Fetch Live Services': [{ json: {} }] });
assert.strictEqual(portalLines(noLive)[0].contract_invoice_description, 'Thing - sub SUB-A');
assert.strictEqual(portalLines(noLive)[0].contract_price, 34.55);

const unmatched = Object.assign({}, portalNodes, { 'Fetch Live Services': [{ json: { items: [
  { id: 9999, invoiceDescription: 'someone else' },
] } }] });
assert.strictEqual(portalLines(unmatched)[0].contract_invoice_description, 'Thing - sub SUB-A',
  'another contract service must not bleed into this line');

// A description edited in Autotask beats a stale portal override. The
// override the portal last pushed is recorded in contract_invoice_description,
// so a live value that differs from it means someone edited Autotask.
const staleOverride = Object.assign({}, portalNodes, {
  'Fetch Lines': [{ json: Object.assign({}, storedLine, {
    invoice_description: 'Test - Thing - sub SUB-A',
    contract_invoice_description: 'Test - Thing - sub SUB-A',
  }) }],
});
const cleared = portalLines(staleOverride)[0];
assert.strictEqual(cleared.invoice_description, '',
  'a stale override must be dropped once Autotask holds something else');
assert.strictEqual(cleared.contract_invoice_description, 'Edited by hand in Autotask');

// An override typed in the portal but not yet synced must survive a refresh:
// Autotask still holds exactly what the last sync pushed.
const pendingEdit = Object.assign({}, portalNodes, {
  'Fetch Lines': [{ json: Object.assign({}, storedLine, {
    invoice_description: 'Typed but not synced',
    contract_invoice_description: 'Edited by hand in Autotask',
  }) }],
});
assert.strictEqual(portalLines(pendingEdit)[0].invoice_description, 'Typed but not synced',
  'an unsynced portal edit must survive a refresh');

// The sync side of the same rule: never push an override over a description
// that has been edited in Autotask since we last wrote it.
function descDecision(extra, liveDesc) {
  const n = { 'Current Line': [{ json: Object.assign({}, line, extra) }] };
  n['Record Service'] = [{ json: { sku: line.service_key, autotask_service_id: 9001 } }];
  n['Contract Decision'] = [{ json: { line_key: line.line_key, contract_id: 7001 } }];
  const row = { id: 8001, serviceID: 9001, adjustedPrice: 34.55, invoiceDescription: liveDesc };
  return runNode('cs-decision.js', [{ json: { items: [row] } }], n)[0].json;
}

const externalDecision = descDecision({
  service_invoice_description: 'Test - Thing - sub SUB-A',
  invoice_description_custom: true,
  contract_invoice_description: 'Test - Thing - sub SUB-A',
}, 'Edited by hand in Autotask');
assert.strictEqual(externalDecision.desc_change, false,
  'a hand-edited Autotask description must not be overwritten by a stale override');

const pendingDecision = descDecision({
  service_invoice_description: 'Typed but not synced',
  invoice_description_custom: true,
  contract_invoice_description: 'Edited by hand in Autotask',
}, 'Edited by hand in Autotask');
assert.strictEqual(pendingDecision.desc_change, true,
  'an unsynced portal edit must still be pushed');

// No recorded marker (a line synced before the marker existed): fall back to
// the old behaviour rather than refusing to push forever.
const noMarker = descDecision({
  service_invoice_description: 'New text',
  invoice_description_custom: true,
}, 'Thing - sub SUB-A');
assert.strictEqual(noMarker.desc_change, true);


// -- Last approved & posted ------------------------------------------------
// The newest itemDate for a contract service is its last posting; the rows
// sharing that date (a cycle charge plus its pro-rata adjustments) are summed,
// and the invoice number is resolved from the posting's invoiceID.
function withBilling(items, invs) {
  return Object.assign({}, portalNodes, {
    'Fetch Billing Items': [{ json: { items: items } }],
    'Fetch Invoices': [{ json: { items: invs || [] } }],
  });
}
const posted = portalLines(withBilling([
  { contractServiceID: 8001, itemDate: '2026-06-30T00:00:00.000Z', totalAmount: 1000,
    quantity: 29, postedOnTime: '2026-07-02T04:11:00.000Z', invoiceID: 77 },
  { contractServiceID: 8001, itemDate: '2026-06-30T00:00:00.000Z', totalAmount: 71.05,
    quantity: 2, postedOnTime: '2026-07-02T04:11:00.000Z', invoiceID: 77 },
  { contractServiceID: 8001, itemDate: '2026-05-31T00:00:00.000Z', totalAmount: 900,
    quantity: 29, postedOnTime: '2026-06-02T04:00:00.000Z', invoiceID: 70 },
  { contractServiceID: 9999, itemDate: '2026-07-31T00:00:00.000Z', totalAmount: 5,
    quantity: 1, invoiceID: 0 },
], [{ id: 77, invoiceNumber: 'INV-10023', invoiceDateTime: '2026-07-02T00:00:00.000Z' }]))[0];

assert.strictEqual(posted.billing_last_date, '2026-06-30', 'the newest item date is the last posting');
assert.ok(Math.abs(posted.billing_last_amount - 1071.05) < 0.005,
  'rows sharing the posting date are summed: ' + posted.billing_last_amount);
assert.strictEqual(posted.billing_last_qty, 31);
assert.strictEqual(posted.billing_last_rows, 2);
assert.strictEqual(posted.billing_last_posted_on, '2026-07-02');
assert.strictEqual(posted.billing_last_invoice_number, 'INV-10023');
assert.strictEqual(posted.billing_last_invoice_date, '2026-07-02');
assert.strictEqual(posted.billing_last, '2026-06-30 · $1071.05 · invoiced');

// Posted but not yet invoiced: invoiceID 0 must not read as an invoice.
const notInvoiced = portalLines(withBilling([
  { contractServiceID: 8001, itemDate: '2026-06-30T00:00:00.000Z', extendedPrice: 315,
    quantity: 20, postedOnTime: '2026-07-02T04:11:00.000Z', invoiceID: 0 },
]))[0];
assert.strictEqual(notInvoiced.billing_last_invoice_id, '');
assert.strictEqual(notInvoiced.billing_last_invoice_number, '');
assert.strictEqual(notInvoiced.billing_last, '2026-06-30 · $315.00 · posted');

// A $0 posting is still a posting, not an absence.
const zeroPost = portalLines(withBilling([
  { contractServiceID: 8001, itemDate: '2026-06-30T00:00:00.000Z', totalAmount: 0,
    quantity: 4, postedOnTime: '2026-07-02T04:11:00.000Z', invoiceID: 0 },
]))[0];
assert.strictEqual(zeroPost.billing_last_date, '2026-06-30');
assert.strictEqual(zeroPost.billing_last_amount, 0);

// Nothing posted for this service: the stored value is left alone rather
// than being overwritten with a blank.
const otherOnly = portalLines(withBilling([
  { contractServiceID: 9999, itemDate: '2026-07-31T00:00:00.000Z', totalAmount: 5, quantity: 1 },
]))[0];
assert.strictEqual(otherOnly.billing_last_date, undefined,
  'another service\'s postings must not attach to this line');

console.log('\nALL SYNC TESTS PASSED');
