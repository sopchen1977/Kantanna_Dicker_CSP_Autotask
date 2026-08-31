// Turn the portal's save payload into one item per line for the update node.
// Read the request off the webhook by name, not off whatever happens to be
// the previous node - the access gate now sits between the two.
const req = $('Save Pricing').first().json;
const body = req.body || req;
const lines = body.lines || [];
if (!lines.length) throw new Error('Save payload contained no lines.');
function isoDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
}
return lines
  .map((l) => ({ json: {
    subscription_id: String(l.subscription_id || ''),
    stock_code: String(l.stock_code || ''),
    use_custom_price: !!l.use_custom_price,
    sell_price: (l.sell_price === null || l.sell_price === undefined || l.sell_price === '')
      ? null : Number(l.sell_price),
    include: l.include !== false,
    price_effective_date: isoDate(l.price_effective_date),
    // Empty string means "no override" - the generated default is used.
    invoice_description: String(l.invoice_description || '').trim().slice(0, 100),
  } }))
  .filter((i) => i.json.subscription_id);
