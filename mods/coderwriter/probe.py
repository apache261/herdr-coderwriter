# Tests an OpenAI-compatible endpoint for coderwriter's custom models, as JSON on stdout.
# Run as `python3 -c <this file> <base_url> <model> <key mode> <env name> <key file>`.
# The key is read here (env var, the person's shell, or the saved file), never from argv.
#   GET  <base>/models     the endpoint answers and lists models
#   POST <base>/responses  what Codex needs (one tiny request: a few tokens)
#   POST <base>/chat/completions, only when /responses fails: tells "Chat Completions only"
import json, os, subprocess, sys, urllib.error, urllib.request

base, model, mode, env_name, key_file = (sys.argv[1:6] + [""] * 5)[:5]
base = base.rstrip("/")
out = {"models": None, "model_count": None, "responses": None, "chat": None, "key": None, "error": None}

key = None
if mode == "file":
    try:
        with open(key_file, "r", encoding="utf-8") as f:
            key = f.read().strip()
        out["key"] = "saved key"
    except OSError:
        out["key"] = "no saved key"
elif mode == "env" and env_name:
    key = os.environ.get(env_name)
    if not key and os.environ.get("SHELL"):
        try:
            r = subprocess.run([os.environ["SHELL"], "-ic", 'printf %s "$%s"' % env_name], capture_output=True,
                               text=True, timeout=10, stdin=subprocess.DEVNULL)
            key = r.stdout.strip() or None
        except Exception:
            key = None
    out["key"] = ("$%s found" % env_name) if key else ("$%s is not set" % env_name)

def call(method, path, body=None):
    headers = {"Content-Type": "application/json", "User-Agent": "coderwriter-probe"}
    if key:
        headers["Authorization"] = "Bearer " + key
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read(400000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(4000).decode("utf-8", "replace")
    except Exception as e:
        return None, str(getattr(e, "reason", e))

def brief(status, text):
    msg = text
    try:
        j = json.loads(text)
        err = j.get("error")
        msg = (err.get("message") if isinstance(err, dict) else err) or j.get("message") or text
    except Exception:
        pass
    msg = " ".join(str(msg).split())[:200]
    return {"ok": status is not None and 200 <= status < 300, "status": status, "message": msg}

if not base.startswith(("http://", "https://")):
    out["error"] = "The base URL must start with http:// or https://"
else:
    st, text = call("GET", "/models")
    out["models"] = brief(st, text)
    if out["models"]["ok"]:
        try:
            ids = [m.get("id") for m in json.loads(text).get("data", []) if isinstance(m, dict) and m.get("id")]
            out["model_count"] = len(ids)
            out["model_ids"] = sorted(ids)[:80]
            out["model_listed"] = model in ids if model else None
        except Exception:
            pass
    if model:
        st, text = call("POST", "/responses", {"model": model, "input": "Reply with OK.", "max_output_tokens": 16})
        out["responses"] = brief(st, text)
        if not out["responses"]["ok"]:
            st, text = call("POST", "/chat/completions",
                            {"model": model, "messages": [{"role": "user", "content": "Reply with OK."}], "max_tokens": 16})
            out["chat"] = brief(st, text)
json.dump(out, sys.stdout)
