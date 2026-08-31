// Hand the rendered portal its session token.
//
// The page got here through a top-level navigation, so the browser sent the
// session cookie and the gate let it through. Its own background calls are a
// different matter: n8n Cloud serves every webhook response under
// Content-Security-Policy: sandbox with no allow-same-origin, which puts the
// page in an opaque origin. From there a fetch() back to our own host counts
// as third-party and carries no cookies at all.
//
// So the token is injected into the page and fetch is wrapped to attach it,
// which the gate accepts as an alternative to the cookie. Done here rather
// than inside portal.html so the page stays a plain document that knows
// nothing about sessions, and the whole scheme sits in one file.
const html = $input.first().json.html;

let token = '';
try { token = String($('Check Access Portal').first().json.token || ''); } catch (e) { /* none */ }
if (!token) return [{ json: { html: html } }];

const shim =
  '<script>(function () {\n' +
  '  var T = ' + JSON.stringify(token) + ';\n' +
  '  var real = window.fetch;\n' +
  '  window.fetch = function (url, opts) {\n' +
  '    if (typeof url === "string" && url.indexOf("/csp-") >= 0) {\n' +
  '      url += (url.indexOf("?") < 0 ? "?" : "&") + "t=" + encodeURIComponent(T);\n' +
  '    }\n' +
  '    return real(url, opts);\n' +
  '  };\n' +
  '})();<\/script>';

return [{ json: { html: html.replace('</head>', shim + '</head>') } }];
