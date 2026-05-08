"""mitmproxy addon — rewrite Anthropic's /bridge response so api_base_url
points at the local Vakka relay. Combined with sse-tee.py if you want both
in one mitmdump session:

    mitmdump -s tools/mitm/bridge-rewrite.py -s tools/mitm/sse-tee.py

What it does:
- On POST .../v1/code/sessions/{cseId}/bridge, after Anthropic's response
  comes back, JSON-decode it and replace api_base_url with VK_RELAY_URL.
- Optionally also replaces worker_jwt with the original (no change needed —
  CC's worker traffic now goes to our relay using the real JWT, which the
  relay accepts blindly).

After this, all subsequent /worker/* requests from CC dial VK_RELAY_URL
instead of api.anthropic.com — they bypass mitmproxy entirely.

Configure with env var VK_RELAY_URL (default http://127.0.0.1:9876).
"""
import json
import os
import re
from mitmproxy import http

VK_RELAY_URL = os.environ.get("VK_RELAY_URL", "http://127.0.0.1:9876")
BRIDGE_RE = re.compile(r"/v1/code/sessions/[^/]+/bridge$")


def response(flow: http.HTTPFlow) -> None:
    if flow.request.method != "POST":
        return
    if not BRIDGE_RE.search(flow.request.path):
        return
    if flow.response.status_code != 200:
        return
    try:
        body = json.loads(flow.response.get_text())
    except Exception:
        return
    original = body.get("api_base_url")
    if not original:
        return
    body["api_base_url"] = VK_RELAY_URL
    flow.response.set_text(json.dumps(body))
    print(f"[bridge-rewrite] {flow.request.path}: api_base_url {original} → {VK_RELAY_URL}")
