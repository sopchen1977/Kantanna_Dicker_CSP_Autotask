// One JSON response item for the portal after saving prices.
let updated = 0;
try { updated = $('Update Line Pricing').all().filter((i) => i.json.id).length; } catch (e) {}
return [{ json: { ok: true, updated: updated } }];
