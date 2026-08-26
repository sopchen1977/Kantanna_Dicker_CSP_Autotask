// Serve the pricing portal: inject subscription lines + customer mappings
// into the static HTML template as base64 JSON.
let lines = [];
let mappings = [];
try {
  lines = $('Fetch Lines').all().map((i) => i.json).filter((j) => j.subscription_id);
} catch (e) { /* table empty */ }
try {
  mappings = $('Fetch Mappings').all().map((i) => i.json).filter((j) => j.tenant_name);
} catch (e) { /* table empty */ }

const payload = { lines: lines, mappings: mappings };
const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
const html = __PORTAL_HTML__.replace('__DATA_PLACEHOLDER__', encoded);
return [{ json: { html: html } }];
