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
//
// Every event is posted as the gap between the report's quantity and the
// quantity Autotask already holds on that date, so this runs the same way on
// a service that is new and on one billing for the tenth month - and posts
// nothing at all the second time the same report is synced.
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

// The same records as a dated timeline, oldest first. `current` is what the
// service bills today; only the series can say whether a mid-cycle change
// from the report has already been given to Autotask, which is what makes
// replaying one safe to repeat.
const history = items
  .filter((u) => u && u.startDate)
  .map((u) => ({ date: String(u.startDate).slice(0, 10), units: Number(u.units || 0) }))
  .sort((a, b) => a.date.localeCompare(b.date));
const historyStart = history.length ? history[0].date : '';
// Units in force on a date, and just before one: Autotask holds a step
// series, so a date carries the last value that started on or before it.
function unitsAt(date) {
  let v = 0;
  for (const h of history) { if (h.date > date) break; v = h.units; }
  return v;
}
function unitsBefore(date) {
  let v = 0;
  for (const h of history) { if (h.date >= date) break; v = h.units; }
  return v;
}

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

  // Replay the report's timeline against Autotask's own. Each event posts the
  // difference between the units the report says are in force from that date
  // and the units Autotask already has there, so a change it has already been
  // given costs nothing and re-running a sync posts no adjustments at all.
  //
  // Replaying only when the service was new (units === 0) is what lost
  // pro-rata charges: from the second month on, a customer who moved seats
  // mid-cycle had every change collapsed into one delta at the cycle start,
  // so the days Dicker charged pro-rata for were never billed on.
  let desired = unitsBefore(events[0].date);
  let applied = 0;
  let lastDate = cycleStart;
  for (const ev of events) {
    desired = ev.type === 'set' ? ev.q : desired + ev.q;
    if (ev.date > lastDate) lastDate = ev.date;
    // Autotask holds no units for this service before its first record, so an
    // adjustment dated earlier would invent a period it never billed. The
    // correction below still carries the quantity; only the back-dating goes.
    if (historyStart && ev.date < historyStart) continue;
    const change = desired - (unitsAt(ev.date) + applied);
    if (change !== 0) { plan.push({ change: change, date: clampDate(ev.date) }); applied += change; }
  }
  // Correct to the annuity quantity, which is the count Dicker bills from here
  // on whatever the cycle line said. Dated at the last event so Autotask bills
  // the corrected quantity for the rest of the cycle, never before the service
  // had units at all.
  let correctionDate = lastDate;
  if (historyStart && correctionDate < historyStart) correctionDate = historyStart;
  if (current + applied !== target) {
    plan.push({ change: target - current - applied,
      date: clampDate(correctionDate || line.price_effective_date || line.today) });
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

// Autotask keys a contract service period on (contract service, period start,
// period end) and rejects a second insert for the same one with "Attempt to
// insert duplicate data into contract_service_period". Two changes dated the
// same day are one net change anyway, so they are merged before posting.
function mergeSameDate(entries) {
  const byDate = {};
  const order = [];
  for (const p of entries) {
    if (!(p.date in byDate)) { byDate[p.date] = 0; order.push(p.date); }
    byDate[p.date] += p.change;
  }
  return order
    .map((d) => ({ change: byDate[d], date: d }))
    .filter((p) => p.change !== 0);
}
const finalPlan = mergeSameDate(plan);

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
  plan: finalPlan,
  plan_count: finalPlan.length,
  plan_summary: finalPlan.map((p) => (p.change > 0 ? '+' : '') + p.change + ' @' + p.date).join(', '),
} }];
