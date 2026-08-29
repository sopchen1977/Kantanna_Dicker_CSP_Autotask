// Render one uploaded tab exactly as it arrived: the original column headings
// in the original order, every cell as the text the sheet held. No parsing, no
// reformatting, no filtering to the pilot customers - this page exists to be
// checked against the workbook, so anything we "helpfully" tidied would defeat
// it. Cells keep their whitespace (Dicker pads INVOICE NUMBER with spaces).
const q = ($('Report View').first().json.query) || {};
const want = String(q.sheet || 'annuity').toLowerCase() === 'invoice' ? 'invoice' : 'annuity';
const TITLES = {
  annuity: { tab: 'DETAILS', file: 'Annuity Information', other: 'invoice', otherName: 'CSP Invoice Report' },
  invoice: { tab: 'Invoice Details', file: 'CSP Invoice Report', other: 'annuity', otherName: 'Annuity Information' }
};
const t = TITLES[want];

let stored = [];
try {
  stored = $('Fetch Report Rows').all().map((i) => i.json).filter((r) => r && r.sheet === want);
} catch (e) { /* table empty or unreachable */ }
stored.sort((a, b) => Number(a.row_no || 0) - Number(b.row_no || 0));

const rows = [];
for (const r of stored) {
  try { rows.push(JSON.parse(r.data || '{}')); } catch (e) { /* skip a corrupt row */ }
}
const sourceFile = (stored[0] && stored[0].source_file) || '';
const importedAt = String((stored[0] && stored[0].imported_at) || '').slice(0, 10);

// Column order is the sheet's own: first row wins, later rows can only add.
// (A tab that gains a column between months therefore shows it on the right
// rather than silently dropping it.)
const cols = [];
for (const r of rows) for (const k of Object.keys(r)) if (cols.indexOf(k) < 0) cols.push(k);

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Right-align a column only when every value in it reads as a number or money,
// which is how the sheet itself presents them.
const numeric = cols.map((c) => {
  let seen = 0;
  for (const r of rows) {
    const v = String(r[c] === null || r[c] === undefined ? '' : r[c]).trim();
    if (!v) continue;
    if (!/^-?\$?-?[\d,]+(\.\d+)?%?$/.test(v)) return false;
    seen++;
  }
  return seen > 0;
});

const head = '<tr><th class="rn">#</th>' +
  cols.map((c, i) => '<th' + (numeric[i] ? ' class="num"' : '') + '>' + esc(c) + '</th>').join('') +
  '</tr>';
const body = rows.map((r, n) =>
  '<tr><td class="rn">' + (n + 1) + '</td>' +
  cols.map((c, i) => '<td' + (numeric[i] ? ' class="num"' : '') + '>' + esc(r[c]) + '</td>').join('') +
  '</tr>').join('');

// The snapshot is taken at import, so an empty table means no upload has run
// since this viewer existed - not that the tab was empty. Say which, and say
// what to do about it, rather than showing a bare grid with no columns.
const provenance = rows.length
  ? esc(sourceFile) + ' &middot; imported ' + esc(importedAt) +
    ' &middot; ' + rows.length + (rows.length === 1 ? ' row, ' : ' rows, ') +
    cols.length + (cols.length === 1 ? ' column' : ' columns') +
    ' &middot; exactly as uploaded'
  : 'Nothing captured yet';
const empty = rows.length ? '' :
  '<div class="empty"><strong>No upload captured yet</strong>' +
  'This page shows the ' + esc(t.file) + ' ' + esc(t.tab) +
  ' tab exactly as it arrived, and it is filled in when a workbook is ' +
  'imported. Run the <a href="../form/csp-monthly-upload">monthly upload</a> ' +
  'once — re-uploading the same two files is safe, it refreshes the Dicker ' +
  'figures and leaves your prices, invoice wording and approvals alone.</div>';

const html = $('Report Template').first().json.html
  .replace(/__TAB__/g, esc(t.tab))
  .replace(/__FILE__/g, esc(t.file))
  .replace(/__PROVENANCE__/g, provenance)
  .replace(/__OTHER__/g, t.other)
  .replace(/__OTHERNAME__/g, esc(t.otherName))
  .replace('__EMPTY__', empty)
  .replace('__THEAD__', head)
  .replace('__TBODY__', body);
return [{ json: { html: html } }];
