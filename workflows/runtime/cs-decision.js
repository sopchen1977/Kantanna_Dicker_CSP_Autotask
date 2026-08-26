// Input: Autotask ContractServices/query response for the contract.
// Decide whether to create the contract service, re-price it, or do nothing.
const line = $('Current Line').first().json;
const prev = $('Contract Decision').first().json;
let cid = prev.line_key === line.line_key ? prev.contract_id : null;
try {
  const created = $('Contract From Create').first().json;
  if (created.line_key === line.line_key && created.contract_id) cid = created.contract_id;
} catch (e) { /* create branch did not run this iteration */ }

const svcRow = $('Record Service').first().json;
const serviceId = svcRow.sku === line.service_key ? svcRow.autotask_service_id : null;

const resp = $input.first().json || {};
const items = resp.items || [];
const cs = items.find((c) => Number(c.serviceID) === Number(serviceId)) || null;

let action = 'none';
if (!cid || !serviceId) action = 'none';
else if (!cs) action = 'create';
else if (Math.abs(Number(cs.adjustedPrice || 0) - Number(line.effective_sell)) > 0.005) action = 'patch';

return [{ json: {
  line_key: line.line_key,
  action: action,
  contract_id: cid,
  service_id: serviceId,
  cs_id: cs ? cs.id : null,
  old_price: cs ? Number(cs.adjustedPrice || 0) : null,
  sell: Number(line.effective_sell),
} }];
