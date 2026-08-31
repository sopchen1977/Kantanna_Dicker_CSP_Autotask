# Where this is up to

Working branch: `claude/current-status-39v3g6` (no PR). Everything below is
committed and pushed. Read this with `git log` — the commit messages carry the
reasoning for each change.

## The job in progress

Make the portal show, per CSP report line, **what the sync would do in
Autotask** before you press Sync — add a service to a contract, change a
quantity pro-rata, or create the contract outright — and then have Sync just
do it.

Agreed shape (settled with Sop):

- The Autotask check runs **at the end of the import**, plus a **Check
  Autotask** button on the portal. It cannot run on page load: it is ~4
  Autotask queries per line (~440 for 109 lines) against a 3-thread limit,
  which is why a sync takes 2–3 minutes.
- The plan view **leads** the row; the existing billing state (Approve & Post
  range, posted/invoiced tags, last-posted drawer) **stays**.

## Done

**`04 · Autotask Plan`** — workflow `iTE2TSNj225YXBqq`, published, in project
`RGbuWbB4pjqi8VT3`. It is workflow 03 with every write removed: the same four
decision Code nodes (`service-decision`, `contract-decision`, `cs-decision`,
`units-decision`) over the same four `/query` calls, sharing the runtime files
so the preview cannot drift from the sync. Stores per line what would happen.

Twelve `plan_*` columns were added to `csp_subscription_lines`
(`FDGqV46wAYu9bnGe`). `workflows/tests/test-plan.js` covers a first run, a
no-op run, the pro-rata case and a failed lookup.

## Still to do

1. **Make 04 reachable from the import.** 04's webhook is access-gated, and an
   internal call from workflow 01 carries no session cookie, so it would be
   refused by its own gate. Do NOT weaken the gate. Add an **Execute
   Sub-workflow trigger** to 04 alongside the webhook (joining the chain at
   `Autotask Config`), and call it from the end of workflow 01 with an Execute
   Workflow node — the upload form is already behind sign-in, so that caller is
   authenticated. The portal's button keeps using the gated webhook.

   This also unblocks smoke-testing: right now a manual run of 04 hits the gate
   with no session and takes the refused branch, so 04 has never been run
   against real data. Do that first and check Atlas's `plan_*` columns.

2. **Portal.** Render the CSP line items with their planned action, the
   contract-level "exists #7001 / will be created", and the Check Autotask
   button. Sketch agreed with Sop:

   ```
   ATLAS OUTSOURCING
   └─ CSP Microsoft Annual Commit Monthly 31 Aug 2025 → 30 Aug 2026   will be created
      └─ MS NCE M365 BUSINESS PREMIUM     service exists · will be added @ $34.55
         13 Jul → 30 Jul   qty 6     add 6 units from 13 Jul
         27 Jul → 30 Jul   qty 10    add 10 units from 27 Jul
         31 Jul → 30 Aug   qty 275   set 275 units from 31 Jul
   ```

   The portal should render what 04 computed rather than re-deriving the
   actions, so there is one source of truth. The exception is price: comparing
   `effSell` to `contract_price` client-side lets an edited price update
   "will re-price to $X" without another Autotask round trip.

3. **Known gap.** `prepare-lines.js` merges two subscriptions of the same
   product into one contract service (ConnectOS holds M365 Business Standard
   twice) and tracks the siblings in `merged_keys`. The sync writes status back
   to every sibling; 04's `Save Plan` only writes the primary, so a merged
   sibling shows no plan. Fix before a real month-end.

## How to work on this safely

- Edit `workflows/templates/` + `workflows/runtime/` + `portal/`, then
  `python3 workflows/build.py`, then run all of `workflows/tests/*.js`.
  Never edit `workflows/generated/` by hand.
- **Deploying is a hand-transcription into the n8n MCP, so verify it.** After
  every deploy, pull the node back with `get_workflow_details` and diff it
  against the repo file. That check has caught two real drifts. `portal.html`
  is ~85KB in one node and is the worst of them.
- **Saving is not publishing.** `update_workflow` writes a draft: `versionId`
  moves but `activeVersionId` does not, and the live webhook still serves the
  old version until `publish_workflow` runs. This was missed once already.
- `create_workflow_from_code` does **not** carry credentials across — set
  `KantannaAutotask` (`YXJai935T9ICrDqi`) on every HTTP node afterwards with
  `setNodeCredential`.
- `setNodeParameter` cannot index into an array (`/assignments/assignments/0/…`
  fails). Use `updateNodeParameters` with the whole object instead.
- The sandbox cannot reach `gayleai.app.n8n.cloud` directly (egress policy).
  Verify through the n8n MCP, and drive `portal/portal.html` in Chromium
  locally with a fixture — `/opt/pw-browsers/chromium`, Playwright installed in
  the scratchpad.

## Live workflow ids

| | id |
|---|---|
| 00 · CSP Access | `pcJUTSSeW2cRow8s` |
| 01 · Annuity Import | `YvQ9T1rEFfIUnQUj` |
| 02 · CSP Pricing Portal | `X9YtsHTLZJd1B21n` |
| 03 · Autotask Sync | `s9t606cOMcSVkufg` |
| 04 · Autotask Plan | `iTE2TSNj225YXBqq` |
| ZZ · Reset CSP Data Tables | `X1stW6srLjbj8wAm` |
