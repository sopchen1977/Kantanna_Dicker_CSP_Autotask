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

// Inclusive day count between two ISO dates (a term of 31-AUG-25 ->
// 30-AUG-26 is 365 days).
function dayCount(from, to) {
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to + 'T00:00:00Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

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
  annual_monthly: { label: 'Annual Commit (Billed Monthly)', short: 'Annual Commit Monthly', period_type: 2, key: 'ANN-MO' },
  annual_upfront: { label: 'Annual Commit (Billed Annually)', short: 'Annual Commit Yearly', period_type: 5, key: 'ANN-YR' },
  monthly: { label: 'Month to Month', short: 'Month to Month', period_type: 2, key: 'MTM' },
  usage: { label: 'Usage', short: 'Usage', period_type: 2, key: 'USAGE' },
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function longDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(isoDate || '');
  return d.getUTCDate() + ' ' + MONTH_ABBR[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

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

  // The variant matters: CFQ7TTC0LCHC:0002 (Business Premium) and
  // :001J (Defender Suite) share a SKU root but are different products,
  // and inside one shared contract they must be different services.
  // Read straight off the stock code so no re-import is needed.
  const variant = String(l.stock_code || '').split(':')[2] || '';
  const serviceKey = billing.key + ':' + (l.sku || 'CSP') + (variant ? ':' + variant : '');

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
  // A cycle runs [start .. reval], so the next one opens on reval + 1 day.
  // Stepping a whole term back from THAT is exact for every month length;
  // stepping back from reval and adding a day is not (28-FEB minus one month
  // plus a day lands on 29-JAN instead of 01-FEB).
  const inferredStart = reval ? addMonths(addDays(reval, 1), -termMonths) : '';

  let memberStart = '';
  let memberEnd = '';
  let windowSource = '';
  if (reval && invEnd && reval > invEnd) {
    memberStart = maxDate(addDays(invEnd, 1), inferredStart);
    memberEnd = reval;
    windowSource = 'renewed';
  } else if (invStart && invEnd) {
    memberStart = invStart;
    memberEnd = maxDate(invEnd, reval);
    windowSource = 'invoice';
  } else if (reval) {
    // No invoice row this month (annual-upfront plans are only invoiced
    // once a year). A subscription cannot have started before it first
    // started, so START USAGE raises the inferred term start when the
    // subscription was co-termed part-way through a year. Dicker reports
    // START USAGE as the day BEFORE the term begins, hence the +1.
    // Across the August 2026 reports this reproduces the invoice's own
    // TERM START for 68 of 70 comparable lines.
    memberStart = maxDate(inferredStart, addDays(iso(l.usage_start), 1));
    memberEnd = reval;
    if (memberStart > memberEnd) memberStart = inferredStart;
    windowSource = 'revaluation';
  }
  if (!memberStart) { memberStart = invStart || today; windowSource = windowSource || 'unknown'; }
  if (!memberEnd) memberEnd = addMonths(memberStart, termMonths) || memberStart;

  // ---- Co-terming ------------------------------------------------------
  // Microsoft aligns a new annual subscription to an existing anniversary,
  // so its CURRENT term is shorter than the full 12-month commitment (Atlas
  // Entra ID P2: 03-MAR-26 -> 30-AUG-26, 181 days). Dicker still reports the
  // full 12-month UNIT PRICE / UNIT RRP on every such line.
  //   - Billed monthly: the monthly rate is unchanged (unit / 12); the stub
  //     just means fewer monthly charges before it renews for a full year.
  //   - Billed annually upfront: the single charge IS pro-rated on days.
  //     Verified against the invoice report - a 272-of-365-day window bills
  //     unit x 0.7452, exactly the day ratio - so the period price has to be
  //     scaled or the contract bills a full year for a part-year term.
  // Measured before the window is widened for replayed invoice lines.
  const termDays = dayCount(memberStart, memberEnd);
  const termFactor = termMonths === 12 && termDays > 0
    ? Math.min(Math.round((termDays / 365) * 10000) / 10000, 1) : 1;
  const isCoterm = termFactor < 0.99;
  const scale = isCoterm && billingType === 'annual_upfront' ? termFactor : 1;
  const periodRrpTerm = Math.round(periodRrp * scale * 100) / 100;
  const periodCostTerm = Math.round(periodCost * scale * 100) / 100;

  // ---- The co-term group contract ---------------------------------------
  // Autotask generates its billing periods by stepping from the CONTRACT
  // START DATE, while Dicker bills a co-termed subscription on the group's
  // anchor day (verified: 14 of 14 co-termed lines invoice on the group
  // anchor, none on their own term start). Dating a contract from the
  // subscription's own start therefore puts Autotask on the wrong grid.
  //
  // So the contract belongs to the CO-TERM GROUP, not the subscription:
  // one contract per customer + billing type + anniversary, holding every
  // subscription that shares that renewal date. Its window is a pure
  // function of the anniversary and the term length, so every member of a
  // group computes an identical window and the first line to reach Autotask
  // creates it.
  const groupEnd = memberEnd;
  const groupStart = addMonths(addDays(groupEnd, 1), -termMonths) || memberStart;
  // How the contract is labelled, and therefore what counts as "the same
  // contract" on the next import:
  //   - Annual: named for its TERM, so each renewal is a new contract -
  //     which is how Autotask models an annual renewal anyway.
  //   - Month to month: no dates, because it rolls forever. The anchor day
  //     stays in the name because it is not a term, it is which billing
  //     cycle the subscription sits on: B E Smart has one group billing
  //     1st-to-month-end and another billing 22nd-to-21st, and they cannot
  //     share a contract.
  const anchor = new Date(groupStart + 'T00:00:00Z');
  const anchorDay = isNaN(anchor.getTime()) ? 0 : anchor.getUTCDate();
  // What identifies the group, and so which subscriptions share a contract.
  //   - Annual: the co-term anniversary. Subscriptions aligned to the same
  //     renewal date must share a contract's period grid.
  //   - Month to month: the date the subscription first started, so
  //     subscriptions bought at different times get their own contract.
  //     The billing cycle day stays in the KEY (not the name): one customer
  //     can run several month-to-month cycles - B E Smart bills some
  //     subscriptions 1st-to-month-end and others 22nd-to-21st - and
  //     Autotask bills every service against its contract's own period
  //     grid, so two cycles must never merge even if they share a date.
  const startedOn = iso(l.usage_start) || memberStart;
  const groupId = termMonths === 12
    ? groupStart + '..' + groupEnd
    : 'cycle-day-' + anchorDay + '|started-' + startedOn;
  const anchorLabel = termMonths === 12
    ? longDate(groupStart) + ' to ' + longDate(groupEnd)
    : 'Started ' + startedOn;

  let contractStart = groupStart;
  const contractEnd = groupEnd;
  // Reach back over the invoice lines this run replays as unit adjustments.
  const firstUsage = earliestUsage(l.invoice_lines);
  if (firstUsage && firstUsage < contractStart) contractStart = firstUsage;

  // Where this subscription's units begin inside the shared contract.
  // Autotask pro-rates the first period when this falls mid-cycle, which is
  // exactly how Dicker bills a newly co-termed subscription.
  const serviceEffective = maxDate(memberStart, contractStart) || contractStart;
  // Sell price is per billing period (per month, or per term for upfront,
  // pro-rated when the term is a co-termed stub). An explicit portal price
  // is used exactly as typed.
  const effectiveSell =
    l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined
      ? Number(l.sell_price)
      : periodRrpTerm;

  // Autotask-style "effective from" date for price/unit changes,
  // chosen per line in the pricing portal. Defaults to today, clamped
  // into the contract window (Autotask rejects dates outside it).
  let effectiveDate = iso(l.price_effective_date) || today;
  if (effectiveDate < contractStart) effectiveDate = contractStart;
  if (effectiveDate > contractEnd) effectiveDate = contractEnd;

  // Every contract name starts with CSP. The Subscription ID rides on the
  // contract SERVICE's invoice description, so it still reaches the invoice
  // line the customer sees.
  const contractName = 'CSP - ' + billing.short + ' - ' + anchorLabel;
  const groupKey = String(l.tenant_name || '') + '|' + billing.key + '|' + groupId;

  out.push({ json: Object.assign({}, l, {
    line_key: l.subscription_id + '|' + l.stock_code,
    billing_type: billingType,
    billing_label: billing.label,
    service_key: serviceKey,
    service_name: (String(l.offer_name || 'CSP Service') + ' - ' + billing.label + ' [' + (l.sku || 'CSP') + ']').slice(0, 100),
    service_period_type: billing.period_type,
    period_rrp: periodRrpTerm,
    period_cost: periodCostTerm,
    // Full 12-month list prices, kept for reference when a term is a stub.
    full_period_rrp: periodRrp,
    full_period_cost: periodCost,
    contract_name: contractName.slice(0, 100), // Autotask contractName max length
    contract_group_key: groupKey,
    contract_anchor: anchorLabel,
    service_invoice_description:
      (String(l.offer_name || '') + ' - sub ' + l.subscription_id).slice(0, 100),
    effective_sell: Math.round(effectiveSell * 100) / 100,
    contract_start: contractStart,
    contract_end: contractEnd,
    contract_window_source: windowSource,
    // This subscription's OWN term inside the shared contract.
    member_start: memberStart,
    member_end: memberEnd,
    service_effective_date: serviceEffective,
    term_days: termDays,
    term_factor: termFactor,
    is_coterm: isCoterm,
    // START USAGE is the subscription's original start, kept for display
    // only — never used to date the contract.
    first_started: iso(l.usage_start),
    price_effective_date: effectiveDate,
    today: today,
  }) });
}

// ---- Two subscriptions of the same product on one contract --------------
// A customer can hold the same SKU twice as two separate subscriptions
// (ConnectOS has M365 Business Standard as qty 1 and qty 7). Both resolve to
// the same Autotask service, and a contract carries a given service only
// once - so left alone the second line would find the first line's contract
// service and overwrite its units, billing 7 instead of 8.
//
// They are therefore billed as ONE contract service with the combined
// quantity, replaying both subscriptions' invoice lines. Every subscription
// in the group still gets its own status written back to the table, via
// merged_keys, so no row is left stale.
const byService = {};
for (const i of out) {
  const j = i.json;
  const k = j.contract_group_key + '||' + j.service_key;
  (byService[k] = byService[k] || []).push(j);
}

const combined = [];
for (const k of Object.keys(byService)) {
  const group = byService[k].sort((a, b) => String(a.line_key).localeCompare(String(b.line_key)));
  const primary = group[0];
  if (group.length > 1) {
    const parts = group.map((j) => ({
      id: String(j.subscription_id).slice(0, 8),
      qty: Number(j.qty || 0),
      sell: Number(j.effective_sell || 0),
    }));
    primary.qty = parts.reduce((s, p) => s + p.qty, 0);
    // Replay every subscription's invoice lines so the unit history adds up
    // to the combined quantity.
    let invAll = [];
    for (const j of group) {
      try { invAll = invAll.concat(JSON.parse(j.invoice_lines || '[]')); } catch (e) { /* none */ }
    }
    invAll.sort((a, b) => String(a && a.s).localeCompare(String(b && b.s)));
    primary.invoice_lines = JSON.stringify(invAll).slice(0, 4000);
    primary.service_invoice_description =
      (String(primary.offer_name || '') + ' - subs ' + parts.map((p) => p.id).join(', ')).slice(0, 100);
    primary.merged_note = 'combined ' + group.length + ' subscriptions of the same product ('
      + parts.map((p) => p.id + ' x' + p.qty).join(', ') + ')'
      + (new Set(parts.map((p) => p.sell)).size > 1
        ? ' - they had different sell prices, using ' + primary.effective_sell : '');
  }
  // Whether merged or not, every subscription in the group gets its status
  // written back against its own row.
  primary.merged_keys = group.map((j) => ({
    subscription_id: j.subscription_id, stock_code: j.stock_code,
  }));
  combined.push({ json: primary });
}
return combined;
