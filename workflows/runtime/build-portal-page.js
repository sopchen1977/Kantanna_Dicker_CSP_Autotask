// Serve the pricing portal: inject subscription lines + customer mappings
// into the page from the Portal Template node, as base64 JSON.
let lines = [];
let mappings = [];
try {
  lines = $('Fetch Lines').all().map((i) => i.json).filter((j) => j.subscription_id);
} catch (e) { /* table empty */ }
try {
  mappings = $('Fetch Mappings').all().map((i) => i.json).filter((j) => j.tenant_name);
} catch (e) { /* table empty */ }

// Overlay what Autotask holds right now. Anything edited directly in
// Autotask therefore shows on a plain page refresh, without waiting for a
// sync. If the query failed the overlay is simply empty.
let live = [];
try {
  live = ($('Fetch Live Services').first().json.items) || [];
} catch (e) { /* Autotask unreachable - fall back to the stored values */ }

// Same conversion as the sync's CS Decision: the query returns only the
// internal-currency price, scaled by this instance's currency factor, which
// is internalCurrencyUnitPrice / unitPrice.
function livePrice(c) {
  if (c.adjustedPrice !== undefined && c.adjustedPrice !== null) return Number(c.adjustedPrice);
  if (Number(c.internalCurrencyAdjustedPrice) === 0) return 0;
  const mult = Number(c.internalCurrencyUnitPrice) / Number(c.unitPrice);
  if (c.internalCurrencyAdjustedPrice !== undefined && c.internalCurrencyAdjustedPrice !== null
      && isFinite(mult) && mult > 0) {
    return Math.round((Number(c.internalCurrencyAdjustedPrice) / mult) * 100) / 100;
  }
  return null;
}

const byCsId = {};
for (const c of live) byCsId[String(c.id)] = c;

lines = lines.map((l) => {
  const c = byCsId[String(l.autotask_contract_service_id)];
  if (!c) return l;
  const out = Object.assign({}, l);
  if (c.invoiceDescription !== undefined && c.invoiceDescription !== null) {
    const liveDesc = String(c.invoiceDescription);
    const syncedDesc = String(l.contract_invoice_description || '');
    // Autotask is the source of truth. If the description there no longer
    // matches what the last sync pushed, someone edited it by hand, so the
    // stored portal override is stale and is dropped: the page shows what
    // Autotask actually holds. An override that has not been pushed yet
    // (Autotask still matches what we last sent) survives untouched.
    if (syncedDesc && liveDesc !== syncedDesc) out.invoice_description = '';
    out.contract_invoice_description = liveDesc;
  }
  const p = livePrice(c);
  if (p !== null) out.contract_price = p;
  return out;
});

const payload = { lines: lines, mappings: mappings };
const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
const html = $('Portal Template').first().json.html
  .replace('__DATA_PLACEHOLDER__', encoded);
return [{ json: { html: html } }];
