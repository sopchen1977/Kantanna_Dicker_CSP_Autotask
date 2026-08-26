// Identify the two uploaded workbooks by file name and expose them under
// canonical binary keys used by the extract nodes, regardless of what the
// form trigger called the binary properties.
const item = $input.first();
const binaries = item.binary || {};
const out = { json: {}, binary: {} };

for (const key of Object.keys(binaries)) {
  const name = String(binaries[key].fileName || '').toLowerCase();
  if (name.includes('annuity')) {
    out.binary.annuity_file = binaries[key];
  } else if (name.includes('invoice') || name.includes('csp')) {
    out.binary.invoice_file = binaries[key];
  }
}

if (!out.binary.annuity_file) {
  throw new Error('No uploaded file has "Annuity" in its name. Upload the Annuity Information export.');
}
if (!out.binary.invoice_file) {
  throw new Error('No uploaded file has "Invoice" or "CSP" in its name. Upload the CSP Invoice Report.');
}

out.json.annuity_name = out.binary.annuity_file.fileName || 'annuity.xlsx';
out.json.invoice_name = out.binary.invoice_file.fileName || 'invoice.xlsx';
return [out];
