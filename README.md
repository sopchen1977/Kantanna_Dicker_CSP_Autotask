# Kantanna · Dicker Data CSP → Autotask Automation

n8n automation that turns the monthly Dicker Data CSP exports into Autotask
Services and Contracts, with a pricing portal where sell prices default to
RRP but can be overridden per subscription line.

Everything lives in the n8n project **Kantanna Dicker CSP and Autotask**
(`https://gayleai.app.n8n.cloud`, project id `RGbuWbB4pjqi8VT3`).

> **Customer scope:** the customer filter is **off** — `PILOT_CUSTOMERS` at
> the top of the *Parse Subscription Lines* Code node (workflow 01) is an
> empty list, so every customer in the uploaded files is imported. Put names
> back in that list (matched as a substring) to narrow the import again.

## Signing in

Every page and endpoint is behind a sign-in. Open any of them and you land on
a code request: enter a Kantanna address, a six-digit code arrives by email
from the Kantanna mailbox, hand it back and you are taken on to the page you
asked for. A session lasts 14 days on that browser; *Sign out* in the portal's
header ends it.

Only `kantanna.com`, `kantanna.com.au` and `kantanna.ph` addresses are
accepted, compared as whole domains rather than as suffixes, so a lookalike
like `evil-kantanna.com` is refused. Codes last 10 minutes, are single use,
allow five attempts, and are rate limited to 5 per hour per address and 15 per
hour per IP. Codes and sessions are stored only as SHA-256 hashes, so neither
table holds anything that can be signed in with. The reply to a code request
never varies — the same text whether the address is a Kantanna one, rate
limited, or nonsense — so the endpoint cannot be used to find out who works
at Kantanna.

The sign-in is a sequence of ordinary form POSTs rather than a background
`fetch()`, because n8n Cloud serves every webhook response under
`Content-Security-Policy: sandbox`. That puts the page in an opaque origin,
where a cookie set on a `fetch()` response is discarded; a form submit
navigates the top-level window, which is first-party, so the cookie sticks.
For the same reason the portal's own background calls cannot send a cookie,
and carry an explicit session token instead.

## The workflows

| # | Workflow | Trigger | What it does |
|---|----------|---------|--------------|
| 00 | **CSP Access** (`pcJUTSSeW2cRow8s`) | Webhooks `csp-auth-request` / `csp-auth-verify` / `csp-auth-signout` | The sign-in service, and the *Access Check* sub-workflow every other endpoint calls before it does anything else. Issues and verifies email codes, mints and ends sessions. |
| 01 | **Annuity Import (Upload)** (`YvQ9T1rEFfIUnQUj`) | n8n Form | Upload the monthly **Annuity Information** + **CSP Invoice Report** (.xlsx). Reads only the `DETAILS` / `Invoice Details` tabs, normalises each subscription line (SKU + term parsed from the stock code, product name from the annuity STOCK DESCRIPTION, per-term prices converted to per-unit **monthly** cost/RRP, term dates taken from the invoice report), and upserts into the `csp_subscription_lines` data table keyed by *Subscription ID + Stock Code*. Custom sell prices and include/exclude choices survive re-imports. |
| 02 | **CSP Pricing Portal** (`X9YtsHTLZJd1B21n`) | Webhook `GET /webhook/csp-pricing` | Web page grouped by customer: qty, monthly cost, monthly RRP, margin. Sell price **defaults to RRP**; tick *Custom* to set your own price. Map each Dicker tenant to an Autotask company (live company search). *Save prices* persists, *Sync to Autotask* kicks off workflow 03. |
| 03 | **Autotask Sync** (`s9t606cOMcSVkufg`) | Webhook `POST /webhook/csp-autotask-sync` | Per included line: resolve the company mapping → ensure an Autotask **Service** exists for the SKU+term, matched on its **SKU field** and renamed in place if its name has drifted (created with monthly RRP/cost) → ensure a **Contract** exists for the co-term group, matched on its Autotask **External Contract Number** → add/re-price the contract service at the chosen sell price → adjust units to the imported quantity. Results (synced / needs_mapping / error + message and Autotask IDs) are written back per line and shown in the portal. |
| 04 | **Autotask Plan** (`iTE2TSNj225YXBqq`) | Sub-workflow (end of the import) · Webhook `POST /webhook/csp-autotask-plan` | Workflow 03 with every write taken out. Runs the same four decisions over the same four `/query` calls and stores per line what the sync **would** do — create or rename the service, create or extend the contract, add or re-price the contract service, and the unit adjustments with their dates — into the `plan_*` columns, so the portal can show the job before you approve it. Nothing here creates, patches or posts. |

### Data tables (n8n project storage)

| Table | ID | Purpose |
|-------|----|---------|
| `csp_subscription_lines` | `FDGqV46wAYu9bnGe` | Current state of every imported subscription line + pricing decisions + sync results |
| `csp_customer_mappings` | `U7ymd9nAyD0GCLYb` | Dicker tenant name → Autotask company |
| `csp_sku_services` | `ai3p8JIYv082bfjn` | SKU+term → Autotask Service id (audit/cache) |
| `csp_report_rows` | `bMh0poIYCCOyVsAj` | The uploaded Annuity DETAILS and CSP Invoice Details tabs, verbatim, behind the portal's two source links |
| `csp_auth_codes` | `Am9KrzhbyWdKOEeY` | Live sign-in codes, hashed |
| `csp_sessions` | `dejMhLWVWTKdyYpo` | Live sessions, hashed |

**Starting a test round from empty tables.** The utility workflow
**ZZ · Reset CSP Data Tables** (`X1stW6srLjbj8wAm`) empties the four CSP data
tables — the first three above plus `csp_report_rows` — run it by hand from
the n8n canvas. The first three are dumped to its execution log before they
are deleted; `csp_report_rows` is not, because the .xlsx you uploaded is its
backup. The two sign-in tables are left alone: clearing them would only sign
everyone out. Nothing in Autotask is touched either — clear the External
Contract Number off any test contract there yourself, or the next sync will
adopt that contract again instead of creating a fresh one. To read the old
rows back, open the execution the reset produced; the dump nodes run before
the deletes.

## One-time setup (before the first sync)

1. **Share the Autotask credential with the project.** In n8n:
   *Credentials → `KantannaAutotask` (HTTP Custom Auth) → Share → add the
   project “Kantanna Dicker CSP and Autotask”.* Then open workflows 02 and 03
   and select it on every HTTP Request node (they currently show a
   `KantannaAutotask` placeholder). The credential must send the three
   Autotask REST headers: `ApiIntegrationCode`, `UserName`, `Secret`.
2. **Autotask zone.** Already set to ww31
   (`https://webservices31.autotask.net/atservicesrest/v1.0`) in workflow 03 →
   *Autotask Config* and workflow 02 → *Portal Autotask Config*. Verify with
   `GET https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation?user=<api-user>`
   if API calls come back 404/redirected.
3. **Billing code**: Services are created with `billingCodeID 29683278`
   ("Cloud and SaaS" — note the UI shows display number 594, but the API
   needs the entity ID) via *Autotask Config*. Note the REST API's picklists are
   integers: Service/contract period type 2 = Monthly, 5 = Yearly (confirmed
   via the ww31 `entityInformation/fields` endpoint; see the
   *ZZ · Autotask Field Inspector* utility workflow).
4. Check the contract defaults in *Autotask Config*: contract type `7`
   (Recurring Service), status `1` (Active), monthly period.
5. **Sign-in mail.** Workflow 00's *Send Code Email* node sends through the
   Microsoft Outlook credential **Sop Kantanna Email**, which must be shared
   with the project — a code that cannot be sent is a sign-in nobody can
   complete. The failure is deliberately silent to the visitor (the reply
   never varies), so check the workflow's executions rather than the page.

## Monthly run

1. Open the upload form at
   `https://gayleai.app.n8n.cloud/webhook/csp-import` and sign in when asked
   (see [Signing in](#signing-in)), then upload both files. File detection is
   by name: one must contain “Annuity”, the other “Invoice”/“CSP”. The
   completion page appears straight away; workflow 04 keeps running behind it,
   working out what the sync would do to each line. It takes a couple of
   minutes — roughly four Autotask queries per line against a three-thread
   limit — so open the portal and it fills in.
2. Open the portal: `https://gayleai.app.n8n.cloud/webhook/csp-pricing`.
   - Map any customers flagged **not mapped**.
   - Review sell prices (default = monthly RRP); tick *Custom* to override.
   - Untick *Incl.* for lines you don’t want in Autotask. Azure usage plans
     (charge type ≠ NCE or RRP = 0) are excluded by default. The tick on each
     customer's header does the whole customer at once — it includes every
     line shown when some or none are in, and clears them all when they are
     all in. It acts on the lines on screen, so it follows the filter.
   - Read what the sync is going to do, under each service name: *new
     service*, *will be added @ $34.55*, *re-price $30.00 → $34.55*, *units
     259 → 275*, or *nothing to do*. Open a row for the same thing with its
     dates. The contract header says *will be created* or *extend to …*, and
     the **Autotask plan** tile counts what is left to do across the page.
     The import works this out; **Check Autotask** does it again after you
     change something. It only ever reads Autotask.
   - **Save prices**, then **Sync to Autotask**.
3. Refresh the portal to see per-line results (contract id, actions taken, or
   the exact Autotask error).

> **A price edited by hand in Autotask will be pushed back.** The Sell column
> shows what the contract charges today, but the sync's own default is the
> **RRP** — so a service repriced directly in Autotask, on a line with no
> custom price here, is set back to RRP on the next sync. The plan says so
> (*re-price $30.00 → $34.55*) rather than letting it happen quietly. Tick
> *Custom* and enter the price you want to keep it.

The two links under the page title, **Annuity DETAILS** and **CSP Invoice
Details**, show the tabs of the workbooks this page was built from exactly as
they were uploaded, for checking a number against its source without
reopening the .xlsx.

### Billing types & pricing model

The 4th segment of the Dicker stock code encodes the billing plan, giving the
three CSP billing types. Each becomes its **own Autotask Service** with a
matching billing period, so it bills correctly on a recurring contract:

| Stock code pattern | Billing type | Service key | Autotask period | Price basis |
|---|---|---|---|---|
| `P1Y:{sku}:…:1:` | Annual Commit, paid **Monthly** | `ANN-MO:{sku}` | 2 (Monthly) | annual ÷ 12, per month |
| `P1Y:{sku}:…:Y:` | Annual Commit, paid **Annually (upfront)** | `ANN-YR:{sku}` | 5 (Yearly) | full annual amount, per year |
| `P1M:{sku}:…:1:` | **Month to Month** | `MTM:{sku}` | 2 (Monthly) | monthly amount |
| `DZH…` (Azure) | Usage-based | excluded by default | — | — |

Service names are the annuity report's **STOCK DESCRIPTION** plus the billing
type and SKU, e.g. `MS NCE M365 BUSINESS PREMIUM 1 YR COMMIT - Annual Commit
(Billed Monthly) [CFQ7TTC0LCHC]`. The annuity sheet's other name column,
REFERENCE, is only a fallback: it holds 30 characters of whatever Dicker's
catalogue currently calls the product, truncated, so a product Dicker has
retired and relabelled arrives as `DO NOT USE - Microsoft Defende`. Autotask
caps a service name at 100 characters, and when a stock description is long
enough to overflow it is the description that is trimmed — the billing type
and SKU always survive, because they are what make two billing types of one
product different services.

**A service is identified by its SKU field, never by its name** — the same
rule the contract follows. Every service the sync creates carries its service
key (`ANN-MO:CFQ7TTC0LCHC:001J`) in Autotask's `sku` field and is matched on
it from then on, so a product name can be corrected without the next sync
building a duplicate service beside the one already on the contracts. When the
name has drifted, the sync renames the service in place — but only a name it
generated itself (one ending in ` - {billing type} [{SKU}]`); a name typed by
hand in Autotask is left alone. A service created before the key was written
to `sku` is adopted once by its name, and that same PATCH stamps the key on.

**One contract per co-term group.** Autotask steps a contract's billing
periods from its START DATE, and Dicker bills every co-termed subscription on
its group's anchor day - so the contract belongs to the GROUP, not to the
subscription: one per customer + billing type + anniversary, holding every
subscription that shares that renewal date.

**A contract is identified by its External Contract Number, never by its
name.** On create, the sync writes a reference into Autotask's `contractNumber`
field and matches on it from then on:

| Reference | Means |
| --- | --- |
| `CSP-ANN-MO-20251001-20260930` | annual commit billed monthly, co-term year 1 Oct 2025 - 30 Sep 2026 |
| `CSP-ANN-YR-20251229-20261228` | the same, billed annually upfront |
| `CSP-MTM-D1-20251218` | month to month, 1st-of-month billing cycle, subscription started 18 Dec 2025 |

Names are labels: `CSP Microsoft Annual Commit Monthly 1 Oct 2025 to 30 Sep
2026`, or `CSP Microsoft Month to Month Started 18 Dec 2025`. They can be
reworded here or edited by hand in Autotask without the next import losing
track of a contract that has already been approved, posted and invoiced.

A contract created before the reference existed is adopted once, matched on
the name it was given then (including the older `Started 2025-12-18` form),
and the same PATCH stamps the reference on and brings the name up to date.
After that the name is nobody's business but the reader's. A contract already
carrying a *different* reference is never adopted, and a failed lookup is
reported as an error rather than treated as "no contract exists" - either
would put a second contract beside the real one.

When the new report's billing cycle (month-to-month auto-renews at Dicker each
cycle) or a renewed annual term ends after the contract's current end date,
the contract endDate is **extended in place** automatically.
The import stores both monthly figures (`monthly_cost`/`monthly_rrp`, for
comparison) and per-billing-period figures (`period_cost`/`period_rrp`, what
Autotask bills). Sell prices in the portal are **per billing period** — per
month for monthly-billed lines, per year for annual-upfront lines — and
default to the per-period RRP.

### Quantity history replays the CSP report

The sync first derives each subscription's BILLING CYCLE from all of its
CSP invoice lines (distinct from the subscription term): cycle end = the
latest USAGE END; the cycle line = the earliest-starting line with that
end, giving the cycle start and the cycle quantity. Every other line is a
pro-rata change effective at its own USAGE START. Contract quantities are
then built up chronologically, exactly how Autotask expects: pro-rata
items first in date order, the cycle quantity at cycle start, then a
final correction to the annuity quantity (e.g. Atlas M365 BP: +6 @
13-Jul, +10 @ 27-Jul, +259 @ 31-Jul = 275; cycle 31-Jul..30-Aug). Units
only ever exist from dates shown in the report, so Autotask never
back-bills earlier periods.

The replay runs the same way on a service Autotask has never billed and on
one in its tenth month. Each event is posted as the gap between the quantity
the report puts in force from that date and the quantity Autotask already
holds there, read from the service's own unit history — so a change Autotask
already has costs nothing, and syncing the same report twice posts no
adjustments at all. An event older than the service's first unit record is
not back-dated onto a period Autotask never billed; the quantity still lands
in the correction. Adjustments are posted oldest-first, one at a time
(Autotask's 3-thread API limit).

### Price-change effective dates

Each portal line has a **From** date (defaults to today), matching how
Autotask handles contract price changes. On sync, price changes and unit
changes are pushed as Contract Service Adjustments with that
`effectiveDate`, so a price change can be scheduled for e.g. the start of
next month.

## Repository layout

```
workflows/
  templates/   n8n Workflow-SDK source with __TOKEN__ placeholders
               (00-03 plus zz-reset-data-tables, the manual table reset)
  runtime/     the JavaScript that runs inside each Code node
  tests/       node test harness for the parse, sync and sign-in logic
  build.py     assembles templates + runtime (+ the HTML pages) → generated/
  generated/   final SDK code actually deployed to n8n (built artifact)
portal/
  portal.html          the pricing portal single-page app served by workflow 02
  report.html          the verbatim view of an uploaded workbook tab
  signin.html          the address form
  signin-code.html     the code form
  import-complete.html the upload form's hand-off back to the portal
```

To change a workflow: edit the template/runtime/portal source, run
`python3 workflows/build.py`, test with `node workflows/tests/test-parse.js`,
`node workflows/tests/test-sync.js` and `node workflows/tests/test-auth.js`,
then update the workflow in n8n from the matching `workflows/generated/*.js`
file.

## Known caveats

- Autotask REST field names for `ContractServices` / `ContractServiceAdjustments`
  child routes can vary by Autotask version. If the first sync reports an
  error on those steps, the portal shows the exact Autotask message per line —
  adjust the JSON body in the corresponding HTTP node.
- The sync webhook responds immediately (`onReceived`) and runs in the
  background; refresh the portal to see progress.
- Contract start/end dates come from the invoice report’s TERM START/END,
  falling back to the annuity’s REVALUATION PERIOD (current term’s renewal
  date), then usage start + term length. Adjustment/effective dates are
  clamped into the contract window, and an existing contract whose endDate
  predates the current term end is extended automatically (Autotask rejects
  adjustments dated outside the contract window).
- A successful `ContractServiceAdjustments` POST returns `itemId: null` —
  the sync treats “no error in the response” as success.
