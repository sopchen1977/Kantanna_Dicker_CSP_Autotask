// Input: Autotask create-service-adjustment response.
const line = $('Current Line').first().json;
const resp = $input.first().json || {};
return [{ json: {
  line_key: line.line_key,
  adjust_ok: !!resp.itemId,
  adjust_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)
    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),
} }];
