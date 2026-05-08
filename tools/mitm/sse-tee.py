"""mitmproxy addon: stream SSE responses (so SSE delivery isn't blocked by
mitmproxy's default response-buffering) AND tee each chunk to an NDJSON log.

Usage:
    mitmdump -w ~/.vakka/rc-flows3.mitm -s tools/mitm/sse-tee.py

Output:
    ~/.vakka/rc-sse.ndjson — one JSON line per chunk
    {ts, flow_id, direction:"down", method, url, status, chunk}

Also captures request bodies for POSTs to /worker/events and /events so we get
the controller->server direction in the same log:
    {ts, flow_id, direction:"up", method, url, body}
"""
from mitmproxy import http
import json, time, pathlib, uuid

LOG = pathlib.Path.home() / ".vakka" / "rc-sse.ndjson"
LOG.parent.mkdir(parents=True, exist_ok=True)


def _write(record: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def request(flow: http.HTTPFlow) -> None:
    # Strip Accept-Encoding on the SSE stream request so the response comes
    # back uncompressed — mitmproxy can't tee a gzipped/zstd stream chunk-by-
    # chunk (it must buffer the whole body to decompress), which kills SSE
    # delivery to CC. Identity encoding lets streaming work.
    url = flow.request.pretty_url
    if "/worker/events/stream" in url or "/events/stream" in url:
        flow.request.headers["accept-encoding"] = "identity"

    # Tee POST bodies for worker-events and (suspected) controller events.
    if flow.request.method != "POST":
        return
    url = flow.request.pretty_url
    if not any(s in url for s in ("/worker/events", "/events", "/bridge", "/heartbeat", "/presence")):
        return
    body = flow.request.get_text(strict=False) or ""
    _write({
        "ts": time.time(),
        "flow_id": flow.id,
        "direction": "up",
        "method": flow.request.method,
        "url": url,
        "headers": dict(flow.request.headers),
        "body": body,
    })


def responseheaders(flow: http.HTTPFlow) -> None:
    """Switch to streaming mode for SSE responses BEFORE the body arrives.
    Without this, mitmproxy buffers the entire response — fatal for SSE because
    CC's worker reader sees nothing until close, blocking controller turns.
    """
    ct = flow.response.headers.get("content-type", "") if flow.response else ""
    if "text/event-stream" not in ct:
        return

    url = flow.request.pretty_url
    status = flow.response.status_code
    flow_id = flow.id

    # Per-flow buffer to assemble multi-chunk frames before logging.
    buf = bytearray()

    def stream_modifier(chunk: bytes) -> bytes:
        # Empty chunk = end-of-stream sentinel from mitmproxy.
        if chunk:
            buf.extend(chunk)
            # SSE frames are separated by blank lines (\n\n). Flush whole frames.
            while b"\n\n" in buf:
                idx = buf.index(b"\n\n") + 2
                frame = bytes(buf[:idx])
                del buf[:idx]
                _write({
                    "ts": time.time(),
                    "flow_id": flow_id,
                    "direction": "down",
                    "method": flow.request.method,
                    "url": url,
                    "status": status,
                    "chunk": frame.decode("utf-8", errors="replace"),
                })
        else:
            # Stream ended — flush any trailing partial frame.
            if buf:
                _write({
                    "ts": time.time(),
                    "flow_id": flow_id,
                    "direction": "down",
                    "method": flow.request.method,
                    "url": url,
                    "status": status,
                    "chunk": bytes(buf).decode("utf-8", errors="replace"),
                    "partial_tail": True,
                })
                buf.clear()
        return chunk

    flow.response.stream = stream_modifier
