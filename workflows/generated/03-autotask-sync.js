import { workflow, node, trigger, sticky, newCredential, ifElse, switchCase, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';

const startSync = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Start Sync',
    position: [-620, 0],
    parameters: { httpMethod: 'POST', path: 'csp-autotask-sync', responseMode: 'onReceived', options: {} }
  },
  output: [{ body: {} }]
});


/* ============================================================
   Access gate
   ------------------------------------------------------------
   This endpoint pushes contracts, services and unit adjustments
   into Autotask. Anyone who knew the URL could POST to it, so it
   calls the same Access Check sub-workflow as the portal and only
   proceeds with a live session.

   The webhook still answers immediately (responseMode onReceived)
   and the refused branch simply does no work. The portal saves
   prices before it starts a sync, and that save returns 401 on an
   expired session, so the user is told before it gets this far.
   ============================================================ */
const checkAccessSync = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Sync',
    position: [-500, 0],
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'pcJUTSSeW2cRow8s', cachedResultName: '00 CSP Access' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: { cookie: expr('{{ $json.headers.cookie || \'\' }}') },
        matchingColumns: [],
        schema: [
          { id: 'cookie', displayName: 'cookie', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true
      },
      options: { waitForSubWorkflow: true }
    }
  },
  output: [{ authed: false, email: '', expires_at: '' }]
});

const authedSync = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Sync?',
    position: [-380, 0],
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

const refusedSync = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Refused - Not Signed In', position: [-260, 140], parameters: {} }
});

const autotaskConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Autotask Config',
    position: [-400, 0],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'cfg-base-url', name: 'base_url', type: 'string', value: 'https://webservices31.autotask.net/atservicesrest/v1.0' },
          { id: 'cfg-billing-code', name: 'billing_code_id', type: 'number', value: 29683278 },
          { id: 'cfg-contract-type', name: 'contract_type', type: 'number', value: 7 },
          { id: 'cfg-contract-status', name: 'contract_status', type: 'number', value: 1 },
          { id: 'cfg-contract-period', name: 'contract_period_type', type: 'number', value: 2 },
          { id: 'cfg-service-period', name: 'service_period_type', type: 'number', value: 2 },
          // Line of Business (Billing) = General > SaaS and Cloud Services.
          // Autotask calls this organizationalLevelAssociationID; 18 is the id
          // the hand-made SaaS contracts (Bitwarden, Arcserve) already use.
          { id: 'cfg-line-of-business', name: 'line_of_business_id', type: 'number', value: 18 }
        ]
      }
    }
  },
  output: [{ base_url: 'https://webservices31.autotask.net/atservicesrest/v1.0', billing_code_id: 29683278, contract_type: 7, contract_status: 1, contract_period_type: 2, service_period_type: 2, line_of_business_id: 18 }]
});

const fetchSyncLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Sync Lines',
    position: [-180, 0],
    executeOnce: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'FDGqV46wAYu9bnGe', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', sku: 'CFQ7TTC0LCHC', offer_name: 'Microsoft 365 Business Premium', qty: 275, charge_type: 'NCE', status: 'Active', monthly_cost: 28.19, monthly_rrp: 34.55, use_custom_price: false, sell_price: null, include: null, term_months: 12, term_start: '2025-08-31', term_end: '2026-08-30' }]
});

const prepareLines = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Lines',
    position: [40, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Decide which lines to sync and precompute everything Autotask needs.\n// Default include rule: NCE + Active ($0 lines like Teams Phone Resource\n// accounts sync at a $0 sell price). Explicit include/exclude saved from\n// the portal always wins.\nconst rows = $input.all().map((i) => i.json).filter((j) => j.subscription_id);\nconst today = new Date().toISOString().slice(0, 10);\n\n// Calendar-safe month arithmetic: clamp to the last day of the target\n// month instead of overflowing (31-MAR minus one month is 28-FEB, not\n// 3-MAR), because the whole contract window hangs off this.\nfunction addMonths(iso, months) {\n  const d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  const day = d.getUTCDate();\n  d.setUTCDate(1);\n  d.setUTCMonth(d.getUTCMonth() + months);\n  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();\n  d.setUTCDate(Math.min(day, last));\n  return d.toISOString().slice(0, 10);\n}\n\nfunction addDays(iso, days) {\n  const d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  d.setUTCDate(d.getUTCDate() + days);\n  return d.toISOString().slice(0, 10);\n}\n\nconst maxDate = (a, b) => (a && b ? (a > b ? a : b) : (a || b));\n\n// Inclusive day count between two ISO dates (a term of 31-AUG-25 ->\n// 30-AUG-26 is 365 days).\nfunction dayCount(from, to) {\n  const a = new Date(from + 'T00:00:00Z');\n  const b = new Date(to + 'T00:00:00Z');\n  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;\n  return Math.round((b - a) / 86400000) + 1;\n}\n\n// Earliest USAGE START across the invoice lines that get replayed as unit\n// adjustments. The contract window has to reach back that far or Autotask\n// rejects the adjustment.\nfunction earliestUsage(json) {\n  let rows = [];\n  try { rows = JSON.parse(json || '[]'); } catch (e) { return ''; }\n  let first = '';\n  for (const r of rows) {\n    const s = String((r && r.s) || '');\n    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s) && (!first || s < first)) first = s;\n  }\n  return first;\n}\n\n// Billing-type metadata. The Autotask Service is created with a matching\n// period type, so the contract bills it monthly or annually as appropriate.\n// Autotask REST periodType picklist (integers): 2=Monthly, 3=Quarterly,\n// 4=Semi-Annual, 5=Yearly.\n//   annual_monthly -> Annual commit, billed monthly   (periodType 2)\n//   annual_upfront -> Annual commit, billed annually  (periodType 5)\n//   monthly        -> Month-to-month                  (periodType 2)\nconst BILLING = {\n  annual_monthly: { label: 'Annual Commit (Billed Monthly)', short: 'Annual Commit Monthly', period_type: 2, key: 'ANN-MO' },\n  annual_upfront: { label: 'Annual Commit (Billed Annually)', short: 'Annual Commit Yearly', period_type: 5, key: 'ANN-YR' },\n  monthly: { label: 'Month to Month', short: 'Month to Month', period_type: 2, key: 'MTM' },\n  usage: { label: 'Usage', short: 'Usage', period_type: 2, key: 'USAGE' },\n};\n\nconst MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',\n  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\n\nfunction longDate(isoDate) {\n  const d = new Date(isoDate + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return String(isoDate || '');\n  return d.getUTCDate() + ' ' + MONTH_ABBR[d.getUTCMonth()] + ' ' + d.getUTCFullYear();\n}\n\n// Autotask caps a Service name and a contract service's invoice description\n// at 100 characters, and both END in the part that carries the meaning - the\n// billing type, or the Subscription ID. So when the product name is\n// too long it is the NAME that gets trimmed, never the suffix.\nfunction fit(name, suffix, max) {\n  const room = max - suffix.length;\n  if (room <= 0) return suffix.slice(0, max);\n  return String(name || '').slice(0, room).trim() + suffix;\n}\n\nconst out = [];\nfor (const l of rows) {\n  const billingType = l.billing_type ||\n    (l.term_months > 1 ? 'annual_monthly' : 'monthly');\n  const billing = BILLING[billingType] || BILLING.monthly;\n  const periodRrp = Number(l.period_rrp !== null && l.period_rrp !== undefined ? l.period_rrp : l.monthly_rrp) || 0;\n  const periodCost = Number(l.period_cost !== null && l.period_cost !== undefined ? l.period_cost : l.monthly_cost) || 0;\n\n  const active = l.status === 'Active';\n  const defInclude = l.charge_type === 'NCE' && active;\n  const inc = l.include === true ? true : (l.include === false ? false : defInclude);\n  if (!inc) continue;\n\n  // The variant matters: CFQ7TTC0LCHC:0002 (Business Premium) and\n  // :001J (Defender Suite) share a SKU root but are different products,\n  // and inside one shared contract they must be different services.\n  // Read straight off the stock code so no re-import is needed.\n  const variant = String(l.stock_code || '').split(':')[2] || '';\n  const serviceKey = billing.key + ':' + (l.sku || 'CSP') + (variant ? ':' + variant : '');\n\n  // ---- The product name Autotask sees -----------------------------------\n  // Both candidates come from the annuity report's DETAILS sheet, keyed by\n  // Subscription ID + Stock Code:\n  //   STOCK DESCRIPTION - the full Dicker stock description, e.g.\n  //     \"MS NCE MICROSOFT DEFENDER SUITE FOR M365 BUSINESS PREMIUM 1YR COMMIT\"\n  //   REFERENCE         - a 30-character field holding whatever Dicker's\n  //     catalogue currently calls the product, truncated at 30. For a product\n  //     Dicker has retired and relabelled that reads \"DO NOT USE - Microsoft\n  //     Defende\", which is neither the product's name nor a full sentence.\n  // The stock description is therefore the name, and REFERENCE only a\n  // fallback for a row that has none.\n  const productName = String(l.stock_description || l.offer_name || 'CSP Service').trim();\n\n  // The service name is \"{product} - {billing type}\". The suffix is what makes\n  // two billing types of one product different services, so it is never what\n  // gets dropped when the name is too long.\n  //\n  // It carries no SKU. Autotask already holds the service key in its own `sku`\n  // field, which is what the sync matches on, so repeating it in the name only\n  // took up room the product name could use.\n  const serviceSuffix = ' - ' + billing.label;\n  // Names generated before the SKU was dropped end in \"... [CFQ7TTC0LCHC]\".\n  // The sync uses both suffixes to tell a name it wrote itself from one\n  // somebody typed in Autotask; without this it would read every existing\n  // service name as hand-written and never correct one again.\n  const legacySuffix = serviceSuffix + ' [' + (l.sku || 'CSP') + ']';\n\n  // ---- Contract window -------------------------------------------------\n  // The annuity report's START USAGE / END USAGE are when the subscription\n  // FIRST started, not the current term \u2014 anything older than a year has\n  // renewed since, so they are never a source for the contract window.\n  // REVALUATION PERIOD is the current expiry date, and the current term is\n  // inferred backwards from it using the subscription type (P1Y = 12\n  // months, P1M = 1 month).\n  //\n  // The CSP invoice report's TERM START is more precise when it describes\n  // the SAME term: co-termed subscriptions bought mid-year get a short\n  // first term that no amount of inference can recover. But the annuity\n  // report is the later snapshot, so when its REVALUATION PERIOD is past\n  // the invoiced TERM END the subscription has renewed (annual) or rolled\n  // to the next cycle (month-to-month) and the new term starts the day\n  // after the invoiced one ended.\n  const iso = (v) => (/^\\d{4}-\\d{2}-\\d{2}$/.test(String(v || '')) ? String(v) : '');\n  const termMonths = Number(l.term_months) || 12;\n  const invStart = iso(l.term_start);\n  const invEnd = iso(l.term_end);\n  const reval = iso(l.revaluation_period);\n  // A cycle runs [start .. reval], so the next one opens on reval + 1 day.\n  // Stepping a whole term back from THAT is exact for every month length;\n  // stepping back from reval and adding a day is not (28-FEB minus one month\n  // plus a day lands on 29-JAN instead of 01-FEB).\n  const inferredStart = reval ? addMonths(addDays(reval, 1), -termMonths) : '';\n\n  let memberStart = '';\n  let memberEnd = '';\n  let windowSource = '';\n  if (reval && invEnd && reval > invEnd) {\n    memberStart = maxDate(addDays(invEnd, 1), inferredStart);\n    memberEnd = reval;\n    windowSource = 'renewed';\n  } else if (invStart && invEnd) {\n    memberStart = invStart;\n    memberEnd = maxDate(invEnd, reval);\n    windowSource = 'invoice';\n  } else if (reval) {\n    // No invoice row this month (annual-upfront plans are only invoiced\n    // once a year). A subscription cannot have started before it first\n    // started, so START USAGE raises the inferred term start when the\n    // subscription was co-termed part-way through a year. Dicker reports\n    // START USAGE as the day BEFORE the term begins, hence the +1.\n    // Across the August 2026 reports this reproduces the invoice's own\n    // TERM START for 68 of 70 comparable lines.\n    memberStart = maxDate(inferredStart, addDays(iso(l.usage_start), 1));\n    memberEnd = reval;\n    if (memberStart > memberEnd) memberStart = inferredStart;\n    windowSource = 'revaluation';\n  }\n  if (!memberStart) { memberStart = invStart || today; windowSource = windowSource || 'unknown'; }\n  if (!memberEnd) memberEnd = addMonths(memberStart, termMonths) || memberStart;\n\n  // ---- Co-terming ------------------------------------------------------\n  // Microsoft aligns a new annual subscription to an existing anniversary,\n  // so its CURRENT term is shorter than the full 12-month commitment (Atlas\n  // Entra ID P2: 03-MAR-26 -> 30-AUG-26, 181 days). Dicker still reports the\n  // full 12-month UNIT PRICE / UNIT RRP on every such line.\n  //   - Billed monthly: the monthly rate is unchanged (unit / 12); the stub\n  //     just means fewer monthly charges before it renews for a full year.\n  //   - Billed annually upfront: the single charge IS pro-rated on days.\n  //     Verified against the invoice report - a 272-of-365-day window bills\n  //     unit x 0.7452, exactly the day ratio - so the period price has to be\n  //     scaled or the contract bills a full year for a part-year term.\n  // Measured before the window is widened for replayed invoice lines.\n  const termDays = dayCount(memberStart, memberEnd);\n  const termFactor = termMonths === 12 && termDays > 0\n    ? Math.min(Math.round((termDays / 365) * 10000) / 10000, 1) : 1;\n  const isCoterm = termFactor < 0.99;\n  const scale = isCoterm && billingType === 'annual_upfront' ? termFactor : 1;\n  const periodRrpTerm = Math.round(periodRrp * scale * 100) / 100;\n  const periodCostTerm = Math.round(periodCost * scale * 100) / 100;\n\n  // ---- The co-term group contract ---------------------------------------\n  // Autotask generates its billing periods by stepping from the CONTRACT\n  // START DATE, while Dicker bills a co-termed subscription on the group's\n  // anchor day (verified: 14 of 14 co-termed lines invoice on the group\n  // anchor, none on their own term start). Dating a contract from the\n  // subscription's own start therefore puts Autotask on the wrong grid.\n  //\n  // So the contract belongs to the CO-TERM GROUP, not the subscription:\n  // one contract per customer + billing type + anniversary, holding every\n  // subscription that shares that renewal date. Its window is a pure\n  // function of the anniversary and the term length, so every member of a\n  // group computes an identical window and the first line to reach Autotask\n  // creates it.\n  const groupEnd = memberEnd;\n  const groupStart = addMonths(addDays(groupEnd, 1), -termMonths) || memberStart;\n  // How the contract is labelled, and therefore what counts as \"the same\n  // contract\" on the next import:\n  //   - Annual: named for its TERM, so each renewal is a new contract -\n  //     which is how Autotask models an annual renewal anyway.\n  //   - Month to month: named for the date the subscription first started,\n  //     because it rolls forever and has no term to be named after. Which\n  //     billing cycle it sits on is in the KEY, not the name: one customer\n  //     can bill some subscriptions 1st-to-month-end and others 22nd-to-21st,\n  //     and those cannot share a contract.\n  const anchor = new Date(groupStart + 'T00:00:00Z');\n  const anchorDay = isNaN(anchor.getTime()) ? 0 : anchor.getUTCDate();\n  // What identifies the group, and so which subscriptions share a contract.\n  //   - Annual: the co-term anniversary. Subscriptions aligned to the same\n  //     renewal date must share a contract's period grid.\n  //   - Month to month: the date the subscription first started, so\n  //     subscriptions bought at different times get their own contract.\n  //     The billing cycle day stays in the KEY (not the name): one customer\n  //     can run several month-to-month cycles - B E Smart bills some\n  //     subscriptions 1st-to-month-end and others 22nd-to-21st - and\n  //     Autotask bills every service against its contract's own period\n  //     grid, so two cycles must never merge even if they share a date.\n  const startedOn = iso(l.usage_start) || memberStart;\n  const groupId = termMonths === 12\n    ? groupStart + '..' + groupEnd\n    : 'cycle-day-' + anchorDay + '|started-' + startedOn;\n  // Both halves read as dates a human would write: \"1 Oct 2025 to 30 Sep 2026\"\n  // and \"Started 5 Oct 2026\". The GROUP KEY above keeps the raw ISO date -\n  // it is an identity, not a label, and must not shift with formatting.\n  const anchorLabel = termMonths === 12\n    ? longDate(groupStart) + ' to ' + longDate(groupEnd)\n    : 'Started ' + longDate(startedOn);\n\n  let contractStart = groupStart;\n  const contractEnd = groupEnd;\n  // Reach back over the invoice lines this run replays as unit adjustments.\n  const firstUsage = earliestUsage(l.invoice_lines);\n  if (firstUsage && firstUsage < contractStart) contractStart = firstUsage;\n\n  // Where this subscription's units begin inside the shared contract.\n  // Autotask pro-rates the first period when this falls mid-cycle, which is\n  // exactly how Dicker bills a newly co-termed subscription.\n  const serviceEffective = maxDate(memberStart, contractStart) || contractStart;\n  // Sell price is per billing period (per month, or per term for upfront,\n  // pro-rated when the term is a co-termed stub). An explicit portal price\n  // is used exactly as typed.\n  const effectiveSell =\n    l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined\n      ? Number(l.sell_price)\n      : periodRrpTerm;\n\n  // Autotask-style \"effective from\" date for price/unit changes,\n  // chosen per line in the pricing portal. Defaults to today, clamped\n  // into the contract window (Autotask rejects dates outside it).\n  let effectiveDate = iso(l.price_effective_date) || today;\n  if (effectiveDate < contractStart) effectiveDate = contractStart;\n  if (effectiveDate > contractEnd) effectiveDate = contractEnd;\n\n  const defaultInvoiceDesc = fit(productName, ' - sub ' + l.subscription_id, 100);\n  const customInvoiceDesc = String(l.invoice_description || '').trim().slice(0, 100);\n\n  // Every contract name starts with \"CSP Microsoft\". The Subscription ID\n  // rides on the contract SERVICE's invoice description, so it still reaches\n  // the invoice line the customer sees.\n  //\n  // The name is a LABEL, not an identity. What tells the sync \"this is the\n  // same contract I made last month\" is the reference below, written to\n  // Autotask's External Contract Number (contractNumber, 50 chars) when the\n  // contract is created. That is why the name can be reworded at any time\n  // without the next import creating a second contract beside the one that\n  // has already been approved, posted and invoiced.\n  const contractName = 'CSP Microsoft ' + billing.short + ' ' + anchorLabel;\n  const groupKey = String(l.tenant_name || '') + '|' + billing.key + '|' + groupId;\n  // The same identity as groupId, written the way a person reading the\n  // Autotask contract screen can still decode it:\n  //   CSP-ANN-MO-20251001-20260930   annual commit, that co-term year\n  //   CSP-MTM-D1-20251218            month to month, 1st-of-month cycle,\n  //                                  subscription started 18 Dec 2025\n  // 28 characters at its longest, well inside Autotask's 50.\n  const compact = (d) => String(d).replace(/-/g, '');\n  const contractRef = termMonths === 12\n    ? 'CSP-' + billing.key + '-' + compact(groupStart) + '-' + compact(groupEnd)\n    : 'CSP-' + billing.key + '-D' + anchorDay + '-' + compact(startedOn);\n  // Month-to-month contracts made before the reference existed were named\n  // with a raw ISO date (\"Started 2025-12-18\"). Carried only so the sync can\n  // find such a contract once, stamp the reference on it and rename it;\n  // nothing else reads this.\n  const legacyName = termMonths === 12\n    ? ''\n    : 'CSP Microsoft ' + billing.short + ' Started ' + startedOn;\n\n  out.push({ json: Object.assign({}, l, {\n    line_key: l.subscription_id + '|' + l.stock_code,\n    billing_type: billingType,\n    billing_label: billing.label,\n    service_key: serviceKey,\n    product_name: productName,\n    service_name: fit(productName, serviceSuffix, 100),\n    // What every service name this automation generates ends with. The sync\n    // uses it to tell a name it wrote itself from one somebody typed in\n    // Autotask, and only corrects its own.\n    service_name_suffix: serviceSuffix,\n    service_name_suffix_legacy: legacySuffix,\n    service_period_type: billing.period_type,\n    period_rrp: periodRrpTerm,\n    period_cost: periodCostTerm,\n    // Full 12-month list prices, kept for reference when a term is a stub.\n    full_period_rrp: periodRrp,\n    full_period_cost: periodCost,\n    contract_name: contractName.slice(0, 100), // Autotask contractName max length\n    contract_name_legacy: legacyName.slice(0, 100),\n    // Autotask External Contract Number - the contract's stable identity.\n    contract_number: contractRef.slice(0, 50),\n    contract_group_key: groupKey,\n    contract_anchor: anchorLabel,\n    // What Autotask shows on the invoice line. Generated by default; a\n    // description typed in the portal overrides it and is what gets pushed.\n    service_invoice_description: customInvoiceDesc || defaultInvoiceDesc,\n    service_invoice_description_default: defaultInvoiceDesc,\n    invoice_description_custom: !!customInvoiceDesc,\n    // Autotask's INTERNAL description is a different field with a different\n    // job: it is the permanent internal record of which Dicker subscription\n    // this contract service is. It is set once at create time and is never\n    // touched again, so renaming the customer-facing invoice line does not\n    // destroy the traceability.\n    service_internal_description: defaultInvoiceDesc,\n    effective_sell: Math.round(effectiveSell * 100) / 100,\n    contract_start: contractStart,\n    contract_end: contractEnd,\n    contract_window_source: windowSource,\n    // This subscription's OWN term inside the shared contract.\n    member_start: memberStart,\n    member_end: memberEnd,\n    service_effective_date: serviceEffective,\n    term_days: termDays,\n    term_factor: termFactor,\n    is_coterm: isCoterm,\n    // START USAGE is the subscription's original start, kept for display\n    // only \u2014 never used to date the contract.\n    first_started: iso(l.usage_start),\n    price_effective_date: effectiveDate,\n    today: today,\n  }) });\n}\n\n// ---- Two subscriptions of the same product on one contract --------------\n// A customer can hold the same SKU twice as two separate subscriptions\n// (ConnectOS has M365 Business Standard as qty 1 and qty 7). Both resolve to\n// the same Autotask service, and a contract carries a given service only\n// once - so left alone the second line would find the first line's contract\n// service and overwrite its units, billing 7 instead of 8.\n//\n// They are therefore billed as ONE contract service with the combined\n// quantity, replaying both subscriptions' invoice lines. Every subscription\n// in the group still gets its own status written back to the table, via\n// merged_keys, so no row is left stale.\nconst byService = {};\nfor (const i of out) {\n  const j = i.json;\n  const k = j.contract_group_key + '||' + j.service_key;\n  (byService[k] = byService[k] || []).push(j);\n}\n\nconst combined = [];\nfor (const k of Object.keys(byService)) {\n  const group = byService[k].sort((a, b) => String(a.line_key).localeCompare(String(b.line_key)));\n  const primary = group[0];\n  if (group.length > 1) {\n    const parts = group.map((j) => ({\n      id: String(j.subscription_id).slice(0, 8),\n      qty: Number(j.qty || 0),\n      sell: Number(j.effective_sell || 0),\n    }));\n    primary.qty = parts.reduce((s, p) => s + p.qty, 0);\n    // Replay every subscription's invoice lines so the unit history adds up\n    // to the combined quantity.\n    let invAll = [];\n    for (const j of group) {\n      try { invAll = invAll.concat(JSON.parse(j.invoice_lines || '[]')); } catch (e) { /* none */ }\n    }\n    invAll.sort((a, b) => String(a && a.s).localeCompare(String(b && b.s)));\n    primary.invoice_lines = JSON.stringify(invAll).slice(0, 4000);\n    primary.service_invoice_description_default =\n      fit(primary.product_name, ' - subs ' + parts.map((p) => p.id).join(', '), 100);\n    primary.service_internal_description = primary.service_invoice_description_default;\n    if (!primary.invoice_description_custom) {\n      primary.service_invoice_description = primary.service_invoice_description_default;\n    }\n    primary.merged_note = 'combined ' + group.length + ' subscriptions of the same product ('\n      + parts.map((p) => p.id + ' x' + p.qty).join(', ') + ')'\n      + (new Set(parts.map((p) => p.sell)).size > 1\n        ? ' - they had different sell prices, using ' + primary.effective_sell : '');\n  }\n  // Whether merged or not, every subscription in the group gets its status\n  // written back against its own row.\n  primary.merged_keys = group.map((j) => ({\n    subscription_id: j.subscription_id, stock_code: j.stock_code,\n  }));\n  combined.push({ json: primary });\n}\nreturn combined;\n" }
  },
  output: [{ tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_key: 'P1Y:CFQ7TTC0LCHC', service_name: 'Microsoft 365 Business Premium [P1Y:CFQ7TTC0LCHC]', contract_name: 'CSP - Microsoft 365 Business Premium - 2F295B21', effective_sell: 34.55, qty: 275, monthly_cost: 28.19, monthly_rrp: 34.55, contract_start: '2025-08-31', contract_end: '2026-08-30', today: '2026-08-26', stock_description: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT' }]
});

const syncLoop = splitInBatches({
  version: 3,
  config: { name: 'Sync Loop', position: [280, 0], parameters: { batchSize: 1, options: {} } }
});

const syncDone = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sync Done',
    position: [520, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// End of the sync loop.\nreturn [{ json: { done: true, finished_at: new Date().toISOString() } }];\n" }
  },
  output: [{ done: true }]
});

const currentLine = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Current Line',
    position: [520, 120],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'cl-marker', name: 'in_sync', type: 'boolean', value: true }
        ]
      }
    }
  },
  output: [{ in_sync: true, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_key: 'P1Y:CFQ7TTC0LCHC', service_name: 'Microsoft 365 Business Premium [P1Y:CFQ7TTC0LCHC]', contract_name: 'CSP - Microsoft 365 Business Premium - 2F295B21', effective_sell: 34.55, qty: 275, monthly_cost: 28.19, monthly_rrp: 34.55, contract_start: '2025-08-31', contract_end: '2026-08-30', today: '2026-08-26', stock_description: 'MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT' }]
});

const lookupMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Lookup Mapping',
    position: [740, 120],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'U7ymd9nAyD0GCLYb', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'tenant_name', condition: 'eq', keyValue: expr('{{ $json.tenant_name }}') }
        ]
      },
      returnAll: false,
      limit: 1
    }
  },
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', autotask_company_id: 123, autotask_company_name: 'Atlas Outsourcing' }]
});

const isMapped = ifElse({
  version: 2.2,
  config: {
    name: 'Is Mapped?',
    position: [960, 120],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.autotask_company_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const markNeedsMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Mark Needs Mapping',
    position: [1180, 320],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: 'FDGqV46wAYu9bnGe', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'subscription_id', condition: 'eq', keyValue: expr("{{ $('Current Line').first().json.subscription_id }}") },
          { keyName: 'stock_code', condition: 'eq', keyValue: expr("{{ $('Current Line').first().json.stock_code }}") }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          sync_status: 'needs_mapping',
          sync_message: 'Customer is not mapped to an Autotask company yet. Map it in the pricing portal.'
        },
        schema: [
          { id: 'sync_status', displayName: 'sync_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sync_message', displayName: 'sync_message', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, sync_status: 'needs_mapping' }]
});

// The service is matched on its SKU field, which carries this automation's
// service key (see Service Decision) - the name is only a fallback for a
// service created before the key was written there.
const findService = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Service',
    position: [1180, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Services/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 25, Filter: [{ op: "or", items: [{ op: "eq", field: "sku", value: $("Current Line").first().json.service_key }, { op: "eq", field: "name", value: $("Current Line").first().json.service_name }] }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const serviceDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Service Decision',
    position: [1400, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask Services/query response. Decide whether the service exists,\n// and whether the name it carries needs bringing up to date.\n//\n// IDENTITY IS THE SERVICE'S SKU, NOT ITS NAME - the same lesson the contract\n// learned. Every service this automation creates carries its service key\n// (ANN-MO:CFQ7TTC0LCHC:001J) in Autotask's `sku` field, so the product name\n// in the service NAME can be corrected without the next sync failing to find\n// the service and standing a duplicate up beside it.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  return 'unknown';\n}\n\nconst queryError = (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '';\n\nconst wantedKey = String(line.service_key || '').trim();\nconst wantedName = String(line.service_name || '').trim();\nconst suffix = String(line.service_name_suffix || '');\nconst legacySuffix = String(line.service_name_suffix_legacy || '');\nconst sku = (s) => String(s.sku || '').trim();\nconst name = (s) => String(s.name || '').trim();\n\nlet found = wantedKey ? items.find((s) => sku(s) === wantedKey) || null : null;\nlet matchedBy = found ? 'sku' : '';\n\n// A service created before the key was written to `sku` carries only its\n// name. Match one of those by the name it was given, and the patch below\n// stamps the key on, so this fallback never fires for it again.\nif (!found && wantedName) {\n  found = items.find((s) => name(s) === wantedName && !sku(s)) || null;\n  if (found) matchedBy = 'name';\n}\n\nconst currentName = found ? name(found) : '';\n// Only a name this automation wrote is ours to rewrite. Every generated name\n// ends in \" - {billing type}\", or \" - {billing type} [{SKU}]\" for the ones\n// written before the SKU was dropped from the name; a name typed by hand in\n// Autotask ends in neither, and is left exactly as its author left it.\nconst endsWith = (sfx) => !!sfx && currentName.endsWith(sfx);\nconst generatedName = endsWith(suffix) || endsWith(legacySuffix);\n\nconst patch = { id: found ? found.id : null };\nconst patchNotes = [];\nif (found) {\n  if (matchedBy === 'name' && wantedKey) {\n    patch.sku = wantedKey;\n    patchNotes.push('key ' + wantedKey);\n  }\n  if (wantedName && currentName !== wantedName && generatedName) {\n    patch.name = wantedName;\n    patchNotes.push('renamed to \"' + wantedName + '\"');\n  }\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  service_id: found ? found.id : null,\n  // A failed lookup must never look like \"no service exists\" - that would\n  // create a second service beside the real one.\n  need_service: !found && !queryError,\n  need_service_patch: patchNotes.length > 0,\n  service_patch: patch,\n  service_patch_summary: patchNotes.join('; '),\n  service_matched_by: matchedBy,\n  service_name_found: currentName,\n  query_error: queryError,\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_id: null, need_service: true, need_service_patch: false, service_patch: {}, service_patch_summary: '', service_matched_by: '', service_name_found: '', query_error: '' }]
});

const needService = ifElse({
  version: 2.2,
  config: {
    name: 'Need Service?',
    position: [1620, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.need_service }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const createService = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Create Service',
    position: [1840, -120],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Services"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ name: $("Current Line").first().json.service_name, description: ("Microsoft CSP subscription service - " + $("Current Line").first().json.billing_label + " - " + $("Current Line").first().json.stock_description).slice(0, 380), sku: String($("Current Line").first().json.service_key || "").slice(0, 50), unitPrice: $("Current Line").first().json.period_rrp, unitCost: $("Current Line").first().json.period_cost, periodType: Number($("Current Line").first().json.service_period_type), billingCodeID: Number($("Autotask Config").first().json.billing_code_id), isActive: true }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 9001 }]
});

const serviceFromCreate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Service From Create',
    position: [2060, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask create-service response ({ itemId }) or an error payload.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nreturn [{ json: {\n  line_key: line.line_key,\n  service_id: resp.itemId || null,\n  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)\n    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_id: 9001, create_error: '' }]
});

const needServicePatch = ifElse({
  version: 2.2,
  config: {
    name: 'Patch Service?',
    position: [1840, 180],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.need_service_patch }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const patchService = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Patch Service',
    position: [2040, 180],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'PATCH',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Services"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.service_patch) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 9001 }]
});

const servicePatched = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Service Patched',
    position: [2240, 180],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: the Autotask PATCH /Services response after adopting or correcting\n// an existing service - stamping its service key on, bringing its product\n// name up to date, or both. Restores the id Record Service needs.\nconst line = $('Current Line').first().json;\nconst dec = $('Service Decision').first().json;\nconst resp = $input.first().json || {};\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  if (r.errors) return JSON.stringify(r.errors);\n  return 'unknown';\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  service_id: dec.service_id,\n  patch_summary: dec.service_patch_summary || '',\n  patch_error: (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '',\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_id: 9001, patch_summary: 'renamed to "MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT - Annual Commit (Billed Monthly) [CFQ7TTC0LCHC]"', patch_error: '' }]
});

const recordService = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Record Service',
    position: [2280, 20],
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: 'ai3p8JIYv082bfjn', cachedResultName: 'csp_sku_services' },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'sku', condition: 'eq', keyValue: expr("{{ $('Current Line').first().json.service_key }}") }
        ]
      },
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: [],
        value: {
          sku: expr("{{ $('Current Line').first().json.service_key }}"),
          service_name: expr("{{ $('Current Line').first().json.service_name }}"),
          autotask_service_id: expr('{{ $json.service_id }}'),
          unit_rrp: expr("{{ $('Current Line').first().json.period_rrp }}")
        },
        schema: [
          { id: 'sku', displayName: 'sku', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'service_name', displayName: 'service_name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'autotask_service_id', displayName: 'autotask_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'unit_rrp', displayName: 'unit_rrp', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, sku: 'P1Y:CFQ7TTC0LCHC', service_name: 'Microsoft 365 Business Premium [P1Y:CFQ7TTC0LCHC]', autotask_service_id: 9001, unit_rrp: 34.55 }]
});

// Every CSP contract this customer has, in one query: the contract is matched
// on its External Contract Number (see Contract Decision), which Autotask
// cannot filter on with a value the query does not know yet. Bounded by the
// "CSP-" reference / "CSP Microsoft " name prefixes so a customer's unrelated
// contracts never come back.
const findContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Contract',
    position: [2500, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: [{ op: "and", items: [{ op: "eq", field: "companyID", value: $("Lookup Mapping").first().json.autotask_company_id }, { op: "or", items: [{ op: "beginsWith", field: "contractNumber", value: "CSP-" }, { op: "beginsWith", field: "contractName", value: "CSP Microsoft " }] }] }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const contractDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contract Decision',
    position: [2720, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: the Autotask Contracts/query response holding every CSP contract\n// this customer has. Work out which one this line belongs to, and what (if\n// anything) has to be patched on it before the services are synced.\n//\n// IDENTITY IS THE EXTERNAL CONTRACT NUMBER, NOT THE NAME. Autotask's\n// contractNumber field carries a reference this automation generates from\n// the co-term group (see prepare-lines.js), so contract names are free to be\n// reworded - by us or by hand in Autotask - without the next import losing\n// track of a contract that has already been approved, posted and invoiced.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  return 'unknown';\n}\n\nconst queryError = (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '';\n\nconst wantedRef = String(line.contract_number || '').trim();\nconst wantedName = String(line.contract_name || '').trim();\nconst legacyName = String(line.contract_name_legacy || '').trim();\nconst ref = (c) => String(c.contractNumber || '').trim();\nconst name = (c) => String(c.contractName || '').trim();\n\nlet found = wantedRef ? items.find((c) => ref(c) === wantedRef) || null : null;\nlet matchedBy = found ? 'number' : '';\n\n// Contracts created before the reference existed carry only their name. Match\n// one of those ONCE, by the name this line would have been given then, and\n// only if it is not already claimed by a different reference. The patch below\n// stamps the reference on, so this fallback never fires for it again.\nif (!found) {\n  const candidates = [wantedName, legacyName].filter((n) => n);\n  for (const n of candidates) {\n    found = items.find((c) => name(c) === n && !ref(c)) || null;\n    if (found) { matchedBy = 'name'; break; }\n  }\n}\n\nconst neededEnd = String(line.contract_end || '');\nconst foundEnd = found ? String(found.endDate || '').slice(0, 10) : '';\n// An existing contract whose endDate predates this import's term end makes\n// Autotask reject every adjustment dated after it, so it has to be extended.\nconst needDateFix = !!(found && neededEnd && foundEnd && foundEnd < neededEnd);\n\nconst patch = { id: found ? found.id : null };\nconst patchNotes = [];\nif (found) {\n  if (needDateFix) {\n    patch.endDate = neededEnd;\n    patchNotes.push('end date ' + foundEnd + ' -> ' + neededEnd);\n  }\n  if (matchedBy === 'name') {\n    patch.contractNumber = wantedRef;\n    patchNotes.push('reference ' + wantedRef);\n    // Adopting a contract is the one moment its name is ours to correct.\n    // After that the name belongs to whoever is looking at Autotask.\n    if (wantedName && name(found) !== wantedName) {\n      patch.contractName = wantedName;\n      patchNotes.push('renamed to \"' + wantedName + '\"');\n    }\n  }\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: found ? found.id : null,\n  // A failed lookup must never look like \"no contract exists\" - that would\n  // create a second contract beside the real one.\n  need_contract: !found && !queryError,\n  need_contract_patch: patchNotes.length > 0,\n  contract_patch: patch,\n  contract_patch_summary: patchNotes.join('; '),\n  contract_matched_by: matchedBy,\n  contract_number: wantedRef,\n  contract_end_needed: neededEnd,\n  contract_end_found: foundEnd,\n  query_error: queryError,\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: null, need_contract: true, need_contract_patch: false, contract_patch: { id: null }, contract_patch_summary: '', contract_matched_by: '', contract_number: 'CSP-ANN-MO-20250831-20260830', contract_end_needed: '2026-12-28', contract_end_found: '', query_error: '' }]
});

const needContract = ifElse({
  version: 2.2,
  config: {
    name: 'Need Contract?',
    position: [2940, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.need_contract }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const createContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Create Contract',
    position: [3160, -120],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ companyID: $("Lookup Mapping").first().json.autotask_company_id, contractName: $("Current Line").first().json.contract_name, contractNumber: $("Current Line").first().json.contract_number, contractType: Number($("Autotask Config").first().json.contract_type), status: Number($("Autotask Config").first().json.contract_status), startDate: $("Current Line").first().json.contract_start, endDate: $("Current Line").first().json.contract_end, contractPeriodType: Number($("Autotask Config").first().json.contract_period_type), timeReportingRequiresStartAndStopTimes: 0, setupFee: 0, organizationalLevelAssociationID: Number($("Autotask Config").first().json.line_of_business_id), description: ("Dicker Data CSP - " + $("Current Line").first().json.billing_label + ". Every subscription co-termed to " + $("Current Line").first().json.contract_end + " bills on this contract; each Subscription ID is on its service line. Managed by the Kantanna n8n automation.").slice(0, 1900) }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 7001 }]
});

const contractFromCreate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contract From Create',
    position: [3380, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask create-contract response ({ itemId }) or an error payload.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: resp.itemId || null,\n  contract_created: !!resp.itemId,\n  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)\n    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, contract_created: true, create_error: '' }]
});

// An existing contract sometimes needs repairing before its services can be
// synced. Contract Decision works out what, and hands over a ready-made PATCH
// body; this branch only asks whether there is anything to send. Three things
// land here:
//   - its End Date predates this import's term end, which would make Autotask
//     reject every adjustment dated after it ("effectiveDate must be between
//     the start date and end date of the Contract");
//   - it predates the External Contract Number and has just been adopted by
//     name, so the reference gets stamped on and the fallback never fires
//     for it again;
//   - and, in that same moment, its name is brought up to date.
const needContractPatch = ifElse({
  version: 2.2,
  config: {
    name: 'Patch Contract?',
    position: [3160, 160],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.need_contract_patch }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const patchContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Patch Contract',
    position: [3380, 160],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'PATCH',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.contract_patch) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 7001 }]
});

const contractPatched = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contract Patched',
    position: [3580, 160],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: the Autotask PATCH /Contracts response after adopting or repairing\n// an existing contract - stamping its External Contract Number on, correcting\n// its name, extending its end date, or any combination. Restores the ids\n// Fetch Contract Services needs.\nconst line = $('Current Line').first().json;\nconst dec = $('Contract Decision').first().json;\nconst resp = $input.first().json || {};\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  if (r.errors) return JSON.stringify(r.errors);\n  return 'unknown';\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: dec.contract_id,\n  patch_summary: dec.contract_patch_summary || '',\n  patch_error: (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '',\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, patch_summary: 'reference CSP-ANN-MO-20250831-20260830', patch_error: '' }]
});

const fetchContractServices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Contract Services',
    position: [3600, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServices/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 200, Filter: [{ op: "eq", field: "contractID", value: $json.contract_id || 0 }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const csDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS Decision',
    position: [3820, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask ContractServices/query response for the contract.\n// Decide whether to create the contract service, re-price it, or do nothing.\nconst line = $('Current Line').first().json;\nconst prev = $('Contract Decision').first().json;\nlet cid = prev.line_key === line.line_key ? prev.contract_id : null;\ntry {\n  const created = $('Contract From Create').first().json;\n  if (created.line_key === line.line_key && created.contract_id) cid = created.contract_id;\n} catch (e) { /* create branch did not run this iteration */ }\n\nconst svcRow = $('Record Service').first().json;\nconst serviceId = svcRow.sku === line.service_key ? svcRow.autotask_service_id : null;\n\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nconst cs = items.find((c) => Number(c.serviceID) === Number(serviceId)) || null;\n\n// The current sell price of an existing contract service. The query does\n// not return adjustedPrice \u2014 only internalCurrencyAdjustedPrice, which is\n// scaled by the instance's internal-currency factor. That same factor is\n// internalCurrencyUnitPrice / unitPrice, so divide it back out.\nfunction currentPrice(c) {\n  if (c.adjustedPrice !== undefined && c.adjustedPrice !== null) return Number(c.adjustedPrice);\n  if (Number(c.internalCurrencyAdjustedPrice) === 0) return 0; // $0 line ($0 sell)\n  const mult = Number(c.internalCurrencyUnitPrice) / Number(c.unitPrice);\n  if (c.internalCurrencyAdjustedPrice !== undefined && c.internalCurrencyAdjustedPrice !== null\n      && isFinite(mult) && mult > 0) {\n    return Math.round((Number(c.internalCurrencyAdjustedPrice) / mult) * 100) / 100;\n  }\n  return null; // unknown -> re-price to be safe\n}\n\nconst oldPrice = cs ? currentPrice(cs) : null;\n\n// The invoice description Autotask currently shows for this contract\n// service, and whether the portal is asking to change it. Like the price,\n// it is only pushed when the user explicitly typed one - so a description\n// edited by hand in Autotask is never silently overwritten. A brand-new\n// contract service gets its description at create time, not by patching.\nconst currentDesc = cs && cs.invoiceDescription !== undefined && cs.invoiceDescription !== null\n  ? String(cs.invoiceDescription) : '';\nconst targetDesc = String(line.service_invoice_description || '');\n// If Autotask no longer holds what the last sync pushed, the description was\n// edited there by hand. Their wording wins over a stale portal override.\n// prepare-lines passes the stored data-table row through untouched, so\n// contract_invoice_description is what the last sync recorded pushing.\nconst syncedDesc = String(line.contract_invoice_description || '');\nconst externallyEdited = !!syncedDesc && currentDesc !== syncedDesc;\nconst descChange = !!cs && line.invoice_description_custom === true\n  && !!targetDesc && currentDesc !== targetDesc && !externallyEdited;\n// Re-price ONLY when the user explicitly set a price in the portal\n// (\"Edit price\" ticked). Otherwise the contract keeps its current price \u2014\n// unticking never reverts anything to RRP.\nconst editing = line.use_custom_price === true;\nconst target = Number(line.effective_sell);\nlet action = 'none';\nif (!cid || !serviceId) action = 'none';\nelse if (!cs) action = 'create';\nelse if (editing && (oldPrice === null || Math.abs(oldPrice - target) > 0.005)) action = 'patch';\n\nreturn [{ json: {\n  line_key: line.line_key,\n  action: action,\n  contract_id: cid,\n  service_id: serviceId,\n  cs_id: cs ? cs.id : null,\n  old_price: oldPrice,\n  cs_invoice_description: currentDesc,\n  target_invoice_description: targetDesc,\n  desc_change: descChange,\n  // The price carried into unit adjustments: the price being set when\n  // editing/creating, otherwise the contract's existing price.\n  sell: action === 'none' && oldPrice !== null ? oldPrice : target,\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'create', contract_id: 7001, service_id: 9001, cs_id: null, old_price: null, sell: 34.55 }]
});

const csRoute = switchCase({
  version: 3.2,
  config: {
    name: 'CS Route',
    position: [4040, 20],
    parameters: {
      rules: {
        values: [
          { outputKey: 'create', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'create' }], combinator: 'and' } },
          { outputKey: 'patch', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'patch' }], combinator: 'and' } },
          { outputKey: 'none', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.action }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'none' }], combinator: 'and' } }
        ]
      },
      options: {}
    }
  }
});

const createCS = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Create Contract Service',
    position: [4260, -180],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $json.contract_id }}/Services"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ contractID: $json.contract_id, serviceID: $json.service_id, adjustedPrice: $json.sell, invoiceDescription: $("Current Line").first().json.service_invoice_description, internalDescription: $("Current Line").first().json.service_internal_description }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 8001 }]
});

const csFromCreate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS From Create',
    position: [4480, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask create-contract-service response ({ itemId }).\nconst line = $('Current Line').first().json;\nconst dec = $('CS Decision').first().json;\nconst resp = $input.first().json || {};\nreturn [{ json: {\n  line_key: line.line_key,\n  action: 'create',\n  contract_id: dec.contract_id,\n  service_id: dec.service_id,\n  cs_id: resp.itemId || null,\n  sell: dec.sell,\n  cs_created: !!resp.itemId,\n  create_error: resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 300)\n    : (resp.errors ? JSON.stringify(resp.errors).slice(0, 300) : ''),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'create', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, cs_created: true, create_error: '' }]
});

const patchCS = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Patch Contract Service',
    position: [4260, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $json.contract_id }}/ServiceAdjustments"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ contractID: $json.contract_id, serviceID: $json.service_id, unitChange: 0, adjustedUnitPrice: $json.sell, effectiveDate: $("Current Line").first().json.price_effective_date }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 8001 }]
});

const csAfterPatch = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS After Patch',
    position: [4480, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask service-adjustment (re-price) response. A successful\n// ServiceAdjustments POST returns { itemId: null } \u2014 only an error field\n// means failure.\nconst line = $('Current Line').first().json;\nconst dec = $('CS Decision').first().json;\nconst resp = $input.first().json || {};\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  if (r.errors) return JSON.stringify(r.errors);\n  return 'unknown';\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  action: 'patch',\n  contract_id: dec.contract_id,\n  service_id: dec.service_id,\n  cs_id: dec.cs_id,\n  sell: dec.sell,\n  old_price: dec.old_price,\n  effective_date: line.price_effective_date || line.today,\n  patch_error: (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '',\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'patch', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 33, old_price: 34.55, patch_error: '' }]
});

// Only an EXISTING contract service needs a description patch - a new one
// is created with its description already set.
const needDesc = ifElse({
  version: 2.2,
  config: {
    name: 'Need Description Change?',
    position: [4700, -80],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $("CS Decision").first().json.desc_change }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } },
          { leftValue: expr('{{ $("CS Decision").first().json.cs_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

// Autotask patches a child collection by PATCHing the parent's collection
// URL with the child's own id in the body.
const patchDesc = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Patch CS Description',
    position: [4920, -180],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'PATCH',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $('CS Decision').first().json.contract_id }}/Services"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      // Only the invoice description. The internal description is set once at
      // create time and left alone, so it keeps pointing at the subscription.
      jsonBody: expr('{{ JSON.stringify({ id: $("CS Decision").first().json.cs_id, invoiceDescription: $("Current Line").first().json.service_invoice_description }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 8001 }]
});

const descResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Desc Result',
    position: [5140, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: the Autotask response to PATCHing a contract service's\n// invoice description. Passes the contract-service identifiers straight\n// through so the units query downstream is unaffected either way.\nconst line = $('Current Line').first().json;\nconst dec = $('CS Decision').first().json;\nconst resp = $input.first().json || {};\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  if (r.errors) return JSON.stringify(r.errors);\n  return 'unknown';\n}\n\n// A create in this same run supersedes the id the decision node saw.\nlet csId = dec.cs_id;\ntry {\n  const c = $('CS From Create').first().json;\n  if (c.line_key === line.line_key && c.cs_id) csId = c.cs_id;\n} catch (e) { /* create branch did not run */ }\n\nconst failed = !!(resp.error || resp.errors);\nreturn [{ json: {\n  line_key: line.line_key,\n  action: dec.action,\n  contract_id: dec.contract_id,\n  service_id: dec.service_id,\n  cs_id: csId,\n  sell: dec.sell,\n  old_price: dec.old_price,\n  desc_from: dec.cs_invoice_description || '',\n  desc_to: dec.target_invoice_description || '',\n  desc_updated: !failed,\n  desc_error: failed ? autotaskError(resp).slice(0, 300) : '',\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'none', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, desc_from: 'Microsoft 365 Business Premium - sub 2F295B21', desc_to: 'M365 Business Premium licences', desc_updated: true, desc_error: '' }]
});

const fetchUnits = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch CS Units',
    position: [4700, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServiceUnits/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 100, Filter: [{ op: "eq", field: "contractServiceID", value: $json.cs_id || 0 }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const unitsDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Units Decision',
    position: [4920, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask ContractServiceUnits/query response. Build a CHRONOLOGICAL\n// unit-adjustment plan by first understanding the BILLING CYCLE from the\n// CSP invoice lines (distinct from the subscription term):\n//   - cycle end   = latest USAGE END across this subscription's lines\n//   - cycle line  = earliest-starting line with that end; its USAGE START\n//                   is the cycle start and its qty is the cycle quantity\n//   - other lines = pro-rata changes (before or within the cycle), each\n//                   effective at its own USAGE START\n// The plan applies pro-rata changes in date order, sets the cycle quantity\n// at cycle start, and finally corrects to the annuity quantity if needed.\n// e.g. Atlas M365 BP: +6 @13-Jul, +10 @27-Jul, +259 @31-Jul (cycle start)\n// = 275. Units never exist before dates shown in the report, so Autotask\n// does not back-bill earlier periods.\nconst line = $('Current Line').first().json;\n\n// Recover the contract-service identifiers from whichever branch ran for\n// THIS line ($() returns the node's most recent run, so verify line_key).\nfunction grab(name) {\n  try {\n    const j = $(name).first().json;\n    return j.line_key === line.line_key ? j : null;\n  } catch (e) { return null; }\n}\nconst carried = grab('CS From Create') || grab('CS After Patch') || grab('CS Decision') || {};\n\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nlet current = 0;\nif (items.length) {\n  let latest = items[0];\n  for (const u of items) {\n    if (String(u.startDate || '') > String(latest.startDate || '')) latest = u;\n  }\n  current = Number(latest.units || 0);\n}\nconst target = Number(line.qty || 0);\n\n// Autotask rejects adjustments dated outside the contract window.\nconst cStart = String(line.contract_start || '');\nconst cEnd = String(line.contract_end || '');\nfunction clampDate(d) {\n  let v = String(d || '');\n  if (cStart && v < cStart) v = cStart;\n  if (cEnd && v > cEnd) v = cEnd;\n  return v;\n}\n\nlet invLines = [];\ntry { invLines = JSON.parse(line.invoice_lines || '[]'); } catch (e) { /* no invoice detail */ }\ninvLines = invLines.filter((x) => x && x.s).sort((a, b) => String(a.s).localeCompare(String(b.s)));\n\nconst plan = [];\nlet cycleStart = '';\nlet cycleEnd = '';\n\nif (invLines.length) {\n  // Identify the billing cycle.\n  for (const x of invLines) {\n    if (String(x.e || '') > cycleEnd) cycleEnd = String(x.e || '');\n  }\n  const enders = invLines.filter((x) => String(x.e || '') === cycleEnd);\n  cycleStart = String(enders[0].s);\n  for (const x of enders) {\n    if (String(x.s) < cycleStart) cycleStart = String(x.s);\n  }\n  const cycleLines = enders.filter((x) => String(x.s) === cycleStart);\n  const cycleQty = cycleLines.reduce((s, x) => s + Number(x.q || 0), 0);\n  const prorata = invLines.filter((x) => cycleLines.indexOf(x) === -1);\n\n  // Chronological events: pro-rata increments at their usage start, the\n  // cycle quantity set at cycle start ('set' sorts after adds on a tie).\n  const events = [];\n  for (const p of prorata) events.push({ type: 'add', q: Number(p.q || 0), date: String(p.s) });\n  events.push({ type: 'set', q: cycleQty, date: cycleStart });\n  events.sort((a, b) => (a.date === b.date\n    ? (a.type === 'set' ? 1 : -1)\n    : a.date.localeCompare(b.date)));\n\n  let running = current;\n  let lastDate = cycleStart;\n  if (current === 0) {\n    // Fresh contract service: replay the cycle.\n    for (const ev of events) {\n      const change = ev.type === 'set' ? ev.q - running : ev.q;\n      if (change !== 0) { plan.push({ change: change, date: clampDate(ev.date) }); running += change; }\n      if (ev.date > lastDate) lastDate = ev.date;\n    }\n  }\n  // Correct to the annuity quantity (also the single-delta path when the\n  // contract already has unit history). Dated at the billing cycle start so\n  // Autotask bills the corrected quantity for the whole cycle, the way Dicker\n  // invoices it.\n  if (running !== target) {\n    plan.push({ change: target - running, date: clampDate(lastDate || line.price_effective_date || line.today) });\n  }\n} else if (target !== current) {\n  // No invoice detail available (annual-upfront plans are invoiced once a\n  // year). A service being added for the first time starts at the\n  // subscription's own term start, so Autotask pro-rates the opening period\n  // when that falls mid-cycle in the shared co-term contract - the same\n  // shape Dicker bills. An existing service moves at the portal's From date.\n  const startDate = current === 0\n    ? (line.service_effective_date || line.price_effective_date || line.today)\n    : (line.price_effective_date || line.today);\n  plan.push({ change: target - current, date: clampDate(startDate) });\n}\n\n// Autotask keys a contract service period on (contract service, period start,\n// period end) and rejects a second insert for the same one with \"Attempt to\n// insert duplicate data into contract_service_period\". Two changes dated the\n// same day are one net change anyway, so they are merged before posting.\nfunction mergeSameDate(entries) {\n  const byDate = {};\n  const order = [];\n  for (const p of entries) {\n    if (!(p.date in byDate)) { byDate[p.date] = 0; order.push(p.date); }\n    byDate[p.date] += p.change;\n  }\n  return order\n    .map((d) => ({ change: byDate[d], date: d }))\n    .filter((p) => p.change !== 0);\n}\nconst finalPlan = mergeSameDate(plan);\n\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: carried.contract_id || null,\n  service_id: carried.service_id || null,\n  cs_id: carried.cs_id || null,\n  sell: carried.sell,\n  current_units: current,\n  target_units: target,\n  cycle_start: cycleStart,\n  cycle_end: cycleEnd,\n  plan: finalPlan,\n  plan_count: finalPlan.length,\n  plan_summary: finalPlan.map((p) => (p.change > 0 ? '+' : '') + p.change + ' @' + p.date).join(', '),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, current_units: 0, target_units: 275, delta: 275 }]
});

// What has been approved & posted so far: BillingItems only exist once a
// charge is posted, so the latest item date shows the last posted period
// and its absence means nothing has been through Approve & Post yet.
const fetchBillingItems = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Billing Items',
    position: [5000, 160],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/BillingItems/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: [{ op: "eq", field: "contractID", value: $json.contract_id || 0 }] }) }}'),
      options: {}
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

const billingSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Billing Summary',
    position: [5070, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask BillingItems/query response for this line's contract.\n// BillingItems only exist once a charge has been APPROVED & POSTED in\n// Autotask, so: the latest item date = what was last posted, and the next\n// approve-and-post charge is estimated as one billing period later (or the\n// current billing cycle when nothing has been posted yet) at qty x sell.\n// Passes the Units Decision fields through for the downstream nodes.\nconst line = $('Current Line').first().json;\n\nfunction grab(name) {\n  try {\n    const j = $(name).first().json;\n    return j.line_key === line.line_key ? j : null;\n  } catch (e) { return null; }\n}\nconst ud = grab('Units Decision') || {};\n\nconst resp = $input.first().json || {};\n// The contract is shared by every subscription that co-terms to the same\n// anniversary, so its billing items cover the whole group. Keep only the\n// ones belonging to THIS line's contract service.\nconst csId = ud.cs_id !== undefined && ud.cs_id !== null ? Number(ud.cs_id) : null;\nconst svcId = ud.service_id !== undefined && ud.service_id !== null ? Number(ud.service_id) : null;\nconst items = (resp.items || []).filter((b) => {\n  if (csId !== null && b.contractServiceID !== undefined && b.contractServiceID !== null) {\n    return Number(b.contractServiceID) === csId;\n  }\n  if (svcId !== null && b.serviceID !== undefined && b.serviceID !== null) {\n    return Number(b.serviceID) === svcId;\n  }\n  return true;\n});\n\nfunction iso(v) { return String(v || '').slice(0, 10); }\nfunction addMonths(isoDate, months) {\n  const d = new Date(isoDate + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  const day = d.getUTCDate();\n  d.setUTCDate(1);\n  d.setUTCMonth(d.getUTCMonth() + months);\n  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();\n  d.setUTCDate(Math.min(day, last));\n  return d.toISOString().slice(0, 10);\n}\nfunction amount(b) {\n  const t = b.totalAmount !== undefined && b.totalAmount !== null ? Number(b.totalAmount)\n    : (b.extendedPrice !== undefined && b.extendedPrice !== null ? Number(b.extendedPrice)\n      : Number(b.quantity || 0) * Number(b.rate || 0));\n  return isNaN(t) ? 0 : t;\n}\n\n// Autotask bills one PERIOD at a time and dates the item at the period\n// start, but can raise a second item inside the same period for a mid-cycle\n// change, dated the day it changed. Group on contractServicePeriodID so the\n// last posting is the last period and its total - taking the newest single\n// row instead would report a period that appears to start mid-month, and\n// the portal reads this date to decide what is already billed.\nconst periods = {};\nfor (const b of items) {\n  const d = iso(b.itemDate || b.postedOnDate || b.postedDate);\n  if (!d) continue;\n  const pk = b.contractServicePeriodID !== undefined && b.contractServicePeriodID !== null\n    ? 'p' + b.contractServicePeriodID : 'd' + d;\n  const e = periods[pk] || (periods[pk] = { date: d, total: 0, invoiced: false });\n  if (d < e.date) e.date = d;\n  e.total += amount(b);\n  if (b.invoiceID) e.invoiced = true;\n}\nlet lastDate = '';\nlet lastTotal = 0;\nlet lastInvoiced = false;\nfor (const pk of Object.keys(periods)) {\n  const e = periods[pk];\n  if (e.date > lastDate) { lastDate = e.date; lastTotal = e.total; lastInvoiced = e.invoiced; }\n}\n\nconst qty = Number(line.qty || 0);\nconst sell = Number(line.effective_sell || 0);\nconst periodMonths = Number(line.billing_months || 1) === 12 ? 12 : 1;\nconst nextDate = lastDate ? addMonths(lastDate, periodMonths)\n  : (ud.cycle_start || line.contract_start || line.today || '');\nconst nextAmount = Math.round(qty * sell * 100) / 100;\n\nconst err = resp.error ? String(resp.error.message || JSON.stringify(resp.error)).slice(0, 120) : '';\nreturn [{ json: Object.assign({}, ud, {\n  line_key: line.line_key,\n  billing_last: err ? 'billing lookup failed: ' + err\n    : (lastDate ? lastDate + ' \u00b7 $' + lastTotal.toFixed(2) + (lastInvoiced ? ' \u00b7 invoiced' : ' \u00b7 posted')\n      : 'nothing posted yet'),\n  billing_next: (nextDate || '?') + ' \u00b7 $' + nextAmount.toFixed(2)\n    + ' (' + qty + ' \u00d7 ' + sell.toFixed(2) + (periodMonths === 12 ? '/yr' : '/mo') + ')',\n}) }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, cs_id: 8001, plan: [], plan_count: 0, billing_last: '2026-07-31 · $9501.25 · posted', billing_next: '2026-08-31 · $9501.25 (275 × 34.55/mo)' }]
});

const needAdjust = ifElse({
  version: 2.2,
  config: {
    name: 'Need Unit Change?',
    position: [5140, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.plan_count }}'), operator: { type: 'number', operation: 'gt' }, rightValue: 0 },
          { leftValue: expr('{{ $json.cs_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const splitPlan = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Split Plan',
    position: [5250, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// One item per planned unit adjustment, in chronological order. The\n// downstream HTTP node posts them one at a time (batched, oldest first) so\n// Autotask builds the quantity history exactly as the CSP report shows it.\nconst dec = $input.first().json;\nreturn (dec.plan || []).map((p) => ({ json: {\n  line_key: dec.line_key,\n  contract_id: dec.contract_id,\n  service_id: dec.service_id,\n  cs_id: dec.cs_id,\n  sell: dec.sell,\n  change: p.change,\n  date: p.date,\n} }));\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: 7001, service_id: 9001, cs_id: 8001, sell: 34.55, change: 259, date: '2025-08-31' }]
});

const adjustUnits = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Adjust Units',
    position: [5360, -120],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/{{ $json.contract_id }}/ServiceAdjustments"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ contractID: $json.contract_id, serviceID: $json.service_id, unitChange: $json.change, effectiveDate: $json.date, adjustedUnitPrice: $json.sell }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 400 } } }
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ itemId: 6001 }]
});

const adjustResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Adjust Result',
    position: [5580, -120],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: one Autotask service-adjustment response per planned change.\n// A successful ContractServiceAdjustments POST returns { itemId: null }\n// (adjustments are write-only in the Autotask REST API), so success is\n// \"the response carries no error\", not a non-null itemId.\nconst line = $('Current Line').first().json;\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  if (r.errors) return JSON.stringify(r.errors);\n  return 'unknown';\n}\n\nconst errors = [];\nlet ok = 0;\nfor (const i of $input.all()) {\n  const r = i.json || {};\n  if (r.error || r.errors) errors.push(autotaskError(r).slice(0, 200));\n  else ok++;\n}\nreturn [{ json: {\n  line_key: line.line_key,\n  adjust_ok_count: ok,\n  adjust_error: errors.join('; ').slice(0, 300),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', adjust_ok: true, adjust_error: '' }]
});

const syncResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sync Result',
    position: [5800, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Build the final per-line outcome that gets written back to the\n// csp_subscription_lines table. Reads every step's node for THIS line only\n// (guarded by line_key, since $() returns a node's most recent run).\nconst line = $('Current Line').first().json;\n\nfunction grab(name) {\n  try {\n    const j = $(name).first().json;\n    return j.line_key === line.line_key ? j : null;\n  } catch (e) { return null; }\n}\n\nconst svcDec = grab('Service Decision');\nconst svcCreated = grab('Service From Create');\nconst svcPatched = grab('Service Patched');\nconst conDec = grab('Contract Decision');\nconst conCreated = grab('Contract From Create');\nconst conPatched = grab('Contract Patched');\nconst csCreate = grab('CS From Create');\nconst csPatch = grab('CS After Patch');\nconst csDec = grab('CS Decision');\nconst csDesc = grab('Desc Result');\nconst units = grab('Units Decision');\nconst billing = grab('Billing Summary');\n\nconst serviceId = (svcCreated && svcCreated.service_id) || (svcDec && svcDec.service_id) || null;\nconst contractId = (conCreated && conCreated.contract_id) || (conDec && conDec.contract_id) || null;\nconst csId = (csCreate && csCreate.cs_id) || (csDec && csDec.cs_id) || null;\n\nconst notes = [];\nconst errors = [];\nif (svcCreated) {\n  if (svcCreated.service_id) notes.push('service created #' + svcCreated.service_id);\n  else errors.push('service create failed: ' + (svcCreated.create_error || 'unknown'));\n}\nif (svcDec && svcDec.query_error) {\n  errors.push('service lookup failed: ' + svcDec.query_error);\n}\nif (svcPatched) {\n  if (svcPatched.patch_error) errors.push('service update failed: ' + svcPatched.patch_error);\n  else notes.push('service updated (' + svcPatched.patch_summary + ')');\n}\nif (conCreated) {\n  if (conCreated.contract_id) notes.push('contract created #' + conCreated.contract_id);\n  else errors.push('contract create failed: ' + (conCreated.create_error || 'unknown'));\n}\nif (conDec && conDec.query_error) {\n  errors.push('contract lookup failed: ' + conDec.query_error);\n}\nif (conPatched) {\n  if (conPatched.patch_error) errors.push('contract update failed: ' + conPatched.patch_error);\n  else notes.push('contract updated (' + conPatched.patch_summary + ')');\n}\nif (csCreate) {\n  if (csCreate.cs_id) notes.push('service added to contract @ ' + csCreate.sell);\n  else errors.push('contract service create failed: ' + (csCreate.create_error || 'unknown'));\n}\nif (csPatch) {\n  if (csPatch.patch_error) errors.push('price update failed: ' + csPatch.patch_error);\n  else notes.push('price ' + csPatch.old_price + ' -> ' + csPatch.sell\n    + (csPatch.effective_date ? ' effective ' + csPatch.effective_date : ''));\n}\nif (csDesc) {\n  if (csDesc.desc_error) errors.push('invoice description update failed: ' + csDesc.desc_error);\n  else notes.push('invoice description -> ' + csDesc.desc_to);\n}\nif (units && units.plan_count > 0 && csId) {\n  const adj = grab('Adjust Result');\n  if (adj && adj.adjust_error) errors.push('unit adjustment failed: ' + adj.adjust_error);\n  else notes.push('units ' + units.current_units + ' -> ' + units.target_units +\n    ' (' + units.plan_summary + ')');\n}\nif (!serviceId) errors.push('no Autotask service resolved');\nif (!contractId) errors.push('no Autotask contract resolved');\nif (!csId && serviceId && contractId) errors.push('no contract service resolved');\n\nif (line.merged_note) notes.unshift(line.merged_note);\n\nconst status = errors.length ? 'error' : 'synced';\nconst message = (errors.length ? errors : (notes.length ? notes : ['up to date'])).join('; ').slice(0, 500);\n\n// The contract service's CURRENT sell price after this run: what a patch\n// or create just set, otherwise what the contract already had. Shown in\n// the portal as the line's price.\nlet contractPrice = null;\nif (csPatch && !csPatch.patch_error) contractPrice = csPatch.sell;\nelse if (csCreate && csCreate.cs_id) contractPrice = csCreate.sell;\nelse if (csDec && csDec.old_price !== null && csDec.old_price !== undefined) contractPrice = csDec.old_price;\n\n// The invoice description now on the contract service: what this run just\n// set, what it was created with, or what Autotask already had. Shown in the\n// portal so you can see the live text without opening Autotask.\nlet invoiceDesc = null;\nif (csDesc && !csDesc.desc_error) invoiceDesc = csDesc.desc_to;\nelse if (csCreate && csCreate.cs_id) invoiceDesc = line.service_invoice_description || '';\nelse if (csDec && csDec.cs_invoice_description !== undefined && csDec.cs_invoice_description !== null) {\n  invoiceDesc = csDec.cs_invoice_description;\n}\n\n// When two subscriptions of the same product share one contract service,\n// the sync ran once but BOTH rows need their status written back.\nconst keys = Array.isArray(line.merged_keys) && line.merged_keys.length\n  ? line.merged_keys\n  : [{ subscription_id: line.subscription_id, stock_code: line.stock_code }];\n\nreturn keys.map((k) => ({ json: {\n  subscription_id: k.subscription_id,\n  stock_code: k.stock_code,\n  sync_status: status,\n  sync_message: message,\n  autotask_service_id: serviceId,\n  autotask_contract_id: contractId,\n  autotask_contract_service_id: csId,\n  billing_last: (billing && billing.billing_last) || '',\n  billing_next: (billing && billing.billing_next) || '',\n  contract_price: contractPrice,\n  contract_invoice_description: invoiceDesc === null ? '' : String(invoiceDesc),\n} }));\n" }
  },
  output: [{ subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', sync_status: 'synced', sync_message: 'contract created #7001; service added to contract @ 34.55; units 0 -> 275', autotask_service_id: 9001, autotask_contract_id: 7001, autotask_contract_service_id: 8001 }]
});

const markSynced = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Mark Synced',
    position: [6020, 20],
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
          sync_status: expr('{{ $json.sync_status }}'),
          sync_message: expr('{{ $json.sync_message }}'),
          autotask_service_id: expr('{{ $json.autotask_service_id }}'),
          autotask_contract_id: expr('{{ $json.autotask_contract_id }}'),
          autotask_contract_service_id: expr('{{ $json.autotask_contract_service_id }}'),
          billing_last: expr('{{ $json.billing_last }}'),
          billing_next: expr('{{ $json.billing_next }}'),
          contract_price: expr('{{ $json.contract_price }}'),
          contract_invoice_description: expr('{{ $json.contract_invoice_description }}')
        },
        schema: [
          { id: 'sync_status', displayName: 'sync_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'sync_message', displayName: 'sync_message', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'autotask_service_id', displayName: 'autotask_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_id', displayName: 'autotask_contract_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_service_id', displayName: 'autotask_contract_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'billing_last', displayName: 'billing_last', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'billing_next', displayName: 'billing_next', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'contract_price', displayName: 'contract_price', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'contract_invoice_description', displayName: 'contract_invoice_description', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, sync_status: 'synced' }]
});

const noteSync = sticky(
  '## 03 · Autotask Sync\nPOST /webhook/csp-autotask-sync (the portal Sync button calls this).\nPer included line: resolve company mapping -> ensure Service (matched on its SKU field, which holds the service key) -> ensure Contract (matched on its External Contract Number) -> set sell price on the contract service -> adjust units.\n\n**Config ("Autotask Config"):**\n- base_url: Autotask zone REST URL (ww31)\n- billing_code_id: the Autotask Billing (Material) Code for created Services (594 = Cloud and SaaS)',
  [startSync, autotaskConfig],
  { color: 3 }
);

export default workflow('kantanna-csp-03-sync', '03 · Autotask Sync')
  .add(startSync)
  .to(checkAccessSync)
  .to(authedSync.onTrue(autotaskConfig).onFalse(refusedSync))
  .add(autotaskConfig)
  .to(fetchSyncLines)
  .to(prepareLines)
  .to(syncLoop
    .onDone(syncDone)
    .onEachBatch(currentLine
      .to(lookupMapping)
      .to(isMapped
        .onTrue(findService)
        .onFalse(markNeedsMapping.to(nextBatch(syncLoop))))))
  .add(findService)
  .to(serviceDecision)
  .to(needService
    .onTrue(createService.to(serviceFromCreate.to(recordService)))
    .onFalse(needServicePatch
      .onTrue(patchService.to(servicePatched.to(recordService)))
      .onFalse(recordService)))
  .add(recordService)
  .to(findContract)
  .to(contractDecision)
  .to(needContract
    .onTrue(createContract.to(contractFromCreate.to(fetchContractServices)))
    .onFalse(needContractPatch
      .onTrue(patchContract.to(contractPatched.to(fetchContractServices)))
      .onFalse(fetchContractServices)))
  .add(fetchContractServices)
  .to(csDecision)
  .to(csRoute
    .onCase(0, createCS.to(csFromCreate.to(needDesc)))
    .onCase(1, patchCS.to(csAfterPatch.to(needDesc)))
    .onCase(2, needDesc))
  .add(needDesc
    .onTrue(patchDesc.to(descResult.to(fetchUnits)))
    .onFalse(fetchUnits))
  .add(fetchUnits)
  .to(unitsDecision)
  .to(fetchBillingItems)
  .to(billingSummary)
  .to(needAdjust
    .onTrue(splitPlan.to(adjustUnits.to(adjustResult.to(syncResult))))
    .onFalse(syncResult))
  .add(syncResult)
  .to(markSynced)
  .to(nextBatch(syncLoop))
  .add(noteSync);
