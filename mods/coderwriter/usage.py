# Token usage from the agents' own session logs, as JSON on stdout.
# Run by usage.js as `python3 -c <this file> <folder> <since-ms>`, so it also
# works on another machine. Reads only; never writes.
#   Claude Code: ~/.claude/projects/**/*.jsonl, one usage per assistant message
#                (repeated per content block: deduped by message id + request id).
#   Codex:       ~/.codex/sessions/**/rollout-*.jsonl, cumulative token_count
#                events plus the account's rate limits.
import json, os, sys, time
from datetime import datetime, timezone

folder = sys.argv[1] if len(sys.argv) > 1 else ""
since_ms = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 0
live = len(sys.argv) > 3 and sys.argv[3] == "live"
home = os.path.expanduser("~")

now = time.time()
lt = time.localtime(now)
day_start = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
since = since_ms / 1000 if since_ms else day_start
cutoff = min(day_start, since)

def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

DAY, SINCE, CUT = iso(day_start), iso(since), iso(cutoff)

def ms(s):
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None

def zero():
    return {"input": 0, "cached": 0, "cache_write": 0, "output": 0, "total": 0}

def add(a, b):
    for k in a:
        a[k] += b.get(k, 0)

def files(root):
    out = []
    for d, _dirs, names in os.walk(root):
        for n in names:
            if n.endswith(".jsonl"):
                p = os.path.join(d, n)
                try:
                    if os.path.getmtime(p) >= cutoff:
                        out.append(p)
                except OSError:
                    pass
    return out

result = {"day_start": int(day_start * 1000), "since": int(since * 1000), "folder": folder,
          "today": {"claude": zero(), "codex": zero()}, "sessions": [], "limits": None, "errors": []}

# ---- Claude Code -----------------------------------------------------------
claude_sessions = {}
seen = {}
for path in files(os.path.join(home, ".claude", "projects")):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"usage"' not in line or '"assistant"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                ts = e.get("timestamp") or ""
                if ts < CUT:
                    continue
                msg = e.get("message") or {}
                u = msg.get("usage")
                if not isinstance(u, dict):
                    continue
                key = (msg.get("id"), e.get("requestId"))
                c = {"input": u.get("input_tokens", 0) or 0,
                     "cached": u.get("cache_read_input_tokens", 0) or 0,
                     "cache_write": u.get("cache_creation_input_tokens", 0) or 0,
                     "output": u.get("output_tokens", 0) or 0}
                c["total"] = c["input"] + c["cached"] + c["cache_write"] + c["output"]
                # Later copies of a streamed message carry its final count.
                seen[key] = (ts, c, e.get("sessionId"), e.get("cwd"), msg.get("model"), e.get("isSidechain"))
    except OSError as err:
        result["errors"].append(str(err))

for key, (ts, c, sid, cwd, model, side) in seen.items():
    if ts >= DAY:
        add(result["today"]["claude"], c)
    if cwd == folder and ts >= SINCE and sid:
        s = claude_sessions.setdefault(sid, {"agent": "claude", "id": sid, "model": None, "tokens": zero(),
                                             "first": ts, "last": ts, "context": 0, "turns": 0})
        add(s["tokens"], c)
        if ts < s["first"]:
            s["first"] = ts
        if ts >= s["last"] and not side:
            s["last"] = ts
            s["context"] = c["input"] + c["cached"] + c["cache_write"]
            if model and not model.startswith("<"):
                s["model"] = model
        if not side:
            s["turns"] += 1
        if not s["model"] and model and not model.startswith("<"):
            s["model"] = model

# ---- Codex -----------------------------------------------------------------
def codex_usage(t):
    t = t or {}
    inp, cached, out = t.get("input_tokens", 0) or 0, t.get("cached_input_tokens", 0) or 0, t.get("output_tokens", 0) or 0
    return {"input": max(inp - cached, 0), "cached": cached, "cache_write": t.get("cache_write_input_tokens", 0) or 0,
            "output": out, "total": t.get("total_tokens", inp + out) or (inp + out)}

def minus(a, b):
    return {k: max(a[k] - b.get(k, 0), 0) for k in a}

limits, limits_ts = None, ""
codex_sessions = []
for path in files(os.path.join(home, ".codex", "sessions")):
    meta, model = {}, None
    base_day, base_since, last, last_ts, last_turn, window = zero(), zero(), None, "", None, None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"session_meta"' in line and not meta:
                    try:
                        meta = json.loads(line).get("payload") or {}
                    except ValueError:
                        pass
                    continue
                if '"turn_context"' in line:
                    try:
                        model = (json.loads(line).get("payload") or {}).get("model") or model
                    except ValueError:
                        pass
                    continue
                if '"token_count"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                p = e.get("payload") or {}
                ts = e.get("timestamp") or ""
                rl = p.get("rate_limits")
                if rl and ts >= limits_ts:
                    limits, limits_ts = rl, ts
                info = p.get("info")
                if not info:
                    continue
                tot = codex_usage(info.get("total_token_usage"))
                if ts < DAY:
                    base_day = tot
                if ts < SINCE:
                    base_since = tot
                last, last_ts = tot, ts
                last_turn = info.get("last_token_usage") or last_turn
                window = info.get("model_context_window") or window
    except OSError as err:
        result["errors"].append(str(err))
        continue
    if not last:
        continue
    if last_ts >= DAY:
        add(result["today"]["codex"], minus(last, base_day))
    if meta.get("cwd") == folder and last_ts >= SINCE:
        used = minus(last, base_since)
        if used["total"] > 0:
            codex_sessions.append({"agent": "codex", "id": meta.get("id"), "model": model, "tokens": used,
                                   "first": meta.get("timestamp") or last_ts, "last": last_ts,
                                   "context": (last_turn or {}).get("input_tokens", 0) or 0, "window": window})

sessions = list(claude_sessions.values()) + codex_sessions
for s in sessions:
    s["first"], s["last"] = ms(s["first"]), ms(s["last"])
sessions.sort(key=lambda s: s["last"] or 0, reverse=True)
result["sessions"] = sessions[:12]

def window_of(w):
    if not isinstance(w, dict):
        return None
    return {"used": w.get("used_percent"), "minutes": w.get("window_minutes"), "resets_at": w.get("resets_at")}

if limits:
    result["limits"] = {"codex": {"primary": window_of(limits.get("primary")), "secondary": window_of(limits.get("secondary")),
                                  "plan": limits.get("plan_type"), "at": ms(limits_ts), "source": "logs"}}

# Live limits, as Codex's /status shows them: ask its app-server (JSON-RPC on stdio)
# for account/rateLimits/read. Only when asked ("live"), since it starts codex.
def codex_live():
    import select, shutil, subprocess
    exe = shutil.which("codex")
    if not exe:
        return None
    p = subprocess.Popen([exe, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True)
    try:
        def send(o):
            p.stdin.write(json.dumps(o) + "\n")
            p.stdin.flush()
        send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
              "params": {"clientInfo": {"name": "coderwriter", "version": "1"}, "capabilities": None}})
        send({"jsonrpc": "2.0", "method": "initialized"})
        send({"jsonrpc": "2.0", "id": 1, "method": "account/rateLimits/read", "params": None})
        end = time.time() + 12
        while time.time() < end:
            ready, _, _ = select.select([p.stdout], [], [], 0.5)
            if not ready:
                continue
            line = p.stdout.readline()
            if not line:
                return None
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == 1:
                rl = (m.get("result") or {}).get("rateLimits")
                if not rl:
                    return None
                win = lambda w: None if not w else {"used": w.get("usedPercent"), "minutes": w.get("windowDurationMins"), "resets_at": w.get("resetsAt")}
                return {"primary": win(rl.get("primary")), "secondary": win(rl.get("secondary")), "plan": rl.get("planType"),
                        "at": int(time.time() * 1000), "source": "live"}
        return None
    finally:
        p.kill()

if live:
    try:
        got = codex_live()
        if got:
            result["limits"] = {"codex": got}
    except Exception as err:
        result["errors"].append("codex limits: %s" % err)
json.dump(result, sys.stdout)
