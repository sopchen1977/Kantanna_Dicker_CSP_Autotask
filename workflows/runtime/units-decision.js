// Input: Autotask ContractServiceUnits/query response. Build a CHRONOLOGICAL
// unit-adjustment plan by first understanding the BILLING CYCLE from the
// CSP invoice lines (distinct from the subscription term):
//   - cycle end   = latest USAGE END across this subscription's lines
//   - cycle line  = earliest-starting line with that end; its USAGE START
//                   is the cycle start and its qty is the cycle quantity
//   - other lines = pro-rata changes (before or within the cycle), each
//                   effective at its own USAGE START
// The plan applies pro-rata changes in date order, sets the cycle quantity
// at cycle start, and finally corrects to the annuity quantity if needed.
// e.g. Atlas M365 BP: +6 @13-Jul, +10 @27-Jul, +259 @31-Jul (cycle start)
// = 275. Units never exist before dates shown in the report, so Autotask
// does not back-bill earlier periods.
const line = $('Current Line').first().json;

// Recover the contract-service identifiers from whichever branch ran for
// THIS line ($() returns the node's most recent run, so verify line_key).
function grab(name) {
  try {
    const j = $(name).first().json;
    return j.line_key === line.line_key ? j : null;
  } catch (e) { return null; }
}
const carried = grab('CS From Create') || grab('CS After Patch') || grab('CS Decision') || {};

const resp = $input.first().json || {};
const items = resp.items || [];
let current = 0;
if (items.length) {
  let latest = items[0];
  for (const u of items) {
    if (String(u.startDate || '') > String(latest.startDate || '')) latest = u;
  }
  current = Number(latest.units || 0);
}
const target = Number(line.qty || 0);

// Autotask rejects adjustments dated outside the contract window.
const cStart = String(line.contract_start || '');
const cEnd = String(line.contract_end || '');
function clampDate(d) {
  let v = String(d || '');
  if (cStart && v < cStart) v = cStart;
  if (cEnd && v > cEnd) v = cEnd;
  return v;
}

let invLines = [];
try { invLines = JSON.parse(line.invoice_lines || '[]'); } catch (e) { /* no invoice detail */ }
invLines = invLines.filter((x) => x && x.s).sort((a, b) => String(a.s).localeCompare(String(b.s)));

const plan = [];
let cycleStart = '';
let cycleEnd = '';

if (invLines.length) {
  // Identify the billing cycle.
  for (const x of invLines) {
    if (String(x.e || '') > cycleEnd) cycleEnd = String(x.e || '');
  }
  const enders = invLines.filter((x) => String(x.e || '') === cycleEnd);
  cycleStart = String(enders[0].s);
  for (const x of enders) {
    if (String(x.s) < cycleStart) cycleStart = String(x.s);
  }
  const cycleLines = enders.filter((x) => String(x.s) === cycleStart);
  const cycleQty = cycleLines.reduce((s, x) => s + Number(x.q || 0), 0);
  const prorata = invLines.filter((x) => cycleLines.indexOf(x) === -1);

  // Chronological events: pro-rata increments at their usage start, the
  // cycle quantity set at cycle start ('set' sorts after adds on a tie).
  const events = [];
  for (const p of prorata) events.push({ type: 'add', q: Number(p.q || 0), date: String(p.s) });
  events.push({ type: 'set', q: cycleQty, date: cycleStart });
  events.sort((a, b) => (a.date === b.date
    ? (a.type === 'set' ? 1 : -1)
    : a.date.localeCompare(b.date)));

  let running = current;
  let lastDate = cycleStart;
  if (current === 0) {
    // Fresh contract service: replay the cycle.
    for (const ev of events) {
      const change = ev.type === 'set' ? ev.q - running : ev.q;
      if (change !== 0) { plan.push({ change: change, date: clampDate(ev.date) }); running += change; }
      if (ev.date > lastDate) lastDate = ev.date;
    }
  }
  // Correct to the annuity quantity (also the single-delta path when the
  // contract already has unit history).
  if (running !== target) {
    plan.push({ change: target - running, date: clampDate(lastDate || line.price_effective_date || line.today) });
  }
} else if (target !== current) {
  // No invoice detail available (annual-upfront plans are invoiced once a
  // year). A service being added for the first time starts at the
  // subscription's own term start, so Autotask pro-rates the opening period
  // when that falls mid-cycle in the shared co-term contract - the same
  // shape Dicker bills. An existing service moves at the portal's From date.
  const startDate = current === 0
    ? (line.service_effective_date || line.price_effective_date || line.today)
    : (line.price_effective_date || line.today);
  plan.push({ change: target - current, date: clampDate(startDate) });
}

return [{ json: {
  line_key: line.line_key,
  contract_id: carried.contract_id || null,
  service_id: carried.service_id || null,
  cs_id: carried.cs_id || null,
  sell: carried.sell,
  current_units: current,
  target_units: target,
  cycle_start: cycleStart,
  cycle_end: cycleEnd,
  plan: plan,
  plan_count: plan.length,
  plan_summary: plan.map((p) => (p.change > 0 ? '+' : '') + p.change + ' @' + p.date).join(', '),
} }];
