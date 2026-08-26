# Kantanna · Dicker Data CSP → Autotask Automation

n8n automation that turns the monthly Dicker Data CSP exports into Autotask
Services and Contracts, with a pricing portal where sell prices default to
RRP but can be overridden per subscription line.

Everything lives in the n8n project **Kantanna Dicker CSP and Autotask**
(`https://gayleai.app.n8n.cloud`, project id `RGbuWbB4pjqi8VT3`).

> **Pilot scope:** the import currently only keeps lines for
> **ATLAS OUTSOURCING PTY LTD** and **Galilee Solicitors**. Edit the
> `PILOT_CUSTOMERS` list at the top of the *Parse Subscription Lines* Code
> node (workflow 01) to add customers, or make the list empty to import all.

## The three workflows

| # | Workflow | Trigger | What it does |
|---|----------|---------|--------------|
| 01 | **Annuity Import (Upload)** (`YvQ9T1rEFfIUnQUj`) | n8n Form | Upload the monthly **Annuity Information** + **CSP Invoice Report** (.xlsx). Reads only the `DETAILS` / `Invoice Details` tabs, normalises each subscription line (SKU + term parsed from the stock code, per-term prices converted to per-unit **monthly** cost/RRP, term dates taken from the invoice report), and upserts into the `csp_subscription_lines` data table keyed by *Subscription ID + Stock Code*. Custom sell prices and include/exclude choices survive re-imports. |
| 02 | **CSP Pricing Portal** (`X9YtsHTLZJd1B21n`) | Webhook `GET /webhook/csp-pricing` | Web page grouped by customer: qty, monthly cost, monthly RRP, margin. Sell price **defaults to RRP**; tick *Custom* to set your own price. Map each Dicker tenant to an Autotask company (live company search). *Save prices* persists, *Sync to Autotask* kicks off workflow 03. |
| 03 | **Autotask Sync** (`s9t606cOMcSVkufg`) | Webhook `POST /webhook/csp-autotask-sync` | Per included line: resolve the company mapping → ensure an Autotask **Service** exists for the SKU+term (created with monthly RRP/cost) → ensure a **Contract** exists whose name embeds the **Subscription ID** (`CSP - {offer} - {subscription id}`) → add/re-price the contract service at the chosen sell price → adjust units to the imported quantity. Results (synced / needs_mapping / error + message and Autotask IDs) are written back per line and shown in the portal. |

### Data tables (n8n project storage)

| Table | ID | Purpose |
|-------|----|---------|
| `csp_subscription_lines` | `FDGqV46wAYu9bnGe` | Current state of every imported subscription line + pricing decisions + sync results |
| `csp_customer_mappings` | `U7ymd9nAyD0GCLYb` | Dicker tenant name → Autotask company |
| `csp_sku_services` | `ai3p8JIYv082bfjn` | SKU+term → Autotask Service id (audit/cache) |

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
3. **Material code**: already set — Services are created with material code
   `594` (Cloud and SaaS) via *Autotask Config*.
4. Check the contract defaults in *Autotask Config*: contract type `7`
   (Recurring Service), status `1` (Active), monthly period.

## Monthly run

1. Open the upload form at
   `https://gayleai.app.n8n.cloud/webhook/csp-import` (redirects to the n8n
   form) and upload both files. File detection is by name: one must contain
   “Annuity”, the other “Invoice”/“CSP”.
2. Open the portal: `https://gayleai.app.n8n.cloud/webhook/csp-pricing`.
   - Map any customers flagged **not mapped**.
   - Review sell prices (default = monthly RRP); tick *Custom* to override.
   - Untick *Incl.* for lines you don’t want in Autotask. Azure usage plans
     (charge type ≠ NCE or RRP = 0) are excluded by default.
   - **Save prices**, then **Sync to Autotask**.
3. Refresh the portal to see per-line results (contract id, actions taken, or
   the exact Autotask error).

### Billing types & pricing model

The 4th segment of the Dicker stock code encodes the billing plan, giving the
three CSP billing types. Each becomes its **own Autotask Service** with a
matching billing period, so it bills correctly on a recurring contract:

| Stock code pattern | Billing type | Service key | Autotask period | Price basis |
|---|---|---|---|---|
| `P1Y:{sku}:…:1:` | Annual Commit, paid **Monthly** | `ANN-MO:{sku}` | `m` (monthly) | annual ÷ 12, per month |
| `P1Y:{sku}:…:Y:` | Annual Commit, paid **Annually (upfront)** | `ANN-YR:{sku}` | `y` (yearly) | full annual amount, per year |
| `P1M:{sku}:…:1:` | **Month to Month** | `MTM:{sku}` | `m` (monthly) | monthly amount |
| `DZH…` (Azure) | Usage-based | excluded by default | — | — |

Service names carry the billing type, e.g.
`Microsoft 365 Business Premium - Annual Commit (Monthly) [CFQ7TTC0LCHC]`.
The import stores both monthly figures (`monthly_cost`/`monthly_rrp`, for
comparison) and per-billing-period figures (`period_cost`/`period_rrp`, what
Autotask bills). Sell prices in the portal are **per billing period** — per
month for monthly-billed lines, per year for annual-upfront lines — and
default to the per-period RRP.

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
  runtime/     the JavaScript that runs inside each Code node
  tests/       node test harness for the parse + sync decision logic
  build.py     assembles templates + runtime (+ portal HTML) → generated/
  generated/   final SDK code actually deployed to n8n (built artifact)
portal/
  portal.html  the pricing portal single-page app served by workflow 02
```

To change a workflow: edit the template/runtime/portal source, run
`python3 workflows/build.py`, test with `node workflows/tests/test-parse.js`
and `node workflows/tests/test-sync.js`, then update the workflow in n8n from
the matching `workflows/generated/*.js` file.

## Known caveats

- Autotask REST field names for `ContractServices` / `ContractServiceAdjustments`
  child routes can vary by Autotask version. If the first sync reports an
  error on those steps, the portal shows the exact Autotask message per line —
  adjust the JSON body in the corresponding HTTP node.
- The sync webhook responds immediately (`onReceived`) and runs in the
  background; refresh the portal to see progress.
- Contract start/end dates come from the invoice report’s TERM START/END
  (falling back to usage start + term length).
