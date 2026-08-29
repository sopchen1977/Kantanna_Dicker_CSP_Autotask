// Input: the Autotask PATCH /Services response after adopting or correcting
// an existing service - stamping its service key on, bringing its product
// name up to date, or both. Restores the id Record Service needs.
const line = $('Current Line').first().json;
const dec = $('Service Decision').first().json;
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
  service_id: dec.service_id,
  patch_summary: dec.service_patch_summary || '',
  patch_error: (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '',
} }];
