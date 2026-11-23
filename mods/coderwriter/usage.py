# Token usage from the agents' own session logs, as JSON on stdout.
# Run by usage.js as `python3 -c <this file> <folder> <since-ms>`, so it also
# works on another machine. Reads only; never writes.
#   Claude Code: ~/.claude/projects/**/*.jsonl, one usage per assistant message
#                (repeated per content block: deduped by message id + request id).
#   Codex:       ~/.codex/sessions/**/rollout-*.jsonl, cumulative token_count
#                events plus the account's rate limits.
#   Gemini CLI:  ~/.gemini/tmp/*/chats/session-*.json(l), per-message token counts.
#   Antigravity: ~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl,
#                PLANNER_RESPONSE token counts + workspace mapping from conversation_summaries.db.
import hashlib, json, os, sqlite3, sys, time, urllib.parse
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
DAY_MS, SINCE_MS, CUT_MS = int(day_start * 1000), int(since * 1000), int(cutoff * 1000)

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
          "today": {"claude": zero(), "codex": zero(), "gemini": zero(), "antigravity": zero()},
          "today_providers": {}, "sessions": [], "limits": None, "errors": []}

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
                # Plan limits belong to ChatGPT-signed-in Codex, not to custom providers.
                if rl and ts >= limits_ts and (meta.get("model_provider") or "openai") == "openai":
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
    provider = meta.get("model_provider") or "openai"
    if last_ts >= DAY:
        if provider == "openai":
            add(result["today"]["codex"], minus(last, base_day))
        else:
            add(result["today_providers"].setdefault(provider, zero()), minus(last, base_day))
    if meta.get("cwd") == folder and last_ts >= SINCE:
        used = minus(last, base_since)
        if used["total"] > 0:
            codex_sessions.append({"agent": "codex", "provider": provider, "id": meta.get("id"), "model": model, "tokens": used,
                                   "first": meta.get("timestamp") or last_ts, "last": last_ts,
                                   "context": (last_turn or {}).get("input_tokens", 0) or 0, "window": window})

# ---- Gemini CLI ------------------------------------------------------------
folder_norms = set()
if folder:
    folder_norms.add(os.path.normpath(folder))
    try:
        folder_norms.add(os.path.realpath(folder))
    except OSError:
        pass
folder_hashes = {hashlib.sha256(p.encode("utf-8")).hexdigest() for p in ({folder} | folder_norms) if p}

gemini_sessions = {}
gemini_tmp = os.path.join(home, ".gemini", "tmp")
if os.path.isdir(gemini_tmp):
    try:
        proj_entries = os.listdir(gemini_tmp)
    except OSError:
        proj_entries = []
    for proj in proj_entries:
        proj_dir = os.path.join(gemini_tmp, proj)
        chats_dir = os.path.join(proj_dir, "chats")
        if not os.path.isdir(chats_dir):
            continue
        proj_match = proj in folder_hashes
        if not proj_match and folder_norms:
            root_file = os.path.join(proj_dir, ".project_root")
            if os.path.isfile(root_file):
                try:
                    with open(root_file, "r", encoding="utf-8", errors="replace") as rf:
                        pr = os.path.normpath(rf.read().strip())
                    proj_match = pr in folder_norms
                except OSError:
                    pass
        try:
            chat_names = os.listdir(chats_dir)
        except OSError:
            continue
        for name in chat_names:
            if not name.startswith("session-") or not (name.endswith(".json") or name.endswith(".jsonl")):
                continue
            path = os.path.join(chats_dir, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    continue
            except OSError:
                continue
            sid, msgs, fallback_ts = name, [], None
            try:
                if name.endswith(".json"):
                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                        doc = json.load(f)
                    if isinstance(doc, dict):
                        sid = doc.get("sessionId") or sid
                        if not proj_match and doc.get("projectHash") in folder_hashes:
                            proj_match = True
                        fallback_ts = doc.get("lastUpdated") or doc.get("startTime")
                        msgs = doc.get("messages") or []
                else:
                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                        for idx, line in enumerate(f):
                            try:
                                obj = json.loads(line)
                            except ValueError:
                                continue
                            if not isinstance(obj, dict):
                                continue
                            if idx == 0 and ("sessionId" in obj or "projectHash" in obj):
                                sid = obj.get("sessionId") or sid
                                if not proj_match and obj.get("projectHash") in folder_hashes:
                                    proj_match = True
                                fallback_ts = obj.get("lastUpdated") or obj.get("startTime")
                            if "tokens" in obj:
                                msgs.append(obj)
            except (OSError, ValueError) as err:
                result["errors"].append("gemini: %s" % err)
                continue
            for m in msgs:
                if not isinstance(m, dict):
                    continue
                t = m.get("tokens")
                if not isinstance(t, dict):
                    continue
                ts_ms = ms(m.get("timestamp") or fallback_ts or "")
                if ts_ms is None or ts_ms < CUT_MS:
                    continue
                inp = t.get("input", 0) or 0
                cached = t.get("cached", 0) or 0
                out = (t.get("output", 0) or 0) + (t.get("thoughts", 0) or 0) + (t.get("tool", 0) or 0)
                uncached = max(inp - cached, 0)
                tot = t.get("total") or (inp + out)
                c = {"input": uncached, "cached": cached, "cache_write": 0, "output": out, "total": tot}
                if ts_ms >= DAY_MS:
                    add(result["today"]["gemini"], c)
                if proj_match and ts_ms >= SINCE_MS:
                    s = gemini_sessions.setdefault(sid, {"agent": "gemini", "id": sid, "model": None, "tokens": zero(),
                                                         "first": ts_ms, "last": ts_ms, "context": 0, "turns": 0})
                    add(s["tokens"], c)
                    if ts_ms < s["first"]:
                        s["first"] = ts_ms
                    if ts_ms >= s["last"]:
                        s["last"] = ts_ms
                        s["context"] = inp
                        if m.get("model"):
                            s["model"] = m["model"]
                    s["turns"] += 1
                    if not s["model"] and m.get("model"):
                        s["model"] = m["model"]

# ---- Antigravity (agy) -----------------------------------------------------
agy_root = os.path.join(home, ".gemini", "antigravity-cli")
agy_workspaces = {}
agy_db = os.path.join(agy_root, "conversation_summaries.db")
if os.path.isfile(agy_db):
    try:
        con = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(agy_db), uri=True, timeout=2)
        try:
            for cid, uris_json in con.execute("SELECT conversation_id, workspace_uris FROM conversation_summaries"):
                paths = []
                try:
                    for u in json.loads(uris_json or "[]"):
                        if isinstance(u, str):
                            p = urllib.parse.unquote(urllib.parse.urlsplit(u).path) if u.startswith("file://") else u
                            if p:
                                paths.append(os.path.normpath(p))
                except ValueError:
                    pass
                if paths:
                    agy_workspaces[cid] = paths
        finally:
            con.close()
    except Exception:
        pass

agy_sessions = {}
agy_brain = os.path.join(agy_root, "brain")
if os.path.isdir(agy_brain):
    try:
        conv_ids = os.listdir(agy_brain)
    except OSError:
        conv_ids = []
    for cid in conv_ids:
        tpath = os.path.join(agy_brain, cid, ".system_generated", "logs", "transcript.jsonl")
        try:
            if not os.path.isfile(tpath) or os.path.getmtime(tpath) < cutoff:
                continue
        except OSError:
            continue
        ws = agy_workspaces.get(cid) or []
        match_folder = bool(folder_norms and any(p in folder_norms for p in ws))
        try:
            with open(tpath, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"input_tokens"' not in line and '"output_tokens"' not in line:
                        continue
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(e, dict):
                        continue
                    ts_ms = ms(e.get("created_at") or "")
                    if ts_ms is None or ts_ms < CUT_MS:
                        continue
                    inp = e.get("input_tokens", 0) or 0
                    cached = e.get("cache_read_tokens", 0) or 0
                    cwrite = e.get("cache_write_tokens", 0) or 0
                    out = e.get("output_tokens", 0) or 0
                    tot = inp + cached + cwrite + out
                    if tot <= 0:
                        continue
                    c = {"input": inp, "cached": cached, "cache_write": cwrite, "output": out, "total": tot}
                    if ts_ms >= DAY_MS:
                        add(result["today"]["antigravity"], c)
                    if match_folder and ts_ms >= SINCE_MS:
                        s = agy_sessions.setdefault(cid, {"agent": "antigravity", "id": cid, "model": None, "tokens": zero(),
                                                          "first": ts_ms, "last": ts_ms, "context": 0, "turns": 0})
                        add(s["tokens"], c)
                        if ts_ms < s["first"]:
                            s["first"] = ts_ms
                        if ts_ms >= s["last"]:
                            s["last"] = ts_ms
                            s["context"] = inp + cached + cwrite
                            if e.get("model"):
                                s["model"] = e["model"]
                        s["turns"] += 1
                        if not s["model"] and e.get("model"):
                            s["model"] = e["model"]
        except OSError as err:
            result["errors"].append("antigravity: %s" % err)

sessions = list(claude_sessions.values()) + codex_sessions + list(gemini_sessions.values()) + list(agy_sessions.values())
for s in sessions:
    if isinstance(s["first"], str):
        s["first"] = ms(s["first"])
    if isinstance(s["last"], str):
        s["last"] = ms(s["last"])
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

# Claude Code's plan limits, as its /usage shows them: the usage endpoint, asked with
# Claude Code's own sign-in (read only: never refreshed or written here). Only when
# Claude Code is installed and signed in with a Claude plan.
def claude_live():
    import shutil, subprocess, urllib.error, urllib.request
    if not shutil.which("claude"):
        return {"status": "not_installed"}
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")
    creds = None
    try:
        with open(os.path.join(cfg, ".credentials.json"), "r", encoding="utf-8") as f:
            creds = json.load(f)
    except (OSError, ValueError):
        if sys.platform == "darwin":  # macOS keeps it in the login keychain
            try:
                r = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                                   capture_output=True, text=True, timeout=10)
                creds = json.loads(r.stdout) if r.returncode == 0 else None
            except Exception:
                creds = None
    oauth = (creds or {}).get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    if not token:
        return {"status": "no_plan"}  # signed out, or an API key (billed per token)
    plan = oauth.get("subscriptionType")
    if (oauth.get("expiresAt") or 0) and oauth["expiresAt"] < now * 1000:
        return {"status": "expired", "plan": plan}
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
        "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json", "User-Agent": "coderwriter-usage"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return {"status": "expired" if e.code in (401, 403) else "error", "plan": plan, "error": "HTTP %d" % e.code}
    names = {"session": "Current session", "weekly_all": "All models"}
    out = []
    for l in data.get("limits") or []:
        if l.get("percent") is None:
            continue
        scope = l.get("scope") or {}
        label = names.get(l.get("kind")) or ((scope.get("model") or {}).get("display_name")) or (scope.get("surface") or "") or l.get("kind")
        out.append({"label": label, "group": l.get("group"), "used": l.get("percent"), "severity": l.get("severity"),
                    "resets_at": (ms(l.get("resets_at") or "") or 0) // 1000 or None, "active": l.get("is_active")})
    if not out:  # older shape: five_hour / seven_day / seven_day_<model>
        for key, label, group in (("five_hour", "Current session", "session"), ("seven_day", "All models", "weekly"),
                                  ("seven_day_opus", "Opus", "weekly"), ("seven_day_sonnet", "Sonnet", "weekly")):
            w = data.get(key)
            if isinstance(w, dict) and w.get("utilization") is not None:
                out.append({"label": label, "group": group, "used": w["utilization"], "severity": None,
                            "resets_at": (ms(w.get("resets_at") or "") or 0) // 1000 or None, "active": None})
    return {"status": "ok", "plan": plan, "limits": out, "at": int(time.time() * 1000), "source": "live"}

if live:
    try:
        cl = claude_live()
        if cl:
            result["limits"] = {**(result["limits"] or {}), "claude": cl}
    except Exception as err:
        result["errors"].append("claude limits: %s" % err)
    try:
        got = codex_live()
        if got:
            result["limits"] = {**(result["limits"] or {}), "codex": got}
    except Exception as err:
        result["errors"].append("codex limits: %s" % err)
json.dump(result, sys.stdout)
