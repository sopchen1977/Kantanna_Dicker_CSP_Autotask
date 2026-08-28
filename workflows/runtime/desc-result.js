// Input: the Autotask response to PATCHing a contract service's
// invoice description. Passes the contract-service identifiers straight
// through so the units query downstream is unaffected either way.
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

// A create in this same run supersedes the id the decision node saw.
let csId = dec.cs_id;
try {
  const c = $('CS From Create').first().json;
  if (c.line_key === line.line_key && c.cs_id) csId = c.cs_id;
} catch (e) { /* create branch did not run */ }

const failed = !!(resp.error || resp.errors);
return [{ json: {
  line_key: line.line_key,
  action: dec.action,
  contract_id: dec.contract_id,
  service_id: dec.service_id,
  cs_id: csId,
  sell: dec.sell,
  old_price: dec.old_price,
  desc_from: dec.cs_invoice_description || '',
  desc_to: dec.target_invoice_description || '',
  desc_updated: !failed,
  desc_error: failed ? autotaskError(resp).slice(0, 300) : '',
} }];
