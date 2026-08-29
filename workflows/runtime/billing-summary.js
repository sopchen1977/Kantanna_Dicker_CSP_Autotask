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
// The contract is shared by every subscription that co-terms to the same
// anniversary, so its billing items cover the whole group. Keep only the
// ones belonging to THIS line's contract service.
const csId = ud.cs_id !== undefined && ud.cs_id !== null ? Number(ud.cs_id) : null;
const svcId = ud.service_id !== undefined && ud.service_id !== null ? Number(ud.service_id) : null;
const items = (resp.items || []).filter((b) => {
  if (csId !== null && b.contractServiceID !== undefined && b.contractServiceID !== null) {
    return Number(b.contractServiceID) === csId;
  }
  if (svcId !== null && b.serviceID !== undefined && b.serviceID !== null) {
    return Number(b.serviceID) === svcId;
  }
  return true;
});

function iso(v) { return String(v || '').slice(0, 10); }
function addMonths(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function amount(b) {
  const t = b.totalAmount !== undefined && b.totalAmount !== null ? Number(b.totalAmount)
    : (b.extendedPrice !== undefined && b.extendedPrice !== null ? Number(b.extendedPrice)
      : Number(b.quantity || 0) * Number(b.rate || 0));
  return isNaN(t) ? 0 : t;
}

// Autotask bills one PERIOD at a time and dates the item at the period
// start, but can raise a second item inside the same period for a mid-cycle
// change, dated the day it changed. Group on contractServicePeriodID so the
// last posting is the last period and its total - taking the newest single
// row instead would report a period that appears to start mid-month, and
// the portal reads this date to decide what is already billed.
const periods = {};
for (const b of items) {
  const d = iso(b.itemDate || b.postedOnDate || b.postedDate);
  if (!d) continue;
  const pk = b.contractServicePeriodID !== undefined && b.contractServicePeriodID !== null
    ? 'p' + b.contractServicePeriodID : 'd' + d;
  const e = periods[pk] || (periods[pk] = { date: d, total: 0, invoiced: false });
  if (d < e.date) e.date = d;
  e.total += amount(b);
  if (b.invoiceID) e.invoiced = true;
}
let lastDate = '';
let lastTotal = 0;
let lastInvoiced = false;
for (const pk of Object.keys(periods)) {
  const e = periods[pk];
  if (e.date > lastDate) { lastDate = e.date; lastTotal = e.total; lastInvoiced = e.invoiced; }
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
