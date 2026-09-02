import { workflow, node, trigger, sticky, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

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

// The three Autotask queries below each cover every contract on screen in a
// single call, so they are executeOnce: without it they re-run for every item
// Fetch Mappings emits and the duplicate requests trip Autotask's limit of 3
// concurrent API threads (429).
//
// The portal shows what Autotask has RIGHT NOW, not what the last sync
// happened to record - so a description or price edited by hand in Autotask
// shows up on the next page load. One query covers every contract on screen
// (Autotask's `in` operator), and a failure here is non-fatal: the page still
// renders from the stored values.
const fetchLiveServices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Live Services',
    executeOnce: true,
    position: [340, -240],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://webservices31.autotask.net/atservicesrest/v1.0/ContractServices/query',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: (() => { const ids = [...new Set($("Fetch Lines").all().map((i) => i.json.autotask_contract_id).filter((v) => v))]; return ids.length ? [{ op: "in", field: "contractID", value: ids }] : [{ op: "eq", field: "id", value: 0 }]; })() }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// What Autotask has already approved & posted. A BillingItem only exists
// once a charge has been through Approve & Post, so the newest itemDate per
// contract service is that service's last posting, and its invoiceID says
// whether the posting has since been invoiced. One query covers every
// contract on screen; a failure here is non-fatal.
const fetchBillingItems = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Billing Items',
    executeOnce: true,
    position: [400, -240],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://webservices31.autotask.net/atservicesrest/v1.0/BillingItems/query',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: (() => { const ids = [...new Set($("Fetch Lines").all().map((i) => i.json.autotask_contract_id).filter((v) => v))]; return ids.length ? [{ op: "in", field: "contractID", value: ids }] : [{ op: "eq", field: "id", value: 0 }]; })() }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// The invoice each posting landed on. BillingItems carry only an invoiceID,
// and the number a customer actually quotes lives on the Invoice itself.
const fetchInvoices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Invoices',
    executeOnce: true,
    position: [430, -240],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://webservices31.autotask.net/atservicesrest/v1.0/Invoices/query',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: (() => { let bi = []; try { bi = $("Fetch Billing Items").first().json.items || []; } catch (e) {} const ids = [...new Set(bi.map((b) => Number(b.invoiceID)).filter((v) => v > 0))]; return ids.length ? [{ op: "in", field: "id", value: ids }] : [{ op: "eq", field: "id", value: 0 }]; })() }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// The page itself, held as a plain string on a Set node. Keeping it out of
// the Build Portal Page code node means the assembly logic can be changed
// without re-deploying 55KB of HTML, and the page carries no escaping layer.
// Generated from portal/portal.html at build time - edit that file.
const portalTemplate = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Portal Template',
    position: [460, -240],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [{ id: 'portal-html', name: 'html', type: 'string', value: "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Kantanna CSP Pricing Portal</title>\n<style>\n  :root {\n    --bg:#f1f4f8; --card:#fff; --ink:#0f172a; --ink2:#334155; --muted:#64748b;\n    --line:#e2e8f0; --line2:#eef2f7;\n    --brand:#2563eb; --ok:#047857; --okbg:#ecfdf5; --warn:#b45309; --warnbg:#fffbeb;\n    --err:#b91c1c; --errbg:#fef2f2; --violet:#6d28d9; --violetbg:#f5f3ff;\n    --shadow:0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.06);\n  }\n  * { box-sizing:border-box; }\n  html { -webkit-text-size-adjust:100%; }\n  body {\n    margin:0; background:var(--bg); color:var(--ink);\n    font:15px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;\n    font-variant-numeric:tabular-nums;\n  }\n  .num, td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }\n  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }\n  .muted { color:var(--muted); }\n\n  /* ---------- top bar ---------- */\n  .topbar {\n    position:sticky; top:0; z-index:40; background:#0d1b30; color:#fff;\n    display:flex; align-items:center; gap:20px; flex-wrap:wrap;\n    padding:11px 26px; box-shadow:0 1px 0 rgba(255,255,255,.06), 0 2px 12px rgba(13,27,48,.28);\n  }\n  .brand { display:flex; align-items:center; gap:12px; flex:1; min-width:260px; }\n  .logo {\n    width:34px; height:34px; border-radius:9px; background:#2563eb; color:#fff;\n    display:grid; place-items:center; font-size:12px; font-weight:700; letter-spacing:.06em;\n  }\n  .topbar h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }\n  .topbar p { margin:1px 0 0; font-size:12px; color:#9fb3d1; }\n  .topbar p a { color:#cfe0f7; text-decoration:none; border-bottom:1px solid rgba(207,224,247,.35); }\n  .topbar p a:hover { color:#fff; border-bottom-color:#fff; }\n  .actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }\n  .actions .msg { font-size:12.5px; color:#a9c4ea; max-width:340px; }\n\n  .btn {\n    padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:#fff;\n    color:var(--ink); cursor:pointer; font:inherit; font-size:13.5px; font-weight:500;\n    white-space:nowrap; transition:filter .12s, background .12s;\n  }\n  .btn:hover:not(:disabled) { filter:brightness(.97); }\n  .btn:disabled { opacity:.45; cursor:default; }\n  .btn.primary { background:var(--brand); border-color:var(--brand); color:#fff; }\n  .btn.go { background:#047857; border-color:#047857; color:#fff; }\n  .btn.ghost { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.22); color:#e7eefb; text-decoration:none; }\n  .btn.tiny { padding:4px 10px; font-size:12px; }\n  .btn.link { border:none; background:none; padding:0; color:var(--brand); font-size:12px; }\n  .btn.link:hover { text-decoration:underline; }\n\n  .wrap { max-width:1660px; margin:0 auto; padding:22px 22px 80px; }\n\n  /* ---------- stats ---------- */\n  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(178px,1fr)); gap:12px; margin-bottom:16px; }\n  .stat { background:var(--card); border:1px solid var(--line); border-radius:11px; padding:13px 15px; box-shadow:var(--shadow); }\n  .stat .k { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }\n  .stat .v { font-size:22px; font-weight:650; letter-spacing:-.02em; margin-top:3px; }\n  .stat .s { font-size:12px; color:var(--muted); margin-top:1px; }\n  .stat.due .v { color:var(--warn); }\n  .stat.attn .v { color:var(--err); }\n  .stat.clear .v { color:var(--ok); }\n\n  /* ---------- filter bar ---------- */\n  .filterbar {\n    position:sticky; top:57px; z-index:30; display:flex; align-items:center; gap:12px; flex-wrap:wrap;\n    background:var(--bg); padding:10px 0 12px; margin-bottom:2px;\n    box-shadow:0 12px 12px -12px rgba(15,23,42,.10);\n  }\n  .filterbar input[type=search] {\n    flex:1; min-width:220px; max-width:400px; padding:8px 12px; font:inherit; font-size:13.5px;\n    border:1px solid var(--line); border-radius:8px; background:#fff;\n  }\n  .filterbar input[type=search]:focus { outline:2px solid #bfdbfe; outline-offset:-1px; border-color:var(--brand); }\n  .chk { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--ink2); cursor:pointer; user-select:none; }\n  .spacer { flex:1; }\n\n  /* ---------- customer ---------- */\n  .customer { background:var(--card); border:1px solid var(--line); border-radius:13px; margin-bottom:18px; box-shadow:var(--shadow); overflow:hidden; }\n  .chead-cust {\n    display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:14px 18px;\n    border-bottom:1px solid var(--line); cursor:pointer;\n  }\n  .chead-cust:hover { background:#fafbfd; }\n  .chead-cust h2 { margin:0; font-size:16px; font-weight:650; letter-spacing:-.01em; }\n  .custsum { margin-left:auto; display:flex; align-items:center; gap:16px; font-size:12.5px; color:var(--muted); }\n  .custsum b { color:var(--ink); font-weight:600; }\n  /* Include/exclude every line of one customer at once. It lives in the\n     header, which is itself the collapse toggle, so it is boxed to read as\n     its own control rather than as part of the heading. */\n  .pickall {\n    display:inline-flex; align-items:center; gap:7px; flex:none; cursor:pointer;\n    font-size:12px; color:var(--muted); white-space:nowrap; user-select:none;\n    border:1px solid var(--line); border-radius:7px; padding:4px 9px; background:#fff;\n  }\n  .pickall:hover { border-color:var(--brand); color:var(--ink); background:#f8fafc; }\n  .pickall input { margin:0; cursor:pointer; }\n  .caret { width:16px; color:var(--muted); font-size:11px; transition:transform .15s; flex:none; }\n  .collapsed > .caret, .collapsed .caret { transform:rotate(-90deg); }\n  .customer.collapsed .cbody { display:none; }\n  .contract.collapsed .tablewrap { display:none; }\n\n  /* ---------- contract ---------- */\n  .contract { border-top:1px solid var(--line2); }\n  .contract:first-child { border-top:none; }\n  .chead {\n    display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:11px 18px;\n    background:#f8fafc; cursor:pointer;\n  }\n  .chead:hover { background:#f1f5f9; }\n  .ctitle { display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; min-width:0; }\n  .cpre { font-size:10.5px; font-weight:700; letter-spacing:.08em; color:#94a3b8; }\n  .cname { font-size:13.5px; font-weight:650; letter-spacing:-.01em; }\n  .cdates { font-size:12.5px; color:var(--muted); }\n  .cmeta { margin-left:auto; display:flex; align-items:center; gap:14px; font-size:12.5px; color:var(--muted); white-space:nowrap; }\n  .cmeta .cval { color:var(--ink); font-weight:600; }\n  .contract.usage .chead { background:#fbfcfd; }\n  .contract.usage .cname { color:var(--muted); font-weight:500; }\n\n  .atlink { color:var(--brand); text-decoration:none; font-weight:600; font-size:12.5px; white-space:nowrap; }\n  .atlink:hover { text-decoration:underline; }\n\n  /* ---------- table ---------- */\n  /* Every table shares one fixed column grid so the numbers line up all\n     the way down the page, across contracts and customers. */\n  .cbody { overflow-x:auto; }\n  .cinner { min-width:1180px; }\n  table { width:100%; border-collapse:collapse; table-layout:fixed; }\n  th {\n    font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);\n    text-align:left; padding:9px 12px 8px; background:#fff; border-bottom:1px solid var(--line);\n    white-space:nowrap;\n  }\n  th[title] { cursor:help; text-decoration:underline dotted #cbd5e1; text-underline-offset:3px; }\n  .colhead { background:#fff; border-bottom:1px solid var(--line); }\n  .colhead table { border-collapse:collapse; }\n  .colhead th { border-bottom:none; }\n  /* One line-height for every cell, so the first line of a service name, its\n     quantity, its prices and its chips all sit on the same baseline across the\n     row. The row divider is the full line colour because the rows are tall -\n     a service name, its term and its invoice wording stack up - and a hairline\n     gets lost over that distance. */\n  td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top;\n       font-size:13.5px; line-height:1.35; }\n  tr.line:last-child td, tr.detail:last-child td { border-bottom:none; }\n  tr.line:hover td { background:#fafcff; }\n  tr.line.off td { opacity:.5; }\n  tr.line.off:hover td { opacity:.75; }\n  td.pick { width:34px; padding-left:18px; padding-right:0; }\n  td.pick input { width:15px; height:15px; accent-color:var(--brand); cursor:pointer; }\n\n  .svc { font-weight:550; letter-spacing:-.005em; }\n  .svcsub { font-size:11.5px; color:var(--muted); margin-top:3px; display:flex; flex-wrap:wrap; gap:3px 10px; align-items:center; }\n  .dot { color:#cbd5e1; }\n\n  .badge {\n    display:inline-block; padding:1.5px 8px; border-radius:99px; font-size:11px; font-weight:600;\n    background:#eef2f7; color:var(--ink2); white-space:nowrap; line-height:1.5;\n  }\n  .badge.b-annual_monthly { background:#eff6ff; color:#1d4ed8; }\n  .badge.b-annual_upfront { background:#eef2ff; color:#4338ca; }\n  .badge.b-monthly { background:#f0fdfa; color:#0f766e; }\n  .badge.b-usage { background:#f1f5f9; color:var(--muted); }\n  .badge.coterm { background:var(--violetbg); color:var(--violet); cursor:help; }\n  .badge.synced { background:var(--okbg); color:var(--ok); }\n  .badge.pending { background:#eef2ff; color:#4338ca; }\n  .badge.needs_mapping, .badge.partial { background:var(--warnbg); color:var(--warn); }\n  .badge.error, .badge.unmapped { background:var(--errbg); color:var(--err); }\n  .badge.mapped { background:var(--okbg); color:var(--ok); }\n\n  .rate { font-weight:600; }\n  /* Every right-aligned column ends on ONE edge shared by its heading and its\n     content - that is what makes a table of numbers read as lined up. The unit\n     is part of the value and ends on that edge with everything else; it is a\n     fixed width so the digits in front of it still form their own straight\n     column, whether the row reads /mo or /yr. */\n  .per { display:inline-block; width:24px; text-align:right;\n    font-size:11px; color:var(--muted); font-weight:400; }\n  /* Margin is neutral when healthy so the exceptions are the only thing\n     that catches the eye. */\n  .marg { color:var(--ink2); }\n  .marg.thin { color:var(--warn); font-weight:650; }\n  .marg.neg { color:var(--err); font-weight:650; }\n  .ok-tick { color:#94a3b8; font-size:13px; cursor:help; }\n\n  /* ---------- sell cell ---------- */\n  td.sell { white-space:nowrap; }\n  .sellview { display:flex; align-items:center; justify-content:flex-end; }\n  .sellview .amt {\n    font:inherit; font-weight:650; font-variant-numeric:tabular-nums; border:none; background:none;\n    padding:0; cursor:pointer; color:var(--ink); border-bottom:1px dashed transparent; line-height:1.3;\n  }\n  .sellview .amt:hover { color:var(--brand); border-bottom-color:#93c5fd; }\n  .sellview .amt.custom { color:var(--brand); }\n  .editing .sellview { display:none; }\n  .selledit { display:none; }\n  .editing .selledit { display:block; }\n  .selledit input[type=number] {\n    width:100%; max-width:120px; padding:5px 7px; border:1px solid var(--brand); border-radius:7px; font:inherit;\n    font-size:13.5px; text-align:right; font-variant-numeric:tabular-nums;\n  }\n  .selledit input[type=date] { width:100%; max-width:140px; padding:4px 6px; border:1px solid var(--line); border-radius:7px; font:inherit; font-size:12px; margin-top:5px; }\n  .fromlbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-top:6px; }\n  .picks { font-size:11px; margin-top:3px; white-space:nowrap; }\n  .picks a { color:var(--brand); cursor:pointer; text-decoration:none; }\n  .picks a:hover { text-decoration:underline; }\n\n  /* ---------- invoice description ---------- */\n  .inv { margin-top:5px; font-size:11.5px; display:flex; align-items:baseline; gap:6px; min-width:0; }\n  .inv .lbl { color:#94a3b8; font-weight:600; text-transform:uppercase; letter-spacing:.04em; font-size:10px; flex:none; }\n  /* One line, ellipsised - the full text is in the tooltip and in the\n     editor, so a long description never changes the row height. */\n  .invtext {\n    font:inherit; font-size:11.5px; text-align:left; border:none; background:none; padding:0; cursor:pointer;\n    color:var(--ink2); border-bottom:1px dashed transparent; line-height:1.35;\n    min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;\n  }\n  .invtext:hover { color:var(--brand); border-bottom-color:#93c5fd; }\n  .invtext.custom { color:var(--brand); font-weight:600; }\n  .invtext.default { color:#94a3b8; font-style:italic; }\n  .invedit { display:none; gap:6px; align-items:center; margin-top:5px; flex-wrap:wrap; }\n  .inv-open .invedit { display:flex; }\n  .inv-open .inv { display:none; }\n  .invedit input[type=text] {\n    flex:1; min-width:220px; max-width:440px; padding:5px 8px; font:inherit; font-size:12.5px;\n    border:1px solid var(--brand); border-radius:7px;\n  }\n  .invedit .count { font-size:10.5px; color:var(--muted); }\n\n  /* ---------- billing pill + detail ---------- */\n  .pill {\n    display:inline-flex; align-items:center; gap:7px; padding:2px 9px 2px 7px; border-radius:8px;\n    font-size:12.5px; font-weight:600; line-height:1.25; border:1px solid transparent; cursor:pointer;\n    background:none; font-family:inherit; color:inherit; white-space:nowrap;\n  }\n  .pill .tick { font-size:9px; opacity:.85; }\n  .pill.due { background:var(--warnbg); border-color:#fde68a; color:var(--warn); }\n  .pill.clear { background:var(--okbg); border-color:#a7f3d0; color:var(--ok); }\n  .pill.none { background:#f8fafc; border-color:var(--line); color:var(--muted); font-weight:500; cursor:default; }\n  .pill.due:hover, .pill.clear:hover { filter:brightness(.97); }\n  .pill .n { font-weight:500; opacity:.85; font-size:11.5px; }\n  .billcell, .chgcell { display:flex; align-items:center; gap:5px; flex-wrap:wrap; min-height:18px; }\n  .itag {\n    display:inline-flex; align-items:center; padding:1px 7px; border-radius:6px; white-space:nowrap;\n    font-size:10px; font-weight:700; line-height:1.4; text-transform:uppercase; letter-spacing:.05em;\n    border:1px solid transparent; cursor:default;\n  }\n  .itag.yes { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }\n  .itag.no { background:#f8fafc; border-color:var(--line); color:var(--muted); font-weight:600; }\n  .itag.wait { background:var(--warnbg); border-color:#fde68a; color:var(--warn); }\n\n  /* The Approve & Post date range. Warm like the pill it sits beside, because\n     it is part of the same \"you have something to post\" story - and labelled,\n     so it is never mistaken for the contract term printed alongside it. */\n  .range {\n    display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:6px;\n    font-size:11.5px; font-weight:600; white-space:nowrap; cursor:help;\n    background:var(--warnbg); border:1px solid #fde68a; color:var(--warn);\n    font-variant-numeric:tabular-nums;\n  }\n  .range .rlbl { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; opacity:.72; }\n\n  /* Most lines repeat last cycle, so \"unchanged\" is plain muted text and only\n     the exceptions carry a chip - the same reason the margin column is neutral\n     when it is healthy. */\n  .chg {\n    display:inline-flex; align-items:center; padding:1px 7px; border-radius:6px; white-space:nowrap;\n    font-size:10px; font-weight:700; line-height:1.4; text-transform:uppercase; letter-spacing:.05em;\n    border:1px solid transparent; cursor:help;\n  }\n  .chg.new { background:#eef2ff; border-color:#c7d2fe; color:#4338ca; }\n  .chg.prorata { background:var(--violetbg); border-color:#ddd6fe; color:var(--violet); }\n  .chg.qty { background:var(--warnbg); border-color:#fde68a; color:var(--warn); }\n  .chg.same, .chg.none { font-size:12.5px; font-weight:400; text-transform:none; letter-spacing:0;\n    padding:0; border:none; color:var(--muted); }\n\n  /* What the sync WILL do, sitting directly under the service name: it leads\n     the row because it is the one thing on this screen you are being asked to\n     approve. Everything else on the row - the billing pill, the invoiced tag,\n     the last-posted drawer - is what has already happened. Sentence case and\n     a size up from the uppercase chips beside it, because it is a sentence\n     about the future rather than a label on a state. */\n  .planline { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin:3px 0 0; }\n  .plan {\n    display:inline-flex; align-items:center; padding:1px 7px; border-radius:6px; white-space:nowrap;\n    font-size:11.5px; font-weight:600; line-height:1.5; border:1px solid transparent; cursor:help;\n  }\n  .plan.do { background:#eef2ff; border-color:#c7d2fe; color:#4338ca; }\n  .plan.price { background:var(--violetbg); border-color:#ddd6fe; color:var(--violet); }\n  .plan.err { background:var(--errbg); border-color:#fecaca; color:var(--err); }\n  .plan.flat { background:none; border:none; padding:0; color:var(--muted); font-weight:400; }\n  .planline .sep { color:var(--muted); opacity:.55; font-size:11px; }\n\n  tr.detail { display:none; }\n  tr.detail.open { display:table-row; }\n  tr.detail td { padding:0 12px 13px 46px; border-bottom:1px solid var(--line2); background:#fcfdfe; }\n  .dpanel { border-left:2px solid var(--line); padding:2px 0 2px 14px; }\n  .dline { display:flex; align-items:baseline; gap:10px; font-size:12.5px; padding:3px 0; flex-wrap:wrap; }\n  .dline .when { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; color:var(--ink2); min-width:186px; }\n  .dline .amt { font-weight:600; margin-left:auto; }\n  .dtag { font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; padding:1px 6px; border-radius:5px; background:#eef2f7; color:var(--muted); }\n  .dtag.cycle { background:#eff6ff; color:#1d4ed8; }\n  .dtag.prorata { background:var(--violetbg); color:var(--violet); }\n  .dfoot { font-size:11.5px; color:var(--muted); margin-top:6px; }\n  .dsec { font-size:10px; text-transform:uppercase; letter-spacing:.06em; font-weight:700; color:#94a3b8; margin:9px 0 3px; }\n  .dsec:first-child { margin-top:0; }\n  .dline.posted .amt { color:var(--ok); }\n  .dnone { font-size:12.5px; color:var(--muted); padding:3px 0; }\n  .inv-no { font-weight:600; color:var(--ink2); }\n\n  /* ---------- mapper ---------- */\n  .map-box { position:relative; }\n  .map-box input { padding:6px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; font-size:13px; width:250px; }\n  .map-results { position:absolute; top:calc(100% + 4px); left:0; width:320px; background:#fff; border:1px solid var(--line); border-radius:9px; box-shadow:0 8px 24px rgba(15,23,42,.14); z-index:20; max-height:250px; overflow:auto; }\n  .map-results div { padding:8px 11px; cursor:pointer; font-size:13px; }\n  .map-results div:hover { background:#eff6ff; }\n\n  .empty { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:40px; text-align:center; color:var(--muted); }\n  @media (max-width:860px) {\n    .wrap { padding:16px 14px 60px; }\n    .custsum, .cmeta { margin-left:0; width:100%; }\n  }\n</style>\n</head>\n<body>\n<header class=\"topbar\">\n  <div class=\"brand\">\n    <span class=\"logo\">CSP</span>\n    <div>\n      <h1>Dicker Data &rarr; Autotask pricing</h1>\n      <p id=\"meta\"></p>\n    </div>\n  </div>\n  <div class=\"actions\">\n    <span class=\"msg\" id=\"msg\"></span>\n    <a class=\"btn ghost\" href=\"https://ww31.autotask.net/\" target=\"_blank\" rel=\"noopener\"\n       title=\"Approve &amp; Post lives under Contracts &gt; Approve &amp; Post\">Autotask &#8599;</a>\n    <button class=\"btn ghost\" onclick=\"location.reload()\">Refresh</button>\n    <button class=\"btn primary\" onclick=\"saveAll(this)\">Save prices</button>\n    <button class=\"btn ghost\" onclick=\"checkAutotask(this)\"\n      title=\"Read Autotask and work out what a sync would do, without doing any of it\">Check Autotask</button>\n    <button class=\"btn go\" onclick=\"syncNow(this)\">Sync to Autotask</button>\n  </div>\n</header>\n\n<div class=\"wrap\">\n  <section class=\"stats\" id=\"stats\"></section>\n  <div class=\"filterbar\">\n    <input id=\"q\" type=\"search\" placeholder=\"Filter by customer, product or SKU\u2026\" autocomplete=\"off\">\n    <label class=\"chk\"><input type=\"checkbox\" id=\"onlyDue\"> Awaiting posting only</label>\n    <label class=\"chk\"><input type=\"checkbox\" id=\"onlyOff\"> Include excluded lines</label>\n    <span class=\"spacer\"></span>\n    <button class=\"btn tiny\" onclick=\"setAll(true)\">Expand all</button>\n    <button class=\"btn tiny\" onclick=\"setAll(false)\">Collapse all</button>\n  </div>\n  <div id=\"app\"></div>\n</div>\n\n<script id=\"__data\" type=\"application/json\">__DATA_PLACEHOLDER__</script>\n<script>\nvar BASE = location.pathname.replace(/\\/csp-pricing.*$/, '');\n// Where the invoice numbers in the \"Last approved & posted\" drawer point.\n// Autotask's ExecuteCommand API has documented codes for opening a contract,\n// a ticket, a quote and half a dozen other things, but none for an invoice -\n// so this address is NOT from the API docs. It is what Autotask itself puts in\n// the address bar with an invoice open, which makes it undocumented and liable\n// to change under us. {id} is the invoice's INTERNAL id (7807), not the number\n// the customer sees on the invoice (4339); {number} is available too. Blank\n// this and the numbers render as plain text again, which is the whole\n// fallback: nothing guessed, nothing to break.\nvar INVOICE_URL = 'https://ww31.autotask.net/Mvc/Contracts/InvoiceViewer.mvc?invoiceId={id}';\nvar DATA = JSON.parse(atob(document.getElementById('__data').textContent));\nvar LINES = DATA.lines || [];\nvar MAPPINGS = {};\n(DATA.mappings || []).forEach(function (m) { MAPPINGS[(m.tenant_name || '').toLowerCase()] = m; });\n\n/* ============================================================\n   Pricing / term maths. Unchanged from the previous portal \u2014\n   these mirror the sync (Prepare Lines) exactly.\n   ============================================================ */\nfunction fmt(n) { return (Number(n) || 0).toFixed(2); }\nfunction money(n) {\n  return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });\n}\nfunction money0(n) {\n  return '$' + Math.round(Number(n) || 0).toLocaleString('en-AU');\n}\nfunction fullPeriodRrp(l) { return Number(l.period_rrp !== null && l.period_rrp !== undefined ? l.period_rrp : l.monthly_rrp) || 0; }\nfunction fullPeriodCost(l) { return Number(l.period_cost !== null && l.period_cost !== undefined ? l.period_cost : l.monthly_cost) || 0; }\n// Co-terming: Microsoft aligns a new annual subscription to an existing\n// anniversary, so its CURRENT term is shorter than 12 months while Dicker\n// still lists the full 12-month unit price. Billed monthly that changes\n// nothing (the monthly rate is the monthly rate, there are just fewer of\n// them); billed annually UPFRONT the single charge is pro-rated on days,\n// exactly as Dicker invoices it.\nfunction cotermInfo(l) {\n  var w = contractWindow(l);\n  var months = Number(l.term_months) || 12;\n  if (months !== 12 || !w.start || !w.end) return { days: 0, factor: 1, coterm: false };\n  var a = new Date(w.start + 'T00:00:00Z'), b = new Date(w.end + 'T00:00:00Z');\n  if (isNaN(a.getTime()) || isNaN(b.getTime())) return { days: 0, factor: 1, coterm: false };\n  var days = Math.round((b - a) / 86400000) + 1;\n  if (days <= 0) return { days: 0, factor: 1, coterm: false };\n  var factor = Math.min(Math.round((days / 365) * 10000) / 10000, 1);\n  return { days: days, factor: factor, coterm: factor < 0.99 };\n}\nfunction termScale(l) {\n  var ci = cotermInfo(l);\n  return ci.coterm && l.billing_type === 'annual_upfront' ? ci.factor : 1;\n}\nfunction periodRrp(l) { return Math.round(fullPeriodRrp(l) * termScale(l) * 100) / 100; }\nfunction periodCost(l) { return Math.round(fullPeriodCost(l) * termScale(l) * 100) / 100; }\nfunction periodSuffix(l) { return l.billing_months === 12 ? '/yr' : '/mo'; }\nfunction billingLabel(l) {\n  if (l.billing_type === 'annual_upfront') return 'Annual \u00b7 upfront';\n  if (l.billing_type === 'annual_monthly') return 'Annual \u00b7 monthly';\n  if (l.billing_type === 'usage') return 'Usage';\n  return 'Month to month';\n}\n// The line's CURRENT contract price (read back from Autotask on the last\n// sync); RRP only as the default for lines with no contract service yet.\nfunction currentPrice(l) {\n  return (l.contract_price !== null && l.contract_price !== undefined && l.contract_price !== '')\n    ? Number(l.contract_price) : periodRrp(l);\n}\nfunction effSell(l) {\n  return (l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined && l.sell_price !== '')\n    ? Number(l.sell_price) : currentPrice(l);\n}\nfunction effInclude(l) {\n  if (l.include === false) return false;\n  if (l.include === true) return true;\n  // $0 lines (e.g. Teams Phone Resource accounts) are included too and\n  // simply sync at a $0 sell price.\n  return l.charge_type === 'NCE' && l.status === 'Active';\n}\n// Monthly run rate for one line: annual-upfront prices are spread over 12.\nfunction monthlyValue(l) {\n  var per = effSell(l) * (Number(l.qty) || 0);\n  return l.billing_months === 12 ? per / 12 : per;\n}\n// Calendar-safe month arithmetic: clamp to the last day of the target\n// month rather than overflowing (31-MAR minus a month is 28-FEB).\nfunction addMonthsIso(iso, months) {\n  var d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  var day = d.getUTCDate();\n  d.setUTCDate(1);\n  d.setUTCMonth(d.getUTCMonth() + months);\n  var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();\n  d.setUTCDate(Math.min(day, last));\n  return d.toISOString().slice(0, 10);\n}\nfunction addDaysIso(iso, days) {\n  var d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  d.setUTCDate(d.getUTCDate() + days);\n  return d.toISOString().slice(0, 10);\n}\n// Same contract-window derivation as the sync (Prepare Lines). REVALUATION\n// PERIOD is the subscription's current expiry; the term is inferred back\n// from it by subscription type. The invoice report's TERM START is more\n// precise for the same term (co-termed subscriptions), but once REVALUATION\n// PERIOD is past the invoiced TERM END the subscription has renewed / rolled\n// to the next cycle. START USAGE is the ORIGINAL start and is never used.\nfunction contractWindow(l) {\n  var ok = function (v) { return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(v || '')) ? String(v) : ''; };\n  var max = function (a, b) { return a && b ? (a > b ? a : b) : (a || b); };\n  var months = Number(l.term_months) || 12;\n  var invStart = ok(l.term_start), invEnd = ok(l.term_end), reval = ok(l.revaluation_period);\n  var inferred = reval ? addMonthsIso(addDaysIso(reval, 1), -months) : '';\n  var start = '', end = '';\n  if (reval && invEnd && reval > invEnd) {\n    start = max(addDaysIso(invEnd, 1), inferred); end = reval;\n  } else if (invStart && invEnd) {\n    start = invStart; end = max(invEnd, reval);\n  } else if (reval) {\n    // No invoice row this month: START USAGE (the day before the original\n    // term began) raises the inferred start for co-termed subscriptions.\n    var su = ok(l.usage_start);\n    start = max(inferred, su ? addDaysIso(su, 1) : '');\n    end = reval;\n    if (start > end) start = inferred;\n  }\n  if (!start) start = invStart;\n  if (!end && start) end = addMonthsIso(start, months);\n  return { start: start, end: end };\n}\n// Earliest USAGE START among the invoice lines the sync replays as unit\n// adjustments; the contract has to reach back that far.\nfunction earliestUsageIso(l) {\n  var inv = [];\n  try { inv = JSON.parse(l.invoice_lines || '[]'); } catch (e) { return ''; }\n  var first = '';\n  for (var i = 0; i < inv.length; i++) {\n    var s = String((inv[i] && inv[i].s) || '');\n    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s) && (!first || s < first)) first = s;\n  }\n  return first;\n}\nvar MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\nfunction longDateIso(iso) {\n  var d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return String(iso || '');\n  return d.getUTCDate() + ' ' + MONTH_ABBR[d.getUTCMonth()] + ' ' + d.getUTCFullYear();\n}\nfunction shortDateIso(iso) {\n  var d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return String(iso || '');\n  return d.getUTCDate() + ' ' + MONTH_ABBR[d.getUTCMonth()];\n}\nvar BILLING_SHORT = { annual_monthly: 'Annual Commit Monthly', annual_upfront: 'Annual Commit Yearly',\n  monthly: 'Month to Month', usage: 'Usage' };\n// The Autotask contract belongs to the CO-TERM GROUP, not the subscription:\n// one per customer + billing type + anniversary. Autotask steps its billing\n// periods from the contract start date, and Dicker bills every co-termed\n// subscription on the group's anchor day, so they have to be the same date.\n// Mirrors the same derivation as the sync (Prepare Lines).\nfunction groupWindow(l) {\n  var w = contractWindow(l);\n  var months = Number(l.term_months) || 12;\n  var end = w.end;\n  if (!end) return null;\n  var start = addMonthsIso(addDaysIso(end, 1), -months);\n  var d = new Date(start + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return null;\n  return { start: start, end: end, months: months, day: d.getUTCDate() };\n}\nfunction groupContract(l) {\n  var g = groupWindow(l);\n  if (!g) return { name: '', start: '', end: '' };\n  var start = g.start;\n  var short = BILLING_SHORT[l.billing_type] || 'Month to Month';\n  // Annual contracts are named for their co-term anniversary; month-to-month\n  // for the date the subscription first started, so subscriptions bought at\n  // different times get their own contract.\n  var su = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(l.usage_start || ''))\n    ? String(l.usage_start) : contractWindow(l).start || g.start;\n  var label = g.months === 12\n    ? longDateIso(g.start) + ' to ' + longDateIso(g.end)\n    : 'Started ' + longDateIso(su);\n  var firstUsage = earliestUsageIso(l);\n  if (firstUsage && firstUsage < start) start = firstUsage;\n  return { name: 'CSP Microsoft ' + short + ' ' + label, start: start, end: g.end, label: label, kind: short };\n}\n// The invoice description Autotask shows for this service. A description\n// typed in the portal is what will be pushed on the next sync; otherwise the\n// live value read back from Autotask, falling back to the generated default.\n// Kept in step with prepare-lines.js: the annuity STOCK DESCRIPTION is the\n// product name, REFERENCE only a fallback.\nfunction productName(l) {\n  return String(l.stock_description || l.offer_name || 'CSP Service').trim();\n}\nfunction defaultInvoiceDesc(l) {\n  var suffix = ' - sub ' + l.subscription_id;\n  return productName(l).slice(0, 100 - suffix.length).trim() + suffix;\n}\nfunction customInvoiceDesc(l) {\n  return String(l.invoice_description || '').trim();\n}\nfunction liveInvoiceDesc(l) {\n  return String(l.contract_invoice_description || '').trim();\n}\n// { text, state } - state is 'custom' (pending push), 'live' (what Autotask\n// has now) or 'default' (what a first sync would set it to).\nfunction invoiceDesc(l) {\n  var c = customInvoiceDesc(l);\n  if (c) return { text: c, state: 'custom' };\n  var live = liveInvoiceDesc(l);\n  if (live) return { text: live, state: 'live' };\n  return { text: defaultInvoiceDesc(l), state: 'default' };\n}\n\nfunction marginPct(l) {\n  var s = effSell(l), c = periodCost(l);\n  if (!s) return null;\n  return ((s - c) / s) * 100;\n}\n// Everything for this subscription in this month's report: each pro-rata\n// change plus the billing-cycle charge, valued at the sell price (pro-rata\n// scaled by the same day fraction Dicker used: window unit cost / full-period\n// unit cost). What is\n// already posted is NOT dropped: guessing that from the last posting's date\n// twice hid charges that had never been billed, so the report is now shown as\n// it arrived and what Autotask has posted is reported beside it instead of\n// quietly subtracted from it. Only a subscription with no rows at all in the\n// report falls back to the NEXT cycle's estimate.\nfunction pendingItems(l) {\n  var sell = effSell(l);\n  var perUnitCost = Number(l.period_cost) || 0;\n  var inv = [];\n  try { inv = JSON.parse(l.invoice_lines || '[]'); } catch (e) {}\n  inv = inv.filter(function (x) { return x && x.s; })\n    .sort(function (a, b) { return String(a.s).localeCompare(String(b.s)); });\n  var lastPosted = lastPostedIso(l) || null;\n\n  var cycleEnd = '';\n  inv.forEach(function (x) { if (String(x.e || '') > cycleEnd) cycleEnd = String(x.e || ''); });\n  var cycleStart = '';\n  inv.forEach(function (x) {\n    if (String(x.e || '') === cycleEnd && (!cycleStart || String(x.s) < cycleStart)) cycleStart = String(x.s);\n  });\n\n  var items = [];\n  inv.forEach(function (x) {\n    var isCycle = String(x.s) === cycleStart && String(x.e) === cycleEnd;\n    var factor = perUnitCost > 0 ? Math.min(Number(x.u || 0) / perUnitCost, 1) : (isCycle ? 1 : 0);\n    items.push({ s: String(x.s), e: String(x.e || ''), q: Number(x.q || 0),\n      type: isCycle ? 'cycle' : 'pro-rata',\n      amount: Math.round(Number(x.q || 0) * sell * factor * 100) / 100 });\n  });\n  if (!items.length) {\n    var months = l.billing_months === 12 ? 12 : 1;\n    var nextS = lastPosted ? addMonthsIso(lastPosted, months) : (cycleStart || groupContract(l).start || '');\n    if (nextS) items.push({ s: nextS, e: '', q: Number(l.qty || 0), type: 'next cycle',\n      amount: Math.round(Number(l.qty || 0) * sell * 100) / 100 });\n  }\n  return items;\n}\n// What THIS MONTH'S REPORT charges for a line, which is known from the upload\n// alone. Two different questions hang off the same list of items, and running\n// them together is what hid a customer's pro-rata charges until a sync had\n// been run: this one the report can answer on its own, dueNow() below only\n// after Autotask has been read.\nfunction reportDue(l) {\n  if (!effInclude(l)) return 0;\n  return pendingItems(l).reduce(function (s, i) {\n    return i.type === 'next cycle' ? s : s + i.amount;\n  }, 0);\n}\n// The one number that matters per line: what is still waiting to be\n// approved and posted (the \"next cycle\" placeholder is not owed yet). Only\n// answerable once a sync has read Autotask's billing state.\nfunction dueNow(l) {\n  if (!l.billing_last) return 0;\n  return reportDue(l);\n}\n// How many charges are still waiting to be approved & posted. A $0 line\n// still has one, so it is the COUNT \u2014 never the dollar value \u2014 that decides\n// whether a line reads as posted.\nfunction pendingCount(l) {\n  if (!effInclude(l) || !l.billing_last) return 0;\n  return pendingItems(l).filter(function (i) { return i.type !== 'next cycle'; }).length;\n}\n// The dates to type into Autotask's Approve & Post screen: the earliest and\n// the latest USAGE START in this month's report. Both ends are CHARGE dates -\n// the start of a period, which is how Autotask dates a billing item - never\n// the end of the last period, which would reach past the last charge in this\n// report and sweep in the cycles after it.\n//\n// The first date is the point of printing this at all: it is NOT the billing\n// month. Seats that moved part way through an earlier cycle arrive as pro-rata\n// lines dated back to the day they changed, so a range starting at this\n// month's cycle silently leaves them behind.\n//\n// It is an indicator and nothing else. It is read straight off the report\n// rather than from any reading of what Autotask has posted, and it decides\n// nothing about what this page shows - a range that also filtered the rows is\n// what hid two of Atlas's pro-rata charges.\nfunction pendingSpan(l) {\n  var span = { first: '', last: '' };\n  if (!effInclude(l)) return span;\n  var inv = [];\n  try { inv = JSON.parse(l.invoice_lines || '[]'); } catch (e) { return span; }\n  inv.forEach(function (x) {\n    var a = String((x && x.s) || '');\n    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(a)) return;\n    if (!span.first || a < span.first) span.first = a;\n    if (!span.last || a > span.last) span.last = a;\n  });\n  return span;\n}\nfunction widenSpan(into, add) {\n  if (add.first && (!into.first || add.first < into.first)) into.first = add.first;\n  if (add.last && (!into.last || add.last > into.last)) into.last = add.last;\n  return into;\n}\n// \"13 Jul \u2192 1 Aug 2026\" - the year on the first date is only worth the room\n// when the range crosses one, and a set of charges all dated the same day is\n// one date, not a range from itself to itself.\nfunction spanLabel(span) {\n  if (!span.first || !span.last) return '';\n  if (span.first === span.last) return longDateIso(span.first);\n  var sameYear = span.first.slice(0, 4) === span.last.slice(0, 4);\n  return (sameYear ? shortDateIso(span.first) : longDateIso(span.first)) +\n    ' \u2192 ' + longDateIso(span.last);\n}\n// `scope` names what the range covers so the sentence reads the same whether\n// it hangs off the contract's pill or the customer's chip.\nfunction rangeHint(scope, span) {\n  if (!span.first || !span.last) return '';\n  return (span.first === span.last\n      ? 'Every charge in this month\u2019s report for ' + scope + ' is dated ' +\n        longDateIso(span.first) + '.'\n      : 'The charges in this month\u2019s report for ' + scope + ' are dated ' +\n        longDateIso(span.first) + ' to ' + longDateIso(span.last) + '.') +\n    ' Use that as the date range in Autotask\u2019s Approve & Post screen. These are charge dates - ' +\n    'Autotask dates a charge at the start of the period it covers - so the range stops at the last ' +\n    'charge rather than running on to the end of its period, which would sweep in cycles that are ' +\n    'not in this report. The first date reaches back to any pro-rata change carried over from an ' +\n    'earlier cycle, dated the day the seats moved. It is a guide to the dates only, and says ' +\n    'nothing about which of these charges Autotask has already posted.';\n}\n// The customer header has no pill to hang the range off, so there it is a\n// chip of its own - labelled, because a bare pair of dates sitting beside a\n// contract term would read as another term.\nfunction rangeHtml(span, scope) {\n  var label = spanLabel(span);\n  if (!label) return '';\n  return '<span class=\"range\" title=\"' + attr(rangeHint(scope, span)) + '\">' +\n    '<span class=\"rlbl\">post</span>' + escapeHtml(label) + '</span>';\n}\n// The date Autotask last approved & posted this service, or '' if it never\n// has. A line with no pending charges is only \"posted\" if something was\n// actually posted; a subscription with no rows in the CSP report has nothing\n// pending and nothing posted, which is a different thing entirely.\nfunction lastPostedIso(l) {\n  if (l.billing_last_date) return String(l.billing_last_date);\n  var m = String(l.billing_last || '').match(/^\\d{4}-\\d{2}-\\d{2}/);\n  return m ? m[0] : '';\n}\n// The last day of the period Autotask's last posting billed. It bills a\n// contract service one PERIOD at a time and dates the resulting item at the\n// period START, so a charge dated 30 June on a monthly service billed\n// 30 June to 29 July.\n//\n// This describes THAT charge and nothing else. It used to be read as \"every\n// report line dated inside this window is already billed\", which is false for\n// any change Autotask only learned about in this month's report - and that\n// reading hid real charges twice.\nfunction postedThroughIso(l) {\n  var start = lastPostedIso(l);\n  if (!start) return '';\n  return addDaysIso(addMonthsIso(start, l.billing_months === 12 ? 12 : 1), -1);\n}\n// Autotask posts a charge first and pulls it onto a customer invoice later,\n// so \"posted\" and \"invoiced\" are two different states. Only the most recent\n// posting is read back from BillingItems, so this is that charge's state: the\n// invoice number if it has landed on one, '' while it is still only posted.\nfunction invoiceRef(l) {\n  return String(l.billing_last_invoice_number || '') || String(l.billing_last_invoice_id || '');\n}\nfunction isInvoiced(l) { return !!invoiceRef(l); }\n// What THIS month's report does to a line, against what Autotask has already\n// billed. The point of the column is to make a re-import scannable: most lines\n// repeat last cycle untouched, and the few that do not are the ones worth\n// reading before you approve and post.\n//\n//   new      - nothing has ever been approved & posted for this subscription:\n//              either Autotask has no contract service for it yet, or the sync\n//              has just created one that has never billed. Its first charge is\n//              not \"unchanged\" - there is no previous cycle to be unchanged\n//              from. (autotask_contract_service_id is written by the sync and\n//              is NOT one of the columns an import overwrites, so it survives\n//              a re-upload and means what it says.)\n//   pro-rata - the report carries a mid-cycle change (seats moved part way\n//              through), which Dicker bills as its own short line\n//   qty      - the same shape as last cycle at a different seat count, which\n//              is what a change landing on the cycle boundary looks like\n//   same     - the cycle charge matches the quantity last posted\n//   none     - the report has nothing new for this subscription\nfunction cycleChange(l) {\n  if (!effInclude(l)) return null;\n  if (!l.autotask_contract_service_id) {\n    return { kind: 'new', label: 'new',\n      hint: 'This subscription has no contract service in Autotask yet - the next sync creates it.' };\n  }\n  if (!lastPostedIso(l)) {\n    return { kind: 'new', label: 'new',\n      hint: 'Autotask has a contract service for this subscription but has never approved & posted a ' +\n        'charge against it, so whatever is waiting now is its first.' };\n  }\n  var items = pendingItems(l).filter(function (x) { return x.type !== 'next cycle'; });\n  if (!items.length) {\n    return { kind: 'none', label: '\u2014',\n      hint: 'Nothing new for this subscription in the imported report.' };\n  }\n  var prorata = items.filter(function (x) { return x.type === 'pro-rata'; });\n  if (prorata.length) {\n    return { kind: 'prorata',\n      label: 'pro-rata' + (prorata.length > 1 ? ' \u00d7' + prorata.length : ''),\n      hint: prorata.length + ' mid-cycle change' + (prorata.length > 1 ? 's' : '') +\n        ' in this report, billed pro-rata: ' +\n        prorata.map(function (x) { return 'qty ' + x.q + ' from ' + longDateIso(x.s); }).join(', ') };\n  }\n  var cyc = items.filter(function (x) { return x.type === 'cycle'; })[0];\n  var lastQty = Number(l.billing_last_qty) || 0;\n  var nowQty = cyc ? Number(cyc.q) : Number(l.qty) || 0;\n  if (lastQty && nowQty !== lastQty) {\n    var d = nowQty - lastQty;\n    return { kind: 'qty', label: (d > 0 ? '+' : '\u2212') + Math.abs(d) + ' qty',\n      hint: 'The cycle charge is qty ' + nowQty + ', against ' + lastQty +\n        ' on the charge last posted. No pro-rata rows, so the change lands on the cycle boundary.' };\n  }\n  return { kind: 'same', label: 'unchanged',\n    hint: 'Same cycle charge as last time' + (lastQty ? ' - qty ' + lastQty : '') + '.' };\n}\nfunction needsAttention(l) {\n  var s = String(l.sync_status || '');\n  return s === 'error' || s === 'needs_mapping' || s === 'unmapped' || s === 'partial';\n}\n\n/* ============================================================\n   View state\n   ============================================================ */\nvar UI = { q: '', onlyDue: false, showOff: true, closed: {} };\ntry {\n  var saved = JSON.parse(localStorage.getItem('csp-portal-closed') || '{}');\n  if (saved && typeof saved === 'object') UI.closed = saved;\n} catch (e) {}\nfunction persist() {\n  try { localStorage.setItem('csp-portal-closed', JSON.stringify(UI.closed)); } catch (e) {}\n}\n\n// Every line carries an effective date even if it is filtered out of view,\n// because Save posts the whole book, not just what is on screen.\nvar TODAY = new Date().toISOString().slice(0, 10);\nLINES.forEach(function (l, i) {\n  l._i = i;\n  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(l.price_effective_date || ''))) l.price_effective_date = TODAY;\n});\n\nfunction matches(l) {\n  if (UI.onlyDue && pendingCount(l) <= 0) return false;\n  if (!UI.showOff && !effInclude(l)) return false;\n  if (!UI.q) return true;\n  // The SKU is no longer shown on the row, but it is still searchable: it is\n  // how the Dicker reports identify a product, so it is what you have to hand\n  // when you are looking for one.\n  var hay = [l.tenant_name, l.offer_name, l.stock_description, l.sku, l.subscription_id,\n    groupContract(l).name, invoiceDesc(l).text].join(' ').toLowerCase();\n  return hay.indexOf(UI.q) >= 0;\n}\n\n/* ============================================================\n   Render\n   ============================================================ */\nfunction render() {\n  var app = document.getElementById('app');\n  var visible = LINES.filter(matches);\n\n  renderStats(visible);\n\n  // The provenance line, and off it the two tabs this page was built from,\n  // shown exactly as they were uploaded. Checking a number against the source\n  // is otherwise a matter of finding the workbook and reopening it.\n  document.getElementById('meta').innerHTML =\n    escapeHtml(LINES.length + ' subscription lines') +\n    (LINES[0] && LINES[0].imported_at\n      ? ' \u00b7 imported ' + escapeHtml(String(LINES[0].imported_at).slice(0, 10)) : '') +\n    ' \u00b7 <a href=\"' + attr(BASE + '/csp-pricing-source?sheet=annuity') +\n      '\" title=\"The Annuity Information DETAILS tab, exactly as uploaded\">Annuity DETAILS</a>' +\n    ' \u00b7 <a href=\"' + attr(BASE + '/csp-pricing-source?sheet=invoice') +\n      '\" title=\"The CSP Invoice Report Invoice Details tab, exactly as uploaded\">CSP Invoice Details</a>' +\n    ' \u00b7 <a href=\"#\" id=\"signout\" title=\"End this session on this browser\">Sign out</a>';\n  var so = document.getElementById('signout');\n  if (so) so.onclick = function (e) { e.preventDefault(); signOut(); };\n\n  if (!LINES.length) {\n    app.innerHTML = '<div class=\"empty\">No subscription lines yet.<br>Run the ' +\n      '<b>01 \u00b7 Annuity Import</b> form first.</div>';\n    return;\n  }\n  if (!visible.length) {\n    app.innerHTML = '<div class=\"empty\">No lines match this filter.</div>';\n    return;\n  }\n\n  var byCustomer = {};\n  visible.forEach(function (l) { (byCustomer[l.tenant_name] = byCustomer[l.tenant_name] || []).push(l); });\n\n  app.innerHTML = Object.keys(byCustomer).sort().map(function (name) {\n    return customerHtml(name, byCustomer[name]);\n  }).join('');\n  wire();\n}\n\n// What the sync has left to do, before it does any of it. Until Autotask has\n// been read this tile is the empty state for the whole page - it is the one\n// place that can say \"nobody has looked yet\" once rather than on every row.\nfunction planTile(visible) {\n  var incl = visible.filter(effInclude);\n  var checked = incl.filter(hasPlan);\n  if (!checked.length) {\n    return { k: 'Autotask plan', v: '\u2014', s: 'press Check Autotask' };\n  }\n  var todo = 0, failed = 0, unmapped = 0;\n  checked.forEach(function (l) {\n    if (String(l.plan_status) === 'error') { failed++; return; }\n    // Unmapped is not a change waiting to be made - it is a question waiting\n    // to be answered, and it is already counted under Needs attention.\n    if (String(l.plan_status) === 'needs_mapping') { unmapped++; return; }\n    if (l.plan_service_action === 'create' || l.plan_service_action === 'rename' ||\n        l.plan_contract_action === 'create' || l.plan_contract_action === 'extend' ||\n        l.plan_cs_action === 'create' || l.plan_cs_action === 'redescribe' ||\n        planPrice(l).kind !== 'same' || planUnits(l).length) todo++;\n  });\n  // Everything standing between this number and a sync you can trust, said in\n  // one line rather than only the first of them.\n  var behind = incl.length - checked.length;\n  var caveats = [];\n  if (failed) caveats.push(failed + ' could not be read');\n  if (unmapped) caveats.push(unmapped + ' unmapped');\n  if (behind) caveats.push(behind + ' not checked yet');\n  var sub = caveats.length ? caveats.join(' \u00b7 ') : 'checked ' + String(planCheckedAt()).slice(0, 10);\n  return { k: 'Autotask plan', v: todo + (todo === 1 ? ' change' : ' changes'), s: sub,\n    cls: (failed || unmapped) ? 'attn' : (todo ? 'due' : 'clear') };\n}\n\nfunction renderStats(visible) {\n  var due = 0, monthly = 0, attn = 0, incl = 0;\n  var contracts = {}, custs = {}, span = { first: '', last: '' };\n  visible.forEach(function (l) {\n    custs[l.tenant_name] = 1;\n    var g = groupContract(l);\n    if (g.name) contracts[l.tenant_name + '|' + g.name] = 1;\n    if (effInclude(l)) { incl++; monthly += monthlyValue(l); }\n    due += dueNow(l);\n    widenSpan(span, pendingSpan(l));\n    if (needsAttention(l)) attn++;\n  });\n  Object.keys(custs).forEach(function (n) { if (!MAPPINGS[n.toLowerCase()]) attn++; });\n\n  var tiles = [\n    { k: 'Customers', v: Object.keys(custs).length, s: Object.keys(contracts).length + ' Autotask contracts' },\n    { k: 'Services billing', v: incl, s: visible.length - incl + ' excluded' },\n    { k: 'Monthly recurring', v: money0(monthly), s: 'at current sell prices' },\n    // The date range replaces \"sitting in Autotask now\": knowing it is there\n    // is one glance, and the next thing you need is the range to type in.\n    { k: 'Awaiting Approve & Post', v: money(due),\n      s: spanLabel(span) || (due > 0 ? 'sitting in Autotask now' : 'nothing outstanding'),\n      cls: due > 0 ? 'due' : 'clear' },\n    { k: 'Needs attention', v: attn, s: attn ? 'unmapped or failed' : 'all clear',\n      cls: attn ? 'attn' : 'clear' },\n    planTile(visible)\n  ];\n  document.getElementById('stats').innerHTML = tiles.map(function (t) {\n    return '<div class=\"stat ' + (t.cls || '') + '\"><div class=\"k\">' + escapeHtml(t.k) + '</div>' +\n      '<div class=\"v\">' + escapeHtml(String(t.v)) + '</div>' +\n      '<div class=\"s\">' + escapeHtml(t.s) + '</div></div>';\n  }).join('');\n}\n\n// One fixed column grid, shared by the header strip and every contract\n// table beneath it.\nvar COLS = '<colgroup>' +\n  '<col style=\"width:42px\">' +\n  '<col>' +\n  '<col style=\"width:52px\">' +\n  '<col style=\"width:100px\">' +\n  '<col style=\"width:100px\">' +\n  '<col style=\"width:150px\">' +\n  '<col style=\"width:72px\">' +\n  '<col style=\"width:104px\">' +\n  '<col style=\"width:280px\">' +\n  '<col style=\"width:76px\">' +\n'</colgroup>';\nvar COLHEAD = '<div class=\"colhead\"><table>' + COLS + '<thead><tr>' +\n  '<th></th>' +\n  '<th>Service</th>' +\n  '<th class=\"num\">Qty</th>' +\n  '<th class=\"num\" title=\"Dicker unit cost for one billing period\">Cost</th>' +\n  '<th class=\"num\" title=\"Dicker unit RRP for one billing period\">RRP</th>' +\n  '<th class=\"num\" title=\"What Autotask charges per unit. Click a price to change it.\">Sell</th>' +\n  '<th class=\"num\">Margin</th>' +\n  '<th title=\"What this month&#39;s imported report does to each line: a subscription Autotask has never billed, a mid-cycle change billed pro-rata, a different seat count, or the same charge as last cycle.\">Change</th>' +\n  '<th title=\"What each service still has waiting in Autotask&#39;s Approve &amp; Post screen, and whether its last posted charge has reached an invoice. Click an amount for the breakdown.\">Billing</th>' +\n  '<th class=\"num\">Sync</th>' +\n'</tr></thead></table></div>';\n\n// One tick that includes or excludes every line shown for a customer. It\n// counts and acts on the lines on screen, so a filtered page does what it\n// looks like it will do rather than reaching lines the filter is hiding.\nfunction pickAllHtml(lines) {\n  var on = 0;\n  lines.forEach(function (l) { if (effInclude(l)) on++; });\n  return '<label class=\"pickall\" onclick=\"event.stopPropagation()\" title=\"' +\n    attr('Include or exclude every line shown for this customer') + '\">' +\n    '<input type=\"checkbox\" class=\"js-inclall\"' + (lines.length && on === lines.length ? ' checked' : '') + '>' +\n    '<span class=\"js-inclall-n\">' + escapeHtml(pickAllLabel(on, lines.length)) + '</span></label>';\n}\n\nfunction pickAllLabel(on, total) {\n  if (on === 0) return 'None incl.';\n  if (on === total) return 'All ' + total + ' incl.';\n  return on + ' of ' + total + ' incl.';\n}\n\n// The customer <section> a control sits in. Both checkboxes live inside one,\n// which is what makes a customer the unit the master tick acts on.\nfunction customerOf(el) {\n  var n = el;\n  while (n && (' ' + (n.className || '') + ' ').indexOf(' customer ') < 0) n = n.parentNode;\n  return n;\n}\n\nfunction setIncluded(box, on) {\n  box.checked = on;\n  LINES[+box.getAttribute('data-i')].include = on;\n  var tr = box.parentNode.parentNode;\n  tr.className = 'line' + (on ? '' : ' off');\n}\n\n// The master tick is a reading of the rows under it, so it is recomputed from\n// them rather than remembered - after a bulk change and after a single row.\n// \"Some included\" is the indeterminate state, which no attribute can set.\nfunction refreshPickAll(el) {\n  var sec = customerOf(el);\n  if (!sec) return;\n  var master = sec.querySelector('.js-inclall');\n  var label = sec.querySelector('.js-inclall-n');\n  var boxes = sec.querySelectorAll('.js-incl');\n  if (!master) return;\n  var on = 0;\n  for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) on++;\n  master.checked = boxes.length > 0 && on === boxes.length;\n  master.indeterminate = on > 0 && on < boxes.length;\n  if (label) label.textContent = pickAllLabel(on, boxes.length);\n}\n\nfunction customerHtml(name, lines) {\n  var mapping = MAPPINGS[name.toLowerCase()];\n  var key = 'c:' + name;\n  var closed = !!UI.closed[key];\n\n  var due = 0, monthly = 0;\n  var span = { first: '', last: '' };\n  lines.forEach(function (l) {\n    due += dueNow(l);\n    widenSpan(span, pendingSpan(l));\n    if (effInclude(l)) monthly += monthlyValue(l);\n  });\n\n  // One block per Autotask contract, with its services listed underneath \u2014\n  // the same shape you Approve & Post in.\n  var byContract = {};\n  lines.forEach(function (l) {\n    var g = groupContract(l);\n    var k = g.name || '';\n    (byContract[k] = byContract[k] || { grp: g, lines: [] }).lines.push(l);\n  });\n  var order = Object.keys(byContract).sort(function (a, b) {\n    if (!a !== !b) return a ? -1 : 1;   // usage-billed lines last\n    return a < b ? -1 : (a > b ? 1 : 0);\n  });\n\n  var head = '<div class=\"chead-cust js-toggle\" data-key=\"' + attr(key) + '\">' +\n    '<span class=\"caret\">&#9660;</span>' +\n    '<h2>' + escapeHtml(name) + '</h2>' +\n    (mapping\n      ? '<span class=\"badge mapped\">' + escapeHtml(mapping.autotask_company_name) + ' &middot; #' +\n        escapeHtml(String(mapping.autotask_company_id)) + '</span>'\n      : '<span class=\"badge unmapped\">not mapped to Autotask</span>' + mapperHtml(name)) +\n    '<div class=\"custsum\">' +\n      '<span>' + order.length + (order.length === 1 ? ' contract' : ' contracts') + '</span>' +\n      '<span><b>' + money0(monthly) + '</b> /mo</span>' +\n      (due > 0 ? '<span style=\"color:var(--warn)\"><b style=\"color:var(--warn)\">' + money(due) + '</b> awaiting</span>' : '') +\n      rangeHtml(span, 'this customer') +\n    '</div>' +\n    pickAllHtml(lines) +\n  '</div>';\n\n  return '<section class=\"customer' + (closed ? ' collapsed' : '') + '\">' + head +\n    '<div class=\"cbody\"><div class=\"cinner\">' + COLHEAD + order.map(function (cn) {\n      return contractHtml(name, cn, byContract[cn]);\n    }).join('') + '</div></div></section>';\n}\n\nfunction contractHtml(customer, cname, block) {\n  var lines = block.lines.slice().sort(function (a, b) {\n    return productName(a).localeCompare(productName(b));\n  });\n  var key = 'k:' + customer + '|' + cname;\n  var closed = !!UI.closed[key];\n\n  var due = 0, monthly = 0, checked = false, pend = 0, posted = 0, invoiced = 0, notApproved = 0;\n  var chg = { new: 0, prorata: 0, qty: 0, same: 0, none: 0 }, classified = 0;\n  var span = { first: '', last: '' };\n  lines.forEach(function (l) {\n    if (effInclude(l)) monthly += monthlyValue(l);\n    if (effInclude(l) && l.billing_last) checked = true;\n    due += dueNow(l);\n    widenSpan(span, pendingSpan(l));\n    pend += pendingCount(l);\n    if (effInclude(l) && pendingCount(l) > 0) notApproved++;\n    if (effInclude(l) && pendingCount(l) === 0 && lastPostedIso(l)) {\n      posted++;\n      if (isInvoiced(l)) invoiced++;\n    }\n    var c = cycleChange(l);\n    if (c) { chg[c.kind]++; classified++; }\n  });\n  // What this import did to the contract as a whole. Only the exceptions are\n  // named; a contract that simply repeats last cycle says so in one word,\n  // because that is the answer that needs no follow-up.\n  var chgParts = [];\n  // Nothing on this contract has ever billed. That is NOT the same claim as\n  // \"the contract is new\", which is what this used to say: a contract an\n  // earlier sync created and nobody has approved & posted against is standing\n  // in Autotask with nothing billed on it, and calling that a new contract\n  // beside a plan chip that (correctly) does not say \"will be created\" is the\n  // page contradicting itself an inch apart. Whether the contract exists is\n  // the plan's question, answered from Autotask; this column only ever\n  // reports what the report does to the billing.\n  if (chg.new) chgParts.push(chg.new === classified ? 'nothing billed yet' : chg.new + ' new');\n  if (chg.prorata) chgParts.push(chg.prorata + ' pro-rata');\n  if (chg.qty) chgParts.push(chg.qty + ' qty change' + (chg.qty > 1 ? 's' : ''));\n  var chgTag = '';\n  if (chgParts.length) {\n    // \"Nothing billed yet\" is the one that invites the wrong conclusion, so it\n    // is the one that explains itself.\n    var chgTitle = (classified && chg.new === classified)\n      ? 'No service on this contract has ever been approved & posted in Autotask, so every ' +\n        'charge here is a first. Whether the contract itself exists is a separate question - ' +\n        'the plan says \"will be created\" when it does not.'\n      : 'What this month\\'s report changes on this contract';\n    chgTag = '<span class=\"chg ' + (chg.new ? 'new' : (chg.prorata ? 'prorata' : 'qty')) +\n      '\" title=\"' + attr(chgTitle) + '\">' +\n      escapeHtml(chgParts.join(' \u00b7 ')) + '</span>';\n  } else if (chg.same) {\n    chgTag = '<span class=\"chg same\" title=\"Every service on this contract bills the same as last cycle\">' +\n      'unchanged</span>';\n  }\n  // The same lifecycle, rolled up. Anything waiting to be approved is the\n  // headline - it is the only one of the three that asks something of you -\n  // and the invoiced split is what is left to say once nothing is waiting.\n  var invTag = '';\n  if (notApproved > 0) {\n    invTag = '<span class=\"itag wait\" title=\"' + attr(notApproved + ' of ' + lines.length +\n      ' services have charges sitting in Approve & Post') + '\">' +\n      notApproved + ' not approved</span>';\n  } else if (posted > 0) {\n    invTag = invoiced === posted\n      ? '<span class=\"itag yes\" title=\"Every posted charge on this contract is on a customer invoice\">all invoiced</span>'\n      : '<span class=\"itag no\" title=\"' + attr(String(posted - invoiced) + ' of ' + posted +\n          ' posted services are not on a customer invoice yet') + '\">' +\n        (posted - invoiced) + ' not invoiced</span>';\n  }\n  var atId = (lines.filter(function (l) { return l.autotask_contract_id; })[0] || {}).autotask_contract_id;\n\n  // The contract belongs to the co-term GROUP, so what happens to it is one\n  // fact for the whole block rather than something to repeat on every line.\n  // Whether it EXISTS is already said by the Open #7001 link beside this;\n  // what is missing is what the sync is about to do to it.\n  var planNew = 0, planErr = 0, planExtend = '', planFound = 0;\n  lines.forEach(function (l) {\n    if (!effInclude(l) || !hasPlan(l)) return;\n    if (l.autotask_contract_id) planFound++;\n    if (String(l.plan_status) === 'error') planErr++;\n    if (l.plan_contract_action === 'create') planNew++;\n    else if (l.plan_contract_action === 'extend' && l.plan_contract_end) planExtend = l.plan_contract_end;\n  });\n  var planTag = '';\n  // Every line in a co-term group sits on the ONE contract, so a check that\n  // found it for any of them found it. Saying \"will be created\" beside the\n  // Open #7001 link that follows would be the page contradicting itself.\n  if (planNew && !planFound) {\n    planTag = '<span class=\"plan do\" title=\"' + attr('No Autotask contract carries the reference ' +\n      (lines[0] && lines[0].contract_number ? lines[0].contract_number : '') +\n      ' yet, so the sync will create this contract.') + '\">will be created</span>';\n  } else if (planExtend) {\n    planTag = '<span class=\"plan do\" title=\"' + attr('This contract ends before the term the report ' +\n      'covers, so the sync will extend it in place - Autotask rejects adjustments dated outside the ' +\n      'contract window.') + '\">extend to ' + escapeHtml(longDateIso(planExtend)) + '</span>';\n  } else if (planErr) {\n    planTag = '<span class=\"plan err\" title=\"' + attr(planErr + ' of these services could not be read ' +\n      'from Autotask, so what the sync would do to this contract is not known.') + '\">check failed</span>';\n  }\n\n  var title, meta;\n  if (!cname) {\n    title = '<div class=\"ctitle\"><span class=\"cname\">Not billed through Autotask</span>' +\n      '<span class=\"cdates\">usage-billed &mdash; excluded from the sync</span></div>';\n    meta = '<div class=\"cmeta\"><span>' + lines.length + (lines.length === 1 ? ' line' : ' lines') + '</span></div>';\n  } else {\n    title = '<div class=\"ctitle\" title=\"' + attr(cname) + '\">' +\n      '<span class=\"cpre\">CSP MICROSOFT</span>' +\n      '<span class=\"cname\">' + escapeHtml(block.grp.kind || '') + '</span>' +\n      '<span class=\"cdates\">' + escapeHtml(block.grp.label || '') + '</span></div>';\n    meta = '<div class=\"cmeta\">' +\n      '<span>' + lines.length + (lines.length === 1 ? ' service' : ' services') + '</span>' +\n      '<span><span class=\"cval\">' + money0(monthly) + '</span> /mo</span>' +\n      (checked\n        ? (pend > 0\n          ? '<span class=\"pill due\" style=\"cursor:default\" title=\"' + attr(rangeHint('this contract', span)) +\n            '\"><span class=\"tick\">&#9679;</span>' + money(due) + ' to post' +\n            (spanLabel(span) ? ' <span class=\"n\">' + escapeHtml(spanLabel(span)) + '</span>' : '') + '</span>'\n          : (posted\n            ? '<span class=\"pill clear\" style=\"cursor:default\"><span class=\"tick\">&#10003;</span>all posted</span>'\n            : '<span class=\"pill none\" style=\"cursor:default\">nothing to bill</span>'))\n        : '') +\n      planTag +\n      chgTag +\n      invTag +\n      (atId ? contractLink(atId) : '') +\n    '</div>';\n  }\n\n  var rows = lines.map(lineHtml).join('');\n\n  return '<div class=\"contract' + (cname ? '' : ' usage') + (closed ? ' collapsed' : '') + '\">' +\n    '<div class=\"chead js-toggle\" data-key=\"' + attr(key) + '\">' +\n      '<span class=\"caret\">&#9660;</span>' + title + meta +\n    '</div>' +\n    '<div class=\"tablewrap\"><table>' + COLS + '<tbody>' + rows + '</tbody></table></div></div>';\n}\n\nfunction lineHtml(l) {\n  var i = l._i;\n  var on = effInclude(l);\n  var win = contractWindow(l);\n  var ci = cotermInfo(l);\n  var suffix = periodSuffix(l);\n  var m = marginPct(l);\n\n  // Sub-line: billing type, and the term only when this line's own window\n  // differs from the contract it sits on (co-terms). Most rows have neither,\n  // and the sub-line is dropped entirely rather than left as an empty gap.\n  var bits = [];\n  // The billing type is already the contract's name, so it is only worth\n  // repeating on the lines that sit outside a contract (usage-billed).\n  if (!groupContract(l).name) {\n    bits.push('<span class=\"badge b-' + escapeHtml(l.billing_type || 'monthly') + '\">' +\n      escapeHtml(billingLabel(l)) + '</span>');\n  }\n  if (ci.coterm) {\n    var mths = Math.round((ci.days / 365) * 12 * 10) / 10;\n    bits.push('<span class=\"badge coterm\" title=\"Co-termed: this term runs ' + ci.days +\n      ' days (' + mths + ' months), aligned to the customer&#39;s other subscriptions and billing on their shared contract. ' +\n      (l.billing_type === 'annual_upfront'\n        ? 'The upfront charge is pro-rated to ' + (ci.factor * 100).toFixed(1) + '% of the annual price, as Dicker invoices it.'\n        : 'The monthly rate is unchanged \u2014 there are simply fewer charges before it renews for a full year.') +\n      '\">co-term ' + mths + ' mo</span>');\n    bits.push('<span title=\"This subscription&#39;s own term\">' +\n      escapeHtml(shortDateIso(win.start)) + ' &rarr; ' + escapeHtml(longDateIso(win.end)) + '</span>');\n  }\n  var firstStarted = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(l.usage_start || '')) ? String(l.usage_start) : '';\n  var subTitle = 'Subscription ' + (l.subscription_id || '') +\n    (firstStarted ? ' \u00b7 first started ' + firstStarted : '') +\n    (win.start ? ' \u00b7 current term ' + win.start + ' to ' + win.end : '');\n\n  // The full Dicker STOCK DESCRIPTION, which is what the Autotask service is\n  // named after. REFERENCE (offer_name) is only a fallback: Dicker truncates\n  // it at 30 characters, so a renamed product arrives as \"DO NOT USE -\n  // Microsoft Defende\".\n  var nm = productName(l);\n  var cut = !l.stock_description && nm.length >= 30;\n\n  var due = dueNow(l);\n  var pill;\n  if (!on) {\n    pill = '<span class=\"pill none\">excluded</span>';\n  } else if (!l.billing_last) {\n    // Autotask has not been read for this line, so nothing can be said about\n    // its Approve & Post queue - but what the CSP report charges is already\n    // known, and saying only \"not checked yet\" hid a mid-cycle change from\n    // the one screen where it was supposed to be reviewed.\n    pill = '<button class=\"pill none js-bill\" style=\"cursor:pointer\" data-i=\"' + i + '\" ' +\n      'title=\"' + attr('What this month\u2019s CSP report charges for this service. ' +\n        'Autotask has not been read yet, so it is not known how much of it is already posted - ' +\n        'run a sync for that.') + '\">' + money(reportDue(l)) + ' to bill</button>';\n  } else {\n    var n = pendingCount(l);\n    if (n > 0) {\n      pill = '<button class=\"pill due js-bill\" data-i=\"' + i + '\"><span class=\"tick\">&#9679;</span>' +\n        money(due) + (n > 1 ? ' <span class=\"n\">' + n + ' items</span>' : '') + '</button>';\n    } else if (lastPostedIso(l)) {\n      pill = '<button class=\"pill clear js-bill\" data-i=\"' + i + '\"><span class=\"tick\">&#10003;</span>posted</button>';\n    } else {\n      pill = '<button class=\"pill none js-bill\" style=\"cursor:pointer\" data-i=\"' + i + '\" ' +\n        'title=\"This subscription has no charges in the CSP report and nothing posted in Autotask yet\">nothing to bill</button>';\n    }\n  }\n\n  // Beside the pill: where this service is in Autotask's billing lifecycle.\n  // A charge is raised, then approved & posted, then pulled onto a customer\n  // invoice, and those are three different places to be:\n  //\n  //   NOT APPROVED      something is sitting in Approve & Post right now. This\n  //                     is about the CURRENT import, so it agrees with the\n  //                     amount in the pill instead of contradicting it.\n  //   APPROVED & POSTED posted, but not yet on a customer invoice.\n  //   INVOICED          on an invoice - the drawer names it and links to it.\n  //\n  // The last two describe the LAST POSTED charge, so they are only shown once\n  // nothing is waiting; while a cycle is pending, what the previous one did is\n  // history and lives in the drawer. A line that has never been posted and has\n  // nothing waiting has no lifecycle to report, so it gets no tag.\n  var itag = '';\n  if (on && pendingCount(l) > 0) {\n    itag = '<span class=\"itag wait\" title=\"' + attr(money(due) +\n      ' is waiting in Autotask\u2019s Approve & Post screen for this service.') +\n      '\">not approved</span>';\n  } else if (on && lastPostedIso(l)) {\n    var when = longDateIso(l.billing_last_date || lastPostedIso(l));\n    if (isInvoiced(l)) {\n      itag = '<span class=\"itag yes\" title=\"' + attr('The charge posted on ' + when +\n        ' is on invoice ' + invoiceRef(l) +\n        (l.billing_last_invoice_date ? ' of ' + longDateIso(l.billing_last_invoice_date) : '') +\n        '. Open the row for the link.') + '\">invoiced</span>';\n    } else {\n      itag = '<span class=\"itag no\" title=\"' + attr('The charge posted on ' + when +\n        ' has been approved & posted but is not on a customer invoice yet.') +\n        '\">approved &amp; posted</span>';\n    }\n  }\n\n  var main = '<tr class=\"line' + (on ? '' : ' off') + '\" data-i=\"' + i + '\">' +\n    '<td class=\"pick\"><input type=\"checkbox\" class=\"js-incl\" data-i=\"' + i + '\"' + (on ? ' checked' : '') +\n      ' title=\"Include this line in the Autotask sync\"></td>' +\n    '<td><div class=\"svc\" title=\"' + attr(subTitle + (cut\n        ? ' \u2014 ' + nm + ' (Dicker truncates REFERENCE at 30 characters, and this row has no stock description)'\n        : '')) + '\">' +\n      escapeHtml(nm) + (cut ? '<span class=\"muted\">\u2026</span>' : '') + '</div>' +\n      (bits.length\n        ? '<div class=\"svcsub\">' + bits.join('') + '</div>'\n        : '') +\n      planHtml(l) +\n      invoiceHtml(l, i) + '</td>' +\n    '<td class=\"num\">' + escapeHtml(String(l.qty || 0)) + '</td>' +\n    '<td class=\"num muted\">' + fmt(periodCost(l)) + '<span class=\"per\">' + suffix + '</span></td>' +\n    '<td class=\"num muted\">' + fmt(periodRrp(l)) + '<span class=\"per\">' + suffix + '</span></td>' +\n    '<td class=\"num sell' + (l.use_custom_price ? ' editing' : '') + '\" data-i=\"' + i + '\">' +\n      '<div class=\"sellview\">' +\n        '<button class=\"amt js-edit' + (l.use_custom_price ? ' custom' : '') + '\" data-i=\"' + i + '\" ' +\n          'title=\"Click to change the price Autotask charges for this service\">' +\n          fmt(effSell(l)) + '<span class=\"per\">' + suffix + '</span></button>' +\n      '</div>' +\n      '<div class=\"selledit\">' +\n        '<input type=\"number\" step=\"0.01\" min=\"0\" class=\"js-sell\" data-i=\"' + i + '\" value=\"' + fmt(effSell(l)) + '\">' +\n        '<div class=\"fromlbl\">effective from</div>' +\n        '<input type=\"date\" class=\"js-date\" data-i=\"' + i + '\" value=\"' + attr(l.price_effective_date) + '\">' +\n        '<div class=\"picks\"><a class=\"js-pick\" data-i=\"' + i + '\" data-p=\"post\" title=\"The next Approve &amp; Post billing start\">next post</a>' +\n        ' <span class=\"dot\">\u00b7</span> <a class=\"js-pick\" data-i=\"' + i + '\" data-p=\"start\" title=\"The contract start date\">contract start</a>' +\n        ' <span class=\"dot\">\u00b7</span> <a class=\"js-cancel\" data-i=\"' + i + '\" title=\"Leave the Autotask price as it is\">keep current</a></div>' +\n      '</div>' +\n    '</td>' +\n    '<td class=\"num\">' + marginHtml(l, i) + '</td>' +\n    '<td><div class=\"chgcell\">' + changeHtml(l) + '</div></td>' +\n    '<td><div class=\"billcell\">' + pill + itag + '</div></td>' +\n    '<td class=\"num\">' + syncHtml(l) + '</td>' +\n  '</tr>';\n\n  return main + detailHtml(l);\n}\n\n// Shown under every service: what appears on the customer's invoice line.\n// Click it to type your own; the next sync pushes it to Autotask.\nfunction invoiceHtml(l, i) {\n  var d = invoiceDesc(l);\n  var hint = d.state === 'custom'\n    ? 'Your wording - the next sync will set this in Autotask. Click to change.'\n    : (d.state === 'live'\n      ? 'What Autotask shows on the invoice line today. Click to change it.'\n      : 'No contract service yet - this is what the first sync will set. Click to change it.');\n  return '<div class=\"inv\"><span class=\"lbl\">Invoice' + (d.state === 'default' ? ' (unset)' : '') + '</span>' +\n      '<button class=\"invtext ' + d.state + ' js-invedit\" data-i=\"' + i + '\" ' +\n        'title=\"' + attr(d.text + ' \u2014 ' + hint) + '\">' + escapeHtml(d.text) +\n      '</button></div>' +\n    '<div class=\"invedit\">' +\n      '<input type=\"text\" maxlength=\"100\" class=\"js-invtext\" data-i=\"' + i + '\" ' +\n        'value=\"' + attr(customInvoiceDesc(l) || d.text) + '\" ' +\n        'placeholder=\"' + attr(defaultInvoiceDesc(l)) + '\">' +\n      '<span class=\"count\" data-invcount=\"' + i + '\"></span>' +\n      '<button class=\"btn link js-invdone\" data-i=\"' + i + '\">done</button>' +\n      '<button class=\"btn link js-invreset\" data-i=\"' + i + '\" ' +\n        'title=\"Drop your wording and go back to the generated description\">reset</button>' +\n    '</div>';\n}\n\n// The Change cell. An excluded line is not being billed at all, so it has\n// nothing to say about this cycle and gets an empty cell rather than a chip.\nfunction changeHtml(l) {\n  var c = cycleChange(l);\n  if (!c) return '';\n  return '<span class=\"chg ' + c.kind + '\" title=\"' + attr(c.hint) + '\">' +\n    escapeHtml(c.label) + '</span>';\n}\n\nfunction marginClass(m) {\n  if (m === null) return '';\n  if (m < 0) return 'neg';\n  return m < 10 ? 'thin' : '';\n}\nfunction marginHtml(l, i) {\n  var m = marginPct(l);\n  return '<span class=\"marg ' + marginClass(m) + '\" data-marg=\"' + i + '\"' +\n    (m !== null && m < 10 ? ' title=\"Thin margin \u2014 cost ' + fmt(periodCost(l)) + ' against sell ' + fmt(effSell(l)) + '\"' : '') +\n    '>' + (m === null ? '\u2014' : m.toFixed(1) + '%') + '</span>';\n}\n/* ============================================================\n   The plan - what the sync WOULD do, worked out by workflow 04\n   against Autotask without writing anything.\n\n   Everything here is READ from what 04 computed rather than\n   derived again, so the preview cannot drift from the sync that\n   follows it. The one exception is price: a price typed on this\n   screen a moment ago has not been anywhere near Autotask, and a\n   preview that ignored it would be describing a price you have\n   already changed. Comparing the sell price to the contract price\n   client-side keeps \"will re-price to $X\" live under your hands,\n   and it is the one comparison this page can make honestly,\n   because both numbers are in front of it.\n   ============================================================ */\n\n// A line 04 has never reached has no plan_checked_at. \"Nothing will happen\"\n// and \"nobody has looked\" are different answers, and only one of them can be\n// shown as a plan.\nfunction hasPlan(l) { return !!l.plan_checked_at; }\n\n// Whether ANY line has been checked. A page where nothing has been decides\n// the empty state at the top rather than putting \"not checked\" on 109 rows;\n// a page where only some have needs to mark the rest, or a blank row reads as\n// \"nothing to do\".\nvar PLAN_RUN = null;\nfunction planWasRun() {\n  if (PLAN_RUN === null) {\n    PLAN_RUN = LINES.filter(function (l) { return hasPlan(l); }).length > 0;\n  }\n  return PLAN_RUN;\n}\nfunction planCheckedAt() {\n  var stamps = LINES.filter(hasPlan).map(function (l) { return String(l.plan_checked_at); }).sort();\n  return stamps.length ? stamps[stamps.length - 1] : '';\n}\n\n// The price the sync would push, by the sync's own rule (Prepare Lines): the\n// portal price when one has been typed, otherwise the per-period RRP.\n//\n// This is NOT the same as effSell, and the difference is the point. effSell\n// answers \"what is this service charged at\" and so falls back to the LIVE\n// Autotask price, which is right for the Sell column - it is what the\n// customer is paying. The sync falls back to RRP. So a price edited by hand\n// in Autotask, on a line with no custom price here, will be pushed back to\n// RRP on the next sync, and a preview built on effSell would have said\n// \"nothing to do\" about exactly the change you most needed warning of.\nfunction planSell(l) {\n  return (l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined && l.sell_price !== '')\n    ? Number(l.sell_price) : periodRrp(l);\n}\n\n// The live price comparison - see the note above. A line with no contract\n// service is not a re-price at all, it is an addition.\nfunction planPrice(l) {\n  var have = (l.contract_price === null || l.contract_price === undefined || l.contract_price === '')\n    ? null : Number(l.contract_price);\n  var want = planSell(l);\n  if (have === null || !l.autotask_contract_service_id) return { kind: 'add', from: null, to: want };\n  return { kind: Math.abs(have - want) < 0.005 ? 'same' : 'change', from: have, to: want };\n}\n\n// The unit adjustments 04 worked out, as [{ change, date }] oldest first.\nfunction planUnits(l) {\n  try {\n    var u = JSON.parse(l.plan_units || '[]');\n    return Array.isArray(u) ? u : [];\n  } catch (e) { return []; }\n}\nfunction signed(n) { return (Number(n) > 0 ? '+' : '') + String(Number(n) || 0); }\n\n// The chips under the service name. An excluded line is not going to Autotask\n// at all, so it has no plan to show - the row already says excluded.\nfunction planHtml(l) {\n  if (!effInclude(l)) return '';\n  if (!hasPlan(l)) {\n    return planWasRun()\n      ? '<div class=\"planline\"><span class=\"plan flat\" title=\"' +\n        attr('Autotask has not been checked for this line. Press Check Autotask to bring it up to date.') +\n        '\">not checked</span></div>'\n      : '';\n  }\n  var st = String(l.plan_status || '');\n  if (st === 'needs_mapping') {\n    return '<div class=\"planline\"><span class=\"plan err\" title=\"' +\n      attr('This customer is not mapped to an Autotask company, so there is nothing to plan against. ' +\n        'Map it above, then press Check Autotask.') + '\">needs mapping</span></div>';\n  }\n  if (st === 'error') {\n    return '<div class=\"planline\"><span class=\"plan err\" title=\"' +\n      attr('Autotask could not be read for this line, so nothing can be said about it: ' +\n        (l.plan_error || 'no message')) + '\">check failed</span></div>';\n  }\n\n  var chips = [];\n  if (l.plan_service_action === 'create') {\n    chips.push('<span class=\"plan do\" title=\"' + attr('No Autotask service carries the SKU ' +\n      (l.service_key || '') + ' yet, so the sync will create one.') + '\">new service</span>');\n  } else if (l.plan_service_action === 'rename') {\n    chips.push('<span class=\"plan do\" title=\"' + attr('The service exists but its name has drifted ' +\n      'from the current stock description; the sync will rename it in place.') + '\">rename service</span>');\n  } else if (l.autotask_service_id) {\n    chips.push('<span class=\"plan flat\" title=\"' + attr('Autotask service #' + l.autotask_service_id +\n      ', matched on its SKU field.') + '\">service exists</span>');\n  }\n\n  var pr = planPrice(l);\n  var suffix = periodSuffix(l);\n  if (l.plan_cs_action === 'create' || pr.kind === 'add') {\n    chips.push('<span class=\"plan do\" title=\"' + attr('This service is not on the contract yet; the ' +\n      'sync will add it at the sell price on this screen.') + '\">will be added @ ' +\n      escapeHtml(money(pr.to)) + suffix + '</span>');\n  } else if (pr.kind === 'change') {\n    chips.push('<span class=\"plan price\" title=\"' + attr('The contract charges ' + money(pr.from) +\n      ' today; the sync would set ' + money(pr.to) +\n      (l.use_custom_price ? ' - the price typed on this screen.' :\n        ' - the RRP, which is what the sync uses when no price has been set here. ' +\n        'Set a custom price to keep the current one.') +\n      ' Effective ' + (l.price_effective_date || 'today') + '.') +\n      '\">re-price ' + escapeHtml(money(pr.from)) + ' &rarr; ' + escapeHtml(money(pr.to)) + suffix + '</span>');\n  } else if (l.plan_cs_action === 'redescribe') {\n    chips.push('<span class=\"plan price\" title=\"' + attr('The wording on the invoice line will be ' +\n      'set to: ' + invoiceDesc(l).text) + '\">new invoice text</span>');\n  }\n\n  var steps = planUnits(l);\n  if (steps.length) {\n    chips.push('<span class=\"plan do\" title=\"' + attr('Autotask holds ' + (l.plan_current_units || 0) +\n      ' units; the report says ' + (l.plan_target_units || 0) + '. The sync posts ' + steps.length +\n      ' adjustment' + (steps.length > 1 ? 's' : '') + ' dated from the report: ' +\n      (l.plan_units_summary || '') + '. Open the row for the dates.') + '\">units ' +\n      escapeHtml(String(l.plan_current_units || 0)) + ' &rarr; ' +\n      escapeHtml(String(l.plan_target_units || 0)) + '</span>');\n  }\n\n  var doing = chips.filter(function (c) { return c.indexOf('plan flat') < 0; }).length;\n  if (!doing) {\n    return '<div class=\"planline\"><span class=\"plan flat\" title=\"' +\n      attr('Autotask already matches this line - the sync would post nothing for it. Checked ' +\n        String(l.plan_checked_at).slice(0, 16).replace('T', ' ') + ' UTC.') +\n      '\">nothing to do</span></div>';\n  }\n  return '<div class=\"planline\">' + chips.join('<span class=\"sep\">&middot;</span>') + '</div>';\n}\n\n// The same plan, spelled out with its dates, inside the row's drawer.\nfunction planDetailHtml(l) {\n  if (!effInclude(l) || !hasPlan(l)) return '';\n  // The same rule the chips follow, and the reason 04 records a status at\n  // all: when the lookup failed or the customer is unmapped, NO plan was\n  // made. The actions below would otherwise read a missing contract service\n  // id as \"not there yet\" and spell out an addition nobody has established\n  // is needed - which is how you end up approving a duplicate.\n  var st = String(l.plan_status || '');\n  if (st === 'error') {\n    return '<div class=\"dsec\">What the sync will do</div>' +\n      '<div class=\"dline\"><span class=\"muted\">Not known \u2014 Autotask could not be read for this ' +\n      'service.</span></div><div class=\"dfoot\">' + escapeHtml(String(l.plan_error || '')) +\n      '<br>Press Check Autotask to try again.</div>';\n  }\n  if (st === 'needs_mapping') {\n    return '<div class=\"dsec\">What the sync will do</div>' +\n      '<div class=\"dline\"><span class=\"muted\">Nothing yet \u2014 this customer is not mapped to an ' +\n      'Autotask company, so there is no company to plan against.</span></div>' +\n      '<div class=\"dfoot\">Map it in the customer header above, then press Check Autotask.</div>';\n  }\n  var rows = [];\n  function step(when, tag, what) {\n    rows.push('<div class=\"dline\"><span class=\"when\">' + escapeHtml(when) + '</span>' +\n      '<span class=\"dtag\">' + escapeHtml(tag) + '</span>' +\n      '<span class=\"muted\">' + what + '</span></div>');\n  }\n  if (l.plan_service_action === 'create') step('\u2014', 'service', 'create ' + escapeHtml(l.service_name || ''));\n  else if (l.plan_service_action === 'rename') step('\u2014', 'service', 'rename to ' + escapeHtml(l.service_name || ''));\n  if (l.plan_contract_action === 'create') step('\u2014', 'contract', 'create ' + escapeHtml(l.contract_name || ''));\n  else if (l.plan_contract_action === 'extend') {\n    step(longDateIso(l.plan_contract_end), 'contract', 'extend the end date to cover this term');\n  }\n  var pr = planPrice(l);\n  if (l.plan_cs_action === 'create' || pr.kind === 'add') {\n    step(longDateIso(l.price_effective_date), 'service', 'add to the contract at ' + escapeHtml(money(pr.to)));\n  } else if (pr.kind === 'change') {\n    step(longDateIso(l.price_effective_date), 'price',\n      escapeHtml(money(pr.from)) + ' &rarr; ' + escapeHtml(money(pr.to)));\n  }\n  planUnits(l).forEach(function (u) {\n    step(longDateIso(u.date), 'units', escapeHtml(signed(u.change)) + ' units');\n  });\n  if (!rows.length) rows.push('<div class=\"dline\"><span class=\"muted\">Autotask already matches ' +\n    'this line \u2014 nothing would be posted.</span></div>');\n\n  var foot = 'Read from Autotask ' + escapeHtml(String(l.plan_checked_at).slice(0, 16).replace('T', ' ')) +\n    ' UTC, without changing anything. Press Check Autotask to read it again.';\n  if (String(l.plan_status || '') === 'error') {\n    foot = 'The check failed, so this is incomplete: ' + escapeHtml(String(l.plan_error || ''));\n  }\n  return '<div class=\"dsec\">What the sync will do</div>' + rows.join('') +\n    '<div class=\"dfoot\">' + foot + '</div>';\n}\n\n// A green \"synced\" badge on every healthy row is just noise; only the rows\n// that need a human get a badge.\nfunction syncHtml(l) {\n  var st = String(l.sync_status || 'pending');\n  var msg = l.sync_message ? String(l.sync_message).slice(0, 200) : '';\n  if (st === 'synced') {\n    return '<span class=\"ok-tick\" title=\"Synced to Autotask' + (msg ? ' \u2014 ' + attr(msg) : '') + '\">&#10003;</span>';\n  }\n  return '<span class=\"badge ' + escapeHtml(st) + '\"' + (msg ? ' title=\"' + attr(msg) + '\"' : '') +\n    '>' + escapeHtml(st) + '</span>';\n}\n\n// The last charge Autotask has actually approved & posted for this service,\n// read live from BillingItems, with the invoice it landed on if it has been\n// invoiced since. The invoice number links straight into Autotask's invoice\n// viewer - see INVOICE_URL at the top of this script.\nfunction lastPostedHtml(l) {\n  if (!l.billing_last_date) {\n    return '<div class=\"dnone\">Nothing has been approved &amp; posted for this service yet.</div>';\n  }\n  var rows = Number(l.billing_last_rows) || 1;\n  var qty = Number(l.billing_last_qty) || 0;\n  var inv = String(l.billing_last_invoice_number || '');\n  var invId = String(l.billing_last_invoice_id || '');\n  var through = postedThroughIso(l);\n  var line = '<div class=\"dline posted\"><span class=\"when\">' +\n    escapeHtml(longDateIso(l.billing_last_date) +\n      (through ? ' \u2192 ' + longDateIso(through) : '')) + '</span>' +\n    '<span class=\"dtag\">' + (inv || invId ? 'invoiced' : 'posted') + '</span>' +\n    '<span class=\"muted\">qty ' + escapeHtml(String(qty)) +\n      (rows > 1 ? ' \u00b7 ' + rows + ' items' : '') + '</span>' +\n    '<span class=\"amt\">' + money(l.billing_last_amount) + '</span></div>';\n  var bits = [];\n  if (l.billing_last_posted_on) bits.push('posted ' + longDateIso(l.billing_last_posted_on));\n  if (through) bits.push('billed the period ending ' + longDateIso(through));\n  if (inv || invId) {\n    bits.push('invoice ' + invoiceLink(invId, inv) +\n      (l.billing_last_invoice_date ? ' of ' + escapeHtml(longDateIso(l.billing_last_invoice_date)) : ''));\n  } else {\n    bits.push('not invoiced yet');\n  }\n  return line + '<div class=\"dfoot\">' + bits.join(' \u00b7 ') + '</div>';\n}\n\n// The breakdown behind the billing pill \u2014 hidden until asked for.\nfunction detailHtml(l) {\n  if (!effInclude(l)) return '';\n  var items = pendingItems(l);\n  var rows = items.map(function (x) {\n    var when = longDateIso(x.s) + (x.e ? ' \u2192 ' + longDateIso(x.e) : '');\n    var tag = x.type === 'cycle' ? 'cycle' : (x.type === 'pro-rata' ? 'prorata' : '');\n    return '<div class=\"dline\"><span class=\"when\">' + escapeHtml(when) + '</span>' +\n      '<span class=\"dtag ' + tag + '\">' + escapeHtml(x.type) + '</span>' +\n      '<span class=\"muted\">qty ' + escapeHtml(String(x.q)) + '</span>' +\n      '<span class=\"amt\">' + money(x.amount) + '</span></div>';\n  }).join('');\n  var nothingPending = !items.filter(function (x) { return x.type !== 'next cycle'; }).length;\n  var everPosted = !!lastPostedIso(l);\n  var checked = !!l.billing_last;\n  var foot;\n  if (!nothingPending && !checked) {\n    foot = 'Estimated at the sell price on this screen. Autotask has not been read for this ' +\n      'service yet, so none of it can be shown as already posted - run a sync for that.';\n  } else if (!nothingPending) {\n    foot = 'Estimated at the sell price on this screen.';\n  } else if (everPosted) {\n    foot = 'The whole CSP report is posted for this service \u2014 the line above is next cycle&#39;s estimate.';\n  } else {\n    foot = 'This subscription has no charges in the CSP report yet \u2014 the line above is what the first ' +\n      'cycle is expected to bill.';\n  }\n  return '<tr class=\"detail\" data-d=\"' + l._i + '\"><td colspan=\"10\"><div class=\"dpanel\">' +\n    planDetailHtml(l) +\n    '<div class=\"dsec\">' + (nothingPending\n      ? 'Next cycle (estimate)'\n      : (checked ? 'Waiting to be approved &amp; posted' : 'Charged by this month&#39;s CSP report')) + '</div>' +\n    rows +\n    '<div class=\"dfoot\">' + foot + '</div>' +\n    '<div class=\"dsec\">Last approved &amp; posted</div>' +\n    lastPostedHtml(l) +\n    '</div></td></tr>';\n}\n\n// Documented Autotask deep link: opens the contract's Summary page in the\n// ww31 zone (Approve & Post for its charges is one click from there).\nfunction contractLink(contractId) {\n  return '<a class=\"atlink\" target=\"_blank\" rel=\"noopener\" onclick=\"event.stopPropagation()\" ' +\n    'href=\"https://ww31.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenContract&amp;ContractID=' +\n    encodeURIComponent(contractId) + '\">Open #' + escapeHtml(String(contractId)) + ' &#8599;</a>';\n}\n\n// Labelled with the invoice NUMBER, because that is what appears on the\n// customer's invoice and in Autotask's own lists; the internal id only ever\n// goes in the URL. Without an internal id there is nothing to link to, so the\n// number stays text however INVOICE_URL is set.\nfunction invoiceLink(invoiceId, invoiceNumber) {\n  var label = escapeHtml(String(invoiceNumber || invoiceId));\n  if (!INVOICE_URL || !invoiceId) {\n    return '<span class=\"inv-no\" title=\"Open Billing &gt; Invoices in Autotask and ' +\n      'search this number\">' + label + '</span>';\n  }\n  var href = INVOICE_URL\n    .replace('{id}', encodeURIComponent(String(invoiceId)))\n    .replace('{number}', encodeURIComponent(String(invoiceNumber || '')));\n  return '<a class=\"atlink\" target=\"_blank\" rel=\"noopener\" onclick=\"event.stopPropagation()\" ' +\n    'href=\"' + attr(href) + '\" title=\"Open invoice ' + attr(label) + ' in Autotask\">' +\n    label + ' &#8599;</a>';\n}\n\nfunction mapperHtml(tenantName) {\n  return '<span class=\"map-box\" onclick=\"event.stopPropagation()\">' +\n    '<input type=\"text\" class=\"js-map\" data-t=\"' + attr(tenantName) + '\" placeholder=\"Search Autotask companies\u2026\">' +\n    '<div class=\"map-results\" style=\"display:none\"></div></span>';\n}\n\n/* ============================================================\n   Wiring \u2014 handlers are attached after each render.\n   ============================================================ */\nfunction wire() {\n  each('.js-toggle', function (el) {\n    el.onclick = function () {\n      var k = el.getAttribute('data-key');\n      UI.closed[k] = !UI.closed[k];\n      if (!UI.closed[k]) delete UI.closed[k];\n      persist();\n      var sec = el.parentNode;\n      sec.className = sec.className.replace(/ ?collapsed/, '') + (UI.closed[k] ? ' collapsed' : '');\n    };\n  });\n\n  each('.js-incl', function (el) {\n    el.onchange = function () {\n      setIncluded(el, el.checked);\n      refreshPickAll(el);\n      renderStats(LINES.filter(matches));\n    };\n  });\n\n  each('.js-inclall', function (el) {\n    refreshPickAll(el);\n    el.onchange = function () {\n      // A partly included customer shows as indeterminate, and a click on\n      // that resolves to checked - so the first click includes the rest, and\n      // the second clears the lot. Only the rows on screen are touched: the\n      // filter decides what this customer currently is.\n      var boxes = customerOf(el).querySelectorAll('.js-incl');\n      for (var i = 0; i < boxes.length; i++) setIncluded(boxes[i], el.checked);\n      refreshPickAll(el);\n      renderStats(LINES.filter(matches));\n    };\n  });\n\n  each('.js-bill', function (el) {\n    el.onclick = function () {\n      var d = document.querySelector('tr.detail[data-d=\"' + el.getAttribute('data-i') + '\"]');\n      if (d) d.className = d.className.indexOf('open') >= 0 ? 'detail' : 'detail open';\n    };\n  });\n\n  each('.js-edit', function (el) {\n    el.onclick = function () { setEditing(+el.getAttribute('data-i'), true); };\n  });\n  each('.js-cancel', function (el) {\n    el.onclick = function () { setEditing(+el.getAttribute('data-i'), false); };\n  });\n  each('.js-sell', function (el) {\n    el.onchange = function () {\n      var l = LINES[+el.getAttribute('data-i')];\n      l.sell_price = Number(el.value);\n      refreshLine(l);\n    };\n  });\n  each('.js-date', function (el) {\n    el.onchange = function () { LINES[+el.getAttribute('data-i')].price_effective_date = el.value; };\n  });\n  each('.js-pick', function (el) {\n    el.onclick = function () {\n      var l = LINES[+el.getAttribute('data-i')];\n      var d;\n      if (el.getAttribute('data-p') === 'start') {\n        d = groupContract(l).start;\n      } else {\n        var items = pendingItems(l), hit = '';\n        for (var i = 0; i < items.length; i++) {\n          if (items[i].type === 'cycle' || items[i].type === 'next cycle') { hit = items[i].s; break; }\n        }\n        d = hit || (items.length ? items[0].s : '');\n      }\n      if (!d) return;\n      l.price_effective_date = d;\n      var input = document.querySelector('.js-date[data-i=\"' + l._i + '\"]');\n      if (input) input.value = d;\n    };\n  });\n\n  each('.js-invedit', function (el) {\n    el.onclick = function () { setInvEditing(+el.getAttribute('data-i'), true); };\n  });\n  each('.js-invdone', function (el) {\n    el.onclick = function () { setInvEditing(+el.getAttribute('data-i'), false); };\n  });\n  each('.js-invreset', function (el) {\n    el.onclick = function () {\n      var i = +el.getAttribute('data-i');\n      LINES[i].invoice_description = '';\n      var input = document.querySelector('.js-invtext[data-i=\"' + i + '\"]');\n      if (input) input.value = defaultInvoiceDesc(LINES[i]);\n      setInvEditing(i, false);\n    };\n  });\n  each('.js-invtext', function (el) {\n    var i = +el.getAttribute('data-i');\n    var count = function () {\n      var c = document.querySelector('[data-invcount=\"' + i + '\"]');\n      if (c) c.textContent = el.value.length + '/100';\n    };\n    var edited = function () {\n      var l = LINES[i];\n      var v = el.value.trim();\n      // An override only means \"different from what Autotask would otherwise\n      // show\" - typing back the live text or the generated default clears it.\n      // Only a real edit assigns; the initial value never does, or every line\n      // whose Autotask wording differs from the default would look overridden.\n      l.invoice_description = (v === defaultInvoiceDesc(l) || v === liveInvoiceDesc(l)) ? '' : v;\n      count();\n    };\n    el.oninput = edited;\n    el.onchange = edited;\n    count();\n  });\n\n  each('.js-map', function (el) { wireMapper(el); });\n}\n\nfunction setInvEditing(i, on) {\n  var cell = document.querySelector('tr.line[data-i=\"' + i + '\"] td:nth-child(2)');\n  if (cell) cell.className = on ? 'inv-open' : '';\n  var input = document.querySelector('.js-invtext[data-i=\"' + i + '\"]');\n  if (on && input) { input.focus(); input.select(); }\n  if (!on) refreshInvoice(LINES[i]);\n}\n\nfunction refreshInvoice(l) {\n  var d = invoiceDesc(l);\n  var btn = document.querySelector('.js-invedit[data-i=\"' + l._i + '\"]');\n  if (!btn) return;\n  btn.className = 'invtext ' + d.state + ' js-invedit';\n  btn.textContent = d.text;\n  var lbl = btn.parentNode.firstChild;\n  if (lbl) lbl.textContent = 'Invoice' + (d.state === 'default' ? ' (unset)' : '');\n}\n\nfunction setEditing(i, on) {\n  var l = LINES[i];\n  l.use_custom_price = on;\n  if (!on) {\n    // Unticking does NOT change anything in Autotask: the contract keeps its\n    // current price, which is what we show.\n    l.sell_price = null;\n    l.price_effective_date = TODAY;\n    var d = document.querySelector('.js-date[data-i=\"' + i + '\"]');\n    if (d) d.value = TODAY;\n  }\n  var cell = document.querySelector('td.sell[data-i=\"' + i + '\"]');\n  if (cell) cell.className = 'num sell' + (on ? ' editing' : '');\n  var input = document.querySelector('.js-sell[data-i=\"' + i + '\"]');\n  if (input) { input.value = fmt(effSell(l)); if (on) { input.focus(); input.select(); } }\n  refreshLine(l);\n}\n\nfunction refreshLine(l) {\n  var m = marginPct(l);\n  var el = document.querySelector('[data-marg=\"' + l._i + '\"]');\n  if (el) {\n    el.className = 'marg ' + marginClass(m);\n    el.textContent = m === null ? '\u2014' : m.toFixed(1) + '%';\n  }\n  var view = document.querySelector('td.sell[data-i=\"' + l._i + '\"] .sellview .amt');\n  if (view) {\n    view.className = 'amt js-edit' + (l.use_custom_price ? ' custom' : '');\n    view.innerHTML = fmt(effSell(l)) + '<span class=\"per\">' + periodSuffix(l) + '</span>';\n  }\n  renderStats(LINES.filter(matches));\n}\n\nfunction wireMapper(input) {\n  var results = input.nextSibling;\n  var tenantName = input.getAttribute('data-t');\n  var timer;\n  input.oninput = function () {\n    clearTimeout(timer);\n    var q = input.value.trim();\n    if (q.length < 2) { results.style.display = 'none'; return; }\n    timer = setTimeout(function () {\n      fetch(BASE + '/csp-pricing-companies?q=' + encodeURIComponent(q),\n        { credentials: 'same-origin' })\n        .then(function (r) {\n          if (r.status === 401) throw expiredError();\n          return r.json();\n        })\n        .then(function (list) {\n          results.innerHTML = '';\n          (list.companies || []).forEach(function (c) {\n            var el = document.createElement('div');\n            el.textContent = c.name + ' (#' + c.id + ')';\n            el.onclick = function () { saveMapping(tenantName, c); };\n            results.appendChild(el);\n          });\n          if (!(list.companies || []).length) results.innerHTML = '<div class=\"muted\">No matches</div>';\n          results.style.display = 'block';\n        })\n        .catch(function (e) {\n          results.innerHTML = '<div class=\"muted\">' + escapeHtml(e.message) + '</div>';\n          results.style.display = 'block';\n        });\n    }, 350);\n  };\n}\n\nfunction saveMapping(tenantName, company) {\n  fetch(BASE + '/csp-pricing-mapping', {\n    method: 'POST', headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ tenant_name: tenantName, autotask_company_id: company.id, autotask_company_name: company.name })\n  }).then(function () { location.reload(); });\n}\n\n/* ============================================================\n   Filters, save, sync\n   ============================================================ */\nfunction setAll(open) {\n  if (open) { UI.closed = {}; }\n  else {\n    UI.closed = {};\n    LINES.forEach(function (l) {\n      UI.closed['c:' + l.tenant_name] = true;\n      var n = groupContract(l).name;\n      UI.closed['k:' + l.tenant_name + '|' + n] = true;\n    });\n  }\n  persist();\n  render();\n}\n\nvar qTimer;\ndocument.getElementById('q').oninput = function () {\n  var el = this;\n  clearTimeout(qTimer);\n  qTimer = setTimeout(function () {\n    UI.q = el.value.trim().toLowerCase();\n    render();\n    el.focus();\n  }, 180);\n};\ndocument.getElementById('onlyDue').onchange = function () { UI.onlyDue = this.checked; render(); };\ndocument.getElementById('onlyOff').checked = true;\ndocument.getElementById('onlyOff').onchange = function () { UI.showOff = this.checked; render(); };\n\nfunction savePayload() {\n  return LINES.map(function (l) {\n    return {\n      subscription_id: l.subscription_id, stock_code: l.stock_code,\n      use_custom_price: !!l.use_custom_price,\n      sell_price: l.use_custom_price ? Number(l.sell_price !== null && l.sell_price !== undefined ? l.sell_price : periodRrp(l)) : null,\n      include: effInclude(l),\n      price_effective_date: l.price_effective_date || '',\n      invoice_description: customInvoiceDesc(l)\n    };\n  });\n}\n\n// A 401 means the sign-in session ran out while this page sat open. Say so\n// plainly: the alternative is \"Saved 0 lines\", which reads like the save\n// worked and there was simply nothing to do.\nfunction expiredError() {\n  return new Error('Your session has expired \u2014 reload the page and sign in again.');\n}\nfunction doSave() {\n  return fetch(BASE + '/csp-pricing-save', {\n    method: 'POST', headers: { 'Content-Type': 'application/json' },\n    credentials: 'same-origin',\n    body: JSON.stringify({ lines: savePayload() })\n  }).then(function (r) {\n    if (r.status === 401) throw expiredError();\n    return r.json();\n  });\n}\nfunction signOut() {\n  fetch(BASE + '/csp-auth-signout', { method: 'POST', credentials: 'same-origin' })\n    .then(function () { location.reload(); })\n    .catch(function () { location.reload(); });\n}\n\n// How many lines are carrying wording of your own, so a save visibly\n// accounts for them rather than just reporting a row count.\nfunction customDescCount() {\n  return LINES.filter(function (l) { return customInvoiceDesc(l); }).length;\n}\nfunction savedMsg(res) {\n  var n = customDescCount();\n  return 'Saved ' + (res.updated || 0) + ' lines' +\n    (n ? ', ' + n + ' with your own invoice description' : '') + '.';\n}\n\nfunction saveAll(btn) {\n  btn.disabled = true;\n  setMsg('Saving\u2026');\n  doSave()\n    .then(function (res) { setMsg(savedMsg(res)); btn.disabled = false; })\n    .catch(function (e) { setMsg('Save failed: ' + e.message); btn.disabled = false; });\n}\n\n// The dry run: workflow 04 reads Autotask and records what a sync WOULD do,\n// writing nothing to Autotask at all. It saves the on-screen prices first for\n// the same reason the sync does - the plan is made against what is stored, so\n// a price still sitting in an input box would be planned around rather than\n// planned for.\n//\n// It takes as long as a sync does (the same four queries a line, against the\n// same three-thread limit) and answers into the table rather than to this\n// page, so there is nothing to await - refresh when it has had its couple of\n// minutes. The import runs it too, so most of the time the plan is already\n// there when this page opens.\nfunction checkAutotask(btn) {\n  btn.disabled = true;\n  setMsg('Saving prices\u2026');\n  doSave()\n    .then(function (res) {\n      setMsg(savedMsg(res) + ' Checking Autotask\u2026');\n      return fetch(BASE + '/csp-autotask-plan', { method: 'POST' });\n    })\n    .then(function () {\n      setMsg('Checking Autotask \u2014 ~2\u20133 minutes, nothing is being changed. Refresh after that.');\n      btn.disabled = false;\n    })\n    .catch(function (e) { setMsg('Check could not start: ' + e.message); btn.disabled = false; });\n}\n\n// Sync ALWAYS saves the on-screen prices first, so what you see is what\n// gets pushed to Autotask.\nfunction syncNow(btn) {\n  if (!confirm('Push included lines to Autotask now?\\n\\nPrices on screen are saved automatically, then contracts and services are created/updated.')) return;\n  btn.disabled = true;\n  setMsg('Saving prices\u2026');\n  doSave()\n    .then(function (res) {\n      setMsg(savedMsg(res) + ' Starting sync\u2026');\n      return fetch(BASE + '/csp-autotask-sync', { method: 'POST' });\n    })\n    .then(function () { setMsg('Sync running \u2014 ~2\u20133 minutes. Refresh after that to see results.'); btn.disabled = false; })\n    .catch(function (e) { setMsg('Sync could not start: ' + e.message); btn.disabled = false; });\n}\n\nfunction setMsg(t) { document.getElementById('msg').textContent = t; }\nfunction each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }\nfunction escapeHtml(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }\n// escapeHtml leaves double quotes alone, which is fine for text but breaks\n// out of a quoted attribute. Anything going into an attribute uses this.\nfunction attr(s) { return escapeHtml(s).replace(/\"/g, '&quot;'); }\n\nrender();\n</script>\n</body>\n</html>\n" }]
      }
    }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const buildPage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Portal Page',
    position: [340, -240],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Serve the pricing portal: inject subscription lines + customer mappings\n// into the page from the Portal Template node, as base64 JSON.\nlet lines = [];\nlet mappings = [];\ntry {\n  lines = $('Fetch Lines').all().map((i) => i.json).filter((j) => j.subscription_id);\n} catch (e) { /* table empty */ }\ntry {\n  mappings = $('Fetch Mappings').all().map((i) => i.json).filter((j) => j.tenant_name);\n} catch (e) { /* table empty */ }\n\n// Overlay what Autotask holds right now. Anything edited directly in\n// Autotask therefore shows on a plain page refresh, without waiting for a\n// sync. If the query failed the overlay is simply empty.\nlet live = [];\ntry {\n  live = ($('Fetch Live Services').first().json.items) || [];\n} catch (e) { /* Autotask unreachable - fall back to the stored values */ }\n\n// Same conversion as the sync's CS Decision: the query returns only the\n// internal-currency price, scaled by this instance's currency factor, which\n// is internalCurrencyUnitPrice / unitPrice.\nfunction livePrice(c) {\n  if (c.adjustedPrice !== undefined && c.adjustedPrice !== null) return Number(c.adjustedPrice);\n  if (Number(c.internalCurrencyAdjustedPrice) === 0) return 0;\n  const mult = Number(c.internalCurrencyUnitPrice) / Number(c.unitPrice);\n  if (c.internalCurrencyAdjustedPrice !== undefined && c.internalCurrencyAdjustedPrice !== null\n      && isFinite(mult) && mult > 0) {\n    return Math.round((Number(c.internalCurrencyAdjustedPrice) / mult) * 100) / 100;\n  }\n  return null;\n}\n\nconst byCsId = {};\nfor (const c of live) byCsId[String(c.id)] = c;\n\n// What Autotask has already approved & posted, per contract service. A\n// BillingItem exists only once a charge has been through Approve & Post.\n// invoiceID is 0 until the posting reaches an invoice.\nlet billing = [];\ntry {\n  billing = ($('Fetch Billing Items').first().json.items) || [];\n} catch (e) { /* Autotask unreachable - the stored value stands */ }\nlet invoices = [];\ntry {\n  invoices = ($('Fetch Invoices').first().json.items) || [];\n} catch (e) { /* no invoices to resolve */ }\n\nconst invoiceById = {};\nfor (const v of invoices) invoiceById[String(v.id)] = v;\n\nfunction itemAmount(b) {\n  const t = b.totalAmount !== undefined && b.totalAmount !== null ? Number(b.totalAmount)\n    : (b.extendedPrice !== undefined && b.extendedPrice !== null ? Number(b.extendedPrice) : NaN);\n  return isNaN(t) ? 0 : t;\n}\n\n// Autotask bills a contract service one PERIOD at a time and dates the item\n// at the period start - but it can raise a SECOND item inside the same\n// period for a mid-cycle change, dated the day the seats moved (Kantanna's\n// Copilot Business line has one on 18 Jun beside the 1 Jun cycle charge).\n// Grouping on contractServicePeriodID keeps a period's rows together, so the\n// last posting is the last PERIOD and its totals - not whichever single row\n// happens to carry the newest date, which for a mid-cycle adjustment would\n// read as a period starting halfway through the month.\nconst periods = {};\nfor (const b of billing) {\n  if (b.contractServiceID === undefined || b.contractServiceID === null) continue;\n  const date = String(b.itemDate || '').slice(0, 10);\n  if (!date) continue;\n  const key = String(b.contractServiceID);\n  // No period id (an ad-hoc charge) means the row stands on its own.\n  const pk = b.contractServicePeriodID !== undefined && b.contractServicePeriodID !== null\n    ? 'p' + b.contractServicePeriodID : 'd' + date;\n  const byPeriod = periods[key] || (periods[key] = {});\n  const e = byPeriod[pk] || (byPeriod[pk] =\n    { date: date, amount: 0, qty: 0, rows: 0, posted_on: '', invoice_id: 0 });\n  // A period starts at its earliest item; a later row is a change within it.\n  if (date < e.date) e.date = date;\n  e.amount = Math.round((e.amount + itemAmount(b)) * 100) / 100;\n  e.qty += Number(b.quantity || 0);\n  e.rows += 1;\n  const on = String(b.postedOnTime || b.postedDate || '').slice(0, 10);\n  if (on > e.posted_on) e.posted_on = on;\n  if (Number(b.invoiceID) > 0) e.invoice_id = Number(b.invoiceID);\n}\nconst postedByCs = {};\nfor (const key of Object.keys(periods)) {\n  let best = null;\n  for (const pk of Object.keys(periods[key])) {\n    const g = periods[key][pk];\n    if (!best || g.date > best.date) best = g;\n  }\n  if (best) postedByCs[key] = best;\n}\n\nlines = lines.map((l) => {\n  const c = byCsId[String(l.autotask_contract_service_id)];\n  if (!c) return l;\n  const out = Object.assign({}, l);\n  if (c.invoiceDescription !== undefined && c.invoiceDescription !== null) {\n    const liveDesc = String(c.invoiceDescription);\n    const syncedDesc = String(l.contract_invoice_description || '');\n    // Autotask is the source of truth. If the description there no longer\n    // matches what the last sync pushed, someone edited it by hand, so the\n    // stored portal override is stale and is dropped: the page shows what\n    // Autotask actually holds. An override that has not been pushed yet\n    // (Autotask still matches what we last sent) survives untouched.\n    if (syncedDesc && liveDesc !== syncedDesc) out.invoice_description = '';\n    out.contract_invoice_description = liveDesc;\n  }\n  const p = livePrice(c);\n  if (p !== null) out.contract_price = p;\n\n  // The last Approve & Post for this service, and the invoice it landed on.\n  const post = postedByCs[String(l.autotask_contract_service_id)];\n  if (post) {\n    out.billing_last = post.date + ' \u00b7 $' + post.amount.toFixed(2)\n      + (post.invoice_id ? ' \u00b7 invoiced' : ' \u00b7 posted');\n    out.billing_last_date = post.date;\n    out.billing_last_amount = post.amount;\n    out.billing_last_qty = post.qty;\n    out.billing_last_rows = post.rows;\n    out.billing_last_posted_on = post.posted_on;\n    const inv = post.invoice_id ? invoiceById[String(post.invoice_id)] : null;\n    out.billing_last_invoice_id = post.invoice_id || '';\n    out.billing_last_invoice_number = inv && inv.invoiceNumber != null ? String(inv.invoiceNumber) : '';\n    out.billing_last_invoice_date = inv ? String(inv.invoiceDateTime || '').slice(0, 10) : '';\n  }\n  return out;\n});\n\nconst payload = { lines: lines, mappings: mappings };\nconst encoded = Buffer.from(JSON.stringify(payload)).toString('base64');\nconst html = $('Portal Template').first().json.html\n  .replace('__DATA_PLACEHOLDER__', encoded);\nreturn [{ json: { html: html } }];\n" }
  },
  output: [{ html: '<!DOCTYPE html>...' }]
});


const attachToken = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Attach Session Token',
    position: [460, -160],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Hand the rendered portal its session token.\n//\n// The page got here through a top-level navigation, so the browser sent the\n// session cookie and the gate let it through. Its own background calls are a\n// different matter: n8n Cloud serves every webhook response under\n// Content-Security-Policy: sandbox with no allow-same-origin, which puts the\n// page in an opaque origin. From there a fetch() back to our own host counts\n// as third-party and carries no cookies at all.\n//\n// So the token is injected into the page and fetch is wrapped to attach it,\n// which the gate accepts as an alternative to the cookie. Done here rather\n// than inside portal.html so the page stays a plain document that knows\n// nothing about sessions, and the whole scheme sits in one file.\nconst html = $input.first().json.html;\n\nlet token = '';\ntry { token = String($('Check Access Portal').first().json.token || ''); } catch (e) { /* none */ }\nif (!token) return [{ json: { html: html } }];\n\nconst shim =\n  '<script>(function () {\\n' +\n  '  var T = ' + JSON.stringify(token) + ';\\n' +\n  '  var real = window.fetch;\\n' +\n  '  window.fetch = function (url, opts) {\\n' +\n  '    if (typeof url === \"string\" && url.indexOf(\"/csp-\") >= 0) {\\n' +\n  '      url += (url.indexOf(\"?\") < 0 ? \"?\" : \"&\") + \"t=\" + encodeURIComponent(T);\\n' +\n  '    }\\n' +\n  '    return real(url, opts);\\n' +\n  '  };\\n' +\n  '})();<\\/script>';\n\nreturn [{ json: { html: html.replace('</head>', shim + '</head>') } }];\n" }
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
      // No caching: the page carries the current pricing data and the current
      // portal code, so a browser-cached copy would silently show stale lines.
      options: { responseHeaders: { entries: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store, must-revalidate' }
      ] } }
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
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Turn the portal's save payload into one item per line for the update node.\n// Read the request off the webhook by name, not off whatever happens to be\n// the previous node - the access gate now sits between the two.\nconst req = $('Save Pricing').first().json;\nconst body = req.body || req;\nconst lines = body.lines || [];\nif (!lines.length) throw new Error('Save payload contained no lines.');\nfunction isoDate(v) {\n  return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(v || '')) ? String(v) : '';\n}\nreturn lines\n  .map((l) => ({ json: {\n    subscription_id: String(l.subscription_id || ''),\n    stock_code: String(l.stock_code || ''),\n    use_custom_price: !!l.use_custom_price,\n    sell_price: (l.sell_price === null || l.sell_price === undefined || l.sell_price === '')\n      ? null : Number(l.sell_price),\n    include: l.include !== false,\n    price_effective_date: isoDate(l.price_effective_date),\n    // Empty string means \"no override\" - the generated default is used.\n    invoice_description: String(l.invoice_description || '').trim().slice(0, 100),\n  } }))\n  .filter((i) => i.json.subscription_id);\n" }
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
          price_effective_date: expr('{{ $json.price_effective_date }}'),
          invoice_description: expr('{{ $json.invoice_description }}')
        },
        schema: [
          { id: 'use_custom_price', displayName: 'use_custom_price', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: false },
          { id: 'sell_price', displayName: 'sell_price', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'include', displayName: 'include', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: false },
          { id: 'price_effective_date', displayName: 'price_effective_date', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'invoice_description', displayName: 'invoice_description', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
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
          { keyName: 'tenant_name', condition: 'eq', keyValue: expr('{{ $(\'Save Mapping\').first().json.body.tenant_name }}') }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          tenant_name: expr('{{ $(\'Save Mapping\').first().json.body.tenant_name }}'),
          autotask_company_id: expr('{{ $(\'Save Mapping\').first().json.body.autotask_company_id }}'),
          autotask_company_name: expr('{{ $(\'Save Mapping\').first().json.body.autotask_company_name }}')
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
      redirectURL: 'https://gayleai.app.n8n.cloud/form/csp-monthly-upload',
      options: {}
    }
  }
});

// The uploaded tabs, served verbatim. ?sheet=annuity | invoice.
//
// NOT plain "csp-report": something else on this instance already holds that
// path and n8n refuses to publish a second workflow claiming it. Namespacing
// under csp-pricing- keeps it with the portal's other routes, which is where
// it belongs anyway.
const reportView = node({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: {
    name: 'Report View',
    position: [-360, 960],
    webhookId: 'csp-report-view',
    parameters: { httpMethod: 'GET', path: 'csp-pricing-source', responseMode: 'responseNode', options: { ignoreBots: true } }
  },
  output: [{ query: { sheet: 'annuity' } }]
});

const fetchReportRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Report Rows',
    position: [-140, 960],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'bMh0poIYCCOyVsAj', cachedResultName: 'csp_report_rows' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, sheet: 'annuity', row_no: 1, data: '{"TENANT ID":"211C4C89-…"}', source_file: 'Annuity_Information.xlsx', imported_at: '2026-08-29T08:14:15.039Z' }]
});

const reportTemplate = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Report Template',
    position: [80, 960],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [{ id: 'report-html', name: 'html', type: 'string', value: "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>__FILE__ &middot; __TAB__</title>\n<style>\n  :root {\n    --bg:#f1f4f8; --card:#fff; --ink:#0f172a; --ink2:#334155; --muted:#64748b;\n    --line:#e2e8f0; --line2:#eef2f7; --brand:#2563eb;\n  }\n  * { box-sizing:border-box; }\n  body {\n    margin:0; background:var(--bg); color:var(--ink);\n    font:15px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;\n  }\n  .topbar {\n    position:sticky; top:0; z-index:40; background:#0d1b30; color:#fff;\n    display:flex; align-items:center; gap:20px; flex-wrap:wrap; padding:11px 22px;\n    box-shadow:0 1px 0 rgba(255,255,255,.06), 0 2px 12px rgba(13,27,48,.28);\n  }\n  .brand { display:flex; align-items:center; gap:12px; flex:1; min-width:260px; }\n  .logo { width:34px; height:34px; border-radius:9px; background:#2563eb; color:#fff;\n    display:grid; place-items:center; font-size:12px; font-weight:700; letter-spacing:.06em; }\n  .topbar h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:-.01em; }\n  .topbar p { margin:1px 0 0; font-size:12px; color:#9fb3d1; }\n  .topbar p a { color:#cfe0f7; text-decoration:none; border-bottom:1px solid rgba(207,224,247,.35); }\n  .topbar p a:hover { color:#fff; border-bottom-color:#fff; }\n  .actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }\n  .btn {\n    padding:7px 14px; border-radius:8px; border:1px solid rgba(255,255,255,.22);\n    background:rgba(255,255,255,.08); color:#e7eefb; cursor:pointer; font:inherit;\n    font-size:13.5px; font-weight:500; white-space:nowrap; text-decoration:none;\n  }\n  .btn:hover { background:rgba(255,255,255,.16); }\n\n  .wrap { padding:18px 22px 60px; }\n  .bar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px; }\n  .bar input {\n    flex:1; min-width:240px; max-width:420px; padding:8px 12px; font:inherit; font-size:13.5px;\n    border:1px solid var(--line); border-radius:8px; background:#fff;\n  }\n  .bar input:focus { outline:2px solid #bfdbfe; outline-offset:-1px; border-color:var(--brand); }\n  .count { font-size:12.5px; color:var(--muted); }\n\n  .sheet { background:var(--card); border:1px solid var(--line); border-radius:12px;\n    box-shadow:0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.06); overflow:auto; max-height:calc(100vh - 190px); }\n  table { border-collapse:separate; border-spacing:0; font-size:12.5px; }\n  /* The heading row stays put over a long tab, and the row number stays put\n     across a wide one - these tabs are 17 and 20 columns of unwrapped text. */\n  th {\n    position:sticky; top:0; z-index:2; background:#f8fafc; text-align:left;\n    font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;\n    color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap;\n  }\n  td { padding:7px 12px; border-bottom:1px solid var(--line2); vertical-align:top;\n    /* pre, not normal: the cells are shown as the sheet holds them, and Dicker\n       pads INVOICE NUMBER with leading spaces. */\n    white-space:pre; }\n  tr:hover td { background:#fafcff; }\n  .num { text-align:right; font-variant-numeric:tabular-nums; }\n  th.rn, td.rn {\n    position:sticky; left:0; z-index:1; background:#fff; color:#94a3b8;\n    text-align:right; font-variant-numeric:tabular-nums; font-size:11px;\n    border-right:1px solid var(--line2); white-space:nowrap;\n  }\n  th.rn { z-index:3; background:#f8fafc; }\n  tr:hover td.rn { background:#fafcff; }\n  tr.off { display:none; }\n  .empty { padding:56px 40px; text-align:center; color:var(--muted); font-size:13.5px;\n    background:var(--card); border:1px solid var(--line); border-radius:10px; }\n  .empty strong { display:block; margin-bottom:8px; color:var(--ink); font-size:15px; font-weight:600; }\n  .empty a { color:var(--brand); }\n  /* Nothing to show means no filter bar and no empty grid to squint at. */\n  .empty ~ .bar, .empty ~ .sheet { display:none; }\n</style>\n</head>\n<body>\n<header class=\"topbar\">\n  <div class=\"brand\">\n    <span class=\"logo\">CSP</span>\n    <div>\n      <h1>__FILE__ &middot; <span style=\"font-weight:400\">__TAB__ tab</span></h1>\n      <p>__PROVENANCE__</p>\n    </div>\n  </div>\n  <div class=\"actions\">\n    <a class=\"btn\" href=\"csp-pricing-source?sheet=__OTHER__\">__OTHERNAME__ &rarr;</a>\n    <a class=\"btn\" href=\"csp-pricing\">&larr; Back to the portal</a>\n  </div>\n</header>\n\n<div class=\"wrap\">\n  __EMPTY__\n  <div class=\"bar\">\n    <input id=\"q\" type=\"search\" placeholder=\"Filter rows&hellip;\" autocomplete=\"off\">\n    <span class=\"count\" id=\"count\"></span>\n  </div>\n  <div class=\"sheet\">\n    <table>\n      <thead>__THEAD__</thead>\n      <tbody id=\"rows\">__TBODY__</tbody>\n    </table>\n  </div>\n</div>\n\n<script>\nvar rows = Array.prototype.slice.call(document.querySelectorAll('#rows tr'));\nvar countEl = document.getElementById('count');\nfunction report(n) {\n  countEl.textContent = n === rows.length\n    ? rows.length + (rows.length === 1 ? ' row' : ' rows')\n    : n + ' of ' + rows.length + ' rows';\n}\nreport(rows.length);\nvar timer;\ndocument.getElementById('q').oninput = function () {\n  var el = this;\n  clearTimeout(timer);\n  timer = setTimeout(function () {\n    var q = el.value.trim().toLowerCase();\n    var n = 0;\n    rows.forEach(function (tr) {\n      var hit = !q || tr.textContent.toLowerCase().indexOf(q) >= 0;\n      tr.className = hit ? '' : 'off';\n      if (hit) n++;\n    });\n    report(n);\n  }, 150);\n};\n</script>\n</body>\n</html>\n" }]
      }
    }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const buildReport = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Report Page',
    position: [300, 960],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Render one uploaded tab exactly as it arrived: the original column headings\n// in the original order, every cell as the text the sheet held. No parsing, no\n// reformatting, no filtering to the pilot customers - this page exists to be\n// checked against the workbook, so anything we \"helpfully\" tidied would defeat\n// it. Cells keep their whitespace (Dicker pads INVOICE NUMBER with spaces).\nconst q = ($('Report View').first().json.query) || {};\nconst want = String(q.sheet || 'annuity').toLowerCase() === 'invoice' ? 'invoice' : 'annuity';\nconst TITLES = {\n  annuity: { tab: 'DETAILS', file: 'Annuity Information', other: 'invoice', otherName: 'CSP Invoice Report' },\n  invoice: { tab: 'Invoice Details', file: 'CSP Invoice Report', other: 'annuity', otherName: 'Annuity Information' }\n};\nconst t = TITLES[want];\n\nlet stored = [];\ntry {\n  stored = $('Fetch Report Rows').all().map((i) => i.json).filter((r) => r && r.sheet === want);\n} catch (e) { /* table empty or unreachable */ }\nstored.sort((a, b) => Number(a.row_no || 0) - Number(b.row_no || 0));\n\nconst rows = [];\nfor (const r of stored) {\n  try { rows.push(JSON.parse(r.data || '{}')); } catch (e) { /* skip a corrupt row */ }\n}\nconst sourceFile = (stored[0] && stored[0].source_file) || '';\nconst importedAt = String((stored[0] && stored[0].imported_at) || '').slice(0, 10);\n\n// Column order is the sheet's own: first row wins, later rows can only add.\n// (A tab that gains a column between months therefore shows it on the right\n// rather than silently dropping it.)\nconst cols = [];\nfor (const r of rows) for (const k of Object.keys(r)) if (cols.indexOf(k) < 0) cols.push(k);\n\nfunction esc(s) {\n  return String(s === null || s === undefined ? '' : s)\n    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');\n}\n// Right-align a column only when every value in it reads as a number or money,\n// which is how the sheet itself presents them.\nconst numeric = cols.map((c) => {\n  let seen = 0;\n  for (const r of rows) {\n    const v = String(r[c] === null || r[c] === undefined ? '' : r[c]).trim();\n    if (!v) continue;\n    if (!/^-?\\$?-?[\\d,]+(\\.\\d+)?%?$/.test(v)) return false;\n    seen++;\n  }\n  return seen > 0;\n});\n\nconst head = '<tr><th class=\"rn\">#</th>' +\n  cols.map((c, i) => '<th' + (numeric[i] ? ' class=\"num\"' : '') + '>' + esc(c) + '</th>').join('') +\n  '</tr>';\nconst body = rows.map((r, n) =>\n  '<tr><td class=\"rn\">' + (n + 1) + '</td>' +\n  cols.map((c, i) => '<td' + (numeric[i] ? ' class=\"num\"' : '') + '>' + esc(r[c]) + '</td>').join('') +\n  '</tr>').join('');\n\n// The snapshot is taken at import, so an empty table means no upload has run\n// since this viewer existed - not that the tab was empty. Say which, and say\n// what to do about it, rather than showing a bare grid with no columns.\nconst provenance = rows.length\n  ? esc(sourceFile) + ' &middot; imported ' + esc(importedAt) +\n    ' &middot; ' + rows.length + (rows.length === 1 ? ' row, ' : ' rows, ') +\n    cols.length + (cols.length === 1 ? ' column' : ' columns') +\n    ' &middot; exactly as uploaded'\n  : 'Nothing captured yet';\nconst empty = rows.length ? '' :\n  '<div class=\"empty\"><strong>No upload captured yet</strong>' +\n  'This page shows the ' + esc(t.file) + ' ' + esc(t.tab) +\n  ' tab exactly as it arrived, and it is filled in when a workbook is ' +\n  'imported. Run the <a href=\"../form/csp-monthly-upload\">monthly upload</a> ' +\n  'once \u2014 re-uploading the same two files is safe, it refreshes the Dicker ' +\n  'figures and leaves your prices, invoice wording and approvals alone.</div>';\n\nconst html = $('Report Template').first().json.html\n  .replace(/__TAB__/g, esc(t.tab))\n  .replace(/__FILE__/g, esc(t.file))\n  .replace(/__PROVENANCE__/g, provenance)\n  .replace(/__OTHER__/g, t.other)\n  .replace(/__OTHERNAME__/g, esc(t.otherName))\n  .replace('__EMPTY__', empty)\n  .replace('__THEAD__', head)\n  .replace('__TBODY__', body);\nreturn [{ json: { html: html } }];\n" }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const respondReport = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Report Page',
    position: [520, 960],
    parameters: {
      respondWith: 'text',
      responseBody: expr('{{ $json.html }}'),
      options: {
        responseHeaders: { entries: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store, must-revalidate' }
        ] }
      }
    }
  }
});


/* ============================================================
   Access gates
   ------------------------------------------------------------
   Every endpoint calls the same Access Check sub-workflow in
   workflow 00 before it touches any data. The check sits BEFORE
   the fetches deliberately: an anonymous request should not cost
   an Autotask API call, and should not read a customer's prices
   only to throw the page away afterwards.

   Pages fall back to the sign-in screen, so signing in and
   reloading lands on the page that was asked for. The JSON
   endpoints answer 401 instead, which the portal turns into
   "your session has expired".
   ============================================================ */

const checkAccessPortal = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Portal',
    position: [-600, -240],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          cookie: expr('{{ $json.headers.cookie || \'\' }}'),
          token: expr('{{ ($json.query && $json.query.t) || ($json.body && $json.body.t) || \'\' }}')
        },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'token', displayName: 'token', required: false, defaultMatch: false, display: true, canBeUsedToMatch: false, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedPortal = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Portal?',
    position: [-480, -240],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessSave = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Save',
    position: [-600, 0],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          cookie: expr('{{ $json.headers.cookie || \'\' }}'),
          token: expr('{{ ($json.query && $json.query.t) || ($json.body && $json.body.t) || \'\' }}')
        },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'token', displayName: 'token', required: false, defaultMatch: false, display: true, canBeUsedToMatch: false, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedSave = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Save?',
    position: [-480, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessMapping = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Mapping',
    position: [-600, 240],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          cookie: expr('{{ $json.headers.cookie || \'\' }}'),
          token: expr('{{ ($json.query && $json.query.t) || ($json.body && $json.body.t) || \'\' }}')
        },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'token', displayName: 'token', required: false, defaultMatch: false, display: true, canBeUsedToMatch: false, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedMapping = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Mapping?',
    position: [-480, 240],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessCompanies = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Companies',
    position: [-600, 480],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          cookie: expr('{{ $json.headers.cookie || \'\' }}'),
          token: expr('{{ ($json.query && $json.query.t) || ($json.body && $json.body.t) || \'\' }}')
        },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'token', displayName: 'token', required: false, defaultMatch: false, display: true, canBeUsedToMatch: false, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedCompanies = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Companies?',
    position: [-480, 480],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessReport = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Report',
    position: [-600, 620],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          cookie: expr('{{ $json.headers.cookie || \'\' }}'),
          token: expr('{{ ($json.query && $json.query.t) || ($json.body && $json.body.t) || \'\' }}')
        },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'token', displayName: 'token', required: false, defaultMatch: false, display: true, canBeUsedToMatch: false, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedReport = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Report?',
    position: [-480, 620],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const checkAccessImport = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Import',
    position: [-600, 720],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          cookie: expr('{{ $json.headers.cookie || \'\' }}'),
          token: expr('{{ ($json.query && $json.query.t) || ($json.body && $json.body.t) || \'\' }}')
        },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'token', displayName: 'token', required: false, defaultMatch: false, display: true, canBeUsedToMatch: false, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedImport = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Import?',
    position: [-480, 720],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

// Served in place of any protected PAGE when there is no session.
// Generated from portal/signin.html at build time - edit that file.
const signinTemplate = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Sign-in Template',
    position: [-140, -120],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [{ id: 'signin-html', name: 'html', type: 'string', value: "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Sign in &middot; CSP Pricing</title>\n<style>\n  :root {\n    --bg:#f1f4f8; --card:#fff; --ink:#0f172a; --ink2:#334155; --muted:#64748b;\n    --line:#e2e8f0; --brand:#2563eb; --bad:#b91c1c; --badbg:#fef2f2;\n    --ok:#166534; --okbg:#f0fdf4;\n  }\n  * { box-sizing:border-box; }\n  body {\n    margin:0; min-height:100vh; background:var(--bg); color:var(--ink);\n    font:15px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;\n    display:grid; place-items:center; padding:24px;\n  }\n  .card {\n    width:100%; max-width:400px; background:var(--card); border:1px solid var(--line);\n    border-radius:14px; padding:30px 30px 26px;\n    box-shadow:0 1px 2px rgba(15,23,42,.05), 0 8px 28px rgba(15,23,42,.08);\n  }\n  .logo {\n    width:40px; height:40px; border-radius:10px; background:#0d1b30; color:#fff;\n    display:grid; place-items:center; font-size:13px; font-weight:700;\n    letter-spacing:.06em; margin-bottom:18px;\n  }\n  h1 { margin:0 0 6px; font-size:19px; font-weight:600; letter-spacing:-.015em; }\n  .sub { margin:0 0 22px; font-size:13.5px; color:var(--muted); }\n  .sub b { color:var(--ink2); font-weight:600; }\n  label { display:block; font-size:12px; font-weight:600; color:var(--ink2);\n    text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }\n  input[type=email], input[type=text] {\n    width:100%; padding:10px 12px; font:inherit; font-size:14.5px;\n    border:1px solid var(--line); border-radius:9px; background:#fff; color:var(--ink);\n  }\n  input:focus { outline:2px solid #bfdbfe; outline-offset:-1px; border-color:var(--brand); }\n  /* The code is six digits and gets pasted out of an email - give it room\n     and tabular figures so a transposed digit is easy to spot. */\n  input.code {\n    font-size:23px; letter-spacing:.34em; text-align:center; font-variant-numeric:tabular-nums;\n    padding:12px; font-weight:600;\n  }\n  button {\n    width:100%; margin-top:14px; padding:11px 16px; font:inherit; font-size:14.5px;\n    font-weight:600; color:#fff; background:var(--brand); border:0; border-radius:9px;\n    cursor:pointer;\n  }\n  button:hover { background:#1d4ed8; }\n  .linkrow { margin-top:16px; font-size:13px; color:var(--muted); text-align:center; }\n  .linkrow a, .linkrow button.link {\n    color:var(--brand); text-decoration:none; cursor:pointer; background:none;\n    border:0; padding:0; margin:0; width:auto; font:inherit; font-size:13px;\n  }\n  .linkrow a:hover, .linkrow button.link:hover { text-decoration:underline; background:none; }\n  .msg { margin-top:14px; padding:9px 12px; border-radius:8px; font-size:13px; }\n  .msg.bad { background:var(--badbg); color:var(--bad); border:1px solid #fecaca; }\n  .msg.ok { background:var(--okbg); color:var(--ok); border:1px solid #bbf7d0; }\n  .foot { margin-top:22px; padding-top:16px; border-top:1px solid var(--line);\n    font-size:12px; color:var(--muted); line-height:1.5; }\n</style>\n</head>\n<body>\n<!--\n  Step one of sign-in. Deliberately a REAL form POST, not fetch().\n\n  n8n Cloud serves every webhook response under Content-Security-Policy:\n  sandbox with no allow-same-origin, which puts this page in an opaque\n  origin: no cookies, no localStorage, and any fetch() it makes counts as\n  third-party, so the Set-Cookie coming back is thrown away by the browser.\n\n  A form submit navigates the top-level window instead. That is a first-party\n  request to the host, so the session cookie the response sets is kept - and\n  the sandbox explicitly permits it (allow-forms,\n  allow-top-navigation-by-user-activation).\n-->\n<div class=\"card\">\n  <div class=\"logo\">CSP</div>\n  <h1>Sign in</h1>\n  <p class=\"sub\">Enter your Kantanna email address and we&rsquo;ll send you a six-digit code.</p>\n\n  <form method=\"POST\" action=\"csp-auth-request\">\n    <label for=\"email\">Work email</label>\n    <input id=\"email\" name=\"email\" type=\"email\" inputmode=\"email\" autocomplete=\"email\"\n           placeholder=\"you@kantanna.com.au\" required autofocus>\n    <input type=\"hidden\" id=\"next\" name=\"next\" value=\"csp-pricing\">\n    <button type=\"submit\">Send me a code</button>\n  </form>\n\n  <p class=\"foot\">\n    Access is limited to kantanna.com, kantanna.com.au and kantanna.ph addresses.\n    Signing in keeps you signed in on this browser for 14 days.\n  </p>\n</div>\n\n<script>\n// Remember which page was actually asked for, so signing in lands there\n// rather than always dumping you on the portal. The server only honours\n// values that look like one of our own routes.\n(function () {\n  var here = location.pathname.split('/').pop() + location.search;\n  if (/^csp-[a-z-]+(\\?[^#]*)?$/.test(here)) {\n    document.getElementById('next').value = here;\n  }\n})();\n</script>\n</body>\n</html>\n" }]
      }
    }
  },
  output: [{ html: '<!DOCTYPE html>…' }]
});

const respondSignin = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Sign-in',
    position: [80, -120],
    parameters: {
      respondWith: 'text',
      responseBody: expr('{{ $json.html }}'),
      options: { responseCode: 200, responseHeaders: { entries: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store, must-revalidate' }
      ] } }
    }
  }
});

// The JSON endpoints get a 401 rather than a login page - they are called by
// fetch() from a page that is already open, so the useful thing to say is
// "reload", not "here is a form you cannot see".
const respondUnauthorised = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Unauthorised',
    position: [-140, 900],
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ ok: false, error: 'Not signed in', message: 'Your session has expired. Reload the page and sign in again.' }) }}"),
      options: { responseCode: 401, responseHeaders: { entries: [
        { name: 'Cache-Control', value: 'no-store' }
      ] } }
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
  .to(checkAccessPortal)
  .to(authedPortal.onTrue(fetchLines).onFalse(signinTemplate))
  .add(fetchLines)
  .to(fetchMappings)
  .to(fetchLiveServices)
  .to(fetchBillingItems)
  .to(fetchInvoices)
  .to(portalTemplate)
  .to(buildPage)
  .to(attachToken)
  .to(respondPage)
  .add(signinTemplate)
  .to(respondSignin)
  .add(savePricing)
  .to(checkAccessSave)
  .to(authedSave.onTrue(splitSaved).onFalse(respondUnauthorised))
  .add(splitSaved)
  .to(updatePricing)
  .to(saveSummary)
  .to(respondSave)
  .add(saveMapping)
  .to(checkAccessMapping)
  .to(authedMapping.onTrue(upsertMapping).onFalse(respondUnauthorised))
  .add(upsertMapping)
  .to(respondMapping)
  .add(companySearch)
  .to(checkAccessCompanies)
  .to(authedCompanies.onTrue(portalConfig).onFalse(respondUnauthorised))
  .add(portalConfig)
  .to(queryCompanies)
  .to(companiesResponse)
  .to(respondCompanies)
  .add(reportView)
  .to(checkAccessReport)
  .to(authedReport.onTrue(fetchReportRows).onFalse(signinTemplate))
  .add(fetchReportRows)
  .to(reportTemplate)
  .to(buildReport)
  .to(respondReport)
  .add(importRedirect)
  .to(checkAccessImport)
  .to(authedImport.onTrue(redirectToForm).onFalse(signinTemplate))
  .add(notePortal);
