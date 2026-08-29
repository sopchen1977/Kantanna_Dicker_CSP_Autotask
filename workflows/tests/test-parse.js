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
function runNode(file, inputItems, nodes, patch) {
  let code = fs.readFileSync(path.join(RUNTIME, file), 'utf8');
  if (patch) code = patch(code);
  const fn = new Function('$input', '$', code);
  return fn({ all: () => inputItems, first: () => inputItems[0], item: inputItems[0] }, makeDollar(nodes));
}

// PILOT_CUSTOMERS is deployment config that changes as customers are switched
// on, so the tests pin their own list rather than tracking it.
const pilot = (list) => (code) => code.replace(/const PILOT_CUSTOMERS = .*;/,
  'const PILOT_CUSTOMERS = ' + JSON.stringify(list) + ';');
const withPilot = pilot(['ATLAS OUTSOURCING PTY LTD', 'Galilee Solicitors']);

const annuity = [
  { 'TENANT ID': 'T1', 'TENANT NAME': 'ATLAS OUTSOURCING PTY LTD', 'SUBSCRIPTION ID': 'SUB-1',
    'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:0002:1:', 'STOCK DESCRIPTION': 'MS NCE M365 BP 1YR', 'REFERENCE': 'Microsoft 365 Business Premium',
    'QTY': '275.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '30-AUG-2025', 'END USAGE': '30-AUG-2025',
    'REVALUATION PERIOD': '30-AUG-2026', 'UNIT PRICE': '$338.31', 'UNIT RRP': '$414.60' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-2',
    'STOCK CODE': 'P1M:CFQ7TTC0LCHC:0002:1:', 'STOCK DESCRIPTION': 'MS NCE M365 BP 1MTH', 'REFERENCE': 'Microsoft 365 Business Premium',
    'QTY': '27.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '18-DEC-2025', 'END USAGE': '18-DEC-2025',
    'REVALUATION PERIOD': '31-AUG-2026', 'UNIT PRICE': '$33.56', 'UNIT RRP': '$39.48' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-3',
    'STOCK CODE': 'DZH318Z0BPS6:0001', 'STOCK DESCRIPTION': 'Microsoft Azure Plan', 'REFERENCE': 'Azure plan',
    'QTY': '1.00', 'CHARGE TYPE': 'MODN', 'STATUS': 'Active', 'START USAGE': '', 'END USAGE': '',
    'REVALUATION PERIOD': '', 'UNIT PRICE': '$0.00', 'UNIT RRP': '$0.00' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-4',
    'STOCK CODE': 'P1Y:CFQ7TTC0LFLZ:0002:Y:', 'STOCK DESCRIPTION': 'MS NCE M365 E5 1YR ANNUAL BILL', 'REFERENCE': 'Microsoft 365 E5',
    'QTY': '10.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '17-AUG-2023', 'END USAGE': '17-AUG-2023',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$835.26', 'UNIT RRP': '$1,000.00' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-5',
    'STOCK CODE': 'P1Y:CFQ7TTC0LH0R:0001:1:', 'STOCK DESCRIPTION': 'MS NCE TEAMS PHONE RESOURCE', 'REFERENCE': 'Microsoft Teams Phone Resource',
    'QTY': '4.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '20-MAY-2026', 'END USAGE': '20-MAY-2026',
    'REVALUATION PERIOD': '30-SEP-2026', 'UNIT PRICE': '$0.00', 'UNIT RRP': '$0.00' },
  // Month-to-month that has auto-renewed since the invoice was raised:
  // REVALUATION PERIOD is a cycle past the invoiced TERM END.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-6',
    'STOCK CODE': 'P1M:CFQ7TTC0LH0L:0001:1:', 'STOCK DESCRIPTION': 'MS NCE EXCHANGE ONLINE KIOSK', 'REFERENCE': 'Exchange Online Kiosk',
    'QTY': '1.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '11-NOV-2025', 'END USAGE': '11-NOV-2025',
    'REVALUATION PERIOD': '31-AUG-2026', 'UNIT PRICE': '$3.00', 'UNIT RRP': '$4.00' },
  // Three-year-old annual subscription: START USAGE is 2023, but the
  // current term is the one the invoice reports.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-7',
    'STOCK CODE': 'P1Y:CFQ7TTC0HD32:0002:1:', 'STOCK DESCRIPTION': 'MS NCE VISIO PLAN 2 1YR', 'REFERENCE': 'Visio Plan 2',
    'QTY': '3.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '29-JUL-2023', 'END USAGE': '28-AUG-2023',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$100.00', 'UNIT RRP': '$120.00' },
  // Month-to-month expiring on a month end: the derived cycle start must
  // not overflow into the following month.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-8',
    'STOCK CODE': 'P1M:CFQ7TTC0LH16:0001:1:', 'STOCK DESCRIPTION': 'MS NCE M365 BUSINESS STD 1MTH', 'REFERENCE': 'Microsoft 365 Business Standard',
    'QTY': '5.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '31-MAY-2025', 'END USAGE': '31-MAY-2025',
    'REVALUATION PERIOD': '31-MAR-2027', 'UNIT PRICE': '$20.00', 'UNIT RRP': '$25.00' },
  // Co-termed annual BILLED ANNUALLY: bought mid-year and aligned to the
  // customer's 28-DEC anniversary, so the current term is a 229-day stub.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-10',
    'STOCK CODE': 'P1Y:CFQ7TTC0LH16:0001:Y:', 'STOCK DESCRIPTION': 'MS NCE M365 BUSINESS STD 1YR ANNUAL BILL', 'REFERENCE': 'Microsoft 365 Business Standard',
    'QTY': '2.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '13-MAY-2026', 'END USAGE': '13-MAY-2026',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$1,000.00', 'UNIT RRP': '$1,200.00' },
  // Co-termed annual BILLED MONTHLY, same 229-day stub: the monthly rate
  // must NOT be pro-rated.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-11',
    'STOCK CODE': 'P1Y:CFQ7TTC0LSGZ:0001:1:', 'STOCK DESCRIPTION': 'MS NCE POWER AUTOMATE PREMIUM 1YR COMMIT', 'REFERENCE': 'Power Automate Premium',
    'QTY': '1.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '13-MAY-2026', 'END USAGE': '13-MAY-2026',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$239.90', 'UNIT RRP': '$282.24' },
  // Bought the same day as SUB-6 and on the same cycle, so it shares that
  // subscription's contract.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-12',
    'STOCK CODE': 'P1M:CFQ7TTC0LH1P:0001:1:', 'STOCK DESCRIPTION': 'MS NCE EXCHANGE ONLINE PLAN 2', 'REFERENCE': 'Exchange Online (Plan 2)',
    'QTY': '4.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '11-NOV-2025', 'END USAGE': '11-NOV-2025',
    'REVALUATION PERIOD': '31-AUG-2026', 'UNIT PRICE': '$11.32', 'UNIT RRP': '$13.32' },
  // Two SEPARATE subscriptions of the same product on the same annual term.
  // Both resolve to one Autotask service, so they must bill as one line of
  // 3 + 5 = 8 rather than the second overwriting the first.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-13',
    'STOCK CODE': 'P1Y:CFQ7TTC0LH04:0001:1:', 'STOCK DESCRIPTION': 'MS NCE EXCHANGE ONLINE PLAN 1', 'REFERENCE': 'Exchange Online (Plan 1)',
    'QTY': '3.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '29-JUL-2023', 'END USAGE': '28-AUG-2023',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$100.00', 'UNIT RRP': '$120.00' },
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-14',
    'STOCK CODE': 'P1Y:CFQ7TTC0LH04:0001:1:', 'STOCK DESCRIPTION': 'MS NCE EXCHANGE ONLINE PLAN 1', 'REFERENCE': 'Exchange Online (Plan 1)',
    'QTY': '5.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '29-JUL-2023', 'END USAGE': '28-AUG-2023',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$100.00', 'UNIT RRP': '$120.00' },
  // Dicker has retired this product and relabelled it in their catalogue, so
  // REFERENCE - a 30-character field - arrives as "DO NOT USE - Microsoft
  // Defende". The STOCK DESCRIPTION is still the product. Same SKU root as
  // SUB-1, different variant: a different product sharing a stock code.
  { 'TENANT ID': 'T2', 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-15',
    'STOCK CODE': 'P1Y:CFQ7TTC0LCHC:001J:1:',
    'STOCK DESCRIPTION': 'MS NCE MICROSOFT DEFENDER SUITE FOR M365 BUSINESS PREMIUM 1YR COMMIT',
    'REFERENCE': 'DO NOT USE - Microsoft Defende',
    'QTY': '12.00', 'CHARGE TYPE': 'NCE', 'STATUS': 'Active', 'START USAGE': '29-JUL-2023', 'END USAGE': '28-AUG-2023',
    'REVALUATION PERIOD': '28-DEC-2026', 'UNIT PRICE': '$60.00', 'UNIT RRP': '$72.00' },
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
  { 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-6', 'STOCK CODE': 'P1M:CFQ7TTC0LH0L:0001:1:',
    'USAGE START': '01-JUL-2026', 'USAGE END': '31-JUL-2026', 'QTY': '1', 'UNIT PRICE': '3.00',
    'TERM START': '01-JUL-2026', 'TERM END': '31-JUL-2026' },
  { 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-7', 'STOCK CODE': 'P1Y:CFQ7TTC0HD32:0002:1:',
    'USAGE START': '29-JUL-2026', 'USAGE END': '28-AUG-2026', 'QTY': '3', 'UNIT PRICE': '8.33',
    'TERM START': '29-DEC-2025', 'TERM END': '28-DEC-2026' },
  { 'TENANT NAME': 'Galilee Solicitors', 'SUBSCRIPTION ID': 'SUB-11', 'STOCK CODE': 'P1Y:CFQ7TTC0LSGZ:0001:1:',
    'USAGE START': '29-JUL-2026', 'USAGE END': '28-AUG-2026', 'QTY': '1', 'UNIT PRICE': '19.99',
    'TERM START': '14-MAY-2026', 'TERM END': '28-DEC-2026' },
];

const nodes = {
  'Extract Annuity Details': annuity.map((j) => ({ json: j })),
  'Extract Invoice Details': invoice.map((j) => ({ json: j })),
  'Normalize Uploads': [{ json: { annuity_name: 'Annuity_Information_test.xlsx' } }],
};
const parsed = runNode('parse-lines.js', [{ json: {} }], nodes, withPilot);

// Pilot filter keeps only pilot customers
assert.strictEqual(parsed.length, 14, 'pilot filter should keep 14 lines');
assert.ok(!parsed.some((i) => i.json.tenant_name === 'Some Other Customer'));

// The filter matches on substring, so a customer can be named by a short
// distinctive word and still pick up the full name Dicker writes.
const short = runNode('parse-lines.js', [{ json: {} }], nodes, pilot(['Galilee']));
assert.ok(short.length > 0 && short.every((i) => /Galilee/i.test(i.json.tenant_name)),
  "'Galilee' must match 'Galilee Solicitors' and nothing else");
// An empty list means every customer, which is how a full import is run.
const everyone = runNode('parse-lines.js', [{ json: {} }], nodes, pilot([]));
assert.ok(everyone.length > parsed.length, 'an empty filter imports every customer');
assert.ok(everyone.some((i) => i.json.tenant_name === 'Some Other Customer'));

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
// SUB-7 and SUB-13 are the same product on the same contract, so they come
// out as ONE line carrying the combined quantity.
assert.strictEqual(prepared.length, 12, 'Azure/MODN excluded; $0 NCE kept; duplicate product merged');
// $0 NCE line (Teams Phone Resource) is included and sells at $0
const pZero = prepared.find((i) => i.json.subscription_id === 'SUB-5').json;
assert.strictEqual(pZero.effective_sell, 0);
assert.strictEqual(pZero.period_rrp, 0);
for (const i of prepared) {
  // The contract now belongs to the co-term GROUP, so the Subscription ID
  // rides on the service line instead of the contract name.
  assert.ok(i.json.service_invoice_description.includes(i.json.subscription_id),
    'Subscription ID must reach the invoice line');
  assert.ok(i.json.contract_name.startsWith('CSP Microsoft '), 'every contract name starts with CSP Microsoft');
  assert.ok(i.json.contract_name.length <= 100);
  if (i.json.term_months === 12) {
    // Annual contracts carry their term, so each renewal is a new contract.
    assert.ok(/ \d{1,2} \w{3} \d{4} to \d{1,2} \w{3} \d{4}$/.test(i.json.contract_name),
      'annual contract names carry start and end dates: ' + i.json.contract_name);
  } else {
    // Month to month rolls forever, so it carries no TERM - it is named for
    // when the subscriptions on that cycle first started.
    assert.ok(/ Started \d{1,2} \w{3} \d{4}$/.test(i.json.contract_name),
      i.json.contract_name);
  }
  assert.strictEqual(i.json.effective_sell, i.json.period_rrp, 'default sell price is the per-period RRP');
}
// Each billing type creates a distinct service with the right period type
const pAnnMo = prepared.find((i) => i.json.subscription_id === 'SUB-1').json;
assert.strictEqual(pAnnMo.service_period_type, 2);
assert.ok(pAnnMo.service_name.includes('Annual Commit (Billed Monthly)'));
const pMtm = prepared.find((i) => i.json.subscription_id === 'SUB-2').json;
assert.strictEqual(pMtm.service_period_type, 2);
assert.ok(pMtm.service_name.includes('Month to Month'));
// ---- The product name Autotask sees -----------------------------------
// It is the annuity report's STOCK DESCRIPTION, not its REFERENCE. REFERENCE
// is 30 characters of whatever Dicker's catalogue currently says, which for a
// retired product is "DO NOT USE - Microsoft Defende".
const pDefender = prepared.find((i) => i.json.subscription_id === 'SUB-15').json;
assert.strictEqual(pDefender.product_name,
  'MS NCE MICROSOFT DEFENDER SUITE FOR M365 BUSINESS PREMIUM 1YR COMMIT');
assert.ok(!/DO NOT USE/.test(pDefender.service_name),
  'the catalogue label must never reach an Autotask service name: ' + pDefender.service_name);
assert.ok(!/DO NOT USE/.test(pDefender.service_invoice_description),
  'nor an invoice line the customer reads: ' + pDefender.service_invoice_description);
assert.ok(pDefender.service_name.startsWith('MS NCE MICROSOFT DEFENDER SUITE'));
assert.ok(pDefender.service_invoice_description.startsWith('MS NCE MICROSOFT DEFENDER SUITE'));
// This one is long enough that the name has to be trimmed - and what gets
// trimmed is the product, never the billing type that makes two services of
// one product distinguishable.
assert.ok(pDefender.product_name.length + pDefender.service_name_suffix.length > 100,
  'this fixture exists to exercise the 100-character trim');
// The SKU is not in the name: Autotask holds the service key in its own `sku`
// field, which is what the sync matches on. The legacy suffix is kept only so
// names written before it was dropped are still recognised as ours to correct.
assert.strictEqual(pDefender.service_name_suffix, ' - Annual Commit (Billed Monthly)');
assert.strictEqual(pDefender.service_name_suffix_legacy,
  ' - Annual Commit (Billed Monthly) [CFQ7TTC0LCHC]');
for (const i of prepared) {
  assert.ok(!/\[[A-Z0-9]{6,}\]/.test(i.json.service_name),
    'no service name may carry a SKU: ' + i.json.service_name);
}
assert.ok(pDefender.service_invoice_description.endsWith(' - sub SUB-15'),
  'the Subscription ID survives the trim: ' + pDefender.service_invoice_description);
// Same SKU, different variant: two products that must not collapse into one
// service just because their stock code root matches.
assert.strictEqual(pDefender.service_key, 'ANN-MO:CFQ7TTC0LCHC:001J');
assert.strictEqual(pAnnMo.service_key, 'ANN-MO:CFQ7TTC0LCHC:0002');
assert.notStrictEqual(pDefender.service_name, pAnnMo.service_name);
for (const i of prepared) {
  const j = i.json;
  assert.ok(j.service_name.length <= 100,
    'Autotask service names are 100 characters: ' + j.service_name);
  assert.ok(j.service_name.endsWith(j.service_name_suffix),
    'every generated name ends in the billing type: ' + j.service_name);
  assert.ok(j.service_invoice_description.length <= 100,
    'Autotask invoice descriptions are 100 characters: ' + j.service_invoice_description);
  assert.strictEqual(j.product_name, j.stock_description,
    'the stock description is the product name: ' + j.subscription_id);
}
// A row with no stock description at all still gets a name, from REFERENCE.
const noDesc = runNode('prepare-lines.js', [{ json: Object.assign({}, pAnnMo, {
  stock_description: '', offer_name: 'Microsoft 365 Business Premium', include: true,
}) }], {})[0].json;
assert.ok(noDesc.service_name.startsWith('Microsoft 365 Business Premium - Annual Commit'));

// ---- Co-term group contracts ------------------------------------------
// Autotask steps its billing periods from the CONTRACT START DATE, while
// Dicker bills a co-termed subscription on its GROUP's anchor day. So the
// contract is the group: one per customer + billing type + anniversary,
// named from the anchor's month/day (never the year, or a renewal would
// fork a new contract).
assert.strictEqual(pAnnMo.contract_name, 'CSP Microsoft Annual Commit Monthly 31 Aug 2025 to 30 Aug 2026');
assert.strictEqual(pAnnMo.contract_start, '2025-08-31', 'grid anchored on the 31st, as Dicker invoices');
assert.strictEqual(pAnnMo.contract_end, '2026-08-30');
// Month-to-month splits by the date the subscription first started, so
// SUB-2, SUB-6 and SUB-8 each get their own contract even though all three
// are Galilee on the same 1st-to-month-end cycle.
assert.strictEqual(pMtm.contract_name, 'CSP Microsoft Month to Month Started 18 Dec 2025');
// Both contract kinds write their dates the same human way - no raw ISO in a
// contract name. The month-to-month GROUP KEY still carries the ISO date,
// because it is an identity and must not move when a label is reformatted.
assert.ok(/ Started \d{1,2} \w{3} \d{4}$/.test(pMtm.contract_name));
assert.ok(/ \d{1,2} \w{3} \d{4} to \d{1,2} \w{3} \d{4}$/.test(pAnnMo.contract_name),
  'annual names keep their existing "1 Oct 2025 to 30 Sep 2026" shape');
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(pMtm.contract_name + pAnnMo.contract_name),
  'no contract name may contain a raw ISO date');
assert.ok(/started-\d{4}-\d{2}-\d{2}/.test(pMtm.contract_group_key),
  'the grouping key keeps the ISO date it has always used');

// ---- The contract's identity ------------------------------------------
// Names are labels and get reworded. What says "the same contract" is the
// reference written to Autotask's External Contract Number, which encodes
// exactly what the group key encodes and never moves when a name changes.
assert.strictEqual(pAnnMo.contract_number, 'CSP-ANN-MO-20250831-20260830');
assert.strictEqual(pMtm.contract_number, 'CSP-MTM-D1-20251218');
assert.strictEqual(prepared.find((i) => i.json.subscription_id === 'SUB-4').json.contract_number,
  'CSP-ANN-YR-20251229-20261228');
for (const i of prepared) {
  assert.ok(i.json.contract_number.length <= 50,
    'Autotask contractNumber is 50 characters: ' + i.json.contract_number);
}
// One reference per contract, and one contract per reference.
const refByName = {};
for (const i of prepared) {
  const j = i.json;
  if (refByName[j.contract_name] === undefined) refByName[j.contract_name] = j.contract_number;
  assert.strictEqual(refByName[j.contract_name], j.contract_number,
    'two contracts cannot share a name but differ by reference: ' + j.contract_name);
}
assert.strictEqual(new Set(prepared.map((i) => i.json.contract_number)).size,
  new Set(prepared.map((i) => i.json.contract_name)).size,
  'references and names must partition the lines identically');
// Month-to-month contracts made before the reference existed were named with
// a raw ISO date; the legacy name is what lets the sync adopt one of those
// exactly once. Annual names never changed, so they carry no legacy name.
assert.strictEqual(pMtm.contract_name_legacy, 'CSP Microsoft Month to Month Started 2025-12-18');
assert.strictEqual(pAnnMo.contract_name_legacy, '');
const pAnnYr = prepared.find((i) => i.json.subscription_id === 'SUB-4').json;
assert.strictEqual(pAnnYr.service_key, 'ANN-YR:CFQ7TTC0LFLZ:0002');
assert.strictEqual(pAnnYr.service_period_type, 5, 'upfront billing -> yearly service period (Autotask picklist 5)');
assert.strictEqual(pAnnYr.effective_sell, 1000);
assert.ok(pAnnYr.service_name.includes('Annual Commit (Billed Annually)'));
// ---- Contract window --------------------------------------------------
// The annuity report's START USAGE is when the subscription FIRST started,
// never the current term. REVALUATION PERIOD is the current expiry, and the
// term runs back from it by the subscription type (P1Y = 12, P1M = 1).

// Annual-upfront line: billed once a year, so no invoice rows this month.
// The window comes from REVALUATION PERIOD, NOT from the 2023 START USAGE.
assert.strictEqual(pAnnYr.contract_window_source, 'revaluation');
assert.strictEqual(pAnnYr.member_end, '2026-12-28');
assert.strictEqual(pAnnYr.member_start, '2025-12-29');
assert.strictEqual(pAnnYr.first_started, '2023-08-17');
assert.ok(pAnnYr.price_effective_date >= pAnnYr.contract_start
  && pAnnYr.price_effective_date <= pAnnYr.contract_end,
  'effective date must be clamped into the contract window');

// Three-year-old annual subscription with an invoiced current term: the
// invoice TERM START wins (it survives co-terming), 2023 is ignored.
const pOld = prepared.find((i) => i.json.subscription_id === 'SUB-7').json;
assert.strictEqual(pOld.contract_window_source, 'invoice');
assert.strictEqual(pOld.member_start, '2025-12-29');
assert.strictEqual(pOld.member_end, '2026-12-28');
assert.strictEqual(pOld.first_started, '2023-07-29');

// Month-to-month that auto-renewed since the invoice: REVALUATION PERIOD is
// a cycle past the invoiced TERM END, so the contract runs to the new
// expiry. The start still reaches back over the invoice line being replayed.
const pRenewed = prepared.find((i) => i.json.subscription_id === 'SUB-6').json;
assert.strictEqual(pRenewed.contract_window_source, 'renewed');
assert.strictEqual(pRenewed.member_start, '2026-08-01');
assert.strictEqual(pRenewed.contract_end, '2026-08-31', 'renewal extends to the revaluation period');
assert.strictEqual(pRenewed.contract_start, '2026-07-01', 'window reaches the invoice line it replays');
assert.strictEqual(pRenewed.contract_name, 'CSP Microsoft Month to Month Started 11 Nov 2025');

// Month-end arithmetic must clamp, not overflow: 31-MAR minus one month is
// 28-FEB, so the cycle starts 01-MAR (not 04-MAR).
const pMonthEnd = prepared.find((i) => i.json.subscription_id === 'SUB-8').json;
assert.strictEqual(pMonthEnd.contract_start, '2027-03-01');
assert.strictEqual(pMonthEnd.contract_end, '2027-03-31');
// A month-end monthly cycle always anchors on day 1, in every month length -
// otherwise February would fork the group onto a "day 29" contract.
assert.strictEqual(pMonthEnd.contract_name, 'CSP Microsoft Month to Month Started 31 May 2025');
assert.notStrictEqual(pMtm.contract_group_key, pMonthEnd.contract_group_key,
  'different start dates -> different contracts');
// The cycle day stays in the KEY even though only the date is in the name:
// one customer can run several month-to-month cycles and they must never
// merge onto one contract, whatever their start dates.
assert.ok(pMtm.contract_group_key.indexOf('cycle-day-1|started-2025-12-18') !== -1,
  pMtm.contract_group_key);
// Subscriptions bought together on the same day, on the same cycle, DO
// share one contract - the split is by start date, not by subscription.
const pSameDay = prepared.find((i) => i.json.subscription_id === 'SUB-12').json;
assert.strictEqual(pSameDay.contract_name, pRenewed.contract_name);
assert.strictEqual(pSameDay.contract_group_key, pRenewed.contract_group_key);
// Distinct start dates on the same cycle stay on distinct contracts.
const mtmNames = new Set(prepared.filter((i) => i.json.term_months !== 12)
  .map((i) => i.json.contract_name));
assert.strictEqual(mtmNames.size, 3, [...mtmNames].join(' | '));


// A co-termed subscription with no invoice row: the inferred 12-month term
// would start before the subscription existed, so START USAGE raises it.
const pCoterm = prepared.find((i) => i.json.subscription_id === 'SUB-5').json;
assert.strictEqual(pCoterm.contract_window_source, 'revaluation');
assert.strictEqual(pCoterm.member_start, '2026-05-21', 'START USAGE + 1 beats revaluation - 12 months');
assert.strictEqual(pCoterm.member_end, '2026-09-30');

// START USAGE is never allowed to drag a contract back before its term.
for (const i of prepared) {
  const j = i.json;
  if (j.first_started && j.member_start && j.contract_window_source === 'revaluation') {
    assert.ok(j.member_start > j.first_started,
      'inferred window must start after the subscription first started');
  }
}

// ---- Co-terming -------------------------------------------------------
// A term that is not a full 12 months means Microsoft aligned this
// subscription to the customer's existing anniversary. Dicker still lists
// the full 12-month unit price on the line either way.

// Billed ANNUALLY UPFRONT: the single charge is pro-rated on days, exactly
// as Dicker invoices it (verified live: a 272/365-day window bills x0.7452).
const pCotermYr = prepared.find((i) => i.json.subscription_id === 'SUB-10').json;
assert.strictEqual(pCotermYr.billing_type, 'annual_upfront');
assert.strictEqual(pCotermYr.member_start, '2026-05-14');
assert.strictEqual(pCotermYr.member_end, '2026-12-28');
assert.strictEqual(pCotermYr.contract_name, 'CSP Microsoft Annual Commit Yearly 29 Dec 2025 to 28 Dec 2026');
assert.strictEqual(pCotermYr.term_days, 229);
assert.strictEqual(pCotermYr.term_factor, 0.6274);
assert.strictEqual(pCotermYr.is_coterm, true);
assert.strictEqual(pCotermYr.full_period_rrp, 1200);
assert.strictEqual(pCotermYr.period_rrp, 752.88, 'upfront charge pro-rated to the stub term');
assert.strictEqual(pCotermYr.period_cost, 627.4);
assert.strictEqual(pCotermYr.effective_sell, 752.88);

// Billed MONTHLY on the same stub: the monthly rate is unchanged, there are
// simply fewer charges before it renews for a full year.
const pCotermMo = prepared.find((i) => i.json.subscription_id === 'SUB-11').json;
assert.strictEqual(pCotermMo.billing_type, 'annual_monthly');
assert.strictEqual(pCotermMo.term_days, 229);
assert.strictEqual(pCotermMo.is_coterm, true);
assert.ok(Math.abs(pCotermMo.period_rrp - 23.52) < 0.005, 'monthly rate must NOT be pro-rated');
assert.strictEqual(pCotermMo.period_rrp, pCotermMo.full_period_rrp);
assert.strictEqual(pCotermMo.effective_sell, pCotermMo.period_rrp);

// A full-length term is never flagged, and its prices are untouched.
assert.strictEqual(pOld.is_coterm, false);
assert.strictEqual(pOld.term_days, 365);
assert.strictEqual(pOld.period_rrp, pOld.full_period_rrp);
assert.strictEqual(pAnnYr.is_coterm, false, 'revaluation-derived annual term is a full 365 days');
assert.strictEqual(pAnnYr.period_rrp, 1000);
// Month-to-month never co-terms.
assert.strictEqual(pRenewed.is_coterm, false);

// Every member of a group derives an identical contract window, so whichever
// line reaches Autotask first creates it and the rest find it.
const galilee = prepared.filter((i) => i.json.tenant_name === 'Galilee Solicitors').map((i) => i.json);
const annMoGroup = galilee.filter((j) => j.contract_name === 'CSP Microsoft Annual Commit Monthly 29 Dec 2025 to 28 Dec 2026');
assert.ok(annMoGroup.length >= 2, 'Galilee annual-monthly lines share one contract');
for (const j of annMoGroup) {
  assert.strictEqual(j.contract_start, '2025-12-29');
  assert.strictEqual(j.contract_end, '2026-12-28');
  assert.strictEqual(j.contract_group_key, annMoGroup[0].contract_group_key);
}
// Billing types never share a contract - Autotask period types differ.
const annYrGroup = galilee.filter((j) => j.billing_type === 'annual_upfront');
assert.strictEqual(annYrGroup[0].contract_name, 'CSP Microsoft Annual Commit Yearly 29 Dec 2025 to 28 Dec 2026');
assert.notStrictEqual(annYrGroup[0].contract_name, annMoGroup[0].contract_name);

// A co-termed member's units start at ITS OWN term start, mid-cycle inside
// the shared contract, which is where Autotask pro-rates the opening period.
assert.strictEqual(pCotermMo.service_effective_date, '2026-05-14');
assert.strictEqual(pCotermMo.contract_start, '2025-12-29');
assert.ok(pCotermMo.service_effective_date > pCotermMo.contract_start);
// A full-term member starts with the contract.
assert.strictEqual(pOld.service_effective_date, pOld.contract_start);

// Products sharing a SKU root must stay distinct services inside one shared
// contract: CFQ7TTC0LCHC:0002 is Business Premium, :001J is Defender Suite.
assert.strictEqual(pAnnMo.service_key, 'ANN-MO:CFQ7TTC0LCHC:0002');
assert.strictEqual(pMtm.service_key, 'MTM:CFQ7TTC0LCHC:0002');
assert.strictEqual(pSameDay.service_key, 'MTM:CFQ7TTC0LH1P:0001');
assert.notStrictEqual(pSameDay.service_key, pRenewed.service_key,
  'two subscriptions sharing a contract still need distinct services');

// ---- Two subscriptions of the same product on one contract -------------
const pDup = prepared.filter((i) => i.json.service_key === 'ANN-MO:CFQ7TTC0LH04:0001').map((i) => i.json);
assert.strictEqual(pDup.length, 1, 'one contract service, not two');
assert.strictEqual(pDup[0].qty, 8, 'quantities combine: 3 + 5');
assert.ok(pDup[0].service_invoice_description.indexOf('SUB-13') !== -1
  && pDup[0].service_invoice_description.indexOf('SUB-14') !== -1,
  pDup[0].service_invoice_description);
assert.ok(/combined 2 subscriptions/.test(pDup[0].merged_note), pDup[0].merged_note);
// Both rows still get their own status written back.
assert.deepStrictEqual(pDup[0].merged_keys.map((k) => k.subscription_id).sort(),
  ['SUB-13', 'SUB-14']);
// Their invoice lines are replayed together, in date order.
const dupInv = JSON.parse(pDup[0].invoice_lines);
for (let n = 1; n < dupInv.length; n++) {
  assert.ok(dupInv[n - 1].s <= dupInv[n].s, 'replayed invoice lines stay in date order');
}
// A line with no duplicate still carries exactly its own key.
assert.deepStrictEqual(pAnnMo.merged_keys, [{ subscription_id: 'SUB-1', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:' }]);
assert.strictEqual(pAnnMo.merged_note, undefined);

// custom price override wins
tableRows[0].json.use_custom_price = true;
tableRows[0].json.sell_price = 99.5;
const prepared2 = runNode('prepare-lines.js', tableRows, {});
assert.strictEqual(prepared2.find((i) => i.json.subscription_id === 'SUB-1').json.effective_sell, 99.5);

// -- Invoice description overrides -----------------------------------------
// The generated description is the default; whatever is typed in the portal
// replaces it and is flagged so the sync knows to push it.
const invBase = prepared.find((i) => i.json.subscription_id === 'SUB-1').json;
assert.strictEqual(invBase.service_invoice_description, invBase.service_invoice_description_default);
assert.strictEqual(invBase.invoice_description_custom, false);
assert.ok(invBase.service_invoice_description.includes('SUB-1'),
  'the default description still carries the Subscription ID to the invoice line');

const withDesc = (pick) => parsed.map((i) => ({ json: Object.assign({}, i.json, {
  include: null, use_custom_price: null, sell_price: null, invoice_description: pick(i.json),
}) }));

const invCustom = runNode('prepare-lines.js',
  withDesc((j) => (j.subscription_id === 'SUB-1' ? '  M365 seats - August  ' : '')), {})
  .find((i) => i.json.subscription_id === 'SUB-1').json;
assert.strictEqual(invCustom.service_invoice_description, 'M365 seats - August',
  'a typed description is trimmed and wins over the generated one');
assert.strictEqual(invCustom.invoice_description_custom, true);
assert.ok(invCustom.service_invoice_description_default.includes('SUB-1'),
  'the generated default is still reported alongside');

// Over-long text is cut to the field length rather than rejected by Autotask.
assert.ok(runNode('prepare-lines.js', withDesc(() => 'x'.repeat(180)), {})
  .every((i) => i.json.service_invoice_description.length === 100),
  'descriptions stay within Autotask\'s 100-character field');

// Two subscriptions of one product bill as a single contract service. Its
// generated description names both, but a typed one still wins.
const merged = runNode('prepare-lines.js', withDesc(() => ''), {})
  .find((i) => i.json.merged_note);
assert.ok(merged, 'the duplicate-product fixture still merges');
assert.ok(merged.json.service_invoice_description.indexOf(' - subs ') > 0,
  'a merged service names every subscription by default');

const mergedNamed = runNode('prepare-lines.js',
  withDesc((j) => (j.stock_code === merged.json.stock_code ? 'Copilot seats' : '')), {})
  .find((i) => i.json.merged_note);
assert.strictEqual(mergedNamed.json.service_invoice_description, 'Copilot seats',
  'a typed description survives the same-product merge');
assert.ok(mergedNamed.json.service_invoice_description_default.indexOf(' - subs ') > 0,
  'the merged default is still reported');

// The internal description is the permanent pointer at the subscription, so
// it stays the generated text however the invoice line is renamed.
assert.strictEqual(invBase.service_internal_description, invBase.service_invoice_description_default);
assert.strictEqual(invCustom.service_internal_description, invCustom.service_invoice_description_default,
  'renaming the invoice line must not change the internal description');
assert.ok(invCustom.service_internal_description.includes('SUB-1'));
assert.strictEqual(mergedNamed.json.service_internal_description,
  mergedNamed.json.service_invoice_description_default,
  'the merged service keeps its generated internal description too');

console.log('ALL PARSE TESTS PASSED');
