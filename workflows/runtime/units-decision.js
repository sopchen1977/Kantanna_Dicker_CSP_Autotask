// Input: Autotask ContractServiceUnits/query response. Build a CHRONOLOGICAL
// unit-adjustment plan that mirrors the Dicker CSP invoice report:
//   1. the pre-existing base quantity, effective from contract start
//   2. each pro-rata addition/removal at its USAGE START date
//   3. a final correction (if needed) at the main full-cycle line's date
// ending at the imported quantity. This matches how Autotask expects
// contract quantities to be built up over time.
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

let invLines = [];
try { invLines = JSON.parse(line.invoice_lines || '[]'); } catch (e) { /* no invoice detail */ }
invLines = invLines.filter((x) => x && x.s).sort((a, b) => String(a.s).localeCompare(String(b.s)));
const mainLines = invLines.filter((x) => Number(x.q) === target);
const prorata = invLines.filter((x) => Number(x.q) !== target);
const mainDate = mainLines.length
  ? mainLines[mainLines.length - 1].s
  : (line.price_effective_date || line.today);

const plan = [];
if (current === 0 && invLines.length) {
  // Fresh contract service: replay the report. Base = what existed before
  // the pro-rata changes this cycle.
  const base = target - prorata.reduce((s, x) => s + Number(x.q || 0), 0);
  let running = 0;
  if (base > 0) {
    plan.push({ change: base, date: line.contract_start || mainDate });
    running = base;
  }
  for (const p of prorata) {
    const q = Number(p.q || 0);
    if (q !== 0) { plan.push({ change: q, date: p.s }); running += q; }
  }
  if (running !== target) plan.push({ change: target - running, date: mainDate });
} else if (target !== current) {
  // Contract already has unit history: single delta, dated per the report.
  plan.push({ change: target - current, date: mainDate });
}

return [{ json: {
  line_key: line.line_key,
  contract_id: carried.contract_id || null,
  service_id: carried.service_id || null,
  cs_id: carried.cs_id || null,
  sell: carried.sell,
  current_units: current,
  target_units: target,
  plan: plan,
  plan_count: plan.length,
  plan_summary: plan.map((p) => (p.change > 0 ? '+' : '') + p.change + ' @' + p.date).join(', '),
} }];
