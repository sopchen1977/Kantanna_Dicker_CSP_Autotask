import { workflow, node, trigger, sticky, newCredential, expr } from '@n8n/workflow-sdk';

const portalPage = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Portal Page',
    position: [-380, -240],
    parameters: { httpMethod: 'GET', path: 'csp-pricing', responseMode: 'responseNode', options: { ignoreBots: true } }
  },
  output: [{ headers: {}, params: {}, query: {}, body: {} }]
});

const fetchLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Lines',
    position: [-140, -240],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'FDGqV46wAYu9bnGe', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', offer_name: 'Microsoft 365 Business Premium', qty: 275, monthly_cost: 28.19, monthly_rrp: 34.55, sync_status: 'pending' }]
});

const fetchMappings = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Mappings',
    position: [100, -240],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'U7ymd9nAyD0GCLYb', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', autotask_company_id: 123, autotask_company_name: 'Atlas Outsourcing' }]
});

const buildPage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Portal Page',
    position: [340, -240],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Serve the pricing portal: inject subscription lines + customer mappings\n// into the static HTML template as base64 JSON.\nlet lines = [];\nlet mappings = [];\ntry {\n  lines = $('Fetch Lines').all().map((i) => i.json).filter((j) => j.subscription_id);\n} catch (e) { /* table empty */ }\ntry {\n  mappings = $('Fetch Mappings').all().map((i) => i.json).filter((j) => j.tenant_name);\n} catch (e) { /* table empty */ }\n\nconst payload = { lines: lines, mappings: mappings };\nconst encoded = Buffer.from(JSON.stringify(payload)).toString('base64');\nconst html = \"<!DOCTYPE html>\\n<html lang=\\\"en\\\">\\n<head>\\n<meta charset=\\\"UTF-8\\\">\\n<meta name=\\\"viewport\\\" content=\\\"width=device-width, initial-scale=1.0\\\">\\n<title>Kantanna CSP Pricing Portal</title>\\n<style>\\n  :root {\\n    --bg:#f4f6f9; --card:#fff; --ink:#182233; --muted:#6b7686; --line:#e3e8ef;\\n    --brand:#0b5fff; --ok:#15803d; --warn:#b45309; --err:#b91c1c;\\n  }\\n  * { box-sizing:border-box; }\\n  body { margin:0; font-family:-apple-system,\\\"Segoe UI\\\",Roboto,Arial,sans-serif; background:var(--bg); color:var(--ink); }\\n  header { background:#10233f; color:#fff; padding:14px 24px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; }\\n  header h1 { font-size:17px; margin:0; flex:1; }\\n  .wrap { max-width:1280px; margin:0 auto; padding:20px 24px 60px; }\\n  .customer { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:22px; overflow:hidden; }\\n  .customer > .head { padding:12px 16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; border-bottom:1px solid var(--line); background:#f8fafc; }\\n  .customer h2 { font-size:15px; margin:0; }\\n  table { width:100%; border-collapse:collapse; font-size:13.5px; }\\n  th,td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; }\\n  th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); background:#fbfcfe; }\\n  tr:last-child td { border-bottom:none; }\\n  .num { text-align:right; }\\n  .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:var(--muted); }\\n  .badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11px; background:var(--line); }\\n  .badge.synced { background:#dcfce7; color:var(--ok); }\\n  .badge.pending { background:#e0e7ff; color:#3730a3; }\\n  .badge.needs_mapping,.badge.partial { background:#fef3c7; color:var(--warn); }\\n  .badge.error { background:#fee2e2; color:var(--err); }\\n  .badge.unmapped { background:#fee2e2; color:var(--err); }\\n  input[type=number] { width:92px; padding:4px 6px; border:1px solid var(--line); border-radius:6px; font:inherit; text-align:right; }\\n  input[type=number]:disabled { background:#f1f5f9; color:var(--muted); }\\n  input[type=text] { padding:6px 8px; border:1px solid var(--line); border-radius:6px; font:inherit; width:260px; }\\n  input[type=date] { padding:4px 6px; border:1px solid var(--line); border-radius:6px; font:inherit; width:135px; }\\n  input[type=date]:disabled { background:#f1f5f9; color:var(--muted); }\\n  .btn { padding:8px 16px; border-radius:7px; border:1px solid var(--line); background:#fff; cursor:pointer; font:inherit; font-size:13.5px; }\\n  .btn.primary { background:var(--brand); border-color:var(--brand); color:#fff; }\\n  .btn.sync { background:#15803d; border-color:#15803d; color:#fff; }\\n  .btn:disabled { opacity:.5; cursor:default; }\\n  .toolbar { position:sticky; top:0; z-index:10; background:var(--bg); padding:12px 0; display:flex; gap:10px; align-items:center; }\\n  .toolbar .msg { color:var(--muted); font-size:13px; }\\n  .map-box { position:relative; }\\n  .map-results { position:absolute; top:100%; left:0; width:320px; background:#fff; border:1px solid var(--line); border-radius:6px; box-shadow:0 6px 16px rgba(0,0,0,.12); z-index:20; max-height:240px; overflow:auto; }\\n  .map-results div { padding:7px 10px; cursor:pointer; font-size:13px; }\\n  .map-results div:hover { background:#eef2f7; }\\n  .margin-pos { color:var(--ok); }\\n  .margin-neg { color:var(--err); }\\n  .muted { color:var(--muted); }\\n  .small { font-size:11.5px; }\\n</style>\\n</head>\\n<body>\\n<header>\\n  <h1>Kantanna &middot; Dicker CSP &rarr; Autotask Pricing Portal</h1>\\n  <span id=\\\"meta\\\" class=\\\"small\\\" style=\\\"color:#cdd9ee\\\"></span>\\n</header>\\n<div class=\\\"wrap\\\">\\n  <div class=\\\"toolbar\\\">\\n    <button class=\\\"btn primary\\\" onclick=\\\"saveAll(this)\\\">Save prices</button>\\n    <button class=\\\"btn sync\\\" onclick=\\\"syncNow(this)\\\">Sync to Autotask</button>\\n    <button class=\\\"btn\\\" onclick=\\\"location.reload()\\\">Refresh</button>\\n    <span class=\\\"msg\\\" id=\\\"msg\\\"></span>\\n  </div>\\n  <div id=\\\"app\\\"></div>\\n</div>\\n\\n<script id=\\\"__data\\\" type=\\\"application/json\\\">__DATA_PLACEHOLDER__</script>\\n<script>\\nvar BASE = location.pathname.replace(/\\\\/csp-pricing.*$/, '');\\nvar DATA = JSON.parse(atob(document.getElementById('__data').textContent));\\nvar LINES = DATA.lines || [];\\nvar MAPPINGS = {};\\n(DATA.mappings || []).forEach(function (m) { MAPPINGS[(m.tenant_name || '').toLowerCase()] = m; });\\n\\nfunction fmt(n) { return (Number(n) || 0).toFixed(2); }\\nfunction periodRrp(l) { return Number(l.period_rrp !== null && l.period_rrp !== undefined ? l.period_rrp : l.monthly_rrp) || 0; }\\nfunction periodCost(l) { return Number(l.period_cost !== null && l.period_cost !== undefined ? l.period_cost : l.monthly_cost) || 0; }\\nfunction periodSuffix(l) { return l.billing_months === 12 ? '/yr' : '/mo'; }\\nfunction billingLabel(l) {\\n  if (l.billing_type === 'annual_upfront') return 'Annual \\u00b7 Upfront';\\n  if (l.billing_type === 'annual_monthly') return 'Annual \\u00b7 Monthly';\\n  if (l.billing_type === 'usage') return 'Usage';\\n  return 'Month to Month';\\n}\\nfunction effSell(l) {\\n  return (l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined && l.sell_price !== '')\\n    ? Number(l.sell_price) : periodRrp(l);\\n}\\nfunction effInclude(l) {\\n  if (l.include === false) return false;\\n  if (l.include === true) return true;\\n  // $0 lines (e.g. Teams Phone Resource accounts) are included too and\\n  // simply sync at a $0 sell price.\\n  return l.charge_type === 'NCE' && l.status === 'Active';\\n}\\nfunction addMonthsIso(iso, months) {\\n  var d = new Date(iso + 'T00:00:00Z');\\n  if (isNaN(d.getTime())) return '';\\n  d.setUTCMonth(d.getUTCMonth() + months);\\n  return d.toISOString().slice(0, 10);\\n}\\n// Same contract-window derivation as the sync (Prepare Lines): term dates\\n// from the invoice report, falling back to the revaluation period, then\\n// usage start + term length.\\nfunction contractWindow(l) {\\n  var ok = function (v) { return /^\\\\d{4}-\\\\d{2}-\\\\d{2}$/.test(String(v || '')) ? String(v) : ''; };\\n  var start = ok(l.term_start);\\n  var end = ok(l.term_end) || ok(l.revaluation_period);\\n  if (!start && end) start = addMonthsIso(end, -(l.term_months || 12));\\n  if (!start) start = ok(l.usage_start);\\n  if (!end && start) end = addMonthsIso(start, l.term_months || 12);\\n  return { start: start, end: end };\\n}\\nfunction marginPct(l) {\\n  var s = effSell(l), c = periodCost(l);\\n  if (!s) return null;\\n  return ((s - c) / s) * 100;\\n}\\n\\nfunction render() {\\n  var byCustomer = {};\\n  LINES.forEach(function (l) { (byCustomer[l.tenant_name] = byCustomer[l.tenant_name] || []).push(l); });\\n  var names = Object.keys(byCustomer).sort();\\n  var app = document.getElementById('app');\\n  app.innerHTML = '';\\n  document.getElementById('meta').textContent = LINES.length + ' subscription lines \\u00b7 ' +\\n    names.length + ' customers' + (LINES[0] && LINES[0].imported_at ? ' \\u00b7 imported ' + String(LINES[0].imported_at).slice(0, 10) : '');\\n\\n  if (!names.length) {\\n    app.innerHTML = '<p class=\\\"muted\\\">No subscription lines yet. Run the \\\"01 \\u00b7 Annuity Import\\\" workflow form first.</p>';\\n    return;\\n  }\\n\\n  names.forEach(function (name) {\\n    var mapping = MAPPINGS[name.toLowerCase()];\\n    var card = document.createElement('div');\\n    card.className = 'customer';\\n\\n    var head = document.createElement('div');\\n    head.className = 'head';\\n    var h2 = document.createElement('h2');\\n    h2.textContent = name;\\n    head.appendChild(h2);\\n\\n    if (mapping) {\\n      var ok = document.createElement('span');\\n      ok.className = 'badge synced';\\n      ok.textContent = 'Autotask: ' + mapping.autotask_company_name + ' (#' + mapping.autotask_company_id + ')';\\n      head.appendChild(ok);\\n    } else {\\n      var bad = document.createElement('span');\\n      bad.className = 'badge unmapped';\\n      bad.textContent = 'not mapped';\\n      head.appendChild(bad);\\n      head.appendChild(buildMapper(name));\\n    }\\n    card.appendChild(head);\\n\\n    var table = document.createElement('table');\\n    table.innerHTML = '<thead><tr><th>Incl.</th><th>Offer</th><th>Billing</th><th>Subscription ID</th>' +\\n      '<th title=\\\"Contract/subscription term (current billing period for month-to-month)\\\">Start</th>' +\\n      '<th title=\\\"Contract/subscription term (current billing period for month-to-month)\\\">End</th>' +\\n      '<th class=\\\"num\\\">Qty</th><th class=\\\"num\\\">Cost</th><th class=\\\"num\\\">RRP</th>' +\\n      '<th>Custom</th><th class=\\\"num\\\">Sell</th><th title=\\\"Date the price change takes effect in Autotask\\\">From</th><th class=\\\"num\\\">Margin</th><th>Status</th></tr></thead>';\\n    var tbody = document.createElement('tbody');\\n    byCustomer[name].forEach(function (l) { tbody.appendChild(buildRow(l)); });\\n    table.appendChild(tbody);\\n    card.appendChild(table);\\n    app.appendChild(card);\\n  });\\n}\\n\\nfunction buildRow(l) {\\n  var tr = document.createElement('tr');\\n\\n  var incl = document.createElement('input');\\n  incl.type = 'checkbox';\\n  incl.checked = effInclude(l);\\n  incl.onchange = function () { l.include = incl.checked; l._dirty = true; };\\n  tr.appendChild(td(incl));\\n\\n  var offer = document.createElement('td');\\n  offer.innerHTML = escapeHtml(l.offer_name || '') +\\n    ' <span class=\\\"mono\\\">' + escapeHtml(l.sku || '') + '</span>';\\n  tr.appendChild(offer);\\n\\n  var billing = document.createElement('td');\\n  billing.innerHTML = '<span class=\\\"badge\\\">' + escapeHtml(billingLabel(l)) + '</span>';\\n  tr.appendChild(billing);\\n\\n  var sid = document.createElement('td');\\n  sid.innerHTML = '<span class=\\\"mono\\\" title=\\\"' + escapeHtml(l.subscription_id) + '\\\">' + escapeHtml(String(l.subscription_id).slice(0, 8)) + '\\u2026</span>';\\n  tr.appendChild(sid);\\n\\n  var win = contractWindow(l);\\n  var tdStart = document.createElement('td');\\n  tdStart.innerHTML = win.start ? '<span class=\\\"mono\\\">' + escapeHtml(win.start) + '</span>' : '<span class=\\\"muted\\\">\\u2014</span>';\\n  tr.appendChild(tdStart);\\n  var tdEnd = document.createElement('td');\\n  tdEnd.innerHTML = win.end ? '<span class=\\\"mono\\\">' + escapeHtml(win.end) + '</span>' : '<span class=\\\"muted\\\">\\u2014</span>';\\n  tr.appendChild(tdEnd);\\n\\n  tr.appendChild(tdText(l.qty, 'num'));\\n  tr.appendChild(tdText(fmt(periodCost(l)) + periodSuffix(l), 'num'));\\n  tr.appendChild(tdText(fmt(periodRrp(l)) + periodSuffix(l), 'num'));\\n\\n  var custom = document.createElement('input');\\n  custom.type = 'checkbox';\\n  custom.checked = !!l.use_custom_price;\\n  tr.appendChild(td(custom));\\n\\n  var sell = document.createElement('input');\\n  sell.type = 'number'; sell.step = '0.01'; sell.min = '0';\\n  sell.value = fmt(effSell(l));\\n  sell.disabled = !l.use_custom_price;\\n  sell.title = 'Sell price per billing period (' + periodSuffix(l).slice(1) + ')';\\n  tr.appendChild(td(sell, 'num'));\\n\\n  var effDate = document.createElement('input');\\n  effDate.type = 'date';\\n  effDate.value = /^\\\\d{4}-\\\\d{2}-\\\\d{2}$/.test(l.price_effective_date || '') ? l.price_effective_date : new Date().toISOString().slice(0, 10);\\n  effDate.title = 'Price/unit changes take effect in Autotask from this date';\\n  effDate.onchange = function () { l.price_effective_date = effDate.value; l._dirty = true; };\\n  l.price_effective_date = effDate.value;\\n  tr.appendChild(td(effDate));\\n\\n  var margin = document.createElement('td');\\n  margin.className = 'num';\\n  tr.appendChild(margin);\\n\\n  function refreshMargin() {\\n    var m = marginPct(l);\\n    margin.innerHTML = m === null ? '<span class=\\\"muted\\\">\\u2014</span>'\\n      : '<span class=\\\"' + (m >= 0 ? 'margin-pos' : 'margin-neg') + '\\\">' + m.toFixed(1) + '%</span>';\\n  }\\n  refreshMargin();\\n\\n  custom.onchange = function () {\\n    l.use_custom_price = custom.checked; l._dirty = true;\\n    if (!custom.checked) { l.sell_price = null; sell.value = fmt(periodRrp(l)); sell.disabled = true; }\\n    else { sell.disabled = false; l.sell_price = Number(sell.value); sell.focus(); }\\n    refreshMargin();\\n  };\\n  sell.onchange = function () { l.sell_price = Number(sell.value); l._dirty = true; refreshMargin(); };\\n\\n  var status = document.createElement('td');\\n  var badge = '<span class=\\\"badge ' + escapeHtml(l.sync_status || 'pending') + '\\\">' + escapeHtml(l.sync_status || 'pending') + '</span>';\\n  var extra = '';\\n  if (l.autotask_contract_id) extra += '<div class=\\\"mono small\\\">Contract #' + l.autotask_contract_id + '</div>';\\n  if (l.sync_message) extra += '<div class=\\\"muted small\\\">' + escapeHtml(String(l.sync_message).slice(0, 120)) + '</div>';\\n  status.innerHTML = badge + extra;\\n  tr.appendChild(status);\\n\\n  return tr;\\n}\\n\\nfunction buildMapper(tenantName) {\\n  var box = document.createElement('span');\\n  box.className = 'map-box';\\n  var input = document.createElement('input');\\n  input.type = 'text';\\n  input.placeholder = 'Search Autotask companies\\u2026';\\n  var results = document.createElement('div');\\n  results.className = 'map-results';\\n  results.style.display = 'none';\\n  box.appendChild(input); box.appendChild(results);\\n\\n  var timer;\\n  input.oninput = function () {\\n    clearTimeout(timer);\\n    var q = input.value.trim();\\n    if (q.length < 2) { results.style.display = 'none'; return; }\\n    timer = setTimeout(function () {\\n      fetch(BASE + '/csp-pricing-companies?q=' + encodeURIComponent(q))\\n        .then(function (r) { return r.json(); })\\n        .then(function (list) {\\n          results.innerHTML = '';\\n          (list.companies || []).forEach(function (c) {\\n            var el = document.createElement('div');\\n            el.textContent = c.name + ' (#' + c.id + ')';\\n            el.onclick = function () { saveMapping(tenantName, c); };\\n            results.appendChild(el);\\n          });\\n          if (!(list.companies || []).length) results.innerHTML = '<div class=\\\"muted\\\">No matches</div>';\\n          results.style.display = 'block';\\n        })\\n        .catch(function (e) { results.innerHTML = '<div class=\\\"muted\\\">' + escapeHtml(e.message) + '</div>'; results.style.display = 'block'; });\\n    }, 350);\\n  };\\n  return box;\\n}\\n\\nfunction saveMapping(tenantName, company) {\\n  fetch(BASE + '/csp-pricing-mapping', {\\n    method: 'POST', headers: { 'Content-Type': 'application/json' },\\n    body: JSON.stringify({ tenant_name: tenantName, autotask_company_id: company.id, autotask_company_name: company.name })\\n  }).then(function () { location.reload(); });\\n}\\n\\nfunction saveAll(btn) {\\n  btn.disabled = true;\\n  var payload = LINES.map(function (l) {\\n    return {\\n      subscription_id: l.subscription_id, stock_code: l.stock_code,\\n      use_custom_price: !!l.use_custom_price,\\n      sell_price: l.use_custom_price ? Number(l.sell_price !== null && l.sell_price !== undefined ? l.sell_price : periodRrp(l)) : null,\\n      include: effInclude(l),\\n      price_effective_date: l.price_effective_date || ''\\n    };\\n  });\\n  fetch(BASE + '/csp-pricing-save', {\\n    method: 'POST', headers: { 'Content-Type': 'application/json' },\\n    body: JSON.stringify({ lines: payload })\\n  }).then(function (r) { return r.json(); })\\n    .then(function (res) { setMsg('Saved ' + (res.updated || 0) + ' lines.'); btn.disabled = false; })\\n    .catch(function (e) { setMsg('Save failed: ' + e.message); btn.disabled = false; });\\n}\\n\\nfunction syncNow(btn) {\\n  if (!confirm('Save prices first if you changed anything.\\\\n\\\\nPush included lines to Autotask now? Contracts and services will be created/updated.')) return;\\n  btn.disabled = true;\\n  fetch(BASE + '/csp-autotask-sync', { method: 'POST' })\\n    .then(function () { setMsg('Sync started. Refresh in a minute to see per-line results.'); btn.disabled = false; })\\n    .catch(function (e) { setMsg('Could not start sync: ' + e.message); btn.disabled = false; });\\n}\\n\\nfunction setMsg(t) { document.getElementById('msg').textContent = t; }\\nfunction td(child, cls) { var c = document.createElement('td'); if (cls) c.className = cls; c.appendChild(child); return c; }\\nfunction tdText(t, cls) { var c = document.createElement('td'); if (cls) c.className = cls; c.textContent = t; return c; }\\nfunction escapeHtml(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }\\n\\nrender();\\n</script>\\n</body>\\n</html>\\n\".replace('__DATA_PLACEHOLDER__', encoded);\nreturn [{ json: { html: html } }];\n" }
  },
  output: [{ html: '<!DOCTYPE html>...' }]
});

const respondPage = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Portal Page',
    position: [580, -240],
    parameters: {
      respondWith: 'text',
      responseBody: expr('{{ $json.html }}'),
      options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } }
    }
  }
});

const savePricing = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Save Pricing',
    position: [-380, 0],
    parameters: { httpMethod: 'POST', path: 'csp-pricing-save', responseMode: 'responseNode', options: {} }
  },
  output: [{ body: { lines: [{ subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', use_custom_price: true, sell_price: 33, include: true }] } }]
});

const splitSaved = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Split Saved Lines',
    position: [-140, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Turn the portal's save payload into one item per line for the update node.\nconst body = $input.first().json.body || $input.first().json;\nconst lines = body.lines || [];\nif (!lines.length) throw new Error('Save payload contained no lines.');\nfunction isoDate(v) {\n  return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(v || '')) ? String(v) : '';\n}\nreturn lines\n  .map((l) => ({ json: {\n    subscription_id: String(l.subscription_id || ''),\n    stock_code: String(l.stock_code || ''),\n    use_custom_price: !!l.use_custom_price,\n    sell_price: (l.sell_price === null || l.sell_price === undefined || l.sell_price === '')\n      ? null : Number(l.sell_price),\n    include: l.include !== false,\n    price_effective_date: isoDate(l.price_effective_date),\n  } }))\n  .filter((i) => i.json.subscription_id);\n" }
  },
  output: [{ subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', use_custom_price: true, sell_price: 33, include: true }]
});

const updatePricing = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Update Line Pricing',
    position: [100, 0],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: 'FDGqV46wAYu9bnGe', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'subscription_id', condition: 'eq', keyValue: expr('{{ $json.subscription_id }}') },
          { keyName: 'stock_code', condition: 'eq', keyValue: expr('{{ $json.stock_code }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          use_custom_price: expr('{{ $json.use_custom_price }}'),
          sell_price: expr('{{ $json.sell_price }}'),
          include: expr('{{ $json.include }}'),
          price_effective_date: expr('{{ $json.price_effective_date }}')
        },
        schema: [
          { id: 'use_custom_price', displayName: 'use_custom_price', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: false },
          { id: 'sell_price', displayName: 'sell_price', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'include', displayName: 'include', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: false },
          { id: 'price_effective_date', displayName: 'price_effective_date', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, subscription_id: '2F295B21', sell_price: 33 }]
});

const saveSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Save Summary',
    position: [340, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// One JSON response item for the portal after saving prices.\nlet updated = 0;\ntry { updated = $('Update Line Pricing').all().filter((i) => i.json.id).length; } catch (e) {}\nreturn [{ json: { ok: true, updated: updated } }];\n" }
  },
  output: [{ ok: true, updated: 12 }]
});

const respondSave = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Save', position: [580, 0], parameters: { respondWith: 'firstIncomingItem', options: {} } }
});

const saveMapping = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Save Mapping',
    position: [-380, 240],
    parameters: { httpMethod: 'POST', path: 'csp-pricing-mapping', responseMode: 'responseNode', options: {} }
  },
  output: [{ body: { tenant_name: 'Galilee Solicitors', autotask_company_id: 456, autotask_company_name: 'Galilee Solicitors Pty Ltd' } }]
});

const upsertMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Upsert Mapping',
    position: [-140, 240],
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: 'U7ymd9nAyD0GCLYb', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'tenant_name', condition: 'eq', keyValue: expr('{{ $json.body.tenant_name }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          tenant_name: expr('{{ $json.body.tenant_name }}'),
          autotask_company_id: expr('{{ $json.body.autotask_company_id }}'),
          autotask_company_name: expr('{{ $json.body.autotask_company_name }}')
        },
        schema: [
          { id: 'tenant_name', displayName: 'tenant_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'autotask_company_id', displayName: 'autotask_company_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_company_name', displayName: 'autotask_company_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, tenant_name: 'Galilee Solicitors', autotask_company_id: 456 }]
});

const respondMapping = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Mapping', position: [100, 240], parameters: { respondWith: 'firstIncomingItem', options: {} } }
});

const companySearch = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Company Search',
    position: [-380, 480],
    parameters: { httpMethod: 'GET', path: 'csp-pricing-companies', responseMode: 'responseNode', options: {} }
  },
  output: [{ query: { q: 'galilee' } }]
});

const portalConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Portal Autotask Config',
    position: [-140, 480],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'cfg-base-url', name: 'base_url', type: 'string', value: 'https://webservices31.autotask.net/atservicesrest/v1.0' }
        ]
      }
    }
  },
  output: [{ base_url: 'https://webservices31.autotask.net/atservicesrest/v1.0', query: { q: 'galilee' } }]
});

const queryCompanies = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Query Companies',
    position: [100, 480],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr('{{ $json.base_url }}/Companies/query'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 25, Filter: [{ op: "contains", field: "companyName", value: $("Company Search").first().json.query.q || "" }, { op: "eq", field: "isActive", value: true }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [{ id: 456, companyName: 'Galilee Solicitors Pty Ltd' }], pageDetails: { count: 1 } }]
});

const companiesResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Companies Response',
    position: [340, 480],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Shape the Autotask Companies/query response for the portal's mapper.\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nreturn [{ json: {\n  companies: items.slice(0, 25).map((c) => ({ id: c.id, name: c.companyName || '' })),\n  error: resp.error ? String(resp.error.message || resp.error) : undefined,\n} }];\n" }
  },
  output: [{ companies: [{ id: 456, name: 'Galilee Solicitors Pty Ltd' }] }]
});

const respondCompanies = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond Companies', position: [580, 480], parameters: { respondWith: 'firstIncomingItem', options: {} } }
});

const importRedirect = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Import Redirect',
    position: [-380, 720],
    parameters: { httpMethod: 'GET', path: 'csp-import', responseMode: 'responseNode', options: {} }
  },
  output: [{ headers: {}, query: {} }]
});

const redirectToForm = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Redirect To Form',
    position: [-140, 720],
    parameters: {
      respondWith: 'redirect',
      redirectURL: 'https://gayleai.app.n8n.cloud/form/5c4bd81e-8556-4639-835f-4de4a7faefb3',
      options: {}
    }
  }
});

const notePortal = sticky(
  '## 02 · Pricing Portal\nOpen GET /webhook/csp-pricing in a browser.\n- Sell price defaults to the monthly RRP from the annuity file; tick Custom to override per line.\n- Map each Dicker tenant to an Autotask company before syncing.\n- The Sync button POSTs to workflow 03 (path csp-autotask-sync).\n\nSet your Autotask zone URL in "Portal Autotask Config".',
  [portalPage, fetchLines],
  { color: 5 }
);

export default workflow('kantanna-csp-02-portal', '02 · CSP Pricing Portal')
  .add(portalPage)
  .to(fetchLines)
  .to(fetchMappings)
  .to(buildPage)
  .to(respondPage)
  .add(savePricing)
  .to(splitSaved)
  .to(updatePricing)
  .to(saveSummary)
  .to(respondSave)
  .add(saveMapping)
  .to(upsertMapping)
  .to(respondMapping)
  .add(companySearch)
  .to(portalConfig)
  .to(queryCompanies)
  .to(companiesResponse)
  .to(respondCompanies)
  .add(importRedirect)
  .to(redirectToForm)
  .add(notePortal);
