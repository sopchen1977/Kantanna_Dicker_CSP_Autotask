// Input: Autotask ContractServiceUnits/query response. Compute the unit
// delta between what the contract currently has and the imported quantity.
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
return [{ json: {
  line_key: line.line_key,
  contract_id: carried.contract_id || null,
  service_id: carried.service_id || null,
  cs_id: carried.cs_id || null,
  sell: carried.sell,
  current_units: current,
  target_units: target,
  delta: target - current,
} }];
