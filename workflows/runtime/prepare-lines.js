// Decide which lines to sync and precompute everything Autotask needs.
// Default include rule: NCE + Active + has an RRP. Explicit include/exclude
// saved from the portal always wins.
const rows = $input.all().map((i) => i.json).filter((j) => j.subscription_id);
const today = new Date().toISOString().slice(0, 10);

function addMonths(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Billing-type metadata. The Autotask Service is created with a matching
// period type, so the contract bills it monthly or annually as appropriate.
// Autotask REST periodType picklist (integers): 2=Monthly, 3=Quarterly,
// 4=Semi-Annual, 5=Yearly.
//   annual_monthly -> Annual commit, billed monthly   (periodType 2)
//   annual_upfront -> Annual commit, billed annually  (periodType 5)
//   monthly        -> Month-to-month                  (periodType 2)
const BILLING = {
  annual_monthly: { label: 'Annual Commit (Monthly)', period_type: 2, key: 'ANN-MO' },
  annual_upfront: { label: 'Annual Commit (Upfront)', period_type: 5, key: 'ANN-YR' },
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
  const defInclude = l.charge_type === 'NCE' && active && periodRrp > 0;
  const inc = l.include === true ? true : (l.include === false ? false : defInclude);
  if (!inc) continue;

  const serviceKey = billing.key + ':' + (l.sku || 'CSP');
  // Sell price is per billing period (per month, or per year for upfront).
  const effectiveSell =
    l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined
      ? Number(l.sell_price)
      : periodRrp;

  const contractStart = l.term_start || l.usage_start || today;
  const contractEnd = l.term_end || addMonths(contractStart, l.term_months || 12) || contractStart;
  // Autotask-style "effective from" date for price/unit changes,
  // chosen per line in the pricing portal. Defaults to today.
  const effectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(String(l.price_effective_date || ''))
    ? String(l.price_effective_date) : today;

  out.push({ json: Object.assign({}, l, {
    line_key: l.subscription_id + '|' + l.stock_code,
    billing_type: billingType,
    billing_label: billing.label,
    service_key: serviceKey,
    service_name: (String(l.offer_name || 'CSP Service') + ' - ' + billing.label + ' [' + (l.sku || 'CSP') + ']').slice(0, 100),
    service_period_type: billing.period_type,
    period_rrp: periodRrp,
    period_cost: periodCost,
    // REQUIREMENT: the Subscription ID is always part of the contract name.
    contract_name: ('CSP - ' + String(l.offer_name || '') + ' - ' + l.subscription_id).slice(0, 250),
    effective_sell: Math.round(effectiveSell * 100) / 100,
    contract_start: contractStart,
    contract_end: contractEnd,
    price_effective_date: effectiveDate,
    today: today,
  }) });
}
return out;
