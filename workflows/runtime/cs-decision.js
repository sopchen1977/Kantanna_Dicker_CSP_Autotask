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

// The current sell price of an existing contract service. The query does
// not return adjustedPrice — only internalCurrencyAdjustedPrice, which is
// scaled by the instance's internal-currency factor. That same factor is
// internalCurrencyUnitPrice / unitPrice, so divide it back out.
function currentPrice(c) {
  if (c.adjustedPrice !== undefined && c.adjustedPrice !== null) return Number(c.adjustedPrice);
  if (Number(c.internalCurrencyAdjustedPrice) === 0) return 0; // $0 line ($0 sell)
  const mult = Number(c.internalCurrencyUnitPrice) / Number(c.unitPrice);
  if (c.internalCurrencyAdjustedPrice !== undefined && c.internalCurrencyAdjustedPrice !== null
      && isFinite(mult) && mult > 0) {
    return Math.round((Number(c.internalCurrencyAdjustedPrice) / mult) * 100) / 100;
  }
  return null; // unknown -> re-price to be safe
}

const oldPrice = cs ? currentPrice(cs) : null;
let action = 'none';
if (!cid || !serviceId) action = 'none';
else if (!cs) action = 'create';
else if (oldPrice === null || Math.abs(oldPrice - Number(line.effective_sell)) > 0.005) action = 'patch';

return [{ json: {
  line_key: line.line_key,
  action: action,
  contract_id: cid,
  service_id: serviceId,
  cs_id: cs ? cs.id : null,
  old_price: oldPrice,
  sell: Number(line.effective_sell),
} }];
