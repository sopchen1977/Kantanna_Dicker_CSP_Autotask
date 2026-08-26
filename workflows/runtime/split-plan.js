// One item per planned unit adjustment, in chronological order. The
// downstream HTTP node posts them one at a time (batched, oldest first) so
// Autotask builds the quantity history exactly as the CSP report shows it.
const dec = $input.first().json;
return (dec.plan || []).map((p) => ({ json: {
  line_key: dec.line_key,
  contract_id: dec.contract_id,
  service_id: dec.service_id,
  cs_id: dec.cs_id,
  sell: dec.sell,
  change: p.change,
  date: p.date,
} }));
