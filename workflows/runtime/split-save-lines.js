// Turn the portal's save payload into one item per line for the update node.
const body = $input.first().json.body || $input.first().json;
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
  } }))
  .filter((i) => i.json.subscription_id);
