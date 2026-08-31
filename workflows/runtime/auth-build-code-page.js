// Render the "enter your code" page. It is served in two situations: after a
// code has been requested, and after a wrong code has been handed back - the
// second just carries a different message, so there is one page, not two.
//
// This exists because sign-in is a sequence of real form POSTs rather than
// fetch() calls: n8n Cloud sandboxes webhook responses into an opaque origin
// where cookies cannot be stored, and only a top-level navigation gets to set
// one. Server-rendered steps are the price of that.
function grab(name) {
  try { return $(name).first().json; } catch (e) { return null; }
}
// Only one of these exists per execution: the request chain and the verify
// chain have different triggers.
const asked = grab('Prepare Code');
const checked = grab('Check Code');
const src = checked
  ? { email: checked.email, next: checked.next, message: checked.message, kind: 'bad' }
  : { email: asked.email, next: asked.next, message: asked.message, kind: 'ok' };

const tmpl = $('Sign-in Code Template').first().json.html;

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// `next` comes from the browser, and it ends up in a Location header and an
// href, so it is never trusted. Only our own routes are allowed: no scheme,
// no host, no protocol-relative "//evil", no traversal. Anything else falls
// back to the portal.
function safeNext(v) {
  const s = String(v || '').trim();
  return /^csp-[a-z-]+(\?[A-Za-z0-9=&%._-]*)?$/.test(s) ? s : 'csp-pricing';
}

const html = tmpl
  .replace(/__EMAIL__/g, esc(src.email))
  .replace(/__NEXT__/g, esc(safeNext(src.next)))
  .replace(/__KIND__/g, src.kind === 'bad' ? 'bad' : 'ok')
  .replace(/__MESSAGE__/g, esc(src.message));

return [{ json: { html: html } }];
