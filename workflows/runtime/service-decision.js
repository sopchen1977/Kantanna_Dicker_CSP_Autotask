// Input: Autotask Services/query response. Decide whether the service exists.
const line = $('Current Line').first().json;
const resp = $input.first().json || {};
const items = resp.items || [];
const found = items.length ? items[0] : null;
return [{ json: {
  line_key: line.line_key,
  service_id: found ? found.id : null,
  need_service: !found,
  query_error: resp.error ? String(resp.error.message || resp.error) : '',
} }];
