// Input: the Autotask Contracts/query response holding every CSP contract
// this customer has. Work out which one this line belongs to, and what (if
// anything) has to be patched on it before the services are synced.
//
// IDENTITY IS THE EXTERNAL CONTRACT NUMBER, NOT THE NAME. Autotask's
// contractNumber field carries a reference this automation generates from
// the co-term group (see prepare-lines.js), so contract names are free to be
// reworded - by us or by hand in Autotask - without the next import losing
// track of a contract that has already been approved, posted and invoiced.
const line = $('Current Line').first().json;
const resp = $input.first().json || {};
const items = resp.items || [];

function autotaskError(r) {
  const d = r.details || {};
  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');
  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');
  if (d.description) return String(d.description);
  if (r.error) return String(r.error.message || JSON.stringify(r.error));
  return 'unknown';
}

const queryError = (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '';

const wantedRef = String(line.contract_number || '').trim();
const wantedName = String(line.contract_name || '').trim();
const legacyName = String(line.contract_name_legacy || '').trim();
const ref = (c) => String(c.contractNumber || '').trim();
const name = (c) => String(c.contractName || '').trim();

let found = wantedRef ? items.find((c) => ref(c) === wantedRef) || null : null;
let matchedBy = found ? 'number' : '';

// Contracts created before the reference existed carry only their name. Match
// one of those ONCE, by the name this line would have been given then, and
// only if it is not already claimed by a different reference. The patch below
// stamps the reference on, so this fallback never fires for it again.
if (!found) {
  const candidates = [wantedName, legacyName].filter((n) => n);
  for (const n of candidates) {
    found = items.find((c) => name(c) === n && !ref(c)) || null;
    if (found) { matchedBy = 'name'; break; }
  }
}

const neededEnd = String(line.contract_end || '');
const foundEnd = found ? String(found.endDate || '').slice(0, 10) : '';
// An existing contract whose endDate predates this import's term end makes
// Autotask reject every adjustment dated after it, so it has to be extended.
const needDateFix = !!(found && neededEnd && foundEnd && foundEnd < neededEnd);

const patch = { id: found ? found.id : null };
const patchNotes = [];
if (found) {
  if (needDateFix) {
    patch.endDate = neededEnd;
    patchNotes.push('end date ' + foundEnd + ' -> ' + neededEnd);
  }
  if (matchedBy === 'name') {
    patch.contractNumber = wantedRef;
    patchNotes.push('reference ' + wantedRef);
    // Adopting a contract is the one moment its name is ours to correct.
    // After that the name belongs to whoever is looking at Autotask.
    if (wantedName && name(found) !== wantedName) {
      patch.contractName = wantedName;
      patchNotes.push('renamed to "' + wantedName + '"');
    }
  }
}

return [{ json: {
  line_key: line.line_key,
  contract_id: found ? found.id : null,
  // A failed lookup must never look like "no contract exists" - that would
  // create a second contract beside the real one.
  need_contract: !found && !queryError,
  need_contract_patch: patchNotes.length > 0,
  contract_patch: patch,
  contract_patch_summary: patchNotes.join('; '),
  contract_matched_by: matchedBy,
  contract_number: wantedRef,
  contract_end_needed: neededEnd,
  contract_end_found: foundEnd,
  query_error: queryError,
} }];
