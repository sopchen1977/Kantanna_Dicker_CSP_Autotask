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
const parsed = runNode('parse-lines.js', [{ json: {} }], nodes);

// Pilot filter keeps only pilot customers
assert.strictEqual(parsed.length, 10, 'pilot filter should keep 10 lines');
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
assert.strictEqual(prepared.length, 9, 'Azure/MODN line must be excluded by default; $0 NCE lines stay in');
// $0 NCE line (Teams Phone Resource) is included and sells at $0
const pZero = prepared.find((i) => i.json.subscription_id === 'SUB-5').json;
assert.strictEqual(pZero.effective_sell, 0);
assert.strictEqual(pZero.period_rrp, 0);
for (const i of prepared) {
  // The contract now belongs to the co-term GROUP, so the Subscription ID
  // rides on the service line instead of the contract name.
  assert.ok(i.json.service_invoice_description.includes(i.json.subscription_id),
    'Subscription ID must reach the invoice line');
  assert.ok(!/\d{4}/.test(i.json.contract_name.replace(/CSP - /, '')),
    'contract name must not carry a year, or renewals would fork a new contract');
  assert.ok(i.json.contract_name.length <= 100);
  assert.strictEqual(i.json.effective_sell, i.json.period_rrp, 'default sell price is the per-period RRP');
}
// Each billing type creates a distinct service with the right period type
const pAnnMo = prepared.find((i) => i.json.subscription_id === 'SUB-1').json;
assert.strictEqual(pAnnMo.service_period_type, 2);
assert.ok(pAnnMo.service_name.includes('Annual Commit (Billed Monthly)'));
const pMtm = prepared.find((i) => i.json.subscription_id === 'SUB-2').json;
assert.strictEqual(pMtm.service_period_type, 2);
assert.ok(pMtm.service_name.includes('Month to Month'));
// ---- Co-term group contracts ------------------------------------------
// Autotask steps its billing periods from the CONTRACT START DATE, while
// Dicker bills a co-termed subscription on its GROUP's anchor day. So the
// contract is the group: one per customer + billing type + anniversary,
// named from the anchor's month/day (never the year, or a renewal would
// fork a new contract).
assert.strictEqual(pAnnMo.contract_name, 'CSP - Annual Commit Monthly - 31 Aug');
assert.strictEqual(pAnnMo.contract_start, '2025-08-31', 'grid anchored on the 31st, as Dicker invoices');
assert.strictEqual(pAnnMo.contract_end, '2026-08-30');
assert.strictEqual(pMtm.contract_name, 'CSP - Month to Month - day 1');
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
assert.strictEqual(pRenewed.contract_name, 'CSP - Month to Month - day 1');

// Month-end arithmetic must clamp, not overflow: 31-MAR minus one month is
// 28-FEB, so the cycle starts 01-MAR (not 04-MAR).
const pMonthEnd = prepared.find((i) => i.json.subscription_id === 'SUB-8').json;
assert.strictEqual(pMonthEnd.contract_start, '2027-03-01');
assert.strictEqual(pMonthEnd.contract_end, '2027-03-31');
// A month-end monthly cycle always anchors on day 1, in every month length -
// otherwise February would fork the group onto a "day 29" contract.
assert.strictEqual(pMonthEnd.contract_name, 'CSP - Month to Month - day 1');


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
assert.strictEqual(pCotermYr.contract_name, 'CSP - Annual Commit Yearly - 29 Dec');
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
const annMoGroup = galilee.filter((j) => j.contract_name === 'CSP - Annual Commit Monthly - 29 Dec');
assert.ok(annMoGroup.length >= 2, 'Galilee annual-monthly lines share one contract');
for (const j of annMoGroup) {
  assert.strictEqual(j.contract_start, '2025-12-29');
  assert.strictEqual(j.contract_end, '2026-12-28');
  assert.strictEqual(j.contract_group_key, annMoGroup[0].contract_group_key);
}
// Billing types never share a contract - Autotask period types differ.
const annYrGroup = galilee.filter((j) => j.billing_type === 'annual_upfront');
assert.strictEqual(annYrGroup[0].contract_name, 'CSP - Annual Commit Yearly - 29 Dec');
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
const keys = prepared.map((i) => i.json.service_key);
assert.strictEqual(new Set(keys).size, keys.length, 'service keys must be unique per line here');

// custom price override wins
tableRows[0].json.use_custom_price = true;
tableRows[0].json.sell_price = 99.5;
const prepared2 = runNode('prepare-lines.js', tableRows, {});
assert.strictEqual(prepared2.find((i) => i.json.subscription_id === 'SUB-1').json.effective_sell, 99.5);

console.log('ALL PARSE TESTS PASSED');
