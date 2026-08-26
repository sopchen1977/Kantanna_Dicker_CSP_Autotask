// Input: Autotask create-contract-service response ({ itemId }).
const line = $('Current Line').first().json;
const dec = $('CS Decision').first().json;
const resp = $input.first().json || {};
return [{ json: {
  line_key: line.line_key,
  action: 'create',
  contract_id: dec.contract_id,
  service_id: dec.service_id,
  cs_id: resp.itemId || null,
  sell: dec.sell,
  cs_created: !!resp.itemId,
  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)
    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),
} }];
