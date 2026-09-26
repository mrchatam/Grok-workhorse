#!/usr/bin/env python3
"""Scripted OpenAI-compatible mock LLM for workhorse tests.

- Streams chat.completions SSE (what the AI SDK openai-compatible client expects).
- Picks a scenario from 'MOCK_SCENARIO=<name>' found in any user message.
- Step index = number of assistant messages already in the conversation.
- Logs every request body (never headers) to $MOCK_LOG (JSONL) so tests can
  verify which extra body params Kilo sends (e.g. chat_template_kwargs).
Scenario file: <scenario_dir>/<name>.json = {"steps": [step, ...]}
step: {"text": "..."} | {"tool_calls": [{"name": "...", "arguments": {...}}]}
      | {"sleep": seconds}  (stall before answering) | {"status": 429}
"""
import json, os, re, sys, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCEN_DIR = os.environ.get("MOCK_SCENARIOS", os.path.join(os.path.dirname(__file__), "scenarios"))
LOG = os.environ.get("MOCK_LOG", "/tmp/mock_llm_requests.jsonl")
FAIL_COUNTS = {}

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": "mock/coder", "object": "model"}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(n) or b"{}")
        msgs = body.get("messages", [])
        with open(LOG, "a") as f:
            f.write(json.dumps({"t": time.time(), "path": self.path, "body": body}) + "\n")
        users = " ".join(text_of(m.get("content")) for m in msgs if m.get("role") == "user")
        m = re.search(r"MOCK_SCENARIO=([a-z0-9_\-]+)", users)
        name = m.group(1) if m else "default"
        steps = [{"text": "Done."}]
        p = os.path.join(SCEN_DIR, name + ".json")
        if os.path.exists(p):
            steps = json.load(open(p))["steps"]
        idx = sum(1 for m in msgs if m.get("role") == "assistant")
        step = steps[idx] if idx < len(steps) else {"text": "Finished. Summary: nothing more to do."}
        if "status" in step and step.get("only_models") and body.get("model") not in step["only_models"]:
            step = steps[idx + 1] if idx + 1 < len(steps) else {"text": "ok"}
        if "status" in step:
            key = (name, idx)
            FAIL_COUNTS[key] = FAIL_COUNTS.get(key, 0) + 1
            if FAIL_COUNTS[key] <= step.get("times", 1):
                return self._json(step["status"], {"error": {"message": "mock error", "type": "rate_limit"}})
            step = steps[idx + 1] if idx + 1 < len(steps) else {"text": "recovered"}
        if "sleep" in step:
            time.sleep(step["sleep"])
            step = {"text": step.get("then", "woke up")}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        cid = "chatcmpl-" + uuid.uuid4().hex[:8]
        model = body.get("model", "mock")
        def chunk(delta, finish=None, usage=None):
            o = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage:
                o["usage"] = usage
            self.wfile.write(b"data: " + json.dumps(o).encode() + b"\n\n")
            self.wfile.flush()
        chunk({"role": "assistant", "content": ""})
        if "tool_calls" in step:
            for i, tc in enumerate(step["tool_calls"]):
                chunk({"tool_calls": [{"index": i, "id": "call_" + uuid.uuid4().hex[:8], "type": "function",
                                       "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])}}]})
            finish = "tool_calls"
        else:
            chunk({"content": step.get("text", "")})
            finish = "stop"
        chunk({}, finish, {"prompt_tokens": 1000, "completion_tokens": 50, "total_tokens": 1050})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18999
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
