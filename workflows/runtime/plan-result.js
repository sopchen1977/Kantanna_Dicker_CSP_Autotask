// Assemble what the sync WOULD do to this line, from the same four decisions
// the sync itself runs - Service, Contract, Contract Service and Units. This
// workflow only ever reads from Autotask, so every field here is a statement
// about what is there now and what would change, never a record of a change
// made.
//
// The decisions are the shared runtime files, not a second implementation:
// a plan that disagreed with the sync would be worse than no plan at all.
const line = $('Current Line').first().json;

function grab(name) {
  try {
    const j = $(name).first().json;
    return j && j.line_key === line.line_key ? j : null;
  } catch (e) { return null; }
}

const svc = grab('Service Decision') || {};
const con = grab('Contract Decision') || {};
const cs = grab('CS Decision') || {};
const units = $input.first().json || {};

// A lookup that failed is NOT "nothing exists there" - saying "will create"
// off the back of a 500 would have someone approve a duplicate contract.
const errors = [svc.query_error, con.query_error, units.query_error]
  .filter(function (e) { return e; });

const serviceAction = svc.need_service ? 'create' : (svc.need_service_patch ? 'rename' : 'ok');
const contractAction = con.need_contract ? 'create' : (con.need_contract_patch ? 'extend' : 'ok');
// CS Decision answers 'none' when there is no contract or service id to hang
// a contract service off. During a sync that never happens - both have just
// been created - but nothing is created here, so a line whose contract or
// service is still to come arrives with no id and would otherwise read as
// "nothing to do" when it is in fact the whole job. No id and no failed
// lookup means it is not there, which means it would be added.
let csAction = 'ok';
if (cs.action === 'create' || (!cs.cs_id && !errors.length)) csAction = 'create';
else if (cs.action === 'patch') csAction = 'reprice';
else if (cs.desc_change) csAction = 'redescribe';

const plan = Array.isArray(units.plan) ? units.plan : [];

// One line of English per thing that would change, in the order the sync
// would do them. A line with nothing to do says so rather than going blank,
// because "no row" and "nothing to do" read the same on a screen and mean
// very different things.
const notes = [];
if (serviceAction === 'create') notes.push('create service "' + (line.service_name || '') + '"');
else if (serviceAction === 'rename') notes.push('rename service (' + (svc.service_patch_summary || 'name drifted') + ')');
if (contractAction === 'create') notes.push('create contract "' + (line.contract_name || '') + '"');
else if (contractAction === 'extend') notes.push('extend contract to ' + (con.contract_end_needed || ''));
if (csAction === 'create') notes.push('add to contract @ ' + Number(cs.sell || 0).toFixed(2));
else if (csAction === 'reprice') notes.push('re-price ' + Number(cs.old_price || 0).toFixed(2) +
  ' -> ' + Number(cs.sell || 0).toFixed(2));
else if (csAction === 'redescribe') notes.push('update invoice description');
if (plan.length) notes.push(units.plan_summary);

// When two subscriptions of the same product share one contract service the
// plan was made once, against the primary - but BOTH rows have to carry it,
// or a merged sibling shows a blank plan beside a line that has one and
// reads as "not checked yet".
const keys = Array.isArray(line.merged_keys) && line.merged_keys.length
  ? line.merged_keys
  : [{ subscription_id: line.subscription_id, stock_code: line.stock_code }];

return keys.map((k) => ({ json: {
  line_key: line.line_key,
  subscription_id: k.subscription_id,
  stock_code: k.stock_code,

  // What Autotask holds right now. These are the same columns the sync
  // writes after it acts, because they answer the same question - what is
  // over there - and filling them in from a read means the portal stops
  // calling a standing service "new" before anything has been synced.
  autotask_service_id: svc.service_id || null,
  autotask_contract_id: con.contract_id || null,
  autotask_contract_service_id: cs.cs_id || null,
  contract_price: cs.old_price === null || cs.old_price === undefined ? '' : cs.old_price,
  contract_invoice_description: cs.cs_invoice_description || '',

  // What would happen, per step.
  plan_service_action: serviceAction,
  plan_contract_action: contractAction,
  plan_cs_action: csAction,
  plan_contract_end: con.contract_end_needed || '',
  plan_units: JSON.stringify(plan).slice(0, 2000),
  plan_units_summary: units.plan_summary || '',
  plan_current_units: Number(units.current_units || 0),
  plan_target_units: Number(units.target_units || 0),
  plan_summary: notes.length ? notes.join('; ') : 'nothing to do',
  plan_status: errors.length ? 'error' : 'ok',
  plan_error: errors.join('; ').slice(0, 300),
  plan_checked_at: new Date().toISOString(),
} }));
