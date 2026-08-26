// Shape the Autotask Companies/query response for the portal's mapper.
const resp = $input.first().json || {};
const items = resp.items || [];
return [{ json: {
  companies: items.slice(0, 25).map((c) => ({ id: c.id, name: c.companyName || '' })),
  error: resp.error ? String(resp.error.message || resp.error) : undefined,
} }];
