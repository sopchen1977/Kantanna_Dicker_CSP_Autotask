#!/usr/bin/env python3
"""Assemble the final n8n Workflow SDK code from templates + runtime scripts.

Each template contains __TOKEN__ placeholders that are replaced with a
JSON-escaped string literal of the matching runtime script (so the Code-node
jsCode never has escaping problems), plus the n8n data table / credential IDs.

Usage:  python3 workflows/build.py
Output: workflows/generated/*.js  (paste or push these to n8n)
"""
import json
import re
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
    "__REPORT_TABLE_ID__": "bMh0poIYCCOyVsAj",      # csp_report_rows
    "__AUTH_CODES_TABLE_ID__": "Am9KrzhbyWdKOEeY",  # csp_auth_codes
    "__SESSIONS_TABLE_ID__": "dejMhLWVWTKdyYpo",    # csp_sessions
    "__AUTOTASK_CREDENTIAL_ID__": "YXJai935T9ICrDqi",  # KantannaAutotask (httpCustomAuth)
    "__PLAN_WORKFLOW_ID__": "iTE2TSNj225YXBqq",     # 04 · Autotask Plan
}

# ---- runtime scripts embedded as Code-node jsCode
CODE_TOKENS = {
    "__AUTH_PREPARE_CODE__": "auth-prepare-code.js",
    "__AUTH_BUILD_CODE_PAGE__": "auth-build-code-page.js",
    "__AUTH_CHECK_CODE__": "auth-check-code.js",
    "__AUTH_READ_COOKIE__": "auth-read-cookie.js",
    "__AUTH_CHECK_SESSION__": "auth-check-session.js",
    "__NORMALIZE_UPLOADS__": "normalize-uploads.js",
    "__PARSE_LINES__": "parse-lines.js",
    "__SUMMARIZE_IMPORT__": "summarize-import.js",
    "__SNAPSHOT_REPORT_ROWS__": "snapshot-report-rows.js",
    "__BUILD_PORTAL_PAGE__": "build-portal-page.js",
    "__ATTACH_SESSION_TOKEN__": "attach-session-token.js",
    "__BUILD_REPORT_PAGE__": "build-report-page.js",
    "__SPLIT_SAVE_LINES__": "split-save-lines.js",
    "__SAVE_SUMMARY__": "save-summary.js",
    "__COMPANIES_RESPONSE__": "companies-response.js",
    "__PREPARE_LINES__": "prepare-lines.js",
    "__SERVICE_DECISION__": "service-decision.js",
    "__SERVICE_FROM_CREATE__": "service-from-create.js",
    "__SERVICE_PATCHED__": "service-patched.js",
    "__CONTRACT_DECISION__": "contract-decision.js",
    "__CONTRACT_FROM_CREATE__": "contract-from-create.js",
    "__CONTRACT_PATCHED__": "contract-patched.js",
    "__CS_DECISION__": "cs-decision.js",
    "__CS_FROM_CREATE__": "cs-from-create.js",
    "__CS_AFTER_PATCH__": "cs-after-patch.js",
    "__UNITS_DECISION__": "units-decision.js",
    "__PLAN_RESULT__": "plan-result.js",
    "__PLAN_DONE__": "plan-done.js",
    "__BILLING_SUMMARY__": "billing-summary.js",
    "__SPLIT_PLAN__": "split-plan.js",
    "__ADJUST_RESULT__": "adjust-result.js",
    "__DESC_RESULT__": "desc-result.js",
    "__SYNC_RESULT__": "sync-result.js",
    "__SYNC_DONE__": "sync-done.js",
}


def runtime_literal(filename: str) -> str:
    code = (RUNTIME / filename).read_text()
    return json.dumps(code)


PORTAL_PARTS = 6


def portal_html_parts() -> list:
    """The portal page, split into PORTAL_PARTS string literals.

    n8n takes a node parameter whole, so a single 100KB field can only be
    redeployed by re-sending the entire page at once - too much for one tool
    call, and impossible to review. Split, each part deploys and diffs on its
    own. Build Portal Page joins them back.

    The split is at LINE boundaries, which keeps __DATA_PLACEHOLDER__ (and
    every other marker) whole, and the parts are asserted to reassemble into
    exactly the source file before anything is written.
    """
    text = (HERE.parent / "portal" / "portal.html").read_text()
    lines = text.splitlines(keepends=True)
    size = -(-len(lines) // PORTAL_PARTS)  # ceil, so the last part is the short one
    parts = ["".join(lines[i:i + size]) for i in range(0, len(lines), size)]
    parts += [""] * (PORTAL_PARTS - len(parts))
    assert "".join(parts) == text, "portal split does not reassemble"
    assert sum(p.count("__DATA_PLACEHOLDER__") for p in parts) == 1, \
        "__DATA_PLACEHOLDER__ was split across parts"
    return [json.dumps(p) for p in parts]


def signin_html() -> str:
    """The sign-in page, served in place of any protected page when the
    caller has no live session."""
    return json.dumps((HERE.parent / "portal" / "signin.html").read_text())


def signin_code_html() -> str:
    """The second sign-in step (enter your code), rendered server-side."""
    return json.dumps((HERE.parent / "portal" / "signin-code.html").read_text())


def report_html() -> str:
    """The uploaded-tab viewer, injected into the Report Template Set node."""
    return json.dumps((HERE.parent / "portal" / "report.html").read_text())


def import_done_html() -> str:
    """The upload form's completion page, injected into the Form node.

    The file's HTML comment is repo documentation, not page content, and it is
    stripped rather than shipped - it explains the {{ }} expression rule and so
    contains an empty {{ }} that n8n would otherwise try to evaluate. What is
    left is collapsed to one line: it becomes an n8n expression, so newlines
    buy nothing.
    """
    text = (HERE.parent / "portal" / "import-complete.html").read_text()
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return json.dumps(" ".join(text.split()))


def build() -> None:
    OUT.mkdir(exist_ok=True)
    for tmpl in sorted(TEMPLATES.glob("*.tmpl.js")):
        text = tmpl.read_text()
        for token, filename in CODE_TOKENS.items():
            if token in text:
                text = text.replace(token, runtime_literal(filename))
        if "__PORTAL_HTML_1__" in text:
            for i, part in enumerate(portal_html_parts(), start=1):
                text = text.replace("__PORTAL_HTML_%d__" % i, part)
        if "__SIGNIN_HTML__" in text:
            text = text.replace("__SIGNIN_HTML__", signin_html())
        if "__SIGNIN_CODE_HTML__" in text:
            text = text.replace("__SIGNIN_CODE_HTML__", signin_code_html())
        if "__REPORT_HTML__" in text:
            text = text.replace("__REPORT_HTML__", report_html())
        if "__IMPORT_DONE_HTML__" in text:
            text = text.replace("__IMPORT_DONE_HTML__", import_done_html())
        for token, value in IDS.items():
            text = text.replace(token, value)
        out_path = OUT / tmpl.name.replace(".tmpl.js", ".js")
        out_path.write_text(text)
        print(f"built {out_path.relative_to(HERE.parent)} ({len(text)} bytes)")


if __name__ == "__main__":
    build()
