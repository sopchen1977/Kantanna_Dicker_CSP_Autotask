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

// Did a query actually ANSWER, or did it fail? Everything below turns on
// that difference. An empty result means "nothing there", which is a fact
// worth acting on; a failed request means "we do not know", and treating the
// second as the first is how a page tells you a live contract is about to be
// created. Same rule the sync's decisions follow.
const MAX_RECORDS = 500;
function queryItems(name) {
  try {
    const j = $(name).first().json;
    if (!j || j.error || !Array.isArray(j.items)) return null;
    return j.items;
  } catch (e) { return null; }
}
// Stronger than "did it answer": did it answer in FULL. Every query asks for
// at most MAX_RECORDS, so a result sitting on that cap may have been cut off,
// and a row missing from a truncated list has not been shown to be absent.
// Nothing is invalidated on a list that might not be the whole list.
function complete(items) {
  return items !== null && items.length < MAX_RECORDS ? items : null;
}

// Overlay what Autotask holds right now. Anything edited directly in
// Autotask therefore shows on a plain page refresh, without waiting for a
// sync. If the query failed the overlay is simply empty.
const liveServices = queryItems('Fetch Live Services');
const live = liveServices || [];

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
// BillingItem exists only once a charge has been through Approve & Post.
// invoiceID is 0 until the posting reaches an invoice.
const billing = queryItems('Fetch Billing Items') || [];
const invoices = queryItems('Fetch Invoices') || [];

// Which of the contracts and services we hold ids for are still THERE. null
// means the question could not be asked, and nothing is invalidated on the
// strength of a failed request.
const liveContracts = complete(queryItems('Fetch Live Contracts'));
const liveServiceDefs = complete(queryItems('Fetch Live Service Defs'));
const knownServices = complete(liveServices);
const contractIds = liveContracts && new Set(liveContracts.map((c) => String(c.id)));
const serviceIds = liveServiceDefs && new Set(liveServiceDefs.map((c) => String(c.id)));

const invoiceById = {};
for (const v of invoices) invoiceById[String(v.id)] = v;

function itemAmount(b) {
  const t = b.totalAmount !== undefined && b.totalAmount !== null ? Number(b.totalAmount)
    : (b.extendedPrice !== undefined && b.extendedPrice !== null ? Number(b.extendedPrice) : NaN);
  return isNaN(t) ? 0 : t;
}

// Autotask bills a contract service one PERIOD at a time and dates the item
// at the period start - but it can raise a SECOND item inside the same
// period for a mid-cycle change, dated the day the seats moved (Kantanna's
// Copilot Business line has one on 18 Jun beside the 1 Jun cycle charge).
// Grouping on contractServicePeriodID keeps a period's rows together, so the
// last posting is the last PERIOD and its totals - not whichever single row
// happens to carry the newest date, which for a mid-cycle adjustment would
// read as a period starting halfway through the month.
const periods = {};
for (const b of billing) {
  if (b.contractServiceID === undefined || b.contractServiceID === null) continue;
  const date = String(b.itemDate || '').slice(0, 10);
  if (!date) continue;
  const key = String(b.contractServiceID);
  // No period id (an ad-hoc charge) means the row stands on its own.
  const pk = b.contractServicePeriodID !== undefined && b.contractServicePeriodID !== null
    ? 'p' + b.contractServicePeriodID : 'd' + date;
  const byPeriod = periods[key] || (periods[key] = {});
  const e = byPeriod[pk] || (byPeriod[pk] =
    { date: date, amount: 0, qty: 0, rows: 0, posted_on: '', invoice_id: 0 });
  // A period starts at its earliest item; a later row is a change within it.
  if (date < e.date) e.date = date;
  e.amount = Math.round((e.amount + itemAmount(b)) * 100) / 100;
  e.qty += Number(b.quantity || 0);
  e.rows += 1;
  const on = String(b.postedOnTime || b.postedDate || '').slice(0, 10);
  if (on > e.posted_on) e.posted_on = on;
  if (Number(b.invoiceID) > 0) e.invoice_id = Number(b.invoiceID);
}
const postedByCs = {};
for (const key of Object.keys(periods)) {
  let best = null;
  for (const pk of Object.keys(periods[key])) {
    const g = periods[key][pk];
    if (!best || g.date > best.date) best = g;
  }
  if (best) postedByCs[key] = best;
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

// Bring the stored plan back into line with what Autotask actually holds.
//
// The plan_* columns are written by workflow 04, which runs at the end of an
// import and behind Check Autotask - not on a page load, because it is four
// queries A LINE and takes minutes. So between runs the world moves: delete a
// contract in Autotask and the page went on reporting the plan made against
// it, which is worse than reporting nothing.
//
// This does not re-plan. It only draws the conclusions that follow with
// certainty from a thing no longer existing - exactly the ones 04 draws from
// an empty query - and clears the detail it cannot honestly restore.
lines = lines.map((l) => {
  const out = Object.assign({}, l);
  const hadContract = out.autotask_contract_id;
  const hadService = out.autotask_service_id;

  // The service is a separate record from the contract: deleting a contract
  // does not delete the service, and vice versa. They are checked apart.
  if (serviceIds && hadService && !serviceIds.has(String(hadService))) {
    out.autotask_service_id = '';
    out.plan_service_action = 'create';
  }

  // No contract means no contract service either - it lived on the contract -
  // and no units, because a service that is about to be added starts at zero.
  const contractGone = contractIds && hadContract && !contractIds.has(String(hadContract));
  // The contract may still stand while the service was taken off it. Only
  // conclude that from a ContractServices query that actually answered.
  const csGone = !contractGone && knownServices && out.autotask_contract_service_id
    && !knownServices.some((c) => String(c.id) === String(out.autotask_contract_service_id));

  if (contractGone || csGone) {
    if (contractGone) {
      out.autotask_contract_id = '';
      out.plan_contract_action = 'create';
      out.plan_contract_end = '';
    }
    out.autotask_contract_service_id = '';
    out.plan_cs_action = 'create';
    out.contract_price = '';
    out.contract_invoice_description = '';
    out.plan_current_units = 0;
    // The dated adjustments were worked out against a unit history that is
    // gone. What replaces them is units-decision's job, not this file's, so
    // they are cleared rather than guessed - the chip still says the service
    // will be added, and Check Autotask fills the dates back in.
    out.plan_units = '[]';
    out.plan_units_summary = '';
    // Nothing has been approved & posted against a contract that no longer
    // exists, so neither may the page claim it.
    out.billing_last = '';
    out.billing_last_date = '';
    out.billing_last_amount = '';
    out.billing_last_qty = '';
    out.billing_last_rows = '';
    out.billing_last_posted_on = '';
    out.billing_last_invoice_id = '';
    out.billing_last_invoice_number = '';
    out.billing_last_invoice_date = '';
    out.sync_status = 'pending';
    out.sync_message = contractGone
      ? 'The contract this line was synced to no longer exists in Autotask.'
      : 'This service is no longer on its Autotask contract.';
    out.plan_summary = (out.plan_service_action === 'create' ? 'create service; ' : '')
      + (contractGone ? 'create contract; ' : '') + 'add to contract';
  }
  return out;
});

const payload = { lines: lines, mappings: mappings };
const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
const html = $('Portal Template').first().json.html
  .replace('__DATA_PLACEHOLDER__', encoded);
return [{ json: { html: html } }];
