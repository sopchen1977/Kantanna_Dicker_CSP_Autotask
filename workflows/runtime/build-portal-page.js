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

// What Autotask has already approved & posted, per contract service. A
// BillingItem exists only once a charge has been through Approve & Post, so
// the newest itemDate for a contract service is its last posting; several
// rows can share that date (a cycle charge plus its pro-rata adjustments),
// so they are summed. invoiceID is 0 until the posting reaches an invoice.
let billing = [];
try {
  billing = ($('Fetch Billing Items').first().json.items) || [];
} catch (e) { /* Autotask unreachable - the stored value stands */ }
let invoices = [];
try {
  invoices = ($('Fetch Invoices').first().json.items) || [];
} catch (e) { /* no invoices to resolve */ }

const invoiceById = {};
for (const v of invoices) invoiceById[String(v.id)] = v;

function itemAmount(b) {
  const t = b.totalAmount !== undefined && b.totalAmount !== null ? Number(b.totalAmount)
    : (b.extendedPrice !== undefined && b.extendedPrice !== null ? Number(b.extendedPrice) : NaN);
  return isNaN(t) ? 0 : t;
}

const postedByCs = {};
for (const b of billing) {
  if (b.contractServiceID === undefined || b.contractServiceID === null) continue;
  const date = String(b.itemDate || '').slice(0, 10);
  if (!date) continue;
  const key = String(b.contractServiceID);
  let e = postedByCs[key];
  if (!e || date > e.date) {
    e = { date: date, amount: 0, qty: 0, rows: 0, posted_on: '', invoice_id: 0 };
    postedByCs[key] = e;
  }
  if (date !== e.date) continue;
  e.amount = Math.round((e.amount + itemAmount(b)) * 100) / 100;
  e.qty += Number(b.quantity || 0);
  e.rows += 1;
  const on = String(b.postedOnTime || b.postedDate || '').slice(0, 10);
  if (on > e.posted_on) e.posted_on = on;
  if (Number(b.invoiceID) > 0) e.invoice_id = Number(b.invoiceID);
}

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

  // The last Approve & Post for this service, and the invoice it landed on.
  const post = postedByCs[String(l.autotask_contract_service_id)];
  if (post) {
    out.billing_last = post.date + ' · $' + post.amount.toFixed(2)
      + (post.invoice_id ? ' · invoiced' : ' · posted');
    out.billing_last_date = post.date;
    out.billing_last_amount = post.amount;
    out.billing_last_qty = post.qty;
    out.billing_last_rows = post.rows;
    out.billing_last_posted_on = post.posted_on;
    const inv = post.invoice_id ? invoiceById[String(post.invoice_id)] : null;
    out.billing_last_invoice_id = post.invoice_id || '';
    out.billing_last_invoice_number = inv && inv.invoiceNumber != null ? String(inv.invoiceNumber) : '';
    out.billing_last_invoice_date = inv ? String(inv.invoiceDateTime || '').slice(0, 10) : '';
  }
  return out;
});

const payload = { lines: lines, mappings: mappings };
const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
const html = $('Portal Template').first().json.html
  .replace('__DATA_PLACEHOLDER__', encoded);
return [{ json: { html: html } }];
