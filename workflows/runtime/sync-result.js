// Build the final per-line outcome that gets written back to the
// csp_subscription_lines table. Reads every step's node for THIS line only
// (guarded by line_key, since $() returns a node's most recent run).
const line = $('Current Line').first().json;

function grab(name) {
  try {
    const j = $(name).first().json;
    return j.line_key === line.line_key ? j : null;
  } catch (e) { return null; }
}

const svcDec = grab('Service Decision');
const svcCreated = grab('Service From Create');
const conDec = grab('Contract Decision');
const conCreated = grab('Contract From Create');
const conExtended = grab('Contract Extended');
const csCreate = grab('CS From Create');
const csPatch = grab('CS After Patch');
const csDec = grab('CS Decision');
const units = grab('Units Decision');
const billing = grab('Billing Summary');

const serviceId = (svcCreated && svcCreated.service_id) || (svcDec && svcDec.service_id) || null;
const contractId = (conCreated && conCreated.contract_id) || (conDec && conDec.contract_id) || null;
const csId = (csCreate && csCreate.cs_id) || (csDec && csDec.cs_id) || null;

const notes = [];
const errors = [];
if (svcCreated) {
  if (svcCreated.service_id) notes.push('service created #' + svcCreated.service_id);
  else errors.push('service create failed: ' + (svcCreated.create_error || 'unknown'));
}
if (conCreated) {
  if (conCreated.contract_id) notes.push('contract created #' + conCreated.contract_id);
  else errors.push('contract create failed: ' + (conCreated.create_error || 'unknown'));
}
if (conExtended) {
  if (conExtended.extend_error) errors.push('contract end-date extension failed: ' + conExtended.extend_error);
  else notes.push('contract end extended ' + conExtended.extended_from + ' -> ' + conExtended.extended_to);
}
if (csCreate) {
  if (csCreate.cs_id) notes.push('service added to contract @ ' + csCreate.sell);
  else errors.push('contract service create failed: ' + (csCreate.create_error || 'unknown'));
}
if (csPatch) {
  if (csPatch.patch_error) errors.push('price update failed: ' + csPatch.patch_error);
  else notes.push('price ' + csPatch.old_price + ' -> ' + csPatch.sell
    + (csPatch.effective_date ? ' effective ' + csPatch.effective_date : ''));
}
if (units && units.plan_count > 0 && csId) {
  const adj = grab('Adjust Result');
  if (adj && adj.adjust_error) errors.push('unit adjustment failed: ' + adj.adjust_error);
  else notes.push('units ' + units.current_units + ' -> ' + units.target_units +
    ' (' + units.plan_summary + ')');
}
if (!serviceId) errors.push('no Autotask service resolved');
if (!contractId) errors.push('no Autotask contract resolved');
if (!csId && serviceId && contractId) errors.push('no contract service resolved');

const status = errors.length ? 'error' : 'synced';
const message = (errors.length ? errors : (notes.length ? notes : ['up to date'])).join('; ').slice(0, 500);

// The contract service's CURRENT sell price after this run: what a patch
// or create just set, otherwise what the contract already had. Shown in
// the portal as the line's price.
let contractPrice = null;
if (csPatch && !csPatch.patch_error) contractPrice = csPatch.sell;
else if (csCreate && csCreate.cs_id) contractPrice = csCreate.sell;
else if (csDec && csDec.old_price !== null && csDec.old_price !== undefined) contractPrice = csDec.old_price;

return [{ json: {
  subscription_id: line.subscription_id,
  stock_code: line.stock_code,
  sync_status: status,
  sync_message: message,
  autotask_service_id: serviceId,
  autotask_contract_id: contractId,
  autotask_contract_service_id: csId,
  billing_last: (billing && billing.billing_last) || '',
  billing_next: (billing && billing.billing_next) || '',
  contract_price: contractPrice,
} }];
