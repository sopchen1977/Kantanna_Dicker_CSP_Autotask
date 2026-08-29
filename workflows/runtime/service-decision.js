// Input: Autotask Services/query response. Decide whether the service exists,
// and whether the name it carries needs bringing up to date.
//
// IDENTITY IS THE SERVICE'S SKU, NOT ITS NAME - the same lesson the contract
// learned. Every service this automation creates carries its service key
// (ANN-MO:CFQ7TTC0LCHC:001J) in Autotask's `sku` field, so the product name
// in the service NAME can be corrected without the next sync failing to find
// the service and standing a duplicate up beside it.
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

const wantedKey = String(line.service_key || '').trim();
const wantedName = String(line.service_name || '').trim();
const suffix = String(line.service_name_suffix || '');
const legacySuffix = String(line.service_name_suffix_legacy || '');
const sku = (s) => String(s.sku || '').trim();
const name = (s) => String(s.name || '').trim();

let found = wantedKey ? items.find((s) => sku(s) === wantedKey) || null : null;
let matchedBy = found ? 'sku' : '';

// A service created before the key was written to `sku` carries only its
// name. Match one of those by the name it was given, and the patch below
// stamps the key on, so this fallback never fires for it again.
if (!found && wantedName) {
  found = items.find((s) => name(s) === wantedName && !sku(s)) || null;
  if (found) matchedBy = 'name';
}

const currentName = found ? name(found) : '';
// Only a name this automation wrote is ours to rewrite. Every generated name
// ends in " - {billing type}", or " - {billing type} [{SKU}]" for the ones
// written before the SKU was dropped from the name; a name typed by hand in
// Autotask ends in neither, and is left exactly as its author left it.
const endsWith = (sfx) => !!sfx && currentName.endsWith(sfx);
const generatedName = endsWith(suffix) || endsWith(legacySuffix);

const patch = { id: found ? found.id : null };
const patchNotes = [];
if (found) {
  if (matchedBy === 'name' && wantedKey) {
    patch.sku = wantedKey;
    patchNotes.push('key ' + wantedKey);
  }
  if (wantedName && currentName !== wantedName && generatedName) {
    patch.name = wantedName;
    patchNotes.push('renamed to "' + wantedName + '"');
  }
}

return [{ json: {
  line_key: line.line_key,
  service_id: found ? found.id : null,
  // A failed lookup must never look like "no service exists" - that would
  // create a second service beside the real one.
  need_service: !found && !queryError,
  need_service_patch: patchNotes.length > 0,
  service_patch: patch,
  service_patch_summary: patchNotes.join('; '),
  service_matched_by: matchedBy,
  service_name_found: currentName,
  query_error: queryError,
} }];
