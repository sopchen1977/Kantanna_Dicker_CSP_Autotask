// Input: Autotask patch-contract-service response.
const line = $('Current Line').first().json;
const dec = $('CS Decision').first().json;
const resp = $input.first().json || {};
return [{ json: {
  line_key: line.line_key,
  action: 'patch',
  contract_id: dec.contract_id,
  service_id: dec.service_id,
  cs_id: dec.cs_id,
  sell: dec.sell,
  old_price: dec.old_price,
  patch_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)
    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),
} }];
