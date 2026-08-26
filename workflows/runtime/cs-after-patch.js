// Input: Autotask service-adjustment (re-price) response. A successful
// ServiceAdjustments POST returns { itemId: null } — only an error field
// means failure.
const line = $('Current Line').first().json;
const dec = $('CS Decision').first().json;
const resp = $input.first().json || {};

function autotaskError(r) {
  const d = r.details || {};
  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');
  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');
  if (d.description) return String(d.description);
  if (r.error) return String(r.error.message || JSON.stringify(r.error));
  if (r.errors) return JSON.stringify(r.errors);
  return 'unknown';
}

return [{ json: {
  line_key: line.line_key,
  action: 'patch',
  contract_id: dec.contract_id,
  service_id: dec.service_id,
  cs_id: dec.cs_id,
  sell: dec.sell,
  old_price: dec.old_price,
  effective_date: line.price_effective_date || line.today,
  patch_error: (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '',
} }];
