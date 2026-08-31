// Keep the two uploaded tabs exactly as they arrived, so the portal can show
// the source behind every number without anybody reopening the workbooks.
//
// The extract nodes read the sheets with headerRow: true over a fixed range,
// so each item is already one sheet row keyed by its column heading, with the
// cell text UNPARSED - "$144.64", "275.00", "02-MAR-2025", an invoice number
// still carrying its leading spaces. That is the point: this is the file, not
// our reading of it. Parse Subscription Lines does the interpreting (and any
// customer filtering); this snapshot keeps every row of both tabs regardless.
//
// One row per sheet row, the whole row as JSON in `data` so the tab can gain
// or lose a column without a schema change. row_no preserves sheet order.
const names = $('Normalize Uploads').first().json || {};
const importedAt = new Date().toISOString();

function rowsOf(nodeName) {
  try { return $(nodeName).all().map((i) => i.json); } catch (e) { return []; }
}

const sheets = [
  { sheet: 'annuity', node: 'Extract Annuity Details', file: names.annuity_name || '' },
  { sheet: 'invoice', node: 'Extract Invoice Details', file: names.invoice_name || '' }
];

const out = [];
for (const s of sheets) {
  const rows = rowsOf(s.node);
  rows.forEach((r, i) => {
    out.push({ json: {
      sheet: s.sheet,
      row_no: i + 1,
      data: JSON.stringify(r),
      source_file: s.file,
      imported_at: importedAt
    } });
  });
}
// No rows means nothing downstream runs, which is what we want: the previous
// snapshot has already been cleared, so the viewer honestly shows an empty tab.
return out;
