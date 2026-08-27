// Input: Autotask BillingItems/query response for this line's contract.
// BillingItems only exist once a charge has been APPROVED & POSTED in
// Autotask, so: the latest item date = what was last posted, and the next
// approve-and-post charge is estimated as one billing period later (or the
// current billing cycle when nothing has been posted yet) at qty x sell.
// Passes the Units Decision fields through for the downstream nodes.
const line = $('Current Line').first().json;

function grab(name) {
  try {
    const j = $(name).first().json;
    return j.line_key === line.line_key ? j : null;
  } catch (e) { return null; }
}
const ud = grab('Units Decision') || {};

const resp = $input.first().json || {};
const items = resp.items || [];

function iso(v) { return String(v || '').slice(0, 10); }
function addMonths(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
function amount(b) {
  const t = b.totalAmount !== undefined && b.totalAmount !== null ? Number(b.totalAmount)
    : (b.extendedPrice !== undefined && b.extendedPrice !== null ? Number(b.extendedPrice)
      : Number(b.quantity || 0) * Number(b.rate || 0));
  return isNaN(t) ? 0 : t;
}

// Latest posted period = max item date; several items can share that date
// (pro-rata rows), so sum them and note whether any is already invoiced.
let lastDate = '';
let lastTotal = 0;
let lastInvoiced = false;
for (const b of items) {
  const d = iso(b.itemDate || b.postedOnDate || b.postedDate);
  if (!d) continue;
  if (d > lastDate) { lastDate = d; lastTotal = 0; lastInvoiced = false; }
  if (d === lastDate) { lastTotal += amount(b); if (b.invoiceID) lastInvoiced = true; }
}

const qty = Number(line.qty || 0);
const sell = Number(line.effective_sell || 0);
const periodMonths = Number(line.billing_months || 1) === 12 ? 12 : 1;
const nextDate = lastDate ? addMonths(lastDate, periodMonths)
  : (ud.cycle_start || line.contract_start || line.today || '');
const nextAmount = Math.round(qty * sell * 100) / 100;

const err = resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 120) : '';
return [{ json: Object.assign({}, ud, {
  line_key: line.line_key,
  billing_last: err ? 'billing lookup failed: ' + err
    : (lastDate ? lastDate + ' · $' + lastTotal.toFixed(2) + (lastInvoiced ? ' · invoiced' : ' · posted')
      : 'nothing posted yet'),
  billing_next: (nextDate || '?') + ' · $' + nextAmount.toFixed(2)
    + ' (' + qty + ' × ' + sell.toFixed(2) + (periodMonths === 12 ? '/yr' : '/mo') + ')',
}) }];
