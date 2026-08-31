import { workflow, node, trigger, sticky, newCredential, ifElse, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';

/* ============================================================
   04 · Autotask Plan
   ------------------------------------------------------------
   What WOULD the sync do? This is workflow 03 with every write
   taken out: the same four decision Code nodes, fed by the same
   four Autotask queries, with nothing created, patched or posted.

   It exists because "press Sync and find out" is not a thing you
   can ask of a screen that decides what a customer gets billed.
   The decisions are the shared runtime files rather than a second
   implementation - a preview that disagreed with the sync would
   be worse than no preview at all.

   Two short circuits replace the writes. During a sync, by the
   time the contract services are queried the contract exists,
   because it was just created. Here it may not exist at all, so
   there is nothing to query: an empty result stands in, and the
   decisions read it exactly as they read an empty query - as
   "not there", which is the truth.
   ============================================================ */

const startPlan = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Start Plan',
    position: [-620, 0],
    parameters: { httpMethod: 'POST', path: 'csp-autotask-plan', responseMode: 'onReceived', options: {} }
  },
  output: [{ body: {} }]
});

// Reading a customer's contracts and prices out of Autotask is not public
// information, so this endpoint is gated exactly like the others.
const checkAccessPlan = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Check Access Plan',
    position: [-460, 0],
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

const authedPlan = ifElse({
  version: 2.2,
  config: {
    name: 'Authed Plan?',
    position: [-300, 0],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.authed }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

const refusedPlan = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Refused - Not Signed In', position: [-140, 160], parameters: {} },
  output: [{}]
});

// The import calls the plan as a sub-workflow rather than over its webhook.
// The webhook is gated, and rightly so - but an internal call carries no
// session cookie, so it would be refused by the gate rather than weakening
// it. The caller is workflow 01, whose upload form is itself behind sign-in,
// so whoever set this run going was signed in before a file was read.
//
// It joins the chain at Autotask Config, past the gate, because the gate is
// the only thing being skipped. Everything after it is the same run the
// portal's Check Autotask button gets.
const planFromImport = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.2,
  config: {
    name: 'Plan From Import',
    position: [-620, 200],
    parameters: {
      inputSource: 'workflowInputs',
      // Nothing here is read - the plan is made over the whole table, exactly
      // as the webhook run makes it. It says who asked, so the execution list
      // tells an import-triggered run from a button press at a glance.
      workflowInputs: { values: [{ name: 'source', type: 'string' }] }
    }
  },
  output: [{ source: 'import' }]
});

const autotaskConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Autotask Config',
    position: [-140, 0],
    executeOnce: true,
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'cfg-base-url', name: 'base_url', type: 'string', value: 'https://webservices31.autotask.net/atservicesrest/v1.0' }
        ]
      }
    }
  },
  output: [{ base_url: 'https://webservices31.autotask.net/atservicesrest/v1.0' }]
});

const fetchPlanLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch Plan Lines',
    position: [20, 0],
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
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', stock_code: 'P1Y:CFQ7TTC0LCHC:0002:1:', qty: 275 }]
});

// The same derivation the sync runs, so the plan is made against exactly the
// service key, contract reference and co-term window the sync would use.
const prepareLines = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Lines',
    position: [180, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Decide which lines to sync and precompute everything Autotask needs.\n// Default include rule: NCE + Active ($0 lines like Teams Phone Resource\n// accounts sync at a $0 sell price). Explicit include/exclude saved from\n// the portal always wins.\nconst rows = $input.all().map((i) => i.json).filter((j) => j.subscription_id);\nconst today = new Date().toISOString().slice(0, 10);\n\n// Calendar-safe month arithmetic: clamp to the last day of the target\n// month instead of overflowing (31-MAR minus one month is 28-FEB, not\n// 3-MAR), because the whole contract window hangs off this.\nfunction addMonths(iso, months) {\n  const d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  const day = d.getUTCDate();\n  d.setUTCDate(1);\n  d.setUTCMonth(d.getUTCMonth() + months);\n  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();\n  d.setUTCDate(Math.min(day, last));\n  return d.toISOString().slice(0, 10);\n}\n\nfunction addDays(iso, days) {\n  const d = new Date(iso + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return '';\n  d.setUTCDate(d.getUTCDate() + days);\n  return d.toISOString().slice(0, 10);\n}\n\nconst maxDate = (a, b) => (a && b ? (a > b ? a : b) : (a || b));\n\n// Inclusive day count between two ISO dates (a term of 31-AUG-25 ->\n// 30-AUG-26 is 365 days).\nfunction dayCount(from, to) {\n  const a = new Date(from + 'T00:00:00Z');\n  const b = new Date(to + 'T00:00:00Z');\n  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;\n  return Math.round((b - a) / 86400000) + 1;\n}\n\n// Earliest USAGE START across the invoice lines that get replayed as unit\n// adjustments. The contract window has to reach back that far or Autotask\n// rejects the adjustment.\nfunction earliestUsage(json) {\n  let rows = [];\n  try { rows = JSON.parse(json || '[]'); } catch (e) { return ''; }\n  let first = '';\n  for (const r of rows) {\n    const s = String((r && r.s) || '');\n    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s) && (!first || s < first)) first = s;\n  }\n  return first;\n}\n\n// Billing-type metadata. The Autotask Service is created with a matching\n// period type, so the contract bills it monthly or annually as appropriate.\n// Autotask REST periodType picklist (integers): 2=Monthly, 3=Quarterly,\n// 4=Semi-Annual, 5=Yearly.\n//   annual_monthly -> Annual commit, billed monthly   (periodType 2)\n//   annual_upfront -> Annual commit, billed annually  (periodType 5)\n//   monthly        -> Month-to-month                  (periodType 2)\nconst BILLING = {\n  annual_monthly: { label: 'Annual Commit (Billed Monthly)', short: 'Annual Commit Monthly', period_type: 2, key: 'ANN-MO' },\n  annual_upfront: { label: 'Annual Commit (Billed Annually)', short: 'Annual Commit Yearly', period_type: 5, key: 'ANN-YR' },\n  monthly: { label: 'Month to Month', short: 'Month to Month', period_type: 2, key: 'MTM' },\n  usage: { label: 'Usage', short: 'Usage', period_type: 2, key: 'USAGE' },\n};\n\nconst MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',\n  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\n\nfunction longDate(isoDate) {\n  const d = new Date(isoDate + 'T00:00:00Z');\n  if (isNaN(d.getTime())) return String(isoDate || '');\n  return d.getUTCDate() + ' ' + MONTH_ABBR[d.getUTCMonth()] + ' ' + d.getUTCFullYear();\n}\n\n// Autotask caps a Service name and a contract service's invoice description\n// at 100 characters, and both END in the part that carries the meaning - the\n// billing type, or the Subscription ID. So when the product name is\n// too long it is the NAME that gets trimmed, never the suffix.\nfunction fit(name, suffix, max) {\n  const room = max - suffix.length;\n  if (room <= 0) return suffix.slice(0, max);\n  return String(name || '').slice(0, room).trim() + suffix;\n}\n\nconst out = [];\nfor (const l of rows) {\n  const billingType = l.billing_type ||\n    (l.term_months > 1 ? 'annual_monthly' : 'monthly');\n  const billing = BILLING[billingType] || BILLING.monthly;\n  const periodRrp = Number(l.period_rrp !== null && l.period_rrp !== undefined ? l.period_rrp : l.monthly_rrp) || 0;\n  const periodCost = Number(l.period_cost !== null && l.period_cost !== undefined ? l.period_cost : l.monthly_cost) || 0;\n\n  const active = l.status === 'Active';\n  const defInclude = l.charge_type === 'NCE' && active;\n  const inc = l.include === true ? true : (l.include === false ? false : defInclude);\n  if (!inc) continue;\n\n  // The variant matters: CFQ7TTC0LCHC:0002 (Business Premium) and\n  // :001J (Defender Suite) share a SKU root but are different products,\n  // and inside one shared contract they must be different services.\n  // Read straight off the stock code so no re-import is needed.\n  const variant = String(l.stock_code || '').split(':')[2] || '';\n  const serviceKey = billing.key + ':' + (l.sku || 'CSP') + (variant ? ':' + variant : '');\n\n  // ---- The product name Autotask sees -----------------------------------\n  // Both candidates come from the annuity report's DETAILS sheet, keyed by\n  // Subscription ID + Stock Code:\n  //   STOCK DESCRIPTION - the full Dicker stock description, e.g.\n  //     \"MS NCE MICROSOFT DEFENDER SUITE FOR M365 BUSINESS PREMIUM 1YR COMMIT\"\n  //   REFERENCE         - a 30-character field holding whatever Dicker's\n  //     catalogue currently calls the product, truncated at 30. For a product\n  //     Dicker has retired and relabelled that reads \"DO NOT USE - Microsoft\n  //     Defende\", which is neither the product's name nor a full sentence.\n  // The stock description is therefore the name, and REFERENCE only a\n  // fallback for a row that has none.\n  const productName = String(l.stock_description || l.offer_name || 'CSP Service').trim();\n\n  // The service name is \"{product} - {billing type}\". The suffix is what makes\n  // two billing types of one product different services, so it is never what\n  // gets dropped when the name is too long.\n  //\n  // It carries no SKU. Autotask already holds the service key in its own `sku`\n  // field, which is what the sync matches on, so repeating it in the name only\n  // took up room the product name could use.\n  const serviceSuffix = ' - ' + billing.label;\n  // Names generated before the SKU was dropped end in \"... [CFQ7TTC0LCHC]\".\n  // The sync uses both suffixes to tell a name it wrote itself from one\n  // somebody typed in Autotask; without this it would read every existing\n  // service name as hand-written and never correct one again.\n  const legacySuffix = serviceSuffix + ' [' + (l.sku || 'CSP') + ']';\n\n  // ---- Contract window -------------------------------------------------\n  // The annuity report's START USAGE / END USAGE are when the subscription\n  // FIRST started, not the current term \u2014 anything older than a year has\n  // renewed since, so they are never a source for the contract window.\n  // REVALUATION PERIOD is the current expiry date, and the current term is\n  // inferred backwards from it using the subscription type (P1Y = 12\n  // months, P1M = 1 month).\n  //\n  // The CSP invoice report's TERM START is more precise when it describes\n  // the SAME term: co-termed subscriptions bought mid-year get a short\n  // first term that no amount of inference can recover. But the annuity\n  // report is the later snapshot, so when its REVALUATION PERIOD is past\n  // the invoiced TERM END the subscription has renewed (annual) or rolled\n  // to the next cycle (month-to-month) and the new term starts the day\n  // after the invoiced one ended.\n  const iso = (v) => (/^\\d{4}-\\d{2}-\\d{2}$/.test(String(v || '')) ? String(v) : '');\n  const termMonths = Number(l.term_months) || 12;\n  const invStart = iso(l.term_start);\n  const invEnd = iso(l.term_end);\n  const reval = iso(l.revaluation_period);\n  // A cycle runs [start .. reval], so the next one opens on reval + 1 day.\n  // Stepping a whole term back from THAT is exact for every month length;\n  // stepping back from reval and adding a day is not (28-FEB minus one month\n  // plus a day lands on 29-JAN instead of 01-FEB).\n  const inferredStart = reval ? addMonths(addDays(reval, 1), -termMonths) : '';\n\n  let memberStart = '';\n  let memberEnd = '';\n  let windowSource = '';\n  if (reval && invEnd && reval > invEnd) {\n    memberStart = maxDate(addDays(invEnd, 1), inferredStart);\n    memberEnd = reval;\n    windowSource = 'renewed';\n  } else if (invStart && invEnd) {\n    memberStart = invStart;\n    memberEnd = maxDate(invEnd, reval);\n    windowSource = 'invoice';\n  } else if (reval) {\n    // No invoice row this month (annual-upfront plans are only invoiced\n    // once a year). A subscription cannot have started before it first\n    // started, so START USAGE raises the inferred term start when the\n    // subscription was co-termed part-way through a year. Dicker reports\n    // START USAGE as the day BEFORE the term begins, hence the +1.\n    // Across the August 2026 reports this reproduces the invoice's own\n    // TERM START for 68 of 70 comparable lines.\n    memberStart = maxDate(inferredStart, addDays(iso(l.usage_start), 1));\n    memberEnd = reval;\n    if (memberStart > memberEnd) memberStart = inferredStart;\n    windowSource = 'revaluation';\n  }\n  if (!memberStart) { memberStart = invStart || today; windowSource = windowSource || 'unknown'; }\n  if (!memberEnd) memberEnd = addMonths(memberStart, termMonths) || memberStart;\n\n  // ---- Co-terming ------------------------------------------------------\n  // Microsoft aligns a new annual subscription to an existing anniversary,\n  // so its CURRENT term is shorter than the full 12-month commitment (Atlas\n  // Entra ID P2: 03-MAR-26 -> 30-AUG-26, 181 days). Dicker still reports the\n  // full 12-month UNIT PRICE / UNIT RRP on every such line.\n  //   - Billed monthly: the monthly rate is unchanged (unit / 12); the stub\n  //     just means fewer monthly charges before it renews for a full year.\n  //   - Billed annually upfront: the single charge IS pro-rated on days.\n  //     Verified against the invoice report - a 272-of-365-day window bills\n  //     unit x 0.7452, exactly the day ratio - so the period price has to be\n  //     scaled or the contract bills a full year for a part-year term.\n  // Measured before the window is widened for replayed invoice lines.\n  const termDays = dayCount(memberStart, memberEnd);\n  const termFactor = termMonths === 12 && termDays > 0\n    ? Math.min(Math.round((termDays / 365) * 10000) / 10000, 1) : 1;\n  const isCoterm = termFactor < 0.99;\n  const scale = isCoterm && billingType === 'annual_upfront' ? termFactor : 1;\n  const periodRrpTerm = Math.round(periodRrp * scale * 100) / 100;\n  const periodCostTerm = Math.round(periodCost * scale * 100) / 100;\n\n  // ---- The co-term group contract ---------------------------------------\n  // Autotask generates its billing periods by stepping from the CONTRACT\n  // START DATE, while Dicker bills a co-termed subscription on the group's\n  // anchor day (verified: 14 of 14 co-termed lines invoice on the group\n  // anchor, none on their own term start). Dating a contract from the\n  // subscription's own start therefore puts Autotask on the wrong grid.\n  //\n  // So the contract belongs to the CO-TERM GROUP, not the subscription:\n  // one contract per customer + billing type + anniversary, holding every\n  // subscription that shares that renewal date. Its window is a pure\n  // function of the anniversary and the term length, so every member of a\n  // group computes an identical window and the first line to reach Autotask\n  // creates it.\n  const groupEnd = memberEnd;\n  const groupStart = addMonths(addDays(groupEnd, 1), -termMonths) || memberStart;\n  // How the contract is labelled, and therefore what counts as \"the same\n  // contract\" on the next import:\n  //   - Annual: named for its TERM, so each renewal is a new contract -\n  //     which is how Autotask models an annual renewal anyway.\n  //   - Month to month: named for the date the subscription first started,\n  //     because it rolls forever and has no term to be named after. Which\n  //     billing cycle it sits on is in the KEY, not the name: one customer\n  //     can bill some subscriptions 1st-to-month-end and others 22nd-to-21st,\n  //     and those cannot share a contract.\n  const anchor = new Date(groupStart + 'T00:00:00Z');\n  const anchorDay = isNaN(anchor.getTime()) ? 0 : anchor.getUTCDate();\n  // What identifies the group, and so which subscriptions share a contract.\n  //   - Annual: the co-term anniversary. Subscriptions aligned to the same\n  //     renewal date must share a contract's period grid.\n  //   - Month to month: the date the subscription first started, so\n  //     subscriptions bought at different times get their own contract.\n  //     The billing cycle day stays in the KEY (not the name): one customer\n  //     can run several month-to-month cycles - B E Smart bills some\n  //     subscriptions 1st-to-month-end and others 22nd-to-21st - and\n  //     Autotask bills every service against its contract's own period\n  //     grid, so two cycles must never merge even if they share a date.\n  const startedOn = iso(l.usage_start) || memberStart;\n  const groupId = termMonths === 12\n    ? groupStart + '..' + groupEnd\n    : 'cycle-day-' + anchorDay + '|started-' + startedOn;\n  // Both halves read as dates a human would write: \"1 Oct 2025 to 30 Sep 2026\"\n  // and \"Started 5 Oct 2026\". The GROUP KEY above keeps the raw ISO date -\n  // it is an identity, not a label, and must not shift with formatting.\n  const anchorLabel = termMonths === 12\n    ? longDate(groupStart) + ' to ' + longDate(groupEnd)\n    : 'Started ' + longDate(startedOn);\n\n  let contractStart = groupStart;\n  const contractEnd = groupEnd;\n  // Reach back over the invoice lines this run replays as unit adjustments.\n  const firstUsage = earliestUsage(l.invoice_lines);\n  if (firstUsage && firstUsage < contractStart) contractStart = firstUsage;\n\n  // Where this subscription's units begin inside the shared contract.\n  // Autotask pro-rates the first period when this falls mid-cycle, which is\n  // exactly how Dicker bills a newly co-termed subscription.\n  const serviceEffective = maxDate(memberStart, contractStart) || contractStart;\n  // Sell price is per billing period (per month, or per term for upfront,\n  // pro-rated when the term is a co-termed stub). An explicit portal price\n  // is used exactly as typed.\n  const effectiveSell =\n    l.use_custom_price && l.sell_price !== null && l.sell_price !== undefined\n      ? Number(l.sell_price)\n      : periodRrpTerm;\n\n  // Autotask-style \"effective from\" date for price/unit changes,\n  // chosen per line in the pricing portal. Defaults to today, clamped\n  // into the contract window (Autotask rejects dates outside it).\n  let effectiveDate = iso(l.price_effective_date) || today;\n  if (effectiveDate < contractStart) effectiveDate = contractStart;\n  if (effectiveDate > contractEnd) effectiveDate = contractEnd;\n\n  const defaultInvoiceDesc = fit(productName, ' - sub ' + l.subscription_id, 100);\n  const customInvoiceDesc = String(l.invoice_description || '').trim().slice(0, 100);\n\n  // Every contract name starts with \"CSP Microsoft\". The Subscription ID\n  // rides on the contract SERVICE's invoice description, so it still reaches\n  // the invoice line the customer sees.\n  //\n  // The name is a LABEL, not an identity. What tells the sync \"this is the\n  // same contract I made last month\" is the reference below, written to\n  // Autotask's External Contract Number (contractNumber, 50 chars) when the\n  // contract is created. That is why the name can be reworded at any time\n  // without the next import creating a second contract beside the one that\n  // has already been approved, posted and invoiced.\n  const contractName = 'CSP Microsoft ' + billing.short + ' ' + anchorLabel;\n  const groupKey = String(l.tenant_name || '') + '|' + billing.key + '|' + groupId;\n  // The same identity as groupId, written the way a person reading the\n  // Autotask contract screen can still decode it:\n  //   CSP-ANN-MO-20251001-20260930   annual commit, that co-term year\n  //   CSP-MTM-D1-20251218            month to month, 1st-of-month cycle,\n  //                                  subscription started 18 Dec 2025\n  // 28 characters at its longest, well inside Autotask's 50.\n  const compact = (d) => String(d).replace(/-/g, '');\n  const contractRef = termMonths === 12\n    ? 'CSP-' + billing.key + '-' + compact(groupStart) + '-' + compact(groupEnd)\n    : 'CSP-' + billing.key + '-D' + anchorDay + '-' + compact(startedOn);\n  // Month-to-month contracts made before the reference existed were named\n  // with a raw ISO date (\"Started 2025-12-18\"). Carried only so the sync can\n  // find such a contract once, stamp the reference on it and rename it;\n  // nothing else reads this.\n  const legacyName = termMonths === 12\n    ? ''\n    : 'CSP Microsoft ' + billing.short + ' Started ' + startedOn;\n\n  out.push({ json: Object.assign({}, l, {\n    line_key: l.subscription_id + '|' + l.stock_code,\n    billing_type: billingType,\n    billing_label: billing.label,\n    service_key: serviceKey,\n    product_name: productName,\n    service_name: fit(productName, serviceSuffix, 100),\n    // What every service name this automation generates ends with. The sync\n    // uses it to tell a name it wrote itself from one somebody typed in\n    // Autotask, and only corrects its own.\n    service_name_suffix: serviceSuffix,\n    service_name_suffix_legacy: legacySuffix,\n    service_period_type: billing.period_type,\n    period_rrp: periodRrpTerm,\n    period_cost: periodCostTerm,\n    // Full 12-month list prices, kept for reference when a term is a stub.\n    full_period_rrp: periodRrp,\n    full_period_cost: periodCost,\n    contract_name: contractName.slice(0, 100), // Autotask contractName max length\n    contract_name_legacy: legacyName.slice(0, 100),\n    // Autotask External Contract Number - the contract's stable identity.\n    contract_number: contractRef.slice(0, 50),\n    contract_group_key: groupKey,\n    contract_anchor: anchorLabel,\n    // What Autotask shows on the invoice line. Generated by default; a\n    // description typed in the portal overrides it and is what gets pushed.\n    service_invoice_description: customInvoiceDesc || defaultInvoiceDesc,\n    service_invoice_description_default: defaultInvoiceDesc,\n    invoice_description_custom: !!customInvoiceDesc,\n    // Autotask's INTERNAL description is a different field with a different\n    // job: it is the permanent internal record of which Dicker subscription\n    // this contract service is. It is set once at create time and is never\n    // touched again, so renaming the customer-facing invoice line does not\n    // destroy the traceability.\n    service_internal_description: defaultInvoiceDesc,\n    effective_sell: Math.round(effectiveSell * 100) / 100,\n    contract_start: contractStart,\n    contract_end: contractEnd,\n    contract_window_source: windowSource,\n    // This subscription's OWN term inside the shared contract.\n    member_start: memberStart,\n    member_end: memberEnd,\n    service_effective_date: serviceEffective,\n    term_days: termDays,\n    term_factor: termFactor,\n    is_coterm: isCoterm,\n    // START USAGE is the subscription's original start, kept for display\n    // only \u2014 never used to date the contract.\n    first_started: iso(l.usage_start),\n    price_effective_date: effectiveDate,\n    today: today,\n  }) });\n}\n\n// ---- Two subscriptions of the same product on one contract --------------\n// A customer can hold the same SKU twice as two separate subscriptions\n// (ConnectOS has M365 Business Standard as qty 1 and qty 7). Both resolve to\n// the same Autotask service, and a contract carries a given service only\n// once - so left alone the second line would find the first line's contract\n// service and overwrite its units, billing 7 instead of 8.\n//\n// They are therefore billed as ONE contract service with the combined\n// quantity, replaying both subscriptions' invoice lines. Every subscription\n// in the group still gets its own status written back to the table, via\n// merged_keys, so no row is left stale.\nconst byService = {};\nfor (const i of out) {\n  const j = i.json;\n  const k = j.contract_group_key + '||' + j.service_key;\n  (byService[k] = byService[k] || []).push(j);\n}\n\nconst combined = [];\nfor (const k of Object.keys(byService)) {\n  const group = byService[k].sort((a, b) => String(a.line_key).localeCompare(String(b.line_key)));\n  const primary = group[0];\n  if (group.length > 1) {\n    const parts = group.map((j) => ({\n      id: String(j.subscription_id).slice(0, 8),\n      qty: Number(j.qty || 0),\n      sell: Number(j.effective_sell || 0),\n    }));\n    primary.qty = parts.reduce((s, p) => s + p.qty, 0);\n    // Replay every subscription's invoice lines so the unit history adds up\n    // to the combined quantity.\n    let invAll = [];\n    for (const j of group) {\n      try { invAll = invAll.concat(JSON.parse(j.invoice_lines || '[]')); } catch (e) { /* none */ }\n    }\n    invAll.sort((a, b) => String(a && a.s).localeCompare(String(b && b.s)));\n    primary.invoice_lines = JSON.stringify(invAll).slice(0, 4000);\n    primary.service_invoice_description_default =\n      fit(primary.product_name, ' - subs ' + parts.map((p) => p.id).join(', '), 100);\n    primary.service_internal_description = primary.service_invoice_description_default;\n    if (!primary.invoice_description_custom) {\n      primary.service_invoice_description = primary.service_invoice_description_default;\n    }\n    primary.merged_note = 'combined ' + group.length + ' subscriptions of the same product ('\n      + parts.map((p) => p.id + ' x' + p.qty).join(', ') + ')'\n      + (new Set(parts.map((p) => p.sell)).size > 1\n        ? ' - they had different sell prices, using ' + primary.effective_sell : '');\n  }\n  // Whether merged or not, every subscription in the group gets its status\n  // written back against its own row.\n  primary.merged_keys = group.map((j) => ({\n    subscription_id: j.subscription_id, stock_code: j.stock_code,\n  }));\n  combined.push({ json: primary });\n}\nreturn combined;\n" }
  },
  output: [{ tenant_name: 'ATLAS OUTSOURCING PTY LTD', subscription_id: '2F295B21', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_key: 'ANN-MO:CFQ7TTC0LCHC:0002', qty: 275 }]
});

const planLoop = splitInBatches({
  version: 3,
  config: { name: 'Plan Loop', position: [340, 0], parameters: { batchSize: 1, options: {} } }
});

const planDone = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Plan Done',
    position: [560, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// End of the plan loop. Nothing was changed in Autotask - this only records\n// that every line has been looked at, and when.\nreturn [{ json: { done: true, planned_at: new Date().toISOString() } }];\n" }
  },
  output: [{ done: true }]
});

const currentLine = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Current Line',
    position: [560, 120],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'cl-marker', name: 'in_plan', type: 'boolean', value: true }
        ]
      }
    }
  },
  output: [{ in_plan: true, tenant_name: 'ATLAS OUTSOURCING PTY LTD', line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:' }]
});

const lookupMapping = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Lookup Mapping',
    position: [720, 120],
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
  output: [{ id: 1, tenant_name: 'ATLAS OUTSOURCING PTY LTD', autotask_company_id: 123 }]
});

const isMapped = ifElse({
  version: 2.2,
  config: {
    name: 'Is Mapped?',
    position: [880, 120],
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

// Nothing about this customer can be planned until the tenant is tied to an
// Autotask company: there is no company to look contracts up against.
const markUnmapped = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Mark Unmapped',
    position: [1040, 320],
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
          plan_status: 'needs_mapping',
          plan_summary: 'Map this customer to an Autotask company, then check again.',
          plan_checked_at: expr('{{ $now.toISO() }}')
        },
        schema: [
          { id: 'plan_status', displayName: 'plan_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_summary', displayName: 'plan_summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_checked_at', displayName: 'plan_checked_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, plan_status: 'needs_mapping' }]
});

/* ---- 1. Does the service exist? ------------------------------------- */
const findService = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Service',
    position: [1040, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Services/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 25, Filter: [{ op: "or", items: [{ op: "eq", field: "sku", value: $("Current Line").first().json.service_key }, { op: "eq", field: "name", value: $("Current Line").first().json.service_name }] }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
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
    position: [1200, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask Services/query response. Decide whether the service exists,\n// and whether the name it carries needs bringing up to date.\n//\n// IDENTITY IS THE SERVICE'S SKU, NOT ITS NAME - the same lesson the contract\n// learned. Every service this automation creates carries its service key\n// (ANN-MO:CFQ7TTC0LCHC:001J) in Autotask's `sku` field, so the product name\n// in the service NAME can be corrected without the next sync failing to find\n// the service and standing a duplicate up beside it.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  return 'unknown';\n}\n\nconst queryError = (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '';\n\nconst wantedKey = String(line.service_key || '').trim();\nconst wantedName = String(line.service_name || '').trim();\nconst suffix = String(line.service_name_suffix || '');\nconst legacySuffix = String(line.service_name_suffix_legacy || '');\nconst sku = (s) => String(s.sku || '').trim();\nconst name = (s) => String(s.name || '').trim();\n\nlet found = wantedKey ? items.find((s) => sku(s) === wantedKey) || null : null;\nlet matchedBy = found ? 'sku' : '';\n\n// A service created before the key was written to `sku` carries only its\n// name. Match one of those by the name it was given, and the patch below\n// stamps the key on, so this fallback never fires for it again.\nif (!found && wantedName) {\n  found = items.find((s) => name(s) === wantedName && !sku(s)) || null;\n  if (found) matchedBy = 'name';\n}\n\nconst currentName = found ? name(found) : '';\n// Only a name this automation wrote is ours to rewrite. Every generated name\n// ends in \" - {billing type}\", or \" - {billing type} [{SKU}]\" for the ones\n// written before the SKU was dropped from the name; a name typed by hand in\n// Autotask ends in neither, and is left exactly as its author left it.\nconst endsWith = (sfx) => !!sfx && currentName.endsWith(sfx);\nconst generatedName = endsWith(suffix) || endsWith(legacySuffix);\n\nconst patch = { id: found ? found.id : null };\nconst patchNotes = [];\nif (found) {\n  if (matchedBy === 'name' && wantedKey) {\n    patch.sku = wantedKey;\n    patchNotes.push('key ' + wantedKey);\n  }\n  if (wantedName && currentName !== wantedName && generatedName) {\n    patch.name = wantedName;\n    patchNotes.push('renamed to \"' + wantedName + '\"');\n  }\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  service_id: found ? found.id : null,\n  // A failed lookup must never look like \"no service exists\" - that would\n  // create a second service beside the real one.\n  need_service: !found && !queryError,\n  need_service_patch: patchNotes.length > 0,\n  service_patch: patch,\n  service_patch_summary: patchNotes.join('; '),\n  service_matched_by: matchedBy,\n  service_name_found: currentName,\n  query_error: queryError,\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', service_id: null, need_service: true }]
});

// CS Decision reads the service id off a node called Record Service, which in
// the sync is the data-table row written after the service was created. There
// is nothing to record here, so this stands in with the id the lookup found -
// or null, which is what makes the contract service read as "would be added".
const recordService = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Record Service',
    position: [1360, 20],
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'rs-sku', name: 'sku', type: 'string', value: expr("{{ $('Current Line').first().json.service_key }}") },
          { id: 'rs-id', name: 'autotask_service_id', type: 'number', value: expr('{{ $json.service_id }}') }
        ]
      }
    }
  },
  output: [{ sku: 'ANN-MO:CFQ7TTC0LCHC:0002', autotask_service_id: 9001 }]
});

/* ---- 2. Does the contract exist? ------------------------------------ */
const findContract = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Find Contract',
    position: [1520, 20],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/Contracts/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 500, Filter: [{ op: "and", items: [{ op: "eq", field: "companyID", value: $("Lookup Mapping").first().json.autotask_company_id }, { op: "or", items: [{ op: "beginsWith", field: "contractNumber", value: "CSP-" }, { op: "beginsWith", field: "contractName", value: "CSP Microsoft " }] }] }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
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
    position: [1680, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: the Autotask Contracts/query response holding every CSP contract\n// this customer has. Work out which one this line belongs to, and what (if\n// anything) has to be patched on it before the services are synced.\n//\n// IDENTITY IS THE EXTERNAL CONTRACT NUMBER, NOT THE NAME. Autotask's\n// contractNumber field carries a reference this automation generates from\n// the co-term group (see prepare-lines.js), so contract names are free to be\n// reworded - by us or by hand in Autotask - without the next import losing\n// track of a contract that has already been approved, posted and invoiced.\nconst line = $('Current Line').first().json;\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\n\nfunction autotaskError(r) {\n  const d = r.details || {};\n  if (d.body && Array.isArray(d.body.errors) && d.body.errors.length) return d.body.errors.join('; ');\n  if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('; ');\n  if (d.description) return String(d.description);\n  if (r.error) return String(r.error.message || JSON.stringify(r.error));\n  return 'unknown';\n}\n\nconst queryError = (resp.error || resp.errors) ? autotaskError(resp).slice(0, 300) : '';\n\nconst wantedRef = String(line.contract_number || '').trim();\nconst wantedName = String(line.contract_name || '').trim();\nconst legacyName = String(line.contract_name_legacy || '').trim();\nconst ref = (c) => String(c.contractNumber || '').trim();\nconst name = (c) => String(c.contractName || '').trim();\n\nlet found = wantedRef ? items.find((c) => ref(c) === wantedRef) || null : null;\nlet matchedBy = found ? 'number' : '';\n\n// Contracts created before the reference existed carry only their name. Match\n// one of those ONCE, by the name this line would have been given then, and\n// only if it is not already claimed by a different reference. The patch below\n// stamps the reference on, so this fallback never fires for it again.\nif (!found) {\n  const candidates = [wantedName, legacyName].filter((n) => n);\n  for (const n of candidates) {\n    found = items.find((c) => name(c) === n && !ref(c)) || null;\n    if (found) { matchedBy = 'name'; break; }\n  }\n}\n\nconst neededEnd = String(line.contract_end || '');\nconst foundEnd = found ? String(found.endDate || '').slice(0, 10) : '';\n// An existing contract whose endDate predates this import's term end makes\n// Autotask reject every adjustment dated after it, so it has to be extended.\nconst needDateFix = !!(found && neededEnd && foundEnd && foundEnd < neededEnd);\n\nconst patch = { id: found ? found.id : null };\nconst patchNotes = [];\nif (found) {\n  if (needDateFix) {\n    patch.endDate = neededEnd;\n    patchNotes.push('end date ' + foundEnd + ' -> ' + neededEnd);\n  }\n  if (matchedBy === 'name') {\n    patch.contractNumber = wantedRef;\n    patchNotes.push('reference ' + wantedRef);\n    // Adopting a contract is the one moment its name is ours to correct.\n    // After that the name belongs to whoever is looking at Autotask.\n    if (wantedName && name(found) !== wantedName) {\n      patch.contractName = wantedName;\n      patchNotes.push('renamed to \"' + wantedName + '\"');\n    }\n  }\n}\n\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: found ? found.id : null,\n  // A failed lookup must never look like \"no contract exists\" - that would\n  // create a second contract beside the real one.\n  need_contract: !found && !queryError,\n  need_contract_patch: patchNotes.length > 0,\n  contract_patch: patch,\n  contract_patch_summary: patchNotes.join('; '),\n  contract_matched_by: matchedBy,\n  contract_number: wantedRef,\n  contract_end_needed: neededEnd,\n  contract_end_found: foundEnd,\n  query_error: queryError,\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', contract_id: null, need_contract: true }]
});

const contractExists = ifElse({
  version: 2.2,
  config: {
    name: 'Contract Exists?',
    position: [1840, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.contract_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

/* ---- 3. Is the service already on that contract, and at what price? -- */
const fetchContractServices = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch Contract Services',
    position: [2000, -80],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServices/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 200, Filter: [{ op: "eq", field: "contractID", value: $json.contract_id || 0 }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// No contract means no contract services to fetch. An empty result is not a
// fudge here - it is the literal answer, and CS Decision reads it the same
// way it reads an empty query against a contract that does exist.
const noContractServices = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No Contract Services',
    position: [2000, 140],
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'ncs-items', name: 'items', type: 'array', value: [] }
        ]
      }
    }
  },
  output: [{ items: [] }]
});

const csDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'CS Decision',
    position: [2160, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask ContractServices/query response for the contract.\n// Decide whether to create the contract service, re-price it, or do nothing.\nconst line = $('Current Line').first().json;\nconst prev = $('Contract Decision').first().json;\nlet cid = prev.line_key === line.line_key ? prev.contract_id : null;\ntry {\n  const created = $('Contract From Create').first().json;\n  if (created.line_key === line.line_key && created.contract_id) cid = created.contract_id;\n} catch (e) { /* create branch did not run this iteration */ }\n\nconst svcRow = $('Record Service').first().json;\nconst serviceId = svcRow.sku === line.service_key ? svcRow.autotask_service_id : null;\n\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nconst cs = items.find((c) => Number(c.serviceID) === Number(serviceId)) || null;\n\n// The current sell price of an existing contract service. The query does\n// not return adjustedPrice \u2014 only internalCurrencyAdjustedPrice, which is\n// scaled by the instance's internal-currency factor. That same factor is\n// internalCurrencyUnitPrice / unitPrice, so divide it back out.\nfunction currentPrice(c) {\n  if (c.adjustedPrice !== undefined && c.adjustedPrice !== null) return Number(c.adjustedPrice);\n  if (Number(c.internalCurrencyAdjustedPrice) === 0) return 0; // $0 line ($0 sell)\n  const mult = Number(c.internalCurrencyUnitPrice) / Number(c.unitPrice);\n  if (c.internalCurrencyAdjustedPrice !== undefined && c.internalCurrencyAdjustedPrice !== null\n      && isFinite(mult) && mult > 0) {\n    return Math.round((Number(c.internalCurrencyAdjustedPrice) / mult) * 100) / 100;\n  }\n  return null; // unknown -> re-price to be safe\n}\n\nconst oldPrice = cs ? currentPrice(cs) : null;\n\n// The invoice description Autotask currently shows for this contract\n// service, and whether the portal is asking to change it. Like the price,\n// it is only pushed when the user explicitly typed one - so a description\n// edited by hand in Autotask is never silently overwritten. A brand-new\n// contract service gets its description at create time, not by patching.\nconst currentDesc = cs && cs.invoiceDescription !== undefined && cs.invoiceDescription !== null\n  ? String(cs.invoiceDescription) : '';\nconst targetDesc = String(line.service_invoice_description || '');\n// If Autotask no longer holds what the last sync pushed, the description was\n// edited there by hand. Their wording wins over a stale portal override.\n// prepare-lines passes the stored data-table row through untouched, so\n// contract_invoice_description is what the last sync recorded pushing.\nconst syncedDesc = String(line.contract_invoice_description || '');\nconst externallyEdited = !!syncedDesc && currentDesc !== syncedDesc;\nconst descChange = !!cs && line.invoice_description_custom === true\n  && !!targetDesc && currentDesc !== targetDesc && !externallyEdited;\n// Re-price ONLY when the user explicitly set a price in the portal\n// (\"Edit price\" ticked). Otherwise the contract keeps its current price \u2014\n// unticking never reverts anything to RRP.\nconst editing = line.use_custom_price === true;\nconst target = Number(line.effective_sell);\nlet action = 'none';\nif (!cid || !serviceId) action = 'none';\nelse if (!cs) action = 'create';\nelse if (editing && (oldPrice === null || Math.abs(oldPrice - target) > 0.005)) action = 'patch';\n\nreturn [{ json: {\n  line_key: line.line_key,\n  action: action,\n  contract_id: cid,\n  service_id: serviceId,\n  cs_id: cs ? cs.id : null,\n  old_price: oldPrice,\n  cs_invoice_description: currentDesc,\n  target_invoice_description: targetDesc,\n  desc_change: descChange,\n  // The price carried into unit adjustments: the price being set when\n  // editing/creating, otherwise the contract's existing price.\n  sell: action === 'none' && oldPrice !== null ? oldPrice : target,\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', action: 'create', cs_id: null, sell: 34.55 }]
});

const csExists = ifElse({
  version: 2.2,
  config: {
    name: 'CS Exists?',
    position: [2320, 20],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.cs_id ?? "" }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }
        ],
        combinator: 'and'
      }
    }
  }
});

/* ---- 4. What units does Autotask already hold, and from when? -------- */
const fetchUnits = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fetch CS Units',
    position: [2480, -80],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Autotask Config').first().json.base_url }}/ContractServiceUnits/query"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ MaxRecords: 100, Filter: [{ op: "eq", field: "contractServiceID", value: $json.cs_id || 0 }] }) }}'),
      options: { batching: { batch: { batchSize: 1, batchInterval: 350 } } }
    },
    credentials: { httpCustomAuth: newCredential('KantannaAutotask') }
  },
  output: [{ items: [], pageDetails: { count: 0 } }]
});

// A contract service that does not exist has no unit history, so the replay
// starts from nothing - which is exactly the plan for a brand new service.
const noUnits = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'No CS Units',
    position: [2480, 140],
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'nu-items', name: 'items', type: 'array', value: [] }
        ]
      }
    }
  },
  output: [{ items: [] }]
});

const unitsDecision = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Units Decision',
    position: [2640, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Input: Autotask ContractServiceUnits/query response. Build a CHRONOLOGICAL\n// unit-adjustment plan by first understanding the BILLING CYCLE from the\n// CSP invoice lines (distinct from the subscription term):\n//   - cycle end   = latest USAGE END across this subscription's lines\n//   - cycle line  = earliest-starting line with that end; its USAGE START\n//                   is the cycle start and its qty is the cycle quantity\n//   - other lines = pro-rata changes (before or within the cycle), each\n//                   effective at its own USAGE START\n// The plan applies pro-rata changes in date order, sets the cycle quantity\n// at cycle start, and finally corrects to the annuity quantity if needed.\n// e.g. Atlas M365 BP: +6 @13-Jul, +10 @27-Jul, +259 @31-Jul (cycle start)\n// = 275. Units never exist before dates shown in the report, so Autotask\n// does not back-bill earlier periods.\n//\n// Every event is posted as the gap between the report's quantity and the\n// quantity Autotask already holds on that date, so this runs the same way on\n// a service that is new and on one billing for the tenth month - and posts\n// nothing at all the second time the same report is synced.\nconst line = $('Current Line').first().json;\n\n// Recover the contract-service identifiers from whichever branch ran for\n// THIS line ($() returns the node's most recent run, so verify line_key).\nfunction grab(name) {\n  try {\n    const j = $(name).first().json;\n    return j.line_key === line.line_key ? j : null;\n  } catch (e) { return null; }\n}\nconst carried = grab('CS From Create') || grab('CS After Patch') || grab('CS Decision') || {};\n\nconst resp = $input.first().json || {};\nconst items = resp.items || [];\nlet current = 0;\nif (items.length) {\n  let latest = items[0];\n  for (const u of items) {\n    if (String(u.startDate || '') > String(latest.startDate || '')) latest = u;\n  }\n  current = Number(latest.units || 0);\n}\nconst target = Number(line.qty || 0);\n\n// The same records as a dated timeline, oldest first. `current` is what the\n// service bills today; only the series can say whether a mid-cycle change\n// from the report has already been given to Autotask, which is what makes\n// replaying one safe to repeat.\nconst history = items\n  .filter((u) => u && u.startDate)\n  .map((u) => ({ date: String(u.startDate).slice(0, 10), units: Number(u.units || 0) }))\n  .sort((a, b) => a.date.localeCompare(b.date));\nconst historyStart = history.length ? history[0].date : '';\n// Units in force on a date, and just before one: Autotask holds a step\n// series, so a date carries the last value that started on or before it.\nfunction unitsAt(date) {\n  let v = 0;\n  for (const h of history) { if (h.date > date) break; v = h.units; }\n  return v;\n}\nfunction unitsBefore(date) {\n  let v = 0;\n  for (const h of history) { if (h.date >= date) break; v = h.units; }\n  return v;\n}\n\n// Autotask rejects adjustments dated outside the contract window.\nconst cStart = String(line.contract_start || '');\nconst cEnd = String(line.contract_end || '');\nfunction clampDate(d) {\n  let v = String(d || '');\n  if (cStart && v < cStart) v = cStart;\n  if (cEnd && v > cEnd) v = cEnd;\n  return v;\n}\n\nlet invLines = [];\ntry { invLines = JSON.parse(line.invoice_lines || '[]'); } catch (e) { /* no invoice detail */ }\ninvLines = invLines.filter((x) => x && x.s).sort((a, b) => String(a.s).localeCompare(String(b.s)));\n\nconst plan = [];\nlet cycleStart = '';\nlet cycleEnd = '';\n\nif (invLines.length) {\n  // Identify the billing cycle.\n  for (const x of invLines) {\n    if (String(x.e || '') > cycleEnd) cycleEnd = String(x.e || '');\n  }\n  const enders = invLines.filter((x) => String(x.e || '') === cycleEnd);\n  cycleStart = String(enders[0].s);\n  for (const x of enders) {\n    if (String(x.s) < cycleStart) cycleStart = String(x.s);\n  }\n  const cycleLines = enders.filter((x) => String(x.s) === cycleStart);\n  const cycleQty = cycleLines.reduce((s, x) => s + Number(x.q || 0), 0);\n  const prorata = invLines.filter((x) => cycleLines.indexOf(x) === -1);\n\n  // Chronological events: pro-rata increments at their usage start, the\n  // cycle quantity set at cycle start ('set' sorts after adds on a tie).\n  const events = [];\n  for (const p of prorata) events.push({ type: 'add', q: Number(p.q || 0), date: String(p.s) });\n  events.push({ type: 'set', q: cycleQty, date: cycleStart });\n  events.sort((a, b) => (a.date === b.date\n    ? (a.type === 'set' ? 1 : -1)\n    : a.date.localeCompare(b.date)));\n\n  // Replay the report's timeline against Autotask's own. Each event posts the\n  // difference between the units the report says are in force from that date\n  // and the units Autotask already has there, so a change it has already been\n  // given costs nothing and re-running a sync posts no adjustments at all.\n  //\n  // Replaying only when the service was new (units === 0) is what lost\n  // pro-rata charges: from the second month on, a customer who moved seats\n  // mid-cycle had every change collapsed into one delta at the cycle start,\n  // so the days Dicker charged pro-rata for were never billed on.\n  let desired = unitsBefore(events[0].date);\n  let applied = 0;\n  let lastDate = cycleStart;\n  for (const ev of events) {\n    desired = ev.type === 'set' ? ev.q : desired + ev.q;\n    if (ev.date > lastDate) lastDate = ev.date;\n    // Autotask holds no units for this service before its first record, so an\n    // adjustment dated earlier would invent a period it never billed. The\n    // correction below still carries the quantity; only the back-dating goes.\n    if (historyStart && ev.date < historyStart) continue;\n    const change = desired - (unitsAt(ev.date) + applied);\n    if (change !== 0) { plan.push({ change: change, date: clampDate(ev.date) }); applied += change; }\n  }\n  // Correct to the annuity quantity, which is the count Dicker bills from here\n  // on whatever the cycle line said. Dated at the last event so Autotask bills\n  // the corrected quantity for the rest of the cycle, never before the service\n  // had units at all.\n  let correctionDate = lastDate;\n  if (historyStart && correctionDate < historyStart) correctionDate = historyStart;\n  if (current + applied !== target) {\n    plan.push({ change: target - current - applied,\n      date: clampDate(correctionDate || line.price_effective_date || line.today) });\n  }\n} else if (target !== current) {\n  // No invoice detail available (annual-upfront plans are invoiced once a\n  // year). A service being added for the first time starts at the\n  // subscription's own term start, so Autotask pro-rates the opening period\n  // when that falls mid-cycle in the shared co-term contract - the same\n  // shape Dicker bills. An existing service moves at the portal's From date.\n  const startDate = current === 0\n    ? (line.service_effective_date || line.price_effective_date || line.today)\n    : (line.price_effective_date || line.today);\n  plan.push({ change: target - current, date: clampDate(startDate) });\n}\n\n// Autotask keys a contract service period on (contract service, period start,\n// period end) and rejects a second insert for the same one with \"Attempt to\n// insert duplicate data into contract_service_period\". Two changes dated the\n// same day are one net change anyway, so they are merged before posting.\nfunction mergeSameDate(entries) {\n  const byDate = {};\n  const order = [];\n  for (const p of entries) {\n    if (!(p.date in byDate)) { byDate[p.date] = 0; order.push(p.date); }\n    byDate[p.date] += p.change;\n  }\n  return order\n    .map((d) => ({ change: byDate[d], date: d }))\n    .filter((p) => p.change !== 0);\n}\nconst finalPlan = mergeSameDate(plan);\n\nreturn [{ json: {\n  line_key: line.line_key,\n  contract_id: carried.contract_id || null,\n  service_id: carried.service_id || null,\n  cs_id: carried.cs_id || null,\n  sell: carried.sell,\n  current_units: current,\n  target_units: target,\n  cycle_start: cycleStart,\n  cycle_end: cycleEnd,\n  plan: finalPlan,\n  plan_count: finalPlan.length,\n  plan_summary: finalPlan.map((p) => (p.change > 0 ? '+' : '') + p.change + ' @' + p.date).join(', '),\n} }];\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', plan: [], plan_summary: '' }]
});

const planResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Plan Result',
    position: [2800, 20],
    parameters: { mode: 'runOnceForAllItems', jsCode: "// Assemble what the sync WOULD do to this line, from the same four decisions\n// the sync itself runs - Service, Contract, Contract Service and Units. This\n// workflow only ever reads from Autotask, so every field here is a statement\n// about what is there now and what would change, never a record of a change\n// made.\n//\n// The decisions are the shared runtime files, not a second implementation:\n// a plan that disagreed with the sync would be worse than no plan at all.\nconst line = $('Current Line').first().json;\n\nfunction grab(name) {\n  try {\n    const j = $(name).first().json;\n    return j && j.line_key === line.line_key ? j : null;\n  } catch (e) { return null; }\n}\n\nconst svc = grab('Service Decision') || {};\nconst con = grab('Contract Decision') || {};\nconst cs = grab('CS Decision') || {};\nconst units = $input.first().json || {};\n\n// A lookup that failed is NOT \"nothing exists there\" - saying \"will create\"\n// off the back of a 500 would have someone approve a duplicate contract.\nconst errors = [svc.query_error, con.query_error, units.query_error]\n  .filter(function (e) { return e; });\n\nconst serviceAction = svc.need_service ? 'create' : (svc.need_service_patch ? 'rename' : 'ok');\nconst contractAction = con.need_contract ? 'create' : (con.need_contract_patch ? 'extend' : 'ok');\n// CS Decision answers 'none' when there is no contract or service id to hang\n// a contract service off. During a sync that never happens - both have just\n// been created - but nothing is created here, so a line whose contract or\n// service is still to come arrives with no id and would otherwise read as\n// \"nothing to do\" when it is in fact the whole job. No id and no failed\n// lookup means it is not there, which means it would be added.\nlet csAction = 'ok';\nif (cs.action === 'create' || (!cs.cs_id && !errors.length)) csAction = 'create';\nelse if (cs.action === 'patch') csAction = 'reprice';\nelse if (cs.desc_change) csAction = 'redescribe';\n\nconst plan = Array.isArray(units.plan) ? units.plan : [];\n\n// One line of English per thing that would change, in the order the sync\n// would do them. A line with nothing to do says so rather than going blank,\n// because \"no row\" and \"nothing to do\" read the same on a screen and mean\n// very different things.\nconst notes = [];\nif (serviceAction === 'create') notes.push('create service \"' + (line.service_name || '') + '\"');\nelse if (serviceAction === 'rename') notes.push('rename service (' + (svc.service_patch_summary || 'name drifted') + ')');\nif (contractAction === 'create') notes.push('create contract \"' + (line.contract_name || '') + '\"');\nelse if (contractAction === 'extend') notes.push('extend contract to ' + (con.contract_end_needed || ''));\nif (csAction === 'create') notes.push('add to contract @ ' + Number(cs.sell || 0).toFixed(2));\nelse if (csAction === 'reprice') notes.push('re-price ' + Number(cs.old_price || 0).toFixed(2) +\n  ' -> ' + Number(cs.sell || 0).toFixed(2));\nelse if (csAction === 'redescribe') notes.push('update invoice description');\nif (plan.length) notes.push(units.plan_summary);\n\n// When two subscriptions of the same product share one contract service the\n// plan was made once, against the primary - but BOTH rows have to carry it,\n// or a merged sibling shows a blank plan beside a line that has one and\n// reads as \"not checked yet\".\nconst keys = Array.isArray(line.merged_keys) && line.merged_keys.length\n  ? line.merged_keys\n  : [{ subscription_id: line.subscription_id, stock_code: line.stock_code }];\n\nreturn keys.map((k) => ({ json: {\n  line_key: line.line_key,\n  subscription_id: k.subscription_id,\n  stock_code: k.stock_code,\n\n  // What Autotask holds right now. These are the same columns the sync\n  // writes after it acts, because they answer the same question - what is\n  // over there - and filling them in from a read means the portal stops\n  // calling a standing service \"new\" before anything has been synced.\n  autotask_service_id: svc.service_id || null,\n  autotask_contract_id: con.contract_id || null,\n  autotask_contract_service_id: cs.cs_id || null,\n  contract_price: cs.old_price === null || cs.old_price === undefined ? '' : cs.old_price,\n  contract_invoice_description: cs.cs_invoice_description || '',\n\n  // What would happen, per step.\n  plan_service_action: serviceAction,\n  plan_contract_action: contractAction,\n  plan_cs_action: csAction,\n  plan_contract_end: con.contract_end_needed || '',\n  plan_units: JSON.stringify(plan).slice(0, 2000),\n  plan_units_summary: units.plan_summary || '',\n  plan_current_units: Number(units.current_units || 0),\n  plan_target_units: Number(units.target_units || 0),\n  plan_summary: notes.length ? notes.join('; ') : 'nothing to do',\n  plan_status: errors.length ? 'error' : 'ok',\n  plan_error: errors.join('; ').slice(0, 300),\n  plan_checked_at: new Date().toISOString(),\n} }));\n" }
  },
  output: [{ line_key: '2F295B21|P1Y:CFQ7TTC0LCHC:0002:1:', plan_status: 'ok', plan_summary: 'create contract; add to contract @ 34.55' }]
});

const savePlan = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Save Plan',
    position: [2960, 20],
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
          plan_status: expr('{{ $json.plan_status }}'),
          plan_summary: expr('{{ $json.plan_summary }}'),
          plan_service_action: expr('{{ $json.plan_service_action }}'),
          plan_contract_action: expr('{{ $json.plan_contract_action }}'),
          plan_cs_action: expr('{{ $json.plan_cs_action }}'),
          plan_contract_end: expr('{{ $json.plan_contract_end }}'),
          plan_units: expr('{{ $json.plan_units }}'),
          plan_units_summary: expr('{{ $json.plan_units_summary }}'),
          plan_current_units: expr('{{ $json.plan_current_units }}'),
          plan_target_units: expr('{{ $json.plan_target_units }}'),
          plan_error: expr('{{ $json.plan_error }}'),
          plan_checked_at: expr('{{ $json.plan_checked_at }}'),
          autotask_service_id: expr('{{ $json.autotask_service_id }}'),
          autotask_contract_id: expr('{{ $json.autotask_contract_id }}'),
          autotask_contract_service_id: expr('{{ $json.autotask_contract_service_id }}'),
          contract_price: expr('{{ $json.contract_price }}'),
          contract_invoice_description: expr('{{ $json.contract_invoice_description }}')
        },
        schema: [
          { id: 'plan_status', displayName: 'plan_status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_summary', displayName: 'plan_summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_service_action', displayName: 'plan_service_action', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_contract_action', displayName: 'plan_contract_action', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_cs_action', displayName: 'plan_cs_action', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_contract_end', displayName: 'plan_contract_end', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_units', displayName: 'plan_units', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_units_summary', displayName: 'plan_units_summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_current_units', displayName: 'plan_current_units', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'plan_target_units', displayName: 'plan_target_units', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'plan_error', displayName: 'plan_error', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'plan_checked_at', displayName: 'plan_checked_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
          { id: 'autotask_service_id', displayName: 'autotask_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_id', displayName: 'autotask_contract_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'autotask_contract_service_id', displayName: 'autotask_contract_service_id', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'contract_price', displayName: 'contract_price', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: false },
          { id: 'contract_invoice_description', displayName: 'contract_invoice_description', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false }
        ]
      },
      options: {}
    }
  },
  output: [{ id: 1, plan_status: 'ok' }]
});

const notePlan = sticky(
  '## 04 · Autotask Plan (read only)\nTwo ways in, one run. **Plan From Import** is called as a sub-workflow at the end of the import; POST /webhook/csp-autotask-plan is the portal\'s **Check Autotask** button, behind the sign-in gate. The import joins past the gate because an internal call carries no session cookie - its own caller was signed in to reach the upload form.\n\nRuns the sync\'s four decisions without any of its writes, and stores per line what WOULD happen: create/rename the service, create/extend the contract, add or re-price the contract service, and the unit adjustments with their dates.\n\n**Nothing in this workflow creates, patches or posts anything.** Every HTTP node is a `/query`. If you are adding a node here and it is not a query, it belongs in 03.',
  [startPlan, planFromImport, autotaskConfig],
  { color: 4 }
);

export default workflow('kantanna-csp-04-plan', '04 · Autotask Plan')
  .add(startPlan)
  .to(checkAccessPlan)
  .to(authedPlan.onTrue(autotaskConfig).onFalse(refusedPlan))
  .add(planFromImport)
  .to(autotaskConfig)
  .add(autotaskConfig)
  .to(fetchPlanLines)
  .to(prepareLines)
  .to(planLoop
    .onDone(planDone)
    .onEachBatch(currentLine
      .to(lookupMapping)
      .to(isMapped
        .onTrue(findService)
        .onFalse(markUnmapped.to(nextBatch(planLoop))))))
  .add(findService)
  .to(serviceDecision)
  .to(recordService)
  .to(findContract)
  .to(contractDecision)
  .to(contractExists
    .onTrue(fetchContractServices.to(csDecision))
    .onFalse(noContractServices.to(csDecision)))
  .add(csDecision)
  .to(csExists
    .onTrue(fetchUnits.to(unitsDecision))
    .onFalse(noUnits.to(unitsDecision)))
  .add(unitsDecision)
  .to(planResult)
  .to(savePlan)
  .to(nextBatch(planLoop))
  .add(notePlan);
