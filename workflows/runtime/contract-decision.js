// Input: Autotask Contracts/query response (matched on companyID + contract
// name containing the Subscription ID). Decide whether the contract exists,
// and whether an existing contract's end date must be extended so that the
// adjustment dates from this import fall inside the contract window
// (Autotask rejects adjustments outside it; also covers annual renewals
// where the new term ends after the contract's original endDate).
const line = $('Current Line').first().json;
const resp = $input.first().json || {};
const items = resp.items || [];
const found = items.length ? items[0] : null;
const neededEnd = String(line.contract_end || '');
const foundEnd = found ? String(found.endDate || '').slice(0, 10) : '';
return [{ json: {
  line_key: line.line_key,
  contract_id: found ? found.id : null,
  need_contract: !found,
  need_date_fix: !!(found && neededEnd && foundEnd && foundEnd < neededEnd),
  contract_end_needed: neededEnd,
  contract_end_found: foundEnd,
  query_error: resp.error ? String(resp.error.message || resp.error) : '',
} }];
