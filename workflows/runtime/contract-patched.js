// Input: the Autotask PATCH /Contracts response after adopting or repairing
// an existing contract - stamping its External Contract Number on, correcting
// its name, extending its end date, or any combination. Restores the ids
// Fetch Contract Services needs.
const line = $('Current Line').first().json;
const dec = $('Contract Decision').first().json;
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
  contract_id: dec.contract_id,
  patch_summary: dec.contract_patch_summary || '',
  patch_error: (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '',
} }];
