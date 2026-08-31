// Gate, part two: decide whether the row the query found is a live session.
//
// The query already filtered on the token hash; expiry is checked here so
// that an expired row can never authorise anything, however it was matched.
// Returns a plain verdict - the caller branches on `authed` and nothing else.
const wanted = String($('Read Cookie').first().json.token_hash || '');
const nowIso = new Date().toISOString();

let hit = null;
for (const item of $input.all()) {
  const r = item.json;
  if (!r || !r.token_hash) continue;
  if (String(r.token_hash) !== wanted) continue;
  if (String(r.expires_at || '') <= nowIso) continue;
  hit = r;
  break;
}

return [{ json: {
  authed: !!hit,
  email: hit ? String(hit.email || '') : '',
  expires_at: hit ? String(hit.expires_at || '') : '',
  // Echoed back only when the session is real, so the portal can hand it to
  // its own background calls - they cannot send the cookie from inside n8n
  // Cloud's sandbox.
  token: hit ? String($('Read Cookie').first().json.token || '') : ''
} }];
