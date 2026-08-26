// Input: Autotask create-service response ({ itemId }) or an error payload.
const line = $('Current Line').first().json;
const resp = $input.first().json || {};
return [{ json: {
  line_key: line.line_key,
  service_id: resp.itemId || null,
  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)
    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),
} }];
