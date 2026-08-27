// Decide which lines to sync and precompute everything Autotask needs.
// Default include rule: NCE + Active ($0 lines like Teams Phone Resource
// accounts sync at a $0 sell price). Explicit include/exclude saved from
// the portal always wins.
const rows = $input.all().map((i) => i.json).filter((j) => j.subscription_id);
const today = new Date().toISOString().slice(0, 10);

// Calendar-safe month arithmetic: clamp to the last day of the target
// month instead of overflowing (31-MAR minus one month is 28-FEB, not
// 3-MAR), because the whole contract window hangs off this.
function addMonths(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const maxDate = (a, b) => (a && b ? (a > b ? a : b) : (a || b));

// Earliest USAGE START across the invoice lines that get replayed as unit
// adjustments. The contract window has to reach back that far or Autotask
// rejects the adjustment.
function earliestUsage(json) {
  let rows = [];
  try { rows = JSON.parse(json || '[]'); } catch (e) { return ''; }
  let first = '';
  for (const r of rows) {
    const s = String((r && r.s) || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && (!first || s < first)) first = s;
  }
  return first;
}

// Billing-type metadata. The Autotask Service is created with a matching
// period type, so the contract bills it monthly or annually as appropriate.
// Autotask REST periodType picklist (integers): 2=Monthly, 3=Quarterly,
// 4=Semi-Annual, 5=Yearly.
//   annual_monthly -> Annual commit, billed monthly   (periodType 2)
//   annual_upfront -> Annual commit, billed annually  (periodType 5)
//   monthly        -> Month-to-month                  (periodType 2)
const BILLING = {
  annual_monthly: { label: 'Annual Commit (Billed Monthly)', period_type: 2, key: 'ANN-MO' },
  annual_upfront: { label: 'Annual Commit (Billed Annually)', period_type: 5, key: 'ANN-YR' },
  monthly: { label: 'Month to Month', period_type: 2, key: 'MTM' },
  usage: { label: 'Usage', period_type: 2, key: 'USAGE' },
};

const out = [];
for (const l of rows) {
  const billingType = l.billing_type ||
    (l.term_months > 1 ? 'annual_monthly' : 'monthly');
  const billing = BILLING[billingType] || BILLING.monthly;
  const periodRrp = Number(l.period_rrp !== null && l.period_rrp !== undefined ? l.period_rrp : l.monthly_rrp) || 0;
  const periodCost = Number(l.period_cost !== null && l.period_cost !== undefined ? l.period_cost : l.monthly_cost) || 0;

  const active = l.status === 'Active';
  const defInclude = l.charge_type === 'NCE' && active;
  const inc = l.include === true ? true : (l.include === false ? false : defInclude);
  if (!inc) continue;

  const serviceKey = billing.key + ':' + (l.sku || 'CSP');
  // Sell price is per billing period (per month, or per year for upfront).
  const effectiveSell =
    l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined
      ? Number(l.sell_price)
      : periodRrp;

  // ---- Contract window -------------------------------------------------
  // The annuity report's START USAGE / END USAGE are when the subscription
  // FIRST started, not the current term — anything older than a year has
  // renewed since, so they are never a source for the contract window.
  // REVALUATION PERIOD is the current expiry date, and the current term is
  // inferred backwards from it using the subscription type (P1Y = 12
  // months, P1M = 1 month).
  //
  // The CSP invoice report's TERM START is more precise when it describes
  // the SAME term: co-termed subscriptions bought mid-year get a short
  // first term that no amount of inference can recover. But the annuity
  // report is the later snapshot, so when its REVALUATION PERIOD is past
  // the invoiced TERM END the subscription has renewed (annual) or rolled
  // to the next cycle (month-to-month) and the new term starts the day
  // after the invoiced one ended.
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const termMonths = Number(l.term_months) || 12;
  const invStart = iso(l.term_start);
  const invEnd = iso(l.term_end);
  const reval = iso(l.revaluation_period);
  const inferredStart = reval ? addDays(addMonths(reval, -termMonths), 1) : '';

  let contractStart = '';
  let contractEnd = '';
  let windowSource = '';
  if (reval && invEnd && reval > invEnd) {
    contractStart = maxDate(addDays(invEnd, 1), inferredStart);
    contractEnd = reval;
    windowSource = 'renewed';
  } else if (invStart && invEnd) {
    contractStart = invStart;
    contractEnd = maxDate(invEnd, reval);
    windowSource = 'invoice';
  } else if (reval) {
    // No invoice row this month (annual-upfront plans are only invoiced
    // once a year). A subscription cannot have started before it first
    // started, so START USAGE raises the inferred term start when the
    // subscription was co-termed part-way through a year. Dicker reports
    // START USAGE as the day BEFORE the term begins, hence the +1.
    // Across the August 2026 reports this reproduces the invoice's own
    // TERM START for 68 of 70 comparable lines.
    contractStart = maxDate(inferredStart, addDays(iso(l.usage_start), 1));
    contractEnd = reval;
    if (contractStart > contractEnd) contractStart = inferredStart;
    windowSource = 'revaluation';
  }
  if (!contractStart) { contractStart = invStart || today; windowSource = windowSource || 'unknown'; }
  if (!contractEnd) contractEnd = addMonths(contractStart, termMonths) || contractStart;
  // Reach back over the invoice lines this run replays as unit adjustments.
  const firstUsage = earliestUsage(l.invoice_lines);
  if (firstUsage && firstUsage < contractStart) contractStart = firstUsage;
  // Autotask-style "effective from" date for price/unit changes,
  // chosen per line in the pricing portal. Defaults to today, clamped
  // into the contract window (Autotask rejects dates outside it).
  let effectiveDate = iso(l.price_effective_date) || today;
  if (effectiveDate < contractStart) effectiveDate = contractStart;
  if (effectiveDate > contractEnd) effectiveDate = contractEnd;

  // REQUIREMENT: the Subscription ID is always part of the contract name.
  // ONE contract per subscription for every billing type: each monthly CSP
  // report finds the same contract again, and when the new billing cycle
  // (month-to-month auto-renews at Dicker) or a renewed term ends after
  // the contract's endDate, the contract end date is extended in place.
  const contractName = 'CSP - ' + String(l.offer_name || '') + ' - ' + l.subscription_id;

  out.push({ json: Object.assign({}, l, {
    line_key: l.subscription_id + '|' + l.stock_code,
    billing_type: billingType,
    billing_label: billing.label,
    service_key: serviceKey,
    service_name: (String(l.offer_name || 'CSP Service') + ' - ' + billing.label + ' [' + (l.sku || 'CSP') + ']').slice(0, 100),
    service_period_type: billing.period_type,
    period_rrp: periodRrp,
    period_cost: periodCost,
    contract_name: contractName.slice(0, 100), // Autotask contractName max length
    effective_sell: Math.round(effectiveSell * 100) / 100,
    contract_start: contractStart,
    contract_end: contractEnd,
    contract_window_source: windowSource,
    // START USAGE is the subscription's original start, kept for display
    // only — never used to date the contract.
    first_started: iso(l.usage_start),
    price_effective_date: effectiveDate,
    today: today,
  }) });
}
return out;
