// Input: one Autotask service-adjustment response per planned change.
const line = $('Current Line').first().json;
const all = $input.all();
const errors = [];
let ok = 0;
for (const i of all) {
  const r = i.json || {};
  if (r.itemId) {
    ok++;
  } else {
    errors.push(String(
      (r.error && (r.error.message || JSON.stringify(r.error))) ||
      (r.errors ? JSON.stringify(r.errors) : 'unknown')
    ).slice(0, 150));
  }
}
return [{ json: {
  line_key: line.line_key,
  adjust_ok_count: ok,
  adjust_error: errors.join('; ').slice(0, 300),
} }];
