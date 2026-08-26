// Input: Autotask Contracts/query response (matched on companyID + contract
// name containing the Subscription ID). Decide whether the contract exists.
const line = $('Current Line').first().json;
const resp = $input.first().json || {};
const items = resp.items || [];
const found = items.length ? items[0] : null;
return [{ json: {
  line_key: line.line_key,
  contract_id: found ? found.id : null,
  need_contract: !found,
  query_error: resp.error ? String(resp.error.message || resp.error) : '',
} }];
