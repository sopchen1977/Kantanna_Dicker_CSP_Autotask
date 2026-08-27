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
IDS = {
    "__LINES_TABLE_ID__": "FDGqV46wAYu9bnGe",       # csp_subscription_lines
    "__MAPPINGS_TABLE_ID__": "U7ymd9nAyD0GCLYb",    # csp_customer_mappings
    "__SERVICES_TABLE_ID__": "ai3p8JIYv082bfjn",    # csp_sku_services
    "__AUTOTASK_CREDENTIAL_ID__": "YXJai935T9ICrDqi",  # KantannaAutotask (httpCustomAuth)
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
    "__SYNC_RESULT__": "sync-result.js",
    "__SYNC_DONE__": "sync-done.js",
}


def runtime_literal(filename: str) -> str:
    code = (RUNTIME / filename).read_text()
    if filename == "build-portal-page.js":
        html = (HERE.parent / "portal" / "portal.html").read_text()
        code = code.replace("__PORTAL_HTML__", json.dumps(html))
    return json.dumps(code)


def build() -> None:
    OUT.mkdir(exist_ok=True)
    for tmpl in sorted(TEMPLATES.glob("*.tmpl.js")):
        text = tmpl.read_text()
        for token, filename in CODE_TOKENS.items():
            if token in text:
                text = text.replace(token, runtime_literal(filename))
        for token, value in IDS.items():
            text = text.replace(token, value)
        out_path = OUT / tmpl.name.replace(".tmpl.js", ".js")
        out_path.write_text(text)
        print(f"built {out_path.relative_to(HERE.parent)} ({len(text)} bytes)")


if __name__ == "__main__":
    build()
