#!/usr/bin/env python3
"""Assemble the final n8n Workflow SDK code from templates + runtime scripts.

Each template contains __TOKEN__ placeholders that are replaced with a
JSON-escaped string literal of the matching runtime script (so the Code-node
jsCode never has escaping problems), plus the n8n data table / credential IDs.

Usage:  python3 workflows/build.py
Output: workflows/generated/*.js  (paste or push these to n8n)
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
RUNTIME = HERE / "runtime"
TEMPLATES = HERE / "templates"
OUT = HERE / "generated"

# ---- environment-specific IDs (n8n project: Kantanna Dicker CSP and Autotask)
#
# Two variants are built from the same templates. "" is the live pilot; "-test"
# is a throwaway stack with its own data tables, its own webhook paths and its
# own upload form, so a test import can never touch pilot data. Everything else
# — the parsing, the pricing maths, the Autotask calls — is identical code.
VARIANTS = {
    "": {
        "__LINES_TABLE_ID__": "FDGqV46wAYu9bnGe",       # csp_subscription_lines
        "__MAPPINGS_TABLE_ID__": "U7ymd9nAyD0GCLYb",    # csp_customer_mappings
        "__SERVICES_TABLE_ID__": "ai3p8JIYv082bfjn",    # csp_sku_services
        "__AUTOTASK_CREDENTIAL_ID__": "YXJai935T9ICrDqi",  # KantannaAutotask
        "__SUFFIX__": "",
        "__TABLE_SUFFIX__": "",
        "__WF_SUFFIX__": "",
        "__PILOT_CUSTOMERS__": "['B E Smart Admin Services']",
        "__FORM_URL__": "https://gayleai.app.n8n.cloud/form/5c4bd81e-8556-4639-835f-4de4a7faefb3",
    },
    "-test": {
        "__LINES_TABLE_ID__": "QLQ1Ov51TXE2UiP0",       # csp_subscription_lines_test
        "__MAPPINGS_TABLE_ID__": "wGmRrV8dJLH0C4R0",    # csp_customer_mappings_test
        # The SKU -> Autotask Service map is deliberately SHARED: an Autotask
        # Service is a global product, so the test reuses the ones already
        # created rather than making duplicates in the product catalogue.
        "__SERVICES_TABLE_ID__": "ai3p8JIYv082bfjn",
        "__AUTOTASK_CREDENTIAL_ID__": "YXJai935T9ICrDqi",
        "__SUFFIX__": "-test",
        "__TABLE_SUFFIX__": "_test",
        "__WF_SUFFIX__": " · TEST",
        "__PILOT_CUSTOMERS__": "['Galilee']",
        "__FORM_URL__": "https://gayleai.app.n8n.cloud/form/631341bd-c7cd-49d1-ba58-441ec19deb1c",
    },
}

# ---- runtime scripts embedded as Code-node jsCode
CODE_TOKENS = {
    "__NORMALIZE_UPLOADS__": "normalize-uploads.js",
    "__PARSE_LINES__": "parse-lines.js",
    "__SUMMARIZE_IMPORT__": "summarize-import.js",
    "__BUILD_PORTAL_PAGE__": "build-portal-page.js",
    "__SPLIT_SAVE_LINES__": "split-save-lines.js",
    "__SAVE_SUMMARY__": "save-summary.js",
    "__COMPANIES_RESPONSE__": "companies-response.js",
    "__PREPARE_LINES__": "prepare-lines.js",
    "__SERVICE_DECISION__": "service-decision.js",
    "__SERVICE_FROM_CREATE__": "service-from-create.js",
    "__CONTRACT_DECISION__": "contract-decision.js",
    "__CONTRACT_FROM_CREATE__": "contract-from-create.js",
    "__CONTRACT_EXTENDED__": "contract-extended.js",
    "__CS_DECISION__": "cs-decision.js",
    "__CS_FROM_CREATE__": "cs-from-create.js",
    "__CS_AFTER_PATCH__": "cs-after-patch.js",
    "__UNITS_DECISION__": "units-decision.js",
    "__BILLING_SUMMARY__": "billing-summary.js",
    "__SPLIT_PLAN__": "split-plan.js",
    "__ADJUST_RESULT__": "adjust-result.js",
    "__DESC_RESULT__": "desc-result.js",
    "__SYNC_RESULT__": "sync-result.js",
    "__SYNC_DONE__": "sync-done.js",
}


def portal_html() -> str:
    """The portal page, injected verbatim into the Portal Template Set node."""
    return json.dumps((HERE.parent / "portal" / "portal.html").read_text())


def build() -> None:
    OUT.mkdir(exist_ok=True)
    for suffix, ids in VARIANTS.items():
        for tmpl in sorted(TEMPLATES.glob("*.tmpl.js")):
            text = tmpl.read_text()
            for token, filename in CODE_TOKENS.items():
                if token in text:
                    code = (RUNTIME / filename).read_text()
                    # Runtime scripts carry their own tokens (the pilot filter),
                    # substituted before the script is embedded as a literal.
                    for t, v in ids.items():
                        code = code.replace(t, v)
                    text = text.replace(token, json.dumps(code))
            if "__PORTAL_HTML__" in text:
                text = text.replace("__PORTAL_HTML__", portal_html())
            for token, value in ids.items():
                text = text.replace(token, value)
            name = tmpl.name.replace(".tmpl.js", f"{suffix}.js")
            out_path = OUT / name
            out_path.write_text(text)
            print(f"built {out_path.relative_to(HERE.parent)} ({len(text)} bytes)")


if __name__ == "__main__":
    build()
