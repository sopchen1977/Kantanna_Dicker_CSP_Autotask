# Where this is up to

Working branch: `claude/csp-plan-work-8lzqqb` (no PR). Everything below is
committed and pushed. Read this with `git log` — the commit messages carry the
reasoning for each change.

**All three workflows are deployed and published.**

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
no-op run, the pro-rata case, a failed lookup and a merged pair.

**Reachable from the import.** 04 has a second trigger, *Plan From Import*
(Execute Sub-workflow), joining the chain at `Autotask Config` — past the
access gate and nowhere else. Workflow 01 calls it from a *Refresh and re-read Autotask*
node after *Summarize Import*, with `waitForSubWorkflow` **off** so the
completion page does not sit on a two-minute run, and `onError:
continueRegularOutput` so a failed plan is a portal without a preview rather
than a lost import. The webhook stays gated and is what the portal's button
uses.

**The merged-sibling gap is closed.** `plan-result.js` now fans out over
`merged_keys` the way `sync-result.js` does, so both subscriptions of a
merged product carry the plan.

**The portal renders it.** Chips under each service name (*new service*,
*will be added @ $34.55*, *re-price $30.00 → $34.55*, *units 259 → 275*,
*nothing to do*); the contract-level action on the contract header (*will be
created*, *extend to 21 Sep 2026*); the same plan with its dates in the row
drawer, above the billing history; an **Autotask plan** stat tile counting the
changes and naming what undermines that count (reads that failed, unmapped
customers, lines not checked). A **Refresh and re-read Autotask** button re-runs 04.

Everything is read from what 04 computed rather than derived again, price
included: 04 stores `plan_sell` (cs-decision's own `sell`) and the portal
reads it. The single exception is a price typed on screen a moment ago, which
by definition has not been near Autotask — `use_custom_price` is checked first
so the chip follows the price under your hands.

> **An earlier version of this note claimed the exception had found a
> divergence — that the sync reverts hand-edited Autotask prices to RRP. It
> does not, and the claim came from reading `prepare-lines.js`'s RRP fallback
> without following it to where it is used.** `cs-decision.js` pushes that
> number only when CREATING the contract service or when `use_custom_price`
> is set; on an existing service with no portal price the action is `none`
> and the contract's own price is carried through. So RRP is the default for
> a service being added, Autotask's price stands for one already there, and
> `planSell()` is simply `effSell` — column and plan agree because the sync
> agrees with both. The portal's **use RRP** link is how you ask for RRP back.

**Smoke-tested against real data**, 31 Aug 2026, execution `26956` — 04's
first real run. Entered through *Plan From Import* (`test_workflow` with
`triggerNodeName`, since a manual run picks the webhook trigger and correctly
takes the refused branch), 5m15s, success. 95 loop runs produced **96** plan
rows — all `plan_status: ok`, nothing unmapped, no failed reads.

- The extra row is the merged pair: subscriptions `D1E47C24…` and
  `DE3858AA…` share stock code `P1Y:CFQ7TTC0LH16:0001:1:` and now both carry
  the plan under the primary's `line_key`. Before the fix the second was blank.
- Atlas reads exactly as the sketch above:
  `+6 @2026-07-13, +10 @2026-07-27, +259 @2026-07-31` (0 → 275), service 677
  already there, contract to be created.

## Still to do

1. **`Mark Unmapped` writes only the primary row.** The same merged-sibling
   gap that `plan-result.js` just closed still exists on the needs-mapping
   branch — of **both** 03 (`Mark Needs Mapping`) and 04 (`Mark Unmapped`).
   Those are data-table nodes rather than Code nodes, so fanning out needs a
   small Code node ahead of each. Low harm (both siblings belong to the same
   unmapped customer, so the row is stale rather than wrong), but it is the
   last place the two rows disagree.

2. **`Mark Unmapped` / `Mark Needs Mapping` write only the primary row.**
   The last place a merged pair disagrees — see the note in the README.

## Deploying what is here

| Workflow | What changed | State |
|---|---|---|
| 04 · Autotask Plan | new *Plan From Import* trigger → *Autotask Config*; `Plan Result` code | **deployed & published** |
| 01 · Annuity Import | new *Refresh and re-read Autotask* Execute Workflow node between *Summarize Import* and *Import Complete* | **deployed & published** |
| 02 · CSP Pricing Portal | the *Portal Template* node's `html` (101KB) — plan chips, contract tag, drawer section, stat tile, Refresh and re-read Autotask button | **deployed & published** — pasted by hand, verified byte-exact |

04 goes first because 01 calls it; that order has been followed.

Both deployed changes went in as targeted `update_workflow` operations
(`addNode` / `addConnection` / `updateNodeParameters`) rather than a whole-file
rewrite, which is much easier to get right than a re-transcription. 02 cannot
be done that way — its one parameter *is* the whole file.

## How to work on this safely

- Edit `workflows/templates/` + `workflows/runtime/` + `portal/`, then
  `python3 workflows/build.py`, then run all of `workflows/tests/*.js`.
  Never edit `workflows/generated/` by hand.
- **Deploying is a hand-transcription into the n8n MCP, so verify it.** After
  every deploy, pull the node back with `get_workflow_details` and diff it
  against the repo file. That check has now caught three real drifts.
  `portal.html` is ~101KB in one node and is the worst of them.

  The diff is mechanical, and worth doing exactly this way. A
  `get_workflow_details` on 02 is too big to return inline, so it is written
  to a file — which is the thing that makes a real diff possible:

  ```
  jq -r '.workflow.nodes[] | select(.name=="Portal Template")
         | .parameters.assignments.assignments[0].value' "$TOOL_RESULT_FILE"
  ```

  Strip a leading `=` (expression mode) and compare `md5sum` against
  `portal/portal.html`. Anything but an exact match is a failed deploy.

- **Paste the portal into the field's EXPRESSION editor, never the plain one.**
  The Set node's string field is a single-line input in Fixed mode, and
  pasting 2045 lines into it silently replaces **every newline with a space**.
  The byte count does not change, so nothing looks wrong — but the page's
  script has 271 `//` line comments, the first 63 characters in, and with no
  newline to end it 99.9% of the JavaScript is commented out. The portal
  serves a header and an empty page. This happened on 1 Sep and was caught by
  the diff above, not by looking at it.

  Toggling the value to **Expression** gives a multi-line editor that keeps
  the newlines, and stores it with a leading `=`. That is safe here because
  `portal.html` contains no `{{` — check that it still holds before relying on
  it. A deploy through `update_workflow` does not have the problem at all.

- **The portal cannot be deployed through the MCP, and splitting it does not
  help.** Tried and reverted on 1 Sep; do not spend the afternoon on it again.
  `update_workflow` replaces a node parameter WHOLE, and a JSON Pointer cannot
  address one element of the assignments array — `setNodeParameter` with
  `/assignments/assignments/0/name` returns *"cannot descend into non-object
  at '/assignments/assignments'"*, confirmed against the live instance rather
  than assumed. So the page can only go through in one ~33K-token call, which
  is more than a tool call can carry.

  Splitting it across three chained Set nodes DOES make each part sendable
  (~36KB each) and the round trip is byte-exact — but it turns one paste into
  three for whoever is doing it by hand, which is worse for the common case.
  It was built, verified and reverted for that reason. If a future session
  wants the shape back it is in commits `1a39e06` and `1e633eb`.

  The working process is: paste into the Expression editor, publish, then
  verify with the md5 diff above. That has caught every deploy fault so far.
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
  locally with a fixture. Chromium lives at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (note the version
  suffix — the bare `chromium/` path in the last note was wrong); `npm i
  playwright` in the scratchpad is enough, the browsers are already there.
  Substitute `__DATA_PLACEHOLDER__` with base64 JSON and open the file
  directly — no server needed.

## Live workflow ids

| | id |
|---|---|
| 00 · CSP Access | `pcJUTSSeW2cRow8s` |
| 01 · Annuity Import | `YvQ9T1rEFfIUnQUj` |
| 02 · CSP Pricing Portal | `X9YtsHTLZJd1B21n` |
| 03 · Autotask Sync | `s9t606cOMcSVkufg` |
| 04 · Autotask Plan | `iTE2TSNj225YXBqq` |
| ZZ · Reset CSP Data Tables | `X1stW6srLjbj8wAm` |
