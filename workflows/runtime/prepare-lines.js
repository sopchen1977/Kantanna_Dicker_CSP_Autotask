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

const out = [];
for (const l of rows) {
  const active = l.status === 'Active';
  const defInclude = l.charge_type === 'NCE' && active && Number(l.monthly_rrp) > 0;
  const inc = l.include === true ? true : (l.include === false ? false : defInclude);
  if (!inc) continue;

  const term = l.term_months > 1 ? 'P' + (l.term_months / 12) + 'Y' : 'P1M';
  const serviceKey = term + ':' + (l.sku || 'CSP');
  const effectiveSell =
    l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined
      ? Number(l.sell_price)
      : Number(l.monthly_rrp || 0);

  const contractStart = l.term_start || l.usage_start || today;
  const contractEnd = l.term_end || addMonths(contractStart, l.term_months || 12) || contractStart;

  out.push({ json: Object.assign({}, l, {
    line_key: l.subscription_id + '|' + l.stock_code,
    service_key: serviceKey,
    service_name: (String(l.offer_name || 'CSP Service') + ' [' + serviceKey + ']').slice(0, 100),
    // REQUIREMENT: the Subscription ID is always part of the contract name.
    contract_name: ('CSP - ' + String(l.offer_name || '') + ' - ' + l.subscription_id).slice(0, 250),
    effective_sell: Math.round(effectiveSell * 100) / 100,
    contract_start: contractStart,
    contract_end: contractEnd,
    today: today,
  }) });
}
return out;
