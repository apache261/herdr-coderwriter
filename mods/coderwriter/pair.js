// The writer/reviewer engine: start a pair, send it to review, send feedback,
// run the auto loop. Everything talks to herdr-core through `hc`; state lives in
// shared("coderwriter.pairs") keyed by the pair's tab id, so the bar and the pane
// headers (and a reload) see the same thing.
import { RELAY_PY } from "./relay.js";
import { exec, shared, setShared, terminals, spaces, panes, run, notify, readTextFile, home, appHome, openOverlay } from "herdr";

export const PAIRS = "coderwriter.pairs";
export const PREFS = "coderwriter.prefs";
export const AGENTS = ["claude", "codex", "gemini", "antigravity"]; // the agents with launch flags (the Launch popup)
// Each role's model and effort, added to its agent's launch: Claude Code and Antigravity
// take both (--model, --effort), Gemini takes --model, Codex takes effort
// (model_reasoning_effort). "" means the agent's own default.
// The recommended setup: Claude Code everywhere, the strongest model where judgment pays
// (planning, reviewing), lighter where the job is well specified (tests, docs).
export const RECOMMENDED = {
  pm: { agent: "claude", model: "opus", effort: "high" },
  writer: { agent: "claude", model: "opus", effort: "medium" },
  tester: { agent: "claude", model: "sonnet", effort: "medium" },
  reviewer: { agent: "claude", model: "opus", effort: "high" },
  docs: { agent: "claude", model: "sonnet", effort: "low" },
};
export const MODELS = {
  claude: ["", "opus", "sonnet", "haiku"],
  gemini: ["", "auto", "pro", "flash", "flash-lite"],
  antigravity: ["", "gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5"],
};
export const EFFORTS = {
  claude: ["", "low", "medium", "high", "xhigh", "max"],
  codex: ["", "low", "medium", "high"],
  antigravity: ["", "low", "medium", "high", "xhigh"],
};
// Only Neon and Hydrogen expose an xhigh variant in agy; keep other models on low/medium/high.
export function effortsFor(key, model = "") {
  if (key === "antigravity" && model && model !== "gemini-4-neon" && model !== "gemini-4-hydrogen") {
    return ["", "low", "medium", "high"];
  }
  return EFFORTS[key] ?? null;
}
export function useRecommended() {
  const pr = prefs();
  setPrefs({ ...Object.fromEntries(Object.entries(RECOMMENDED).map(([role, d]) => [role, d.agent])),
    tune: Object.fromEntries(Object.entries(RECOMMENDED).map(([role, d]) => [role, { model: d.model, effort: d.effort }])), commands: pr.commands });
}
function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1] ?? "";
      if (args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
    }
  }
  return null;
}
function tuneArgs(key, role, extraFlags = [], opts = {}) {
  const t = role ? prefs().tune[role] ?? {} : {};
  const models = MODELS[key];
  const model = models && models.includes(t.model) ? t.model : "";
  const efforts = effortsFor(key, model);
  let effort = efforts && efforts.includes(t.effort) ? t.effort : "";
  // In one-shot mode, bump the writer to high effort when the agent supports it so it
  // plans and self-verifies thoroughly on the first turn.
  if (opts.oneShot && role === "writer" && efforts?.includes("high") && (!effort || effort === "low" || effort === "medium")) {
    effort = "high";
  }
  const userModel = flagValue(extraFlags, ["--model", "-m"]);
  const userEffort = flagValue(extraFlags, ["--effort"]);
  if (key === "claude") return [...(!userModel && model ? ["--model", model] : []), ...(!userEffort && effort ? ["--effort", effort] : [])];
  if (key === "codex") return effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
  if (key === "gemini") return !userModel && model ? ["--model", model] : [];
  if (key === "antigravity") {
    // agy rejects --effort when --model already includes an effort suffix (e.g. gemini-4-neon-high).
    const modelHasEffort = typeof userModel === "string" && /-(low|medium|high|xhigh|max)$/i.test(userModel);
    return [...(!userModel && model ? ["--model", model] : []), ...(!userEffort && !modelHasEffort && effort ? ["--effort", effort] : [])];
  }
  return [];
}
// A role's own command line (prefs.commands[role]) instead of an agent: agent key "cmd".
export const CMD = "cmd";
export const REVIEW_DIR = ".coderwriter";

export function prefs() {
  const raw = shared(PREFS) ?? {};
  const p = { writer: "claude", reviewer: "claude", max: 3, auto: true, oneShot: false, lens: false, team: false, tester: "claude", pm: "claude", docs: "claude", docsOn: true, worktree: true, turnLimit: 30, ...raw, ...(raw.autoDefault ? {} : { auto: true }) };
  p.flags = { claude: "", codex: "", gemini: "", antigravity: "", ...(p.flags ?? {}) };
  p.menu = { claude: false, codex: false, gemini: false, antigravity: false, ...(p.menu ?? {}) };
  p.models = Array.isArray(p.models) ? p.models : [];
  p.commands = { writer: "", reviewer: "", tester: "", pm: "", docs: "", ...(p.commands ?? {}) };
  p.tune = Object.fromEntries(Object.entries(RECOMMENDED).map(([role, d]) => [role, { model: d.model, effort: d.effort, ...(p.tune?.[role] ?? {}) }]));
  p.tests = p.tests && typeof p.tests === "object" ? p.tests : {};
  return p;
}

// ---- custom models (OpenAI-compatible, run through Codex) -------------------------
// A model: { id, name, base_url, model, key: "env" | "file" | "none", env }.
// Its agent key is "m:<id>"; Codex sees it as provider "cw_<id>". Codex only speaks
// the Responses API to providers (wire_api "chat" is gone), so the endpoint must
// serve <base_url>/responses.
export const isCustom = (key) => typeof key === "string" && key.startsWith("m:");
export function customModel(key) { return isCustom(key) ? prefs().models.find((m) => m.id === key.slice(2)) ?? null : null; }
export const providerId = (m) => `cw_${m.id}`;
export const keyEnvName = (m) => m.key === "env" ? m.env : `CODERWRITER_KEY_${m.id.toUpperCase()}`;
export const keyDir = () => `${home()}/.config/coderwriter/keys`;
export const keyFile = (m) => `${keyDir()}/${m.id}.key`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const toml = (v) => JSON.stringify(String(v)); // a TOML basic string

// Loads the key into the environment, starts the relay (relay.js) to the model's server,
// then runs Codex against the relay. The key itself never sits in argv: a file is read
// here, and an env var missing from herdr-core's environment is asked of the person's
// interactive shell (where it is usually exported). The relay goes when Codex does.
const KEY_LOADER = 'mode=$1; name=$2; file=$3; up=$4; conf=$5; relay=$6; shift 6; ' +
  'case "$mode" in ' +
  'file) if [ -r "$file" ]; then v=$(cat "$file"); export "$name=$v"; else echo "coderwriter: no saved API key ($file)" >&2; fi ;; ' +
  'env) eval "cur=\\${$name:-}"; if [ -z "$cur" ] && [ -n "$SHELL" ]; then cur=$("$SHELL" -ic "printf %s \\"\\$$name\\"" 2>/dev/null </dev/null); ' +
  'if [ -n "$cur" ]; then export "$name=$cur"; else echo "coderwriter: $name is not set" >&2; fi; fi ;; ' +
  'esac; ' +
  'pf=$(mktemp) || exit 1; python3 -I -c "$relay" "$up" "$pf" & rp=$!; ' +
  'trap \'kill $rp 2>/dev/null; rm -f "$pf"\' EXIT; trap \'exit 130\' INT TERM HUP; ' +
  'i=0; while [ ! -s "$pf" ] && [ $i -lt 100 ] && kill -0 $rp 2>/dev/null; do sleep 0.1; i=$((i+1)); done; ' +
  'port=$(cat "$pf" 2>/dev/null); ' +
  'if [ -z "$port" ]; then echo "coderwriter: the model relay did not start (is python3 installed?)" >&2; exit 1; fi; ' +
  '"$@" -c "$conf=\\"http://127.0.0.1:$port\\""';

export function customArgv(m) {
  const pid = providerId(m);
  const conf = [
    "-c", `model_providers.${pid}.name=${toml(m.name || m.model)}`,
    "-c", `model_providers.${pid}.wire_api="responses"`,
  ];
  if (m.key !== "none") conf.push("-c", `model_providers.${pid}.env_key=${toml(keyEnvName(m))}`);
  conf.push("-c", `model_provider=${toml(pid)}`, "-m", m.model);
  // ChatGPT app connectors (Canva, Drive, ...) add ~400 KB of tool schemas, far past a
  // local model's context, and memories need OpenAI's backend: neither applies here.
  conf.push("-c", "features.apps=false", "-c", "features.memories=false");
  // Codex's base_url is the relay's, known only once it listens: KEY_LOADER adds it.
  const mode = m.key === "none" || (m.key === "env" && !ENV_NAME.test(m.env ?? "")) ? "none" : m.key;
  return ["sh", "-c", KEY_LOADER, "sh", mode, keyEnvName(m), keyFile(m), String(m.base_url).replace(/\/+$/, ""),
    `model_providers.${pid}.base_url`, RELAY_PY, ...BASE_RUN.codex, ...conf];
}

// How each agent starts with no extra flags: Herdr's own commands for them.
export const BASE_RUN = { claude: ["claude"], codex: ["codex", "--no-daemon"], gemini: ["gemini"], antigravity: ["agy"] };

// Split a flags string like a shell would (quotes, backslashes), without running one.
export function splitArgs(text) {
  const out = [];
  let cur = null, quote = null;
  for (let i = 0; i < (text ?? "").length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') { quote = ch; cur = cur ?? ""; }
    else if (ch === "\\" && i + 1 < text.length) { cur = (cur ?? "") + text[++i]; }
    else if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } }
    else cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}
export function joinArgs(args) {
  return args.map((a) => (a === "" ? "''" : /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

// Herdr's own environment (started from a desktop launcher) lacks what the person's
// interactive shell adds to PATH, e.g. nvm's node. Agents' hooks and tools run via
// /bin/sh with the agent's PATH, so a Claude Code plugin hook calling `node` failed
// with "node: not found". This asks the person's shell for its PATH, merges it in front
// of ours (no duplicates, no empty entries), then execs the agent.
// - Login + interactive (-lic), so ~/.zprofile, ~/.bash_profile and rc files all count;
//   bash -lic skips ~/.bashrc when ~/.bash_profile doesn't source it, so bash also runs
//   -ic, and csh/tcsh (which take -l only alone) run -ic.
// - A POSIX `sh` child prints PATH, so fish's list-valued $PATH arrives colon-separated;
//   markers skip anything the rc files print.
// - setsid detaches the shell from the agent's terminal: an interactive shell in a
//   background process group of a PTY is stopped by SIGTTIN/SIGTTOU (and timeout with it).
//   timeout -k escalates to SIGKILL, which an interactive bash can't ignore. Without
//   setsid, timeout --foreground stays in the terminal's foreground group instead.
const PATH_LOADER = String.raw`
if [ -n "$SHELL" ]; then
  set -f
  R=; T=
  if command -v setsid >/dev/null 2>&1; then
    R=setsid; setsid -w true >/dev/null 2>&1 && R="setsid -w"
    command -v timeout >/dev/null 2>&1 && T="timeout -k 1 5"
  elif command -v timeout >/dev/null 2>&1 && timeout --foreground -k 1 5 true >/dev/null 2>&1; then
    T="timeout --foreground -k 1 5"
  fi
  _CW_PRINT='printf "\n__CW_PATH__%s__CW_PATH__\n" "$PATH"'; export _CW_PRINT
  cw_get() {
    cw_out=$($R $T "$SHELL" "$1" 'sh -c "$_CW_PRINT"' 2>/dev/null </dev/null)
    printf '%s\n' "$cw_out" | sed -n 's/^__CW_PATH__\(.*\)__CW_PATH__$/\1/p' | tail -n 1
  }
  case "$SHELL" in
    */bash) cw_a=$(cw_get -lic); cw_b=$(cw_get -ic) ;;
    */csh|*/tcsh) cw_a=$(cw_get -ic); cw_b= ;;
    *) cw_a=$(cw_get -lic); cw_b= ;;
  esac
  unset _CW_PRINT
  if [ -n "$cw_a$cw_b" ]; then
    cw_p=; cw_list=$(IFS=:; printf '%s\n' $cw_a $cw_b $PATH)
    IFS='
'
    for cw_d in $cw_list; do
      case ":$cw_p:" in *":$cw_d:"*) ;; *) if [ -n "$cw_p" ]; then cw_p="$cw_p:$cw_d"; else cw_p=$cw_d; fi ;; esac
    done
    unset IFS
    PATH=$cw_p; export PATH
  fi
  set +f
fi
exec "$@"`;
export const withShellPath = (argv) => (argv.length ? ["sh", "-c", PATH_LOADER, "sh", ...argv] : argv);

// The argv a pair starts an agent with: its base command plus the person's flags, plus
// (with a role) that role's model and effort.
export function launchArgv(agent, role = null, opts = {}) {
  if (agent.key === CMD) return splitArgs(agent.command ?? "");
  const m = customModel(agent.key);
  // Custom models run Codex, so they take Codex's flags.
  if (m) return [...customArgv(m), ...splitArgs(prefs().flags.codex ?? "")];
  const base = BASE_RUN[agent.key] ?? agent.run;
  const extra = splitArgs(prefs().flags[agent.key] ?? "");
  return [...base, ...extra, ...tuneArgs(agent.key, role, extra, opts)];
}
export function setPrefs(patch) { setShared(PREFS, { ...prefs(), autoDefault: 1, ...patch }); }

export function pairs() { return shared(PAIRS) ?? {}; }
export function pair(tab) { return pairs()[tab] ?? null; }
export function update(tab, patch) {
  const all = pairs();
  if (!all[tab] && !patch.tab) return;
  setShared(PAIRS, { ...all, [tab]: { ...(all[tab] ?? {}), ...patch } });
}
export function forget(tab) {
  const all = { ...pairs() };
  delete all[tab];
  setShared(PAIRS, all);
}

// One running job per pair; Stop bumps the generation so a job quits at its next step.
const gen = {};
const busy = {};
export function isBusy(tab) { return Boolean(busy[tab]); }
export function stop(tab) {
  gen[tab] = (gen[tab] ?? 0) + 1;
  busy[tab] = false;
  update(tab, { auto: false, phase: "stopped", pauseReason: null, note: "Stopped" });
}

class Cancelled extends Error {}

const sleep = (ms) => exec("sleep", [String(ms / 1000)]).catch(() => null);

function status(address) {
  const t = terminals().find((x) => x.address === address);
  if (!t) return { state: "gone", status: null };
  return { state: t.state, status: typeof t.status === "string" ? t.status : t.status?.state ?? null };
}

async function hcJson(args, timeout = 30000) {
  const r = await exec("hc", args, { timeout });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* text error */ }
  if (r.code !== 0 && !out) throw new Error((r.stderr || r.stdout || `hc ${args[0]} failed`).trim());
  return out ?? {};
}

// The agent has booted and is at its prompt (idle or done). A trust dialog or a
// login keeps it unreported: we keep waiting and say so, never press keys for it.
async function ready(tab, g, address, role) {
  let told = false;
  for (;;) {
    if (gen[tab] !== g) throw new Cancelled();
    const s = status(address);
    if (s.state === "gone" || s.state === "finished") throw new Error(`The ${role} (${address}) exited`);
    if (s.status === "idle" || s.status === "done" || s.status === "error") return;
    if (!told && (s.status === null || s.status === "blocked")) {
      told = true;
      update(tab, { note: `Waiting for the ${role} — answer its prompt if it shows one` });
    }
    await sleep(1000);
  }
}

// Wait until the agent stops working. Blocked means it needs the person: keep
// waiting (politely) until they answer. The turn counts as over only when the agent stays
// non-working for QUIET_TICKS consecutive 1 s checks, so brief dips between tool calls or
// sub-agent steps aren't mistaken for the end of its turn.
// The pair's time limit for one turn (p.turnLimit minutes, 0: none) counts working time
// only: while the agent waits for you ("blocked") the clock starts again. Over the limit,
// the job stops with a note; the agent itself goes on in its pane.
const QUIET_TICKS = 5;
async function settle(tab, g, address, role, since = Date.now()) {
  const limit = (pair(tab)?.turnLimit ?? 0) * 60000;
  let quiet = 0;
  for (;;) {
    if (gen[tab] !== g) throw new Cancelled();
    const s = status(address);
    if (s.state === "gone" || s.state === "finished") throw new Error(`The ${role} (${address}) exited`);
    if (s.status === "blocked") {
      update(tab, { note: `The ${role} needs you` });
      await sleep(2000);
      since = Date.now();
      quiet = 0;
      continue;
    }
    if (s.status !== "working") {
      quiet++;
      if (quiet >= QUIET_TICKS) return;
      await sleep(1000);
      continue;
    }
    quiet = 0;
    const left = limit ? limit - (Date.now() - since) : Infinity;
    if (left <= 0) {
      const mins = limit / 60000;
      notify({ title: `coderwriter: the ${role} is taking long`, body: `Over ${mins} min on one turn: paused. Its pane shows what it's doing.`,
        level: "warning", action: { name: "tab.select", args: { id: tab } } });
      const err = new Error(`The ${role} worked over ${mins} min on one turn: paused (it goes on in its pane; Review or Feedback carry on)`);
      err.pauseReason = `${mins}m turn limit`;
      throw err;
    }
    // `ended` means the wait ended; `reason: "exit"` means the program did.
    const secs = String(Math.max(5, Math.min(540, Math.ceil(left / 1000))));
    const w = await hcJson(["wait", "--json", "--timeout", secs, address], 600000);
    if (w.reason === "exit") throw new Error(`The ${role} (${address}) exited`);
  }
}

// Paste a message, press Enter and wait for that turn to end. Some agents take a couple of
// seconds to report "working" after paste, so if hc reports started: false we watch briefly
// and retry once before giving up (avoiding false Auto drop-outs).
async function say(tab, g, address, role, text) {
  await ready(tab, g, address, role);
  const since = Date.now(), limit = (pair(tab)?.turnLimit ?? 0) * 60;
  const secs = String(limit ? Math.max(5, Math.min(540, limit)) : 540);
  let r = await hcJson(["send", "--wait", "--json", "--timeout", secs, address, text], 600000);
  if (gen[tab] !== g) throw new Cancelled();
  if (r.started === false) {
    let working = false;
    for (let i = 0; i < 6; i++) {
      await sleep(1000);
      if (gen[tab] !== g) throw new Cancelled();
      const s = status(address);
      if (s.state === "gone" || s.state === "finished") throw new Error(`The ${role} (${address}) exited`);
      if (s.status === "working" || s.status === "blocked") { working = true; break; }
    }
    if (!working) {
      r = await hcJson(["send", "--wait", "--json", "--timeout", secs, address, text], 600000);
      if (gen[tab] !== g) throw new Cancelled();
      if (r.started === false) {
        const s = status(address);
        if (s.status !== "working" && s.status !== "blocked") {
          const err = new Error(`The ${role} did not take the message: ${r.reason ?? "not started"}`);
          err.pauseReason = "Send failed";
          throw err;
        }
      }
    }
  }
  if (r.wait?.reason === "exit") throw new Error(`The ${role} (${address}) exited`);
  if (gen[tab] !== g) throw new Cancelled();
  await settle(tab, g, address, role, since);
}

// Every brief that hands work on ends with this: in a long session an agent may end its
// turn while its sub-agents or background commands still run, or stop to ask whether to go
// on, and coderwriter would read a file that isn't written yet.
const FINISH = " Finish the whole job in this turn: if you start sub-agents or background commands, wait for them" +
  " before you end it, and don't stop to ask whether to go on.";

// The agent's turn ended but its file is missing (or, with `verdict`, has no VERDICT line):
// remind it once, then read again. read() gives the result, bad(result) says it's missing.
async function remind(tab, g, address, role, file, read, bad, verdict = null) {
  const first = await read();
  if (!bad(first)) return first;
  if (gen[tab] !== g) throw new Cancelled();
  update(tab, { note: `The ${role} ended its turn without ${file}: reminding it once` });
  await say(tab, g, address, role, `Your turn ended, but ${file} is ${verdict ? "missing or has no VERDICT line" : "missing"}. ` +
    `If sub-agents or background commands of yours are still running, wait for them. Then write ${file} as asked` +
    (verdict ? `: the first line exactly "VERDICT: ${verdict[0]}" or "VERDICT: ${verdict[1]}", then the numbered findings` : "") +
    `. Then stop.`);
  return read();
}
async function exists(p, rel) {
  try { return (await readTextFile(join(p.folder, rel), where(p))) != null; } catch { return false; }
}

// A new conversation for an agent: /clear on Claude Code, Gemini CLI and Antigravity
// (agy). Codex keeps its conversation: its /new stops at a question in a git repo
// ("Where should the new conversation run?"), which the next brief would be typed into.
// Its brief and the files in .coderwriter/ carry what it needs, so each subtask of a
// long plan starts from a clean context rather than one compacted again and again. Not
// clearing is never fatal.
// hc wraps a message sent from inside a terminal as <hc from="…">…</hc>, which makes a slash
// command a plain prompt the agent answers, so the command goes as from no terminal. It
// starts no turn (hc reports started: false), so there is no turn to wait for: give the
// agent a moment, then wait until it's at its prompt again.
const CLEAR = { claude: "/clear", gemini: "/clear", antigravity: "/clear" };
const SEND_COMMAND = 'unset HC_TERMINAL_ID HC_SCOPE; exec hc send --json "$1" "$2"';
async function fresh(tab, g, who, role) {
  const cmd = CLEAR[who?.agent];
  if (!cmd || !who.t) return;
  await ready(tab, g, who.t, role);
  const r = await exec("sh", ["-c", SEND_COMMAND, "sh", who.t, cmd], { timeout: 30000 }).catch(() => null);
  if (gen[tab] !== g) throw new Cancelled();
  if (r?.code !== 0) { update(tab, { note: `Could not clear the ${role}'s conversation: it keeps it` }); return; }
  await sleep(2000);
  await ready(tab, g, who.t, role);
}

// ---- review skills ----------------------------------------------------------------
// The Ponytail review lens for every round, and two audits the reviewer can run once a
// round is approved. coderwriter installs nothing: it finds a skill's SKILL.md on the
// pair's machine (project, user or plugin folders of Claude Code, Codex and the skills
// CLI) and hands the reviewer its path, so it works whichever agent reviews.
const PONYTAIL = "Claude Code: /plugin marketplace add DietrichGebert/ponytail, then /plugin install ponytail@ponytail. " +
  "Codex: codex plugin marketplace add DietrichGebert/ponytail, then codex plugin add ponytail@ponytail";
export const SKILLS = {
  lens: { skill: "ponytail-review", name: "Ponytail review", install: PONYTAIL },
  security: { skill: "security-audit", name: "Security audit", by: "Cloudflare's security-audit skill",
    install: "npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit --global" },
  ponytail: { skill: "ponytail-audit", name: "Ponytail code audit", by: "Ponytail's ponytail-audit skill", install: PONYTAIL },
};
export const AUDITS = ["security", "ponytail"];
// shortcut: the first match wins, so of several cached plugin versions the lexically first is used.
const FIND_SKILL = 'for n in "$@"; do for f in ".claude/skills/$n/SKILL.md" ".agents/skills/$n/SKILL.md" ".agent/skills/$n/SKILL.md" ".codex/skills/$n/SKILL.md" ".gemini/skills/$n/SKILL.md" ' +
  '"$HOME/.claude/skills/$n/SKILL.md" "$HOME/.agents/skills/$n/SKILL.md" "$HOME/.codex/skills/$n/SKILL.md" "$HOME/.gemini/skills/$n/SKILL.md" "$HOME/.gemini/config/skills/$n/SKILL.md" ' +
  '"$HOME"/.claude/plugins/cache/*/*/*/skills/"$n"/SKILL.md "$HOME"/.codex/plugins/cache/*/*/*/skills/"$n"/SKILL.md; do ' +
  'if [ -f "$f" ]; then case "$f" in /*) ;; *) f="$PWD/$f" ;; esac; printf "%s\\t%s\\n" "$n" "$f"; break; fi; done; done';
// { lens, security, ponytail }: each skill's SKILL.md path, or null.
export async function findSkills(folder, machine) {
  const r = await exec("sh", ["-c", FIND_SKILL, "sh", ...Object.values(SKILLS).map((s) => s.skill)],
    { cwd: folder, timeout: 10000, ...(machine ? { on: machine } : {}) }).catch(() => null);
  const at = Object.fromEntries((r?.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split("\t")));
  return Object.fromEntries(Object.entries(SKILLS).map(([k, s]) => [k, at[s.skill] ?? null]));
}
// Ask (a dialog) whether to audit the pair now. The dialog sends the answer back to the
// bar as "coderwriter.audit", which calls audit().
export function askAudit(tab) {
  openOverlay({ mod: "coderwriter", kind: "dialog", width: 560, height: 440, props: { role: "audit", tab } });
}

export function writerBrief(task, teamOrOpts = false) {
  const opts = typeof teamOrOpts === "boolean" ? { team: teamOrOpts } : (teamOrOpts ?? {});
  const { team = false, testCmd = "", lens = false, oneShot = false, constraints = "" } = opts;
  const guard = ` Before ending your turn: keep edits strictly scoped to the task, inspect \`git status\` and \`git diff --stat\` to make sure nothing unrelated was modified or deleted, never run \`git commit\`, \`git push\`, or \`git reset --hard\`, and never delete or skip existing tests to make tests pass.`;
  const check = testCmd ? ` Run \`${testCmd}\` before finishing and make sure it passes.` : "";
  const extra = constraints ? ` Constraints / do not touch: ${constraints}.` : "";
  if (team) return `You are the CODER in a team: a tester and a reviewer check your work.\n\n${task}\n\n(Make the change in this folder and leave it uncommitted.${extra}` +
    ` When you finish, and after every fix, write what you changed and why, and how you checked it, to ${CODER_NOTES}.` +
    ` A tester writes and runs the tests: don't edit test files; if you think a test is wrong, say why in ${CODER_NOTES}.` +
    `${check}${guard} Then the team checks your work (tests, then review); everything that fails comes back to you in one note, ${REVIEW_DIR}/review-<n>.md.${FINISH})`;
  const mode = oneShot
    ? ` This is a ONE-SHOT run: read the relevant code and conventions first, plan the minimal complete change, handle edge cases, and self-verify everything in this single turn.`
    : "";
  const rubric = lens
    ? ` Your change will be reviewed for correctness, safety, edge cases, tests, performance, and lean minimal diff (Ponytail review): meet that bar on the first pass.`
    : "";
  return `${task}\n\n(You are the WRITER in a writer/reviewer pair. Make the change in this folder and leave it uncommitted.${extra}${mode}${rubric}${check}${guard}` +
    ` A reviewer agent reads your uncommitted changes; its reviews arrive as ${REVIEW_DIR}/review-<n>.md.${FINISH})`;
}
// out: where the review goes and its verdict words (a team stage writes PASS / FAIL).
export function reviewBrief(p, round, lens = null, out = { file: `${REVIEW_DIR}/review-${round}.md`, ok: "APPROVED", no: "CHANGES_REQUESTED" }) {
  const file = out.file;
  const cp = p.checkpoints ?? {}, base = cp[0], now = cp[round], prev = cp[round - 1];
  const sub = subtaskScope(p, round);
  const scope = !sub ? "" : ` ${doneBefore(sub)}: review only this subtask's change` +
    (sub.base && now ? `, \`git diff ${sub.base} ${now}\` (snapshots that include untracked files)` : "") + ".";
  const final = isFinal(p), body = out.criteria ? subtaskBody(p) : "";
  const crit = body ? ` Check the change against the subtask as the PM planned it, and that its "Done when:" holds:\n\n${quoted(body)}\n\n` : "";
  const constraints = p.constraints ? ` Respect these user constraints (flag any violation): ${p.constraints}.` : "";
  const snaps = !now || (final && firstRound(p, round)) ? "" : round > 1 && prev && !firstRound(p, round)
    ? ` Since your round ${round - 1} review the writer changed \`git diff ${prev} ${now}\`: start there and check the findings of ${REVIEW_DIR}/review-${round - 1}.md were addressed.` +
      (base && !final ? ` The whole change${sub ? " so far, earlier subtasks included," : ""} is \`git diff ${base} ${now}\`.` : "")
    : base ? ` The whole change${sub ? " so far, earlier subtasks included," : ""} is \`git diff ${base} ${now}\` (snapshots that include untracked files).` : "";
  const t = p.tests;
  const tests = t?.round !== round ? "" : t.state === "pass" ? ` The tests (\`${t.cmd}\`) pass.`
    : t.state === "fail" ? ` The tests (\`${t.cmd}\`) fail; that is reported to the writer already, so don't repeat it.` : "";
  const notes = p.kind === "team" ? ` The writer's own notes on the change: ${REVIEW_DIR}/round-${round}/coder.md (if it wrote them).` : "";
  const who = p.kind === "team" ? `You are the REVIEWER in a team (round ${round}).` : `You are the REVIEWER in a writer/reviewer pair (round ${round}).`;
  const verdictRule = ` Check for regressions, broken callers, and accidental deletions or weakened/skipped tests.` +
    ` Return "VERDICT: ${out.no}" ONLY for real defects (unmet requirements, bugs, regressions, broken existing behavior, missing error handling on real paths, or security issues);` +
    ` put minor style nits or optional refactors under a "Non-blocking notes:" section while still returning "VERDICT: ${out.ok}".`;
  return who + (out.focus ?? "") +
    (taskText(p) ? ` The writer's task: ${taskText(p)}.` : "") + constraints + crit +
    ` Review the writer's uncommitted changes in this folder (git status, git diff, untracked files; ignore ${REVIEW_DIR}/).` +
    (final ? finalFocus(p, round, out.check ?? "quality") : "") + scope + snaps + tests + notes +
    (lens ? ` Review with the ponytail-review skill: read ${lens} and follow its method, but write the file in the format below.` : "") +
    verdictRule +
    ` Do not edit project files. Write your review to ${file}: the first line exactly "VERDICT: ${out.ok}" or "VERDICT: ${out.no}",` +
    ` then numbered findings, most important first, each with the file and what to change.` + FINISH + ` Then stop.`;
}
// An audit round: the selected audit skills over the whole repository, one review file.
export function auditBrief(p, round, kinds, found) {
  const file = `${REVIEW_DIR}/review-${round}.md`;
  const steps = kinds.map((k) => k === "security"
    ? ` Security audit: read ${found.security} (Cloudflare's security-audit skill) and follow it on this repository;` +
      ` keep its working files in ${REVIEW_DIR}/security-audit/, not in your home folder, and if you cannot run sub-agents run its phases yourself.`
    : ` Code audit: read ${found.ponytail} (the ponytail-audit skill) and follow it on this repository.`).join("");
  const heads = kinds.map((k) => `"## ${SKILLS[k].name}"`).join(" and ");
  return `You are the REVIEWER in a writer/reviewer pair.` +
    (p.verdict === "approved" ? ` Your reviews approved the writer's change; now audit the code (round ${round}).` : ` Audit the code (round ${round}).`) +
    (p.task ? ` The writer's task was: ${p.task.replace(/\s+/g, " ")}.` : "") +
    ` Cover the whole repository, starting with the files the change touches (git status, git diff; ignore ${REVIEW_DIR}/).` + steps +
    ` Do not edit project files. Write the result to ${file}: the first line exactly "VERDICT: APPROVED" (nothing that must be fixed)` +
    ` or "VERDICT: CHANGES_REQUESTED", then a ${heads} section, each with numbered findings, most important first,` +
    ` each with the file and what to change.` + FINISH + ` Then stop.`;
}
export function feedbackBrief(p) {
  const round = p.round;
  const again = (p.repeats ?? []).length
    ? ` These were raised in round ${round - 1} too and are still open: ${p.repeats.map((f) => `"${short(f, 140)}"`).join("; ")}. ` +
      `Fix them properly this time, or explain why you won't.`
    : "";
  const extra = p.constraints ? ` Constraints / do not touch: ${p.constraints}.` : "";
  if (p.kind === "team") {
    const failed = Object.entries(p.stageResults ?? {}).filter(([, r]) => r === "fail").map(([id]) => STAGES[id]?.name ?? id);
    return restoredNote(p) + `You are the CODER in a team${taskText(p) ? `; your task: ${taskText(p)}` : ""}. ` +
      `Round ${round}: ${failed.length ? failed.join(", ") + " failed" : "changes requested"}.${extra} ` +
      `Everything to fix is in ${REVIEW_DIR}/review-${round}.md (each check's full report is in ${REVIEW_DIR}/round-${round}/). ` +
      `Address every finding (push back in your reply if you disagree with one).${again} ` +
      `Fix the code, not the tests: test files are the tester's; if a test is wrong, say why in ${CODER_NOTES}. ` +
      `Then update ${CODER_NOTES} with what you changed. Keep the changes uncommitted.${FINISH}`;
  }
  return restoredNote(p) + `You are the WRITER in a writer/reviewer pair${taskText(p) ? `; your task: ${taskText(p)}` : ""}.${extra} ` +
    `The reviewer's round ${round} review is in ${REVIEW_DIR}/review-${round}.md. Read it and address every finding ` +
    `(push back in your reply if you disagree with one).${again} Keep the changes uncommitted.${FINISH}`;
}

function where(p) { return p.machine ? { on: p.machine } : {}; }
function join(folder, rel) { return folder.endsWith("/") ? folder + rel : `${folder}/${rel}`; }

async function verdictOf(p, round) {
  const path = join(p.folder, `${REVIEW_DIR}/review-${round}.md`);
  let text = null;
  try { text = await readTextFile(path, where(p)); } catch { text = null; }
  if (text == null) return { verdict: "missing", summary: `No ${REVIEW_DIR}/review-${round}.md`, text: null };
  const m = /VERDICT:\s*(APPROVED|CHANGES[_ ]REQUESTED)/i.exec(text);
  const verdict = !m ? "unknown" : /^APPROVED$/i.test(m[1]) ? "approved" : "changes";
  const findings = findingsOf(text).length;
  return { verdict, text, summary: verdict === "approved" ? "Approved" : verdict === "changes" ? `${findings} finding${findings === 1 ? "" : "s"}` : "No verdict line" };
}

// ---- team pipeline ----------------------------------------------------------------
// A team (p.kind === "team") checks a round with a pipeline of stages, run one after
// another and all of them even when one fails. Each stage reports PASS or FAIL with
// numbered findings in .coderwriter/round-<n>/<stage>.md; coderwriter folds the reports
// into .coderwriter/review-<n>.md (failures in full, passes as one line), so the Reviews
// panel, Feedback, repeat detection and snapshots work exactly as for a pair.
export const CODER_NOTES = `${REVIEW_DIR}/coder.md`;
export const STAGES = {
  tester: { name: "Tester", role: "tester", brief: testerBrief }, // writes and runs the tests
  tests: { name: "Tests", run: testsStage },          // the folder's test command (no agent)
  quality: { name: "Quality", role: "reviewer", brief: qualityBrief },   // Ponytail's review, PASS / FAIL
  security: { name: "Security", role: "reviewer", brief: securityBrief }, // this change only, PASS / FAIL
  review: { name: "Review", role: "reviewer", brief: (p, round, file, found) =>  // teams from before the split
    reviewBrief(p, round, p.lens ? found.lens : null, { file, ok: "PASS", no: "FAIL" }) },
  guard: { name: "Test files" },                      // the coder edited tests (computed, not run)
};
// Test files by their usual names: tests/, test/, __tests__/, spec/ folders, *.test.* / *.spec.*,
// *_test.go, test_*.py, *_test.py. shortcut: by name only; a project with other names isn't guarded.
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]*\.py$|_test\.(go|py)$/;
// Test files the coder changed since the tester's last run (its files were snapshotted then).
async function coderTouchedTests(p, round) {
  const from = p.tested?.[round - 1], to = p.checkpoints?.[round];
  if (!from || !to) return [];
  const r = await sh(p, 'git diff --name-only "$1" "$2"', [from, to]).catch(() => null);
  return (r?.stdout ?? "").split("\n").filter((f) => f && TEST_PATH.test(f));
}
// The tester goes first so the test command, run next, includes the tests it wrote.
export const teamStageIds = (tester) => [...(tester ? ["tester"] : []), "tests", "quality", "security"];
const MAX_SECTION = 20000; // characters of a failed stage's report copied into review-<n>.md
export function teamStages(p) {
  return (p.stages ?? ["tests", "review"]).filter((id) => STAGES[id] && (id !== "tests" || pairTestCommand(p)));
}
// The agent playing a role: the pair's writer / reviewer, or one of p.roles (tester, pm…).
const roleOf = (p, role) => p.roles?.[role] ?? p[role] ?? null;

async function sh(p, script, args = [], timeout = 30000) {
  return exec("sh", ["-c", script, "sh", ...args], { cwd: p.folder, timeout, ...where(p) });
}
// A stage report: pass / fail, or missing / unknown (no file, no verdict line).
async function readStage(p, rel) {
  let text = null;
  try { text = await readTextFile(join(p.folder, rel), where(p)); } catch { text = null; }
  const m = /VERDICT:\s*(PASS|FAIL|APPROVED|CHANGES[_ ]REQUESTED)/i.exec(text ?? "");
  const state = text == null ? "missing" : !m ? "unknown" : /^(PASS|APPROVED)$/i.test(m[1]) ? "pass" : "fail";
  return { state, text, file: rel };
}

async function testsStage(tab, g, round) {
  const pass = await runTests(tab, round);
  const t = pair(tab).tests ?? {};
  if (pass) return { state: "pass", text: null, file: t.file };
  const tail = await sh(pair(tab), 'tail -n 60 "$1" 2>/dev/null', [t.file]).catch(() => null);
  const why = t.error ?? `exit code ${t.code}`;
  return { state: "fail", file: t.file,
    text: `1. The test command \`${t.cmd}\` fails (${why}); full output in ${t.file}. Fix the code, not the tests.\n\n` +
      ((tail?.stdout ?? "").trim() ? "Last lines of the output:\n\n```\n" + tail.stdout.trimEnd() + "\n```" : "It printed nothing.") };
}

// Quality and Security are the reviewer's two checks, one message each, in that order.
export function qualityBrief(p, round, file, found) {
  return reviewBrief(p, round, found.lens, { file, ok: "PASS", no: "FAIL", check: "quality", criteria: true,
    focus: " This is the QUALITY check: does the change do what the task asks, correctly (edge cases, errors, callers it breaks)," +
      " and is it clear, lean and in the style of the codebase? A security check follows and the tester owns the tests: leave those to them." });
}
export function securityBrief(p, round, file, found) {
  return reviewBrief(p, round, null, { file, ok: "PASS", no: "FAIL", check: "security",
    focus: " This is the SECURITY check, of this change only (the quality check is done): untrusted input reaching SQL, a shell," +
      " file paths, templates or HTML (injection, path traversal, XSS); authentication and authorization; secrets in code, logs or errors;" +
      " unsafe deserialization; SSRF; CSRF; weak or home-made crypto; new dependencies; data leaking to the wrong user." +
      " Report only real issues, each with a concrete way to exploit it; no style, no maybes. PASS when there is none." +
      (found.security ? ` Read ${found.security} (Cloudflare's security-audit skill) for its principles and anti-patterns, but don't run` +
        ` its phases: this is a review of the change, and the full audit is offered once the work is approved.` : "") });
}

export function testerBrief(p, round, file) {
  const touched = (p.touchedTests ?? []).length
    ? ` The coder changed test files since your last run (not allowed): ${p.touchedTests.join(", ")}. Check them: keep what is right, put back what isn't.` : "";
  const cp = p.checkpoints ?? {}, base = cp[0], now = cp[round], prev = cp[round - 1];
  const sub = subtaskScope(p, round);
  const scope = !sub ? "" : ` ${doneBefore(sub)}. Tests from earlier subtasks stay and must keep passing; write tests for this subtask's change` +
    (sub.base && now ? `, \`git diff ${sub.base} ${now}\`` : "") + ".";
  const final = isFinal(p), body = subtaskBody(p);
  const crit = body ? ` The subtask as the PM planned it; test what its "Tests:" asks for and that its "Done when:" holds:\n\n${quoted(body)}\n\n` : "";
  const since = round > 1 && prev && now && !firstRound(p, round) ? ` Since round ${round - 1} the coder changed \`git diff ${prev} ${now}\`.` : "";
  const whole = final && firstRound(p, round) ? "" : base && now ? ` The whole change${sub ? " so far, earlier subtasks included," : ""} is \`git diff ${base} ${now}\`.` : "";
  const cmd = pairTestCommand(p);
  return `You are the TESTER in a team (round ${round}).` +
    (taskText(p) ? ` The coder's task: ${taskText(p)}.` : "") + crit +
    ` The coder's uncommitted changes are in this folder (git status, git diff, untracked files; ignore ${REVIEW_DIR}/);` +
    ` its notes are in ${REVIEW_DIR}/round-${round}/coder.md (if it wrote them).` + (final ? finalFocus(p, round, "tester") : "") + scope + since + whole + touched +
    ` 1) Write or update unit tests and functional tests for what the change should do, in the project's own test framework and folders` +
    ` (none yet: use the usual one for the language and say so): the normal case, edge cases and the errors the task implies.` +
    (round > 1 && !firstRound(p, round) ? ` Keep your earlier tests; if the coder argues in its notes that one is wrong, check, and fix the test only if it is.` : "") +
    ` 2) Run your tests and the existing suite${cmd ? ` (the project's test command is \`${cmd}\`)` : ""}.` +
    ` Edit only test files, fixtures and test config; never change the code under test: when the code is wrong, that is a finding.` +
    ` Write your report to ${file}: the first line exactly "VERDICT: PASS" (every test passes and the change is covered) or "VERDICT: FAIL",` +
    ` then "Tests written:" and "Ran:" as bullet lists (commands and results), then numbered findings, most important first:` +
    ` for each failing test what it expects, what happens, and the file and line of the code at fault.` + FINISH + ` Then stop.`;
}

async function agentStage(tab, g, round, id, found) {
  const p = pair(tab), s = STAGES[id], who = roleOf(p, s.role);
  if (!who?.t) return { state: "missing", text: null, file: null, why: `no ${s.role} agent` };
  const file = `${REVIEW_DIR}/round-${round}/${id}.md`;
  await sh(p, 'mkdir -p "$(dirname "$1")" && rm -f "$1"', [file]);
  const brief = s.brief(p, round, file, found);
  await say(tab, g, who.t, s.role, brief);
  return remind(tab, g, who.t, s.role, file, () => readStage(pair(tab), file),
    (r) => r.state === "missing" || r.state === "unknown", ["PASS", "FAIL"]);
}

function combine(round, results) {
  const bad = results.filter((r) => r.state === "missing" || r.state === "unknown");
  const failed = results.filter((r) => r.state === "fail");
  const head = bad.length ? "VERDICT: INCOMPLETE" : failed.length ? "VERDICT: CHANGES_REQUESTED" : "VERDICT: APPROVED";
  const mark = { pass: "✓", fail: "✗", missing: "?", unknown: "?" };
  const line = results.map((r) => `${STAGES[r.id].name} ${mark[r.state]}`).join(" · ");
  const parts = [head, "", `Round ${round}: ${line}`];
  for (const r of [...failed, ...bad, ...results.filter((x) => x.state === "pass")]) {
    const name = STAGES[r.id].name, at = r.file ? ` (${r.file})` : "";
    if (r.state === "pass") { parts.push("", `## ${name}: PASS${at}`); continue; }
    if (r.state !== "fail") { parts.push("", `## ${name}: no result${at}`, "", r.state === "missing" ? `No report${r.why ? `: ${r.why}` : ""}.` : "The report has no VERDICT line."); continue; }
    let body = (r.text ?? "").replace(/^.*VERDICT:.*$/m, "").trim();
    if (body.length > MAX_SECTION) body = body.slice(0, MAX_SECTION) + `\n\n… (cut here; the rest is in ${r.file})`;
    parts.push("", `## ${name}: FAIL${at}`, "", body);
  }
  return parts.join("\n") + "\n";
}

// One team round: snapshot, safety checks, the coder's notes, every stage, then review-<n>.md.
async function teamRound(tab, g) {
  let p = pair(tab);
  await settle(tab, g, p.writer.t, "writer");
  const gitCheck = await checkGitIntegrity(tab, "coder");
  if (gen[tab] !== g) throw new Cancelled();
  if (!gitCheck.ok) return pauseForSafety(tab, [gitCheck.reason], "git");
  const round = (p.round ?? 0) + 1;
  await checkpoint(tab, round);
  p = pair(tab);
  const safety = await checkDestruction(p, p.subtaskBase ?? p.checkpoints?.[0] ?? null, p.checkpoints?.[round] ?? null);
  if (gen[tab] !== g) throw new Cancelled();
  if (!safety.ok && safety.sig !== p.safetyAck) return pauseForSafety(tab, safety.issues, safety.sig);
  const ids = teamStages(p);
  await sh(p, 'mkdir -p "$1" && if [ -f "$2" ]; then cp "$2" "$1/coder.md"; fi', [`${REVIEW_DIR}/round-${round}`, CODER_NOTES]).catch(() => null);
  const touched = ids.includes("tester") ? await coderTouchedTests(p, round) : [];
  update(tab, { touchedTests: touched });
  const found = await findSkills(p.folder, p.machine);
  const wantsLens = ids.includes("quality") || (ids.includes("review") && p.lens);
  if (wantsLens && !found.lens && !p.lensWarned) {
    notify({ title: "coderwriter: Ponytail review not installed", body: `The quality check runs without it. ${SKILLS.lens.install}`, level: "warning" });
    update(tab, { lensWarned: true });
  }
  update(tab, { round, phase: "reviewing", verdict: null, repeats: [], stage: null, stageResults: touched.length ? { guard: "fail" } : {}, testFixes: 0,
    note: `Round ${round}: ${ids.map((id) => STAGES[id].name).join(" → ")}` });
  const results = touched.length ? [{ id: "guard", state: "fail", file: null,
    text: `1. You changed test files, which are the tester's: ${touched.join(", ")}. Put them back and fix the code instead; ` +
      `if a test is wrong, say why in ${CODER_NOTES} and the tester will look at it.` }] : [];
  let beforeReviewer = p.checkpoints?.[round] ?? null;
  for (const id of ids) {
    update(tab, { stage: id, note: `Round ${round}: ${STAGES[id].name}` });
    const r = STAGES[id].run ? await STAGES[id].run(tab, g, round) : await agentStage(tab, g, round, id, found);
    if (gen[tab] !== g) throw new Cancelled();
    if (STAGES[id].role === "reviewer") {
      const still = await guardReviewerEdits(tab, g, beforeReviewer, round);
      if (still.length) beforeReviewer = (await snapshot(pair(tab), `round-${round}-${id}-dirty`, `coderwriter: after ${id}`)) ?? beforeReviewer;
    }
    results.push({ id, ...r });
    update(tab, { stageResults: { ...(pair(tab).stageResults ?? {}), [id]: r.state } });
    if (id === "tester") {
      const sha = await snapshot(pair(tab), `round-${round}-tested`, `coderwriter: round ${round} after the tester`);
      if (sha) {
        update(tab, { tested: { ...(pair(tab).tested ?? {}), [round]: sha } });
        beforeReviewer = sha;
      }
    }
  }
  const postGit = await checkGitIntegrity(tab, "team");
  if (gen[tab] !== g) throw new Cancelled();
  if (!postGit.ok) return pauseForSafety(tab, [postGit.reason], "git");
  const file = `${REVIEW_DIR}/review-${round}.md`;
  const w = await sh(pair(tab), 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', [file, combine(round, results)]);
  if (w.code !== 0) throw new Error(`Could not write ${file}: ${(w.stderr || "").trim()}`);
  const v = await verdictOf(pair(tab), round);
  let repeats = [];
  if (v.verdict === "changes" && round - 1 > (p.taskStart ?? 0)) repeats = repeatedFindings((await verdictOf(pair(tab), round - 1)).text, v.text);
  const summary = results.map((r) => `${STAGES[r.id].name} ${r.state === "pass" ? "✓" : r.state === "fail" ? "✗" : "?"}`).join(" · ");
  const again = repeats.length ? ` · ${repeats.length} repeated from round ${round - 1}` : "";
  const unsure = v.verdict === "unknown" ? " · a check gave no result" : "";
  update(tab, { phase: "reviewed", stage: null, verdict: v.verdict, repeats, note: `Round ${round}: ${summary}${again}${unsure}` });
  if (v.verdict === "approved" && !planRunning(pair(tab))) askAudit(tab);
  return v.verdict;
}

// ---- the PM -----------------------------------------------------------------------
// A team with a PM: you give the PM the task, it writes .coderwriter/plan.md (subtasks as
// "## <n>. <title>"), you approve it in the Plan dialog, then coderwriter itself hands the
// subtasks to the coder one by one, each through the team's rounds until approved, and the
// PM writes .coderwriter/report.md at the end. The PM only plans and reports: the hand-offs
// are this code, so a confused agent can't derail them.
export const PLAN = `${REVIEW_DIR}/plan.md`, REPORT = `${REVIEW_DIR}/report.md`, DOCS = `${REVIEW_DIR}/docs.md`;
// What each approved subtask changed, and the coder's notes on it: written by coderwriter,
// read by agents whose conversation was cleared for the next subtask, and by the PM's report.
export const PROGRESS = `${REVIEW_DIR}/progress.md`;

// A team agent's standing role, given to Claude Code at launch (--append-system-prompt).
// It is part of the system prompt, so it outlasts the /clear before each subtask, which
// wipes every brief said in the conversation. Codex isn't cleared and keeps its briefs.
const TEAM = "a coderwriter team working in this folder: a PM plans, a CODER writes the code, a TESTER writes and runs the tests, " +
  "a REVIEWER checks quality and then security, and a DOCS WRITER may update the documentation at the end. " +
  "coderwriter, a program, hands the work around: each of its messages says what to do now and which files to read.";
const CLEARED = ` Your conversation is cleared before each new subtask of the PM's plan (${PLAN}). The subtasks approved before ` +
  `it are already in this folder, uncommitted, and ${PROGRESS} says what each one changed: read it when a message points you there.`;
const ALWAYS = " Always: finish the whole job in one turn (wait for your own sub-agents and background commands), write your file " +
  "where the message says, never run git commit, git push, or git reset --hard, never touch files outside this folder, and never wait for a person to tell you to go on.";
const PM_RULES = `You NEVER write code, edit project files, or spawn subagents, background agents, workflows, or swarms to execute work. ` +
  `You may only edit ${PLAN} (when planning) and ${REPORT} (when reporting). ` +
  `Your ONLY way to delegate work is writing ${PLAN} and stopping: coderwriter detects ${PLAN}, opens the Plan dialog for the user to approve, ` +
  `and hands each subtask to the separate CODER, TESTER, and REVIEWER panes. ` +
  `If the user says "go ahead", "start", "proceed", or "implement it" in your pane, do NOT implement anything or spawn agents—write or update ` +
  `${PLAN}, stop, and tell them to click "Approve & start" in the Plan dialog.`;
const PAIR = "a coderwriter writer/reviewer pair working in this folder: a WRITER makes the changes and leaves them uncommitted, " +
  `and a REVIEWER checks them each round and writes its verdict and findings to ${REVIEW_DIR}/review-<n>.md. ` +
  "coderwriter, a program, hands the work between you.";
export const PAIR_CHARTERS = {
  writer: `You are the WRITER in ${PAIR} You make the changes in this folder and leave them uncommitted. ` +
    `Keep edits strictly scoped to the task: never delete or rewrite unrelated files, and never delete or skip existing tests to make tests pass. ` +
    `After each review, read ${REVIEW_DIR}/review-<n>.md and address its findings.` + ALWAYS,
  reviewer: `You are the REVIEWER in ${PAIR} Each round you review the writer's uncommitted changes and write your verdict and ` +
    `numbered findings to ${REVIEW_DIR}/review-<n>.md. You NEVER edit project files (you may only write inside ${REVIEW_DIR}/).` + ALWAYS,
};
export const CHARTERS = {
  writer: `You are the CODER in ${TEAM} You make the changes in this folder and leave them uncommitted. Test files belong to the ` +
    `tester: never edit them; if one is wrong, say why in ${CODER_NOTES}. Keep edits strictly scoped and never delete or rewrite unrelated files. ` +
    `After every turn write to ${CODER_NOTES} what you changed and why, and how you checked it. Build on the earlier subtasks' work; don't redo or revert it.` + ALWAYS + CLEARED,
  tester: `You are the TESTER in ${TEAM} You write and run unit and functional tests for the coder's change. Edit only test ` +
    `files, fixtures and test config, never the code under test: a bug in it is a finding in your report. Tests from earlier ` +
    `subtasks stay and must keep passing.` + ALWAYS + CLEARED,
  reviewer: `You are the REVIEWER in ${TEAM} Each round you check the coder's uncommitted change, one message for quality and ` +
    `one for security. Never edit project files. Review the current subtask's change: earlier subtasks were approved already.` + ALWAYS + CLEARED,
  pm: `You are the PM in ${TEAM} You plan (${PLAN}) and, when everything is approved, report (${REPORT}). ${PM_RULES}`,
  docs: `You are the DOCS WRITER in ${TEAM} Once the work is approved you update the documentation to match it. ` +
    `Edit documentation only, never code or tests.` + ALWAYS,
};
// Antigravity (agy) loads custom agents from ~/.gemini/config/agents/<name>/agent.md.
// For the PM role, an explicit tool allowlist removes invoke_subagent / define_subagent /
// swarm / run_workflow while keeping file, command, web and question tools, and puts
// CHARTERS.pm in its persistent system prompt.
const AGY_PM_AGENT = "coderwriter-pm";
const AGY_PM_MD = [
  "---",
  `name: ${AGY_PM_AGENT}`,
  "description: Coderwriter team PM (planner and reporter only; never writes code or spawns subagents).",
  "tools:",
  "  - read_file",
  "  - write_file",
  "  - edit_file",
  "  - run_command",
  "  - search_web",
  "  - ask_question",
  "mainAgent: true",
  "subagent: false",
  "---",
  "",
  CHARTERS.pm,
  "",
].join("\n");
async function ensureAgyPmAgent(machine) {
  const script = 'dir="$HOME/.gemini/config/agents/$1"; mkdir -p "$dir" && printf "%s" "$2" > "$dir/agent.md"';
  const r = await exec("sh", ["-c", script, "sh", AGY_PM_AGENT, AGY_PM_MD], { timeout: 10000, ...(machine ? { on: machine } : {}) }).catch(() => null);
  return r?.code === 0;
}
export function charterArgs(key, role, opts = {}) {
  const team = opts.team ?? true;
  const charter = (team ? CHARTERS : PAIR_CHARTERS)[role];
  if (!charter) return [];
  if (key === "claude") {
    return ["--append-system-prompt", charter, ...(team && role === "pm" ? ["--disallowedTools", "Agent,Task"] : [])];
  }
  if (key === "codex" || isCustom(key)) {
    return ["-c", `developer_instructions=${toml(charter)}`, ...(team && role === "pm" ? ["-c", "features.multi_agent=false"] : [])];
  }
  if (team && key === "antigravity" && role === "pm" && opts.agyPmAgent && !flagValue(splitArgs(prefs().flags.antigravity ?? ""), ["--agent"])) {
    return ["--agent", AGY_PM_AGENT];
  }
  return [];
}

// The current subtask of a running plan after the first, for briefs to agents cleared
// before it: how many were done, the snapshot its change starts from, and whether this
// round is its first.
function subtaskScope(p, round) {
  if (!planRunning(p) || !p.plan.at || p.plan.final) return null;
  return { done: p.plan.at, base: p.subtaskBase ?? null, first: firstRound(p, round) };
}
// The first round of a subtask (or of the final check): the agents were cleared before it,
// and the round before belongs to another subtask, so "since round n-1" means nothing to them.
const firstRound = (p, round) => planRunning(p) && round === (p.taskStart ?? 0) + 1;

// The current subtask as the PM wrote it (Do / Done when / Tests), for the tester and the
// quality check, who otherwise get only its title.
const MAX_BODY = 4000;
function subtaskBody(p) {
  const s = planRunning(p) && !p.plan.final ? p.plan.tasks[p.plan.at] : null;
  const body = (s?.body ?? "").trim();
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY) + `\n… (cut here; the rest is in ${PLAN})` : body;
}
const quoted = (text) => text.split("\n").map((l) => `> ${l}`).join("\n");

// The final check: once every subtask of a plan passed on its own, one more round of the
// team's checks over the whole change, for what only shows with the parts together.
const isFinal = (p) => Boolean(planRunning(p) && p.plan.final);
function finalFocus(p, round, who) {
  const cp = p.checkpoints ?? {}, base = cp[0], now = cp[round], n = p.plan.tasks.length;
  const diff = base && now ? `\`git diff ${base} ${now}\` (snapshots that include untracked files)` : "git status and git diff";
  return ` This is the FINAL CHECK of the whole plan: ${n === 2 ? "both" : `all ${n}`} subtasks of ${PLAN} were approved one by one (what each changed: ${PROGRESS}),` +
    ` and now they are checked together. The whole change is ${diff}.` + {
      tester: ` Run the whole test suite, and add tests where the subtasks meet (one subtask's code used by another) and for the plan's goal end to end.`,
      quality: ` Look for what only shows with the parts together: a later subtask breaking or bypassing an earlier one, the same thing done` +
        ` two ways, loose ends (unused code, TODOs, half-wired features), and whether the plan's goal is met as a whole.`,
      security: ` Look most at where the subtasks meet: input checked in one part and used unchecked in another, a check one subtask` +
        ` added that a later one goes around.`,
    }[who];
}
const doneBefore = (sub) => `Subtask${sub.done === 1 ? " 1 was" : `s 1–${sub.done} were`} approved already (see ${PROGRESS})`;

// A subtask was approved: add what it changed and the coder's notes to progress.md, then
// clear coder.md for the next one. Its snapshot is where the next subtask's change starts.
async function logProgress(tab) {
  const p = pair(tab), at = p.plan.at, s = p.plan.tasks[at];
  const sha = await snapshot(p, `subtask-${at + 1}`, `coderwriter: subtask ${at + 1} approved`);
  const from = at ? p.subtaskBase : p.checkpoints?.[0];
  const stat = from && sha ? await sh(p, 'git diff --stat "$1" "$2" -- . ":(exclude)$3"', [from, sha, REVIEW_DIR]).catch(() => null) : null;
  let notes = null;
  try { notes = await readTextFile(join(p.folder, CODER_NOTES), where(p)); } catch { notes = null; }
  const head = at ? "" : `# Progress on ${PLAN}\n\nThe subtasks approved so far. Their changes are in the working tree, uncommitted.\n\n`;
  const entry = [`## ${at + 1}. ${s.title}`, "", `Approved in round ${p.round} (rounds ${(p.taskStart ?? 0) + 1}–${p.round}).`,
    ...((stat?.stdout ?? "").trim() ? ["", "Files changed:", "", "```", stat.stdout.trimEnd(), "```"] : []),
    "", "The coder's notes:", "", (notes ?? "").trim() || "(none)", "", ""].join("\n");
  await sh(p, 'mkdir -p "$(dirname "$1")" && if [ "$4" = new ]; then printf "%s" "$2" > "$1"; else printf "%s" "$2" >> "$1"; fi && rm -f "$3"',
    [PROGRESS, head + entry, CODER_NOTES, at ? "add" : "new"]).catch(() => null);
  update(tab, { subtaskBase: sha ?? null });
}
export function pmBrief(task, constraints = "") {
  const extra = constraints ? `Constraints / do not touch (carry these into the plan's subtasks): ${constraints}\n\n` : "";
  return `You are the PM (project manager) of a small team in this folder: a CODER writes the code, a TESTER writes and runs the tests, ` +
    `and a REVIEWER checks quality and security. You plan and report ONLY; ${PM_RULES} ` +
    (task ? `\n\nThe user's task: ${task}\n\n` : `\n\nThe user will give you the task here. `) + extra +
    `Read enough of the repository to plan it (README, layout, the code the task touches). If something important is unclear, ` +
    `ask the user here and wait for the answer—keep planning focused and write an initial ${PLAN} as soon as requirements are clear ` +
    `rather than letting the chat grow long. Write the plan to ${PLAN}: a one-line goal, then the subtasks in the order ` +
    `to do them, each as a heading "## <n>. <title>" followed by "Do:" (what to change, where), "Done when:" (what must be true) ` +
    `and "Tests:" (what the tester should check). Use as few subtasks as the task needs (one is fine for a small task), each small ` +
    `enough for one coder to finish and get reviewed. The user approves the plan before anyone starts. Then stop.`;
}
const reviseBrief = (text) => `The user wants changes to the plan: ${text}\n\nRewrite ${PLAN} in the same format ` +
  `(ask here first only if something important is still unclear). Reminder: you are the PM (planner only)—do NOT write code, ` +
  `edit project files, or spawn subagents/workers; writing ${PLAN} and stopping is the hand-off. Then stop.`;
const nudgePlanBrief = () => `Hand off the task now by writing ${PLAN} in the required format (a one-line goal, then ` +
  `"## <n>. <title>" subtasks with "Do:", "Done when:", and "Tests:"). Reminder: you are the PM (planner only)—do NOT write code, ` +
  `edit project files, or spawn subagents/workers. Writing ${PLAN} and stopping is how coderwriter delegates the subtasks to the ` +
  `separate CODER, TESTER, and REVIEWER panes once the user clicks "Approve & start". Write ${PLAN} now, then stop.`;
const pmGuardBrief = (files, reverted = false) => `STOP: You (or a subagent you spawned) modified project files outside ${REVIEW_DIR}/: ${files.join(", ")}. ` +
  (reverted ? `coderwriter has already reverted those project file edits automatically. ` : "") +
  `As the PM, you NEVER write code, edit project files, or spawn subagents/workers to implement work—the separate CODER pane does that ` +
  `after the user approves ${PLAN}. Cancel any subagents you started` +
  (reverted ? "" : `, revert those project file edits back to how they started (do not touch ${REVIEW_DIR}/)`) +
  `, then write only ${PLAN} (if ready) and stop.`;
function reportBrief(p) {
  const n = p.plan.tasks.length;
  return `You are the PM (planner and reporter only; do NOT edit code or spawn subagents). ` +
    `All ${n} subtask${n === 1 ? "" : "s"} of ${PLAN} passed the team's checks (tester, test command, quality, security)` +
    (n > 1 ? `, one by one and then together in a final check of the whole change. ` : ". ") +
    (roleOf(p, "docs") ? `The docs writer updated the documentation (see ${DOCS}). ` : "") +
    `Write a short report for the user to ${REPORT}: for each subtask what was done (see ${PROGRESS}, the reports in ` +
    `${REVIEW_DIR}/round-*/ and git diff), the tests added, anything still open or worth a second look, and what to check before ` +
    `committing. Change no file except ${REPORT}.${FINISH} Then stop.`;
}
// The plan's subtasks: [{ title, body }] from its "## <n>. <title>" headings.
export function planTasks(text) {
  return (text ?? "").split(/^##[ \t]+(?=\d+[.)])/m).slice(1).map((part) => {
    const [head, ...rest] = part.split("\n");
    return { title: head.replace(/^\d+[.)]\s*/, "").trim(), body: rest.join("\n").trim() };
  });
}
// The task a brief names: the current subtask once a plan runs, else the pair's task.
export function taskText(p) {
  const s = p.plan?.approved && !p.plan.done ? p.plan.tasks[p.plan.at] : null;
  const task = (p.task ?? "").replace(/\s+/g, " ").trim();
  if (s && p.plan.final) return `the whole plan in ${PLAN}, ${p.plan.tasks.length === 2 ? "both" : `all ${p.plan.tasks.length}`} subtasks together${task ? `; the whole task: ${task}` : ""}`;
  return s ? `${s.title} (subtask ${p.plan.at + 1} of ${p.plan.tasks.length} in ${PLAN}${task ? `; the whole task: ${task}` : ""})` : task;
}
export function askPlan(tab) {
  openOverlay({ mod: "coderwriter", kind: "dialog", width: 660, height: 640, props: { role: "plan", tab } });
}
async function readPlan(p) {
  try { return await readTextFile(join(p.folder, PLAN), where(p)); } catch { return null; }
}

// ---- deterministic safety guards ------------------------------------------------
// Files outside .coderwriter/ that differ from a snapshot sha (including untracked files),
// without touching the real git index or creating refs. Used to catch a PM, reviewer or
// docs writer that drifts into editing disallowed project files.
const DIFF_OUTSIDE = 'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; ' +
  'idx=$(mktemp) || exit 1; trap \'rm -f "$idx"\' EXIT; ' +
  'real=$(git rev-parse --path-format=absolute --git-path index); [ -f "$real" ] && cp -p "$real" "$idx" || rm -f "$idx"; ' +
  'GIT_INDEX_FILE="$idx" git add -A :/ >/dev/null 2>&1 || exit 1; ' +
  'GIT_INDEX_FILE="$idx" git diff --cached --name-only "$1" -- . ":(exclude)$2"';
async function touchedFiles(p, base) {
  if (!base) return [];
  const r = await sh(p, DIFF_OUTSIDE, [base, REVIEW_DIR]).catch(() => null);
  return (r?.stdout ?? "").split("\n").filter(Boolean);
}

// Deterministically revert only the named files back to how they were at `base` (restoring
// tracked files from `base`, deleting newly created files that did not exist in `base`).
// Never asks an LLM to run git checkout, which could wipe the writer's uncommitted work.
const REVERT_FILES = 'top=$(git rev-parse --show-toplevel) && cd "$top" || exit 1; ' +
  'base=$1; shift; ' +
  'for f in "$@"; do ' +
  '  [ -z "$f" ] && continue; ' +
  '  if git cat-file -e "$base:$f" 2>/dev/null; then ' +
  '    git restore --source="$base" --worktree -- "$f" || exit 1; ' +
  '  else ' +
  '    rm -f -- "$f" || exit 1; ' +
  '  fi; ' +
  'done';
const isSafeRelPath = (f) => Boolean(f) && !f.startsWith("/") && f !== ".." && !f.startsWith("../") && !f.includes("/../")
  && f !== ".git" && !f.startsWith(".git/") && f !== REVIEW_DIR && !f.startsWith(`${REVIEW_DIR}/`);
async function revertFiles(p, base, files) {
  const safe = (files ?? []).filter(isSafeRelPath);
  if (!base || !safe.length) return false;
  const r = await sh(p, REVERT_FILES, [base, ...safe], 60000).catch(() => null);
  return r?.code === 0;
}

// Verify git HEAD and branch did not move (catches accidental git commit / reset / checkout).
const GIT_HEAD = 'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ' +
  'git rev-parse -q --verify HEAD 2>/dev/null || echo ""; ' +
  'git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""';
async function gitHeadInfo(p) {
  const r = await sh(p, GIT_HEAD, [], 10000).catch(() => null);
  if (!r || r.code !== 0) return null;
  const [head = "", branch = ""] = (r.stdout ?? "").split("\n").map((s) => s.trim());
  return { head: head || null, branch: branch || null };
}
const shortSha = (s) => (s ? s.slice(0, 7) : "none");
async function checkGitIntegrity(tab, role = "writer") {
  const p = pair(tab);
  if (!p?.baseHead && !p?.baseBranch) return { ok: true };
  const cur = await gitHeadInfo(p);
  if (!cur) return { ok: true };
  const headMoved = Boolean(p.baseHead && cur.head !== p.baseHead);
  const branchMoved = Boolean(p.baseBranch && cur.branch !== p.baseBranch);
  if (!headMoved && !branchMoved) return { ok: true };
  const parts = [];
  if (branchMoved) parts.push(`branch ${p.baseBranch} → ${cur.branch || "detached"}`);
  if (headMoved) parts.push(`HEAD ${shortSha(p.baseHead)} → ${shortSha(cur.head)}`);
  return {
    ok: false,
    reason: `The ${role} changed git state (${parts.join(", ")} — e.g. ran git commit, reset, or checkout). Inspect git log or run \`git reset --soft ${shortSha(p.baseHead)}\` before continuing.`,
  };
}

// Blast-radius & test-tampering checks: catches mass deletions, deleted protected files,
// and (in pair mode) deleted tests or newly introduced test-skip markers.
export const PROTECTED_PATH = /(^|\/)(\.env(\..+)?|\.github\/workflows\/.+|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$/;
export const TEST_SKIP_RE = /\b(it|test|describe)\.(skip|only)\s*\(|\b(xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip\b|\bt\.Skip\s*\(/;
export const SAFETY_LIMITS = { deletedFiles: 3, deletedLines: 300 };

export function analyzeSafety({ deletedFiles = [], numstat = [], skippedTestFiles = [], pairMode = true } = {}) {
  const issues = [];
  const del = deletedFiles.filter(Boolean);
  if (del.length >= SAFETY_LIMITS.deletedFiles) {
    const shown = del.slice(0, 4).join(", ") + (del.length > 4 ? `, +${del.length - 4} more` : "");
    issues.push(`Deleted ${del.length} tracked files (${shown})`);
  }
  const prot = del.filter((f) => PROTECTED_PATH.test(f));
  if (prot.length) issues.push(`Deleted protected file(s): ${prot.join(", ")}`);
  let added = 0, deleted = 0;
  for (const row of numstat) { added += row.added || 0; deleted += row.deleted || 0; }
  if (deleted >= SAFETY_LIMITS.deletedLines && deleted > added * 2) {
    issues.push(`Large deletion (-${deleted} / +${added} lines)`);
  }
  if (pairMode) {
    const delTests = del.filter((f) => TEST_PATH.test(f));
    if (delTests.length) issues.push(`Deleted test file(s): ${delTests.join(", ")}`);
    const skipped = [...new Set(skippedTestFiles.filter(Boolean))];
    if (skipped.length) issues.push(`Added test skip/only marker(s) in: ${skipped.join(", ")}`);
  }
  return { ok: issues.length === 0, issues, sig: issues.join(" | ") };
}

async function checkDestruction(p, fromSha, toSha) {
  if (!fromSha || !toSha || fromSha === toSha) return { ok: true, issues: [], sig: "" };
  const [delR, statR] = await Promise.all([
    sh(p, 'git diff --name-only --diff-filter=D "$1" "$2" -- . ":(exclude)$3"', [fromSha, toSha, REVIEW_DIR]).catch(() => null),
    sh(p, 'git diff --numstat "$1" "$2" -- . ":(exclude)$3"', [fromSha, toSha, REVIEW_DIR]).catch(() => null),
  ]);
  const deletedFiles = (delR?.stdout ?? "").split("\n").filter(Boolean);
  const numstat = (statR?.stdout ?? "").split("\n").filter(Boolean).map((line) => {
    const [a, d, ...rest] = line.split("\t");
    return { added: a === "-" ? 0 : Number(a) || 0, deleted: d === "-" ? 0 : Number(d) || 0, file: rest.join("\t") };
  });
  const skippedTestFiles = [];
  if (p.kind !== "team") {
    const changedTests = numstat.map((x) => x.file).filter((f) => f && TEST_PATH.test(f));
    if (changedTests.length) {
      const diffR = await sh(p, 'git diff -U0 "$1" "$2" -- "$@"', [fromSha, toSha, ...changedTests]).catch(() => null);
      let cur = null;
      for (const line of (diffR?.stdout ?? "").split("\n")) {
        if (line.startsWith("+++ b/")) cur = line.slice(6);
        else if (line.startsWith("+") && !line.startsWith("+++") && cur && TEST_SKIP_RE.test(line.slice(1))) {
          skippedTestFiles.push(cur);
        }
      }
    }
  }
  return analyzeSafety({ deletedFiles, numstat, skippedTestFiles, pairMode: p.kind !== "team" });
}

function pauseForSafety(tab, issues, sig) {
  const summary = issues.join("; ");
  const isGit = sig === "git";
  update(tab, {
    auto: false,
    phase: "safety_paused",
    pauseReason: isGit ? "Git HEAD moved" : "Safety check",
    safetyAlert: isGit ? null : { sig, issues },
    note: `Safety pause: ${summary}`,
  });
  notify({
    title: "coderwriter: safety check paused run",
    body: isGit ? summary : `${summary}. Inspect the diff or restore a snapshot in Reviews; press Review or Auto again to continue anyway.`,
    level: "warning",
    action: { name: "tab.select", args: { id: tab } },
  });
  return "safety";
}

async function guardReviewerEdits(tab, g, before, round) {
  if (!before) return [];
  const p = pair(tab);
  const edited = await touchedFiles(p, before);
  if (gen[tab] !== g) throw new Cancelled();
  if (!edited.length) return [];
  const shown = edited.slice(0, 4).join(", ") + (edited.length > 4 ? `, +${edited.length - 4} more` : "");
  await revertFiles(p, before, edited);
  const still = await touchedFiles(pair(tab), before);
  if (gen[tab] !== g) throw new Cancelled();
  if (!still.length) {
    update(tab, { note: `Round ${round}: reviewer edited project files (${shown}) — reverted automatically` });
    notify({ title: "coderwriter: reverted reviewer edits",
      body: `The reviewer edited project files (${shown}); coderwriter restored them from round ${round}'s snapshot.`,
      level: "warning", action: { name: "tab.select", args: { id: tab } } });
    return [];
  }
  const left = still.slice(0, 4).join(", ") + (still.length > 4 ? `, +${still.length - 4} more` : "");
  notify({ title: "coderwriter: reviewer left project files changed",
    body: `Could not auto-revert: ${left}. Restore round ${round} in Reviews if needed.`,
    level: "warning", action: { name: "tab.select", args: { id: tab } } });
  return still;
}

// Wait until the PM has written (or rewritten) the plan and finished its turn. A turn that
// ends without one means it asked you something: say so, and keep waiting for your answer.
// Whenever the PM settles, also verify it didn't touch project files outside .coderwriter/.
async function waitPlan(tab, g, before) {
  let told = false, checkedIdle = false, corrections = 0, warnedSig = "";
  const base = pair(tab)?.checkpoints?.[0] ?? null;
  for (;;) {
    if (gen[tab] !== g) throw new Cancelled();
    const p = pair(tab), pm = roleOf(p, "pm");
    const s = status(pm.t);
    if (s.state === "gone" || s.state === "finished") throw new Error("The PM exited");
    if (s.status === "working") {
      checkedIdle = false;
      await sleep(2000);
      continue;
    }
    const text = await readPlan(p);
    const planChanged = text != null && text !== before;
    if ((!checkedIdle || planChanged) && base) {
      checkedIdle = true;
      const touched = await touchedFiles(p, base);
      if (gen[tab] !== g) throw new Cancelled();
      if (touched.length) {
        const sig = touched.join(",");
        const shown = touched.slice(0, 4).join(", ") + (touched.length > 4 ? `, +${touched.length - 4} more` : "");
        const reverted = await revertFiles(p, base, touched);
        const still = reverted ? await touchedFiles(pair(tab), base) : touched;
        if (gen[tab] !== g) throw new Cancelled();
        if (corrections < 2 && sig !== warnedSig) {
          corrections++;
          warnedSig = sig;
          update(tab, { note: `PM edited project files (${shown}): ${still.length ? "reminding it to revert and only plan" : "reverted automatically, reminding PM to only plan"}` });
          notify({ title: "coderwriter: the PM edited project files",
            body: still.length
              ? `The PM should only write ${PLAN}, not edit code (${shown}). Asking it to revert.`
              : `The PM edited project files (${shown}); coderwriter reverted them automatically.`,
            level: "warning", action: { name: "tab.select", args: { id: tab } } });
          await say(tab, g, pm.t, "pm", pmGuardBrief(touched, still.length === 0));
          checkedIdle = false;
          continue;
        } else if (still.length && sig !== warnedSig) {
          warnedSig = sig;
          notify({ title: "coderwriter: PM left project files changed",
            body: `Project files changed during planning (${shown}). Restore round 0 in Reviews before approving.`,
            level: "warning", action: { name: "tab.select", args: { id: tab } } });
        }
      }
    }
    if (planChanged) {
      const tasks = planTasks(text);
      update(tab, { phase: "plan_ready", plan: { tasks, at: 0, approved: false, done: false },
        note: tasks.length ? `Plan ready: ${tasks.length} subtask${tasks.length === 1 ? "" : "s"}, approve it to start` : "The plan has no \"## 1. Title\" subtasks: ask the PM to fix it" });
      notify({ title: "coderwriter: plan ready", body: "The PM's plan is ready for you to approve", level: "info", action: { name: "tab.select", args: { id: tab } } });
      askPlan(tab);
      return;
    }
    if (!told && ["idle", "done", "blocked", "error"].includes(s.status)) {
      told = true;
      update(tab, { note: "The PM is waiting in its pane (answer it, or open Plan to nudge hand-off)" });
      notify({ title: "coderwriter: the PM asks", body: "Answer the PM in its pane; the plan follows", level: "info", action: { name: "tab.select", args: { id: tab } } });
    }
    await sleep(2000);
  }
}

async function startSubtask(tab, g, at) {
  const p = pair(tab);
  if (at > 0) {
    update(tab, { note: `Subtask ${at + 1}/${p.plan.tasks.length}: clearing the agents' conversations` });
    for (const role of ["writer", "tester", "reviewer"]) await fresh(tab, g, roleOf(p, role), role);
  }
  update(tab, { plan: { ...p.plan, at }, taskStart: p.round ?? 0, phase: "writing", note: `Subtask ${at + 1}/${p.plan.tasks.length}: coder is working` });
  const q = pair(tab), s = q.plan.tasks[at];
  const earlier = at ? `\n\n${doneBefore({ done: at })}: their changes are already in this folder, uncommitted. ` +
    `Read ${PROGRESS} first, then build on that work; don't redo or revert it.` : "";
  const text = `Subtask ${at + 1} of ${q.plan.tasks.length} from the PM's plan (${PLAN})${q.task ? `; the whole task: ${q.task.replace(/\s+/g, " ")}` : ""}.` +
    `${earlier}\n\n## ${s.title}\n${s.body}`;
  await say(tab, g, q.writer.t, "writer", writerBrief(text, { team: true, testCmd: pairTestCommand(q), constraints: q.constraints }));
  update(tab, { phase: "written", note: `Subtask ${at + 1}/${q.plan.tasks.length}: written, ready for review` });
}

// ---- the docs writer ------------------------------------------------------------
// An optional fifth agent. Once every subtask has passed, it brings the documentation up
// to date (README, changelog, docs/, other Markdown) and says what it changed in
// .coderwriter/docs.md; then the PM reports. It may edit documentation only: any non-doc
// edits are automatically reverted from the snapshot taken before it ran.
const DOC_PATH = /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|adoc)$|(^|\/)(README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|LICENSE)(\.[a-z]+)?$/i;
function docsBrief(p) {
  const base = p.checkpoints?.[0];
  return `You are the DOCS WRITER of a team in this folder. The coder's work on ${p.task ? `"${p.task.replace(/\s+/g, " ")}"` : "the task"} ` +
    `is done and passed the tests and the quality and security checks: the plan is ${PLAN}, what each subtask changed and the coder's notes ${PROGRESS}, ` +
    `and the whole change is ${base ? `\`git diff ${base}\` (plus untracked files)` : "git status and git diff"}; ignore ${REVIEW_DIR}/. ` +
    `Bring the documentation up to date with it: the README (what it does, how to install and use it), the changelog if the ` +
    `project keeps one, docs/ and other Markdown, and doc comments only where the project already has them. Match the existing ` +
    `style; add nothing the change doesn't need, and don't invent features. Edit documentation only, never code or tests. ` +
    `Then write to ${DOCS} what you updated and why, file by file (or that nothing needed changing).${FINISH} Then stop.`;
}
async function writeDocs(tab, g) {
  const p = pair(tab), docs = roleOf(p, "docs");
  if (!docs?.t) return;
  update(tab, { phase: "documenting", note: "All subtasks approved: the docs writer is updating the documentation" });
  const before = await snapshot(p, "before-docs", "coderwriter: before the docs writer");
  await say(tab, g, docs.t, "docs", docsBrief(pair(tab)));
  await remind(tab, g, docs.t, "docs", DOCS, () => exists(pair(tab), DOCS), (ok) => !ok);
  const after = await snapshot(pair(tab), "after-docs", "coderwriter: after the docs writer");
  if (!before || !after) return;
  const r = await sh(pair(tab), 'git diff --name-only "$1" "$2"', [before, after]).catch(() => null);
  const changed = (r?.stdout ?? "").split("\n").filter(Boolean);
  const other = changed.filter((f) => !DOC_PATH.test(f) && !f.startsWith(`${REVIEW_DIR}/`));
  let still = other;
  if (other.length) {
    await revertFiles(pair(tab), before, other);
    const left = new Set(await touchedFiles(pair(tab), before));
    still = other.filter((f) => left.has(f));
    notify({
      title: still.length ? "coderwriter: the docs writer changed code" : "coderwriter: reverted docs writer code edits",
      body: still.length
        ? `Could not auto-revert non-documentation files: ${still.join(", ")}. Check them before you commit.`
        : `The docs writer edited non-documentation files (${other.join(", ")}); coderwriter reverted them automatically.`,
      level: "warning",
      action: { name: "tab.select", args: { id: tab } },
    });
  }
  update(tab, { docsChanged: changed.filter((f) => !f.startsWith(`${REVIEW_DIR}/`) && !other.includes(f)), docsOther: still });
}

// The final check begins: the agents are cleared, and the next round (the loop's, or
// Review's) checks the whole change. A plan of one subtask has none: that was the whole change.
async function startFinal(tab, g) {
  const p = pair(tab);
  update(tab, { note: "Every subtask approved: clearing the agents for the final check" });
  for (const role of ["writer", "tester", "reviewer"]) await fresh(tab, g, roleOf(p, role), role);
  update(tab, { plan: { ...pair(tab).plan, final: true }, taskStart: pair(tab).round ?? 0, phase: "written",
    note: "Final check: the whole change, every subtask together" });
}

// A subtask (or the final check) was approved: hand out the next subtask, start the final
// check, or have the docs writer and the PM finish. "next" or "done".
async function afterApproval(tab, g) {
  let p = pair(tab);
  const n = p.plan.tasks.length;
  if (!p.plan.final) {
    await logProgress(tab);
    p = pair(tab);
    if (p.plan.at < n - 1) {
      notify({ title: "coderwriter", body: `Subtask ${p.plan.at + 1}/${n} approved: on to ${p.plan.at + 2}`, level: "info" });
      await startSubtask(tab, g, p.plan.at + 1);
      return "next";
    }
    if (n > 1) {
      notify({ title: "coderwriter", body: `${n === 2 ? "Both" : `All ${n}`} subtasks approved: a final check of the whole change`, level: "info" });
      await startFinal(tab, g);
      return "next";
    }
  } else {
    await sh(p, 'printf "%s" "$2" >> "$1"', [PROGRESS, `## Final check of the whole change\n\nApproved in round ${p.round} ` +
      `(rounds ${(p.taskStart ?? 0) + 1}–${p.round}).\n\n`]).catch(() => null);
  }
  await writeDocs(tab, g);
  const pm = roleOf(pair(tab), "pm");
  const beforeReport = await snapshot(pair(tab), "before-report", "coderwriter: before the PM report");
  update(tab, { phase: "reporting", note: "All subtasks approved: clearing the PM for the final report" });
  await fresh(tab, g, pm, "pm");
  update(tab, { phase: "reporting", note: "All subtasks approved: the PM is writing the report" });
  await say(tab, g, pm.t, "pm", reportBrief(pair(tab)));
  await remind(tab, g, pm.t, "pm", REPORT, () => exists(pair(tab), REPORT), (ok) => !ok);
  const pmEdited = await touchedFiles(pair(tab), beforeReport);
  if (pmEdited.length) {
    await revertFiles(pair(tab), beforeReport, pmEdited);
    const still = await touchedFiles(pair(tab), beforeReport);
    notify({
      title: still.length ? "coderwriter: the PM edited project files" : "coderwriter: reverted PM edits",
      body: still.length
        ? `During reporting, the PM changed: ${still.join(", ")}. Check them before you commit.`
        : `During reporting, the PM edited project files (${pmEdited.join(", ")}); coderwriter reverted them automatically.`,
      level: "warning",
      action: { name: "tab.select", args: { id: tab } },
    });
  }
  update(tab, { plan: { ...pair(tab).plan, done: true }, auto: false, phase: "approved", note: `All ${n} subtasks done: report in ${REPORT}` });
  notify({ title: "coderwriter: done", body: `${p.task || "The plan"}: all ${n} subtasks approved. The PM's report is in ${REPORT}.${worktreeNote(p)}`,
    level: "success", action: { name: "tab.select", args: { id: tab } } });
  askAudit(tab);
  return "done";
}
const planRunning = (p) => Boolean(p?.plan?.approved && !p.plan.done);
// Where the work is, for the "done" toasts of a pair in its own worktree.
const worktreeNote = (p) => (p.worktree ? ` It's on branch ${p.worktree.branch}, in ${p.worktree.path}.` : "");

// The Plan dialog's answers (through the bar). A job still waiting for the plan gives way.
function interruptWait(tab) {
  if (busy[tab] && ["planning", "plan_ready"].includes(pair(tab)?.phase)) { gen[tab] = (gen[tab] ?? 0) + 1; busy[tab] = false; }
}
export function approvePlan(tab) {
  interruptWait(tab);
  return job(tab, async (g) => {
    const p = pair(tab);
    if (planRunning(p)) throw new Error("The plan is already running");
    const tasks = planTasks(await readPlan(p));
    if (!tasks.length) throw new Error(`No subtasks in ${PLAN} (they are "## 1. Title" headings)`);
    update(tab, { plan: { tasks, at: 0, approved: true, done: false }, auto: true });
    await startSubtask(tab, g, 0);
    await loop(tab, g);
  });
}
export function revisePlan(tab, text) {
  interruptWait(tab);
  return job(tab, async (g) => {
    const p = pair(tab);
    if (planRunning(p)) throw new Error("The plan is already running");
    const before = await readPlan(p);
    update(tab, { phase: "planning", note: "The PM is changing the plan" });
    await say(tab, g, roleOf(p, "pm").t, "pm", reviseBrief(text));
    await waitPlan(tab, g, before);
  });
}
export function nudgePlan(tab) {
  interruptWait(tab);
  return job(tab, async (g) => {
    const p = pair(tab);
    if (planRunning(p)) throw new Error("The plan is already running");
    const before = await readPlan(p);
    update(tab, { phase: "planning", note: "Reminding the PM to write the plan and hand off" });
    await say(tab, g, roleOf(p, "pm").t, "pm", nudgePlanBrief());
    await waitPlan(tab, g, before);
  });
}

// ---- repeated findings ----------------------------------------------------------
// A review's numbered findings, and which of them came back from the round before:
// same words (Jaccard >= 0.6), or the same file named and much the same words (>= 0.45).
export function findingsOf(text) {
  return (text ?? "").split("\n").map((l) => /^\s*\d+[.)]\s+(.+)/.exec(l)?.[1]?.trim()).filter(Boolean);
}
const STOP = new Set("the and for that this with from should into when then than are was were has have not but its it's use uses used also only just which there their them they will would could can".split(" "));
function words(f) {
  return new Set(f.toLowerCase().replace(/[`*_"'()[\]{},;:!?]/g, " ").split(/\s+/).map((w) => w.replace(/\.$/, "")).filter((w) => w.length > 2 && !STOP.has(w)));
}
const filesIn = (f) => new Set((f.match(/[\w./-]+\.[a-z][\w]{0,5}\b/gi) ?? []).map((x) => x.toLowerCase()));
function similar(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  const jaccard = both / (wa.size + wb.size - both);
  const fa = filesIn(a), sameFile = [...filesIn(b)].some((f) => fa.has(f));
  return jaccard >= 0.6 || (sameFile && jaccard >= 0.45);
}
export function repeatedFindings(before, now) {
  const old = findingsOf(before);
  return findingsOf(now).filter((f) => old.some((o) => similar(o, f)));
}
const short = (f, n = 90) => (f.length > n ? f.slice(0, n - 1) + "…" : f);

// ---- test gate ------------------------------------------------------------------
// A per-folder test command, run before each review. Its output goes to
// .coderwriter/tests-<round>.txt; a failure goes back to the writer, not the reviewer.
// When working in a git worktree, falls back to the source repo folder's test command.
export const TEST_FIX_MAX = 3; // writer attempts at failing tests per round (auto loop)
export function testCommand(folder, fallback = null) {
  const t = prefs().tests;
  return (t[folder] ?? (fallback ? t[fallback] : null) ?? "").trim();
}
export function pairTestCommand(p) { return testCommand(p?.folder, p?.sourceFolder ?? null); }
export function setTestCommand(folder, cmd, sourceFolder = null) {
  const tests = { ...prefs().tests };
  const val = cmd.trim();
  for (const dir of [folder, ...(sourceFolder && sourceFolder !== folder ? [sourceFolder] : [])]) {
    if (val) tests[dir] = val; else delete tests[dir];
  }
  setPrefs({ tests });
}

async function runTests(tab, round) {
  const p = pair(tab);
  const cmd = pairTestCommand(p);
  if (!cmd) return null;
  const file = `${REVIEW_DIR}/tests-${round}.txt`;
  update(tab, { tests: { state: "running", round, cmd, file }, note: `Round ${round}: running tests` });
  let code = 1, crashed = null;
  try {
    const r = await exec("sh", ["-c", 'mkdir -p "$1" && sh -c "$3" > "$2" 2>&1 </dev/null', "sh", REVIEW_DIR, file, cmd],
      { cwd: p.folder, timeout: 600000, ...where(p) });
    code = r.code;
  } catch (e) { crashed = String(e.message ?? e); }
  const pass = code === 0 && !crashed;
  update(tab, { tests: { state: pass ? "pass" : "fail", round, cmd, file, code, error: crashed, at: Date.now() } });
  return pass;
}

export function testsBrief(p) {
  const t = p.tests ?? {};
  const role = p.kind === "team" ? "CODER in a team" : "WRITER in a writer/reviewer pair";
  return restoredNote(p) + `You are the ${role}${taskText(p) ? `; your task: ${taskText(p)}` : ""}. ` +
    `The test command \`${t.cmd}\` fails${t.error ? ` (${t.error})` : ` with exit code ${t.code}`}. ` +
    `Its output is in ${t.file}. Fix the code so the tests pass. Don't skip or weaken tests to get there; ` +
    `if a test itself is wrong, fix it and say why. Keep the changes uncommitted.${FINISH}`;
}

// ---- checkpoints ----------------------------------------------------------------
// Each round's files, as a commit under refs/coderwriter/<pair>/ (never on a branch):
// the real index is copied so untracked files are in it too and the user's staging is
// left alone. Round 0 is the folder before the writer started.
const SNAP = 'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3; ' +
  'idx=$(mktemp) || exit 1; trap \'rm -f "$idx"\' EXIT; ' +
  'real=$(git rev-parse --path-format=absolute --git-path index); [ -f "$real" ] && cp -p "$real" "$idx" || rm -f "$idx"; ' +
  'GIT_INDEX_FILE="$idx" git add -A :/ >/dev/null 2>&1 || exit 1; ' +
  'tree=$(GIT_INDEX_FILE="$idx" git write-tree) || exit 1; ' +
  'parent=$(git rev-parse -q --verify HEAD); ' +
  'c=$(git -c user.name=coderwriter -c user.email=coderwriter@localhost commit-tree "$tree" ${parent:+-p "$parent"} -m "$2") || exit 1; ' +
  'git update-ref "$1" "$c" && echo "$c"';
const refBase = (p) => `refs/coderwriter/${p.tab.replace(/[^\w-]/g, "-")}`;

async function snapshot(p, name, message) {
  try {
    const r = await exec("sh", ["-c", SNAP, "sh", `${refBase(p)}/${name}`, message], { cwd: p.folder, timeout: 120000, ...where(p) });
    return r.code === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}
async function checkpoint(tab, round) {
  const p = pair(tab);
  const sha = await snapshot(p, `round-${round}`, `coderwriter: round ${round}`);
  if (sha) update(tab, { checkpoints: { ...(pair(tab).checkpoints ?? {}), [round]: sha } });
  return sha;
}

// Put the files back as they were in a checkpoint (or any snapshot sha). What is there
// now is kept first as "before-restore", so the restore itself can be undone.
// Always excludes .coderwriter/ so reviews, plans and reports are preserved.
const RESTORE = 'top=$(git rev-parse --show-toplevel) && cd "$top" || exit 1; ' +
  'git diff --name-only -z --diff-filter=A "$1" "$2" -- . ":(exclude)$3" | xargs -0 -r rm -f -- ; ' +
  'git restore --source="$1" --worktree -- . ":(exclude)$3"';
async function restoreTo(tab, sha, label) {
  const p = pair(tab);
  const undo = await snapshot(p, "before-restore", `coderwriter: before restoring ${label}`);
  if (!undo) throw new Error("Could not save the current files first, so nothing was restored");
  const r = await exec("sh", ["-c", RESTORE, "sh", sha, undo, REVIEW_DIR], { cwd: p.folder, timeout: 120000, ...where(p) });
  if (r.code !== 0) throw new Error(`Restore failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  update(tab, { undo: { sha: undo, round: p.round ?? 0, verdict: p.verdict ?? null } });
  return undo;
}
export function restore(tab, round) {
  return job(tab, async () => {
    const p = pair(tab);
    const sha = p.checkpoints?.[round];
    if (!sha) throw new Error(`No snapshot for round ${round}`);
    const label = round === 0 ? "the start" : `round ${round}`;
    await restoreTo(tab, sha, label);
    update(tab, { round, verdict: null, phase: "restored", restored: label, repeats: [], tests: null,
      note: `Files restored to ${label}${round === 0 ? "" : "'s review"}` });
  });
}
export function undoRestore(tab) {
  return job(tab, async () => {
    const u = pair(tab)?.undo;
    if (!u) throw new Error("Nothing to undo");
    await restoreTo(tab, u.sha, "the undo");
    update(tab, { round: u.round, verdict: u.verdict, undo: null, restored: null, phase: "idle", note: "Restore undone" });
  });
}
function restoredNote(p) {
  return p.restored ? `(Note: the files were reset to how they were at ${p.restored}; your later edits are gone.) ` : "";
}

// Run one job for a pair. `fn(p, g)` does the work; errors become a note + toast.
async function job(tab, fn) {
  if (busy[tab]) return;
  busy[tab] = true;
  const g = (gen[tab] = (gen[tab] ?? 0) + 1);
  try { await fn(g); }
  catch (e) {
    if (!(e instanceof Cancelled)) {
      const msg = String(e.message ?? e);
      update(tab, { phase: "error", auto: false, pauseReason: e.pauseReason ?? "Error", note: msg });
      notify({ title: "coderwriter", body: msg, level: "error" });
    }
  }
  finally { if (gen[tab] === g) busy[tab] = false; }
}

// One review round: tests first (a failure stops here and returns "tests"), then a
// checkpoint of the files, then the reviewer. With `kinds` (["security", "ponytail"])
// it is an audit round instead; a plain round that approves asks about an audit.
async function reviewRound(tab, g, kinds = null) {
  let p = pair(tab);
  const found = kinds || p.lens ? await findSkills(p.folder, p.machine) : {};
  if (kinds) {
    const missing = kinds.filter((k) => !found[k]);
    if (missing.length) throw new Error(`Not installed: ${missing.map((k) => SKILLS[k].skill).join(", ")} (install: ${SKILLS[missing[0]].install})`);
  }
  const lens = !kinds && p.lens ? found.lens : null;
  if (!kinds && p.lens && !lens) {
    notify({ title: "coderwriter: Ponytail review not installed", body: `Reviewing without it. ${SKILLS.lens.install}`, level: "warning" });
  }
  await settle(tab, g, p.writer.t, "writer");
  const gitCheck = await checkGitIntegrity(tab, "writer");
  if (gen[tab] !== g) throw new Cancelled();
  if (!gitCheck.ok) return pauseForSafety(tab, [gitCheck.reason], "git");
  const round = (p.round ?? 0) + 1;
  await checkpoint(tab, round);
  p = pair(tab);
  if (!kinds) {
    const safety = await checkDestruction(p, p.checkpoints?.[0] ?? null, p.checkpoints?.[round] ?? null);
    if (gen[tab] !== g) throw new Cancelled();
    if (!safety.ok && safety.sig !== p.safetyAck) return pauseForSafety(tab, safety.issues, safety.sig);
  }
  const passed = await runTests(tab, round);
  if (gen[tab] !== g) throw new Cancelled();
  if (passed === false) {
    update(tab, { phase: "tests_failed", note: `Tests failed before round ${round}: Feedback sends them to the writer` });
    return "tests";
  }
  const what = kinds ? kinds.map((k) => SKILLS[k].name.toLowerCase()).join(" + ") : "reviewing";
  update(tab, { round, phase: kinds ? "auditing" : "reviewing", verdict: null, repeats: [], testFixes: 0, safetyAlert: null, note: `Round ${round}: ${what}`,
    ...(kinds ? { audits: { ...(p.audits ?? {}), [round]: kinds } } : {}) });
  await say(tab, g, p.reviewer.t, "reviewer", kinds ? auditBrief(p, round, kinds, found) : reviewBrief(p, round, lens));
  const v = await remind(tab, g, p.reviewer.t, "reviewer", `${REVIEW_DIR}/review-${round}.md`, () => verdictOf(pair(tab), round),
    (r) => r.verdict === "missing" || r.verdict === "unknown", ["APPROVED", "CHANGES_REQUESTED"]);
  await guardReviewerEdits(tab, g, p.checkpoints?.[round] ?? null, round);
  const postGit = await checkGitIntegrity(tab, "reviewer");
  if (gen[tab] !== g) throw new Cancelled();
  if (!postGit.ok) return pauseForSafety(tab, [postGit.reason], "git");
  let repeats = [];
  if (v.verdict === "changes" && round > 1) {
    const before = await verdictOf(pair(tab), round - 1);
    repeats = repeatedFindings(before.text, v.text);
  }
  const again = repeats.length ? ` · ${repeats.length} repeated from round ${round - 1}` : "";
  update(tab, { phase: "reviewed", verdict: v.verdict, repeats, note: `Round ${round}${kinds ? " audit" : ""}: ${v.summary}${again}` });
  if (v.verdict === "approved" && !kinds) askAudit(tab);
  return v.verdict;
}

async function fixRound(tab, g) {
  const p = pair(tab);
  update(tab, { phase: "fixing", note: `Round ${p.round}: writer is fixing` });
  await say(tab, g, p.writer.t, "writer", feedbackBrief(p));
  update(tab, { phase: "written", restored: null, note: `Round ${p.round}: fixed, ready for review` });
}

async function fixTests(tab, g) {
  const p = pair(tab);
  const tries = (p.testFixes ?? 0) + 1;
  update(tab, { phase: "fixing", testFixes: tries, note: `Writer is fixing the failing tests (try ${tries})` });
  await say(tab, g, p.writer.t, "writer", testsBrief(p));
  update(tab, { phase: "written", restored: null, note: "Tests fixed? Send to review to check" });
}

async function loop(tab, g) {
  for (;;) {
    let p = pair(tab);
    if (!p?.auto || gen[tab] !== g) return;
    const verdict = p.kind === "team" ? await teamRound(tab, g) : await reviewRound(tab, g);
    p = pair(tab);
    if (verdict === "safety") return;
    if (verdict === "tests") {
      if ((p.testFixes ?? 0) >= TEST_FIX_MAX) {
        update(tab, { auto: false, pauseReason: "Tests failed", note: `Tests still fail after ${p.testFixes} tries: loop paused` });
        notify({ title: "coderwriter: tests fail", body: `${p.tests?.cmd} still fails after ${p.testFixes} tries`, level: "warning", action: { name: "tab.select", args: { id: tab } } });
        return;
      }
      await fixTests(tab, g);
      continue;
    }
    if (verdict === "approved" && planRunning(p)) {
      update(tab, { repeatStreak: 0, pauseReason: null });
      if ((await afterApproval(tab, g)) === "next") continue;
      return;
    }
    if (verdict === "approved") {
      update(tab, { auto: false, phase: "approved", repeatStreak: 0, pauseReason: null, note: `Approved in round ${p.round}` });
      notify({ title: "coderwriter: approved", body: `${p.task || "The change"} — approved in round ${p.round}.${worktreeNote(p)}`, level: "success", action: { name: "tab.select", args: { id: tab } } });
      return;
    }
    if (verdict !== "changes") {
      update(tab, { auto: false, pauseReason: "No verdict", note: p.kind === "team" ? `${p.note}; loop paused` : `Round ${p.round}: the review has no verdict line; loop paused` });
      notify({ title: "coderwriter", body: `Round ${p.round}: no VERDICT line in the review, loop paused`, level: "warning" });
      return;
    }
    if ((p.repeats ?? []).length) {
      const streak = (p.repeatStreak ?? 0) + 1;
      const f = short(p.repeats[0]);
      if (streak >= 2) {
        update(tab, { auto: false, repeatStreak: streak, pauseReason: "Repeated finding", note: `Round ${p.round}: "${f}" repeated again: loop paused` });
        notify({ title: "coderwriter: stuck", body: `Round ${p.round} still repeats "${f}" after a nudge. Loop paused; Feedback sends it back manually.`,
          level: "warning", action: { name: "tab.select", args: { id: tab } } });
        return;
      }
      // First repeat: nudge the writer automatically instead of killing Auto right away.
      update(tab, { repeatStreak: streak, note: `Round ${p.round}: "${f}" repeated — nudging writer to fix it` });
    } else if (p.repeatStreak) {
      update(tab, { repeatStreak: 0 });
    }
    if (p.round - (p.taskStart ?? 0) >= p.max) {
      update(tab, { auto: false, phase: "limit", pauseReason: "Round limit", note: `Stopped after ${p.round} rounds without approval` });
      notify({ title: "coderwriter: round limit", body: `${p.round} rounds without approval`, level: "warning", action: { name: "tab.select", args: { id: tab } } });
      return;
    }
    await fixRound(tab, g);
  }
}

export function review(tab) {
  const alert = pair(tab)?.safetyAlert;
  update(tab, { pauseReason: null, ...(alert?.sig ? { safetyAck: alert.sig, safetyAlert: null } : {}) });
  return job(tab, async (g) => {
    if (pair(tab)?.kind !== "team") return reviewRound(tab, g);
    const v = await teamRound(tab, g);
    if (v === "approved" && planRunning(pair(tab))) await afterApproval(tab, g);
  });
}
export function audit(tab, kinds) {
  const ok = (kinds ?? []).filter((k) => AUDITS.includes(k));
  if (!ok.length) return;
  if (busy[tab]) { notify({ title: "coderwriter", body: "The pair is busy: press Audit again when it's done", level: "warning" }); return; }
  return job(tab, (g) => reviewRound(tab, g, ok));
}
export function feedback(tab) {
  update(tab, { pauseReason: null });
  return job(tab, (g) => {
    const p = pair(tab);
    if (p?.phase === "tests_failed") return fixTests(tab, g);
    return p?.round ? fixRound(tab, g) : Promise.reject(new Error("No review yet: send to review first"));
  });
}
// Run the test command now, outside a round (to check the command itself).
export function testNow(tab) {
  return job(tab, async () => {
    const p = pair(tab);
    const pass = await runTests(tab, (p.round ?? 0) + 1);
    if (pass === null) throw new Error("No test command for this folder");
    update(tab, { note: pass ? "Tests pass" : "Tests fail: Feedback sends them to the writer", ...(pass ? {} : { phase: "tests_failed" }) });
  });
}
export function setAuto(tab, on) {
  const alert = on ? pair(tab)?.safetyAlert : null;
  update(tab, { auto: on, ...(on ? { pauseReason: null, repeatStreak: 0 } : {}), ...(alert?.sig ? { safetyAck: alert.sig, safetyAlert: null } : {}) });
  if (on && !busy[tab]) job(tab, (g) => loop(tab, g));
  if (!on) update(tab, { pauseReason: null, note: "Auto loop off" });
}

function newTabId() {
  let s = "tbcw";
  for (let i = 0; i < 28; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

// Keep the reviews out of git status (and out of the reviewer's diff).
async function excludeReviews(folder, machine) {
  const script = `f="$(git rev-parse --git-path info/exclude 2>/dev/null)" || exit 0; mkdir -p "$(dirname "$f")"; grep -qxF '${REVIEW_DIR}/' "$f" 2>/dev/null || echo '${REVIEW_DIR}/' >> "$f"`;
  await exec("sh", ["-c", script], { cwd: folder, ...(machine ? { on: machine } : {}) }).catch(() => null);
}

// ---- worktrees -------------------------------------------------------------------
// A pair or team can work in its own git worktree, so your working copy is never touched:
// a new branch cw/<task>-<id> from the last commit, checked out where Herdr's own New
// worktree puts them, <worktrees.directory>/<repo>/<branch> (settings.json; default
// ~/.herdr/worktrees), on the pair's machine. coderwriter never removes one: the work in it
// is uncommitted. Herdr's Remove worktree does that once you've taken what you want.
const ADD_WORKTREE = 'dir="$1"; case "$dir" in "~") dir="$HOME" ;; "~/"*) dir="$HOME/${dir#"~/"}" ;; esac; ' +
  'top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repository" >&2; exit 3; }; ' +
  'path="$dir/$(basename "$top")/$2"; git -C "$top" worktree add -q -b "$3" "$path" HEAD >&2 || exit 1; printf "%s" "$path"';
export async function makeWorktree(folder, machine, task) {
  let dir = "~/.herdr/worktrees";
  try { dir = JSON.parse((await readTextFile(`${appHome()}/settings.json`)) ?? "{}")?.worktrees?.directory || dir; } catch { /* default */ }
  const words = (task ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4).join("-") || "work";
  const branch = `cw/${words}-${Math.random().toString(16).slice(2, 6)}`;
  const r = await exec("sh", ["-c", ADD_WORKTREE, "sh", dir, branch.replace(/\//g, "-"), branch], { cwd: folder, timeout: 600000, ...(machine ? { on: machine } : {}) });
  if (r.code !== 0) throw new Error(`Could not make a worktree: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  return { path: r.stdout.trim(), branch };
}
// What the dialog shows about a folder: a git repo or not, its branch, uncommitted files.
export async function gitState(folder, machine) {
  const r = await exec("sh", ["-c", 'git rev-parse --abbrev-ref HEAD 2>/dev/null || exit 3; git status --porcelain 2>/dev/null | wc -l'],
    { cwd: folder, timeout: 10000, ...(machine ? { on: machine } : {}) }).catch(() => null);
  if (!r || r.code !== 0) return { repo: false, branch: null, dirty: 0 };
  const [branch, n] = r.stdout.trim().split("\n");
  return { repo: true, branch, dirty: Number(n) || 0 };
}

// No space open: make one in `folder` and wait for it to show up.
export async function openSpace(folder, machine = null) {
  const before = new Set(spaces().map((s) => s.id));
  run("space.new", { folder, ...(machine ? { machine } : {}) });
  for (let i = 0; i < 40; i++) {
    const made = spaces().find((s) => !before.has(s.id));
    if (made) return made;
    await sleep(250);
  }
  throw new Error(`Could not open a space in ${folder}`);
}

// A team's panes as a 2×2 grid in the order the work flows: PM over Coder on the left,
// Tester over Reviewer on the right. The writer's pane comes from the tab; each other
// agent is given a pane right of / below one, then swapped up. Whatever can't be placed
// still gets a pane, so no agent is left invisible.
const hasPane = (t) => panes().some((p) => p.terminal === t);
async function waitPane(t) { for (let i = 0; i < 30 && !hasPane(t); i++) await sleep(150); return hasPane(t); }
async function placePane(t, beside, place, up) {
  run("pane.focus", { terminal: beside });
  run("terminal.keep", { terminal: t, place });
  if (!(await waitPane(t)) || !up) return;
  run("pane.focus", { terminal: t });
  run("pane.swap", { direction: "up" });
}
async function arrangeTeam(w, r, tt, pm, docs = null) {
  try {
    if (await waitPane(w)) {
      await placePane(r, w, "right", false);
      if (pm) await placePane(pm, w, "down", true);
      if (tt && hasPane(r)) await placePane(tt, r, "down", true);
      if (docs && hasPane(r)) await placePane(docs, r, "down", false); // under the reviewer
    }
  } catch { /* placed below */ }
  for (const t of [r, tt, pm, docs]) if (t && !hasPane(t)) { run("terminal.keep", { terminal: t, place: "right" }); await waitPane(t); }
  run("pane.focus", { terminal: pm ?? w }); // you talk to the PM first
}

// Start a pair: two agents in a new tab of `space`, writer left, reviewer right.
export async function start({ space, folder, sourceFolder = null, task, constraints = "", writer, reviewer, tester = null, pm = null, docs = null, max, auto, oneShot = false, lens = false, team = false, worktree = null, turnLimit = 30 }) {
  const machine = space.machine ?? null;
  const strip = (id) => (machine && id.startsWith(machine + "/") ? id.slice(machine.length + 1) : id);
  const raw = newTabId();
  const tab = machine ? `${machine}/${raw}` : raw;
  folder = folder || space.folder || home();
  sourceFolder = sourceFolder || folder;
  await excludeReviews(folder, machine);
  const agyPmAgent = team && pm?.key === "antigravity" ? await ensureAgyPmAgent(machine) : false;
  // inTab: labelled into the new tab, which the app lays out side by side; a team's other
  // agents start without a pane and arrangeTeam() places them.
  const launch = async (role, agent, inTab = true) => {
    const args = ["run", "--bg", "--keep", "--json", "--no-parent", "--cwd", folder];
    if (machine) args.push("--on", machine);
    if (inTab) args.push("--label", `herdr.space=${strip(space.id)}`, "--label", `herdr.tab=${raw}`);
    args.push("--label", `coderwriter.role=${role}`, "--label", `coderwriter.pair=${raw}`, "--", ...withShellPath([...launchArgv(agent, role, { oneShot }),
      ...charterArgs(agent.key, role, { team, agyPmAgent })]));
    const r = await hcJson(args);
    if (!r.address) throw new Error(`Could not start the ${role} (${agent.name})`);
    return r.address;
  };
  const w = await launch("writer", writer);
  const r = await launch("reviewer", reviewer, !team);
  const tt = team && tester ? await launch("tester", tester, false) : null;
  const pmT = team && pm ? await launch("pm", pm, false) : null;
  const dT = team && docs ? await launch("docs", docs, false) : null;
  const role = (a, t) => (t ? { agent: a.key, name: a.name, t } : null);
  const roles = Object.fromEntries(Object.entries({ tester: role(tester, tt), pm: role(pm, pmT), docs: role(docs, dT) }).filter(([, v]) => v));
  update(tab, {
    tab, space: space.id, machine, folder, sourceFolder, task, constraints,
    writer: { agent: writer.key, name: writer.name, t: w },
    reviewer: { agent: reviewer.key, name: reviewer.name, t: r },
    ...(team ? { stages: teamStageIds(tt), roles } : {}),
    round: 0, max, auto, oneShot, lens, kind: team ? "team" : "pair", worktree, turnLimit, verdict: null, phase: "starting", note: "Starting agents", started: Date.now(),
  });
  // Clear stale top-level round files from earlier pairs in the same folder so Reviews and
  // repeat detection start clean (leaves custom subdirs/files inside .coderwriter/ alone).
  await sh(pair(tab), 'rm -rf "$1"/review-*.md "$1"/tests-*.txt "$1"/round-* 2>/dev/null || true', [REVIEW_DIR]).catch(() => null);
  // Round 0: the files and HEAD before the writer touches them (no-op outside a git repo).
  const headInfo = await gitHeadInfo(pair(tab));
  if (headInfo) update(tab, { baseHead: headInfo.head, baseBranch: headInfo.branch });
  await checkpoint(tab, 0);
  // The tab appears once the app adopts the labelled terminals.
  for (let i = 0; i < 40; i++) {
    if (spaces().some((s) => s.tabs.some((x) => x.id === tab))) break;
    await sleep(250);
  }
  const title = task ? `cw · ${task.replace(/\s+/g, " ").slice(0, 28)}` : "coderwriter";
  run("tab.rename", { id: tab, name: title });
  run("tab.select", { id: tab });
  if (team) await arrangeTeam(w, r, tt, pmT, dT);
  await job(tab, async (g) => {
    if (pmT) {
      // A plan from an earlier team in this folder must not pass for the new one.
      await sh(pair(tab), 'rm -f "$1" "$2" "$3"', [PLAN, REPORT, PROGRESS]).catch(() => null);
      update(tab, { phase: "planning", note: task ? "The PM is planning" : "Give the PM your task in its pane" });
      await say(tab, g, pmT, "pm", pmBrief(task, constraints));
      await waitPlan(tab, g, null);
    } else if (task) {
      update(tab, { phase: "writing", note: oneShot ? "One-shot: writer is working" : "Writer is working" });
      await say(tab, g, w, "writer", writerBrief(task, { team, testCmd: pairTestCommand(pair(tab)), lens, oneShot, constraints }));
      update(tab, { phase: "written", note: "Writer finished: send to review" });
    } else {
      update(tab, { phase: "idle", note: "Type the task into the writer" });
    }
  });
  if (pair(tab)?.auto && !pmT) setAuto(tab, true); // with a PM, approving the plan starts the loop
  return tab;
}

// On load, re-attach any live Auto pair whose in-memory job was lost on reload (when the
// writer is mid-turn or waiting for review) instead of silently disabling Auto. Active jobs
// still running in memory (busy[tab]) are never interrupted.
export function resumeNote() {
  const live = new Set(terminals().filter((t) => t.state === "live").map((t) => t.address));
  const all = pairs();
  const reattach = [];
  let changed = false;
  for (const [tab, p] of Object.entries(all)) {
    if (busy[tab]) continue;
    if (all[tab].tests?.state === "running") {
      all[tab] = { ...all[tab], tests: null };
      changed = true;
    }
    const bothLive = live.has(p.writer?.t) && live.has(p.reviewer?.t);
    if (p.auto && bothLive && ["writing", "written", "fixing"].includes(p.phase)) {
      all[tab] = { ...all[tab], pauseReason: null, note: "Re-attached after reload: waiting for turn to finish" };
      reattach.push(tab);
      changed = true;
    } else if (["starting", "writing", "reviewing", "auditing", "fixing", "planning", "documenting", "reporting"].includes(p.phase) || p.auto) {
      all[tab] = { ...all[tab], auto: false, phase: "paused", pauseReason: "Herdr reloaded", note: "Paused (Herdr reloaded): press Review or Auto to go on" };
      changed = true;
    }
  }
  if (changed) setShared(PAIRS, all);
  for (const tab of reattach) setAuto(tab, true);
}

// Drop pairs whose agents are both gone (tab closed).
export function prune() {
  const live = new Set(terminals().filter((t) => t.state === "live").map((t) => t.address));
  const all = pairs();
  const keep = Object.fromEntries(Object.entries(all).filter(([, p]) => live.has(p.writer?.t) || live.has(p.reviewer?.t)));
  if (Object.keys(keep).length === Object.keys(all).length) return;
  setShared(PAIRS, keep);
  // The pair's round snapshots go with it.
  for (const [tab, p] of Object.entries(all)) {
    if (keep[tab] || !p.folder || !p.tab) continue;
    exec("sh", ["-c", 'git for-each-ref --format="delete %(refname)" "$1/" | git update-ref --stdin', "sh", refBase(p)],
      { cwd: p.folder, ...where(p) }).catch(() => null);
  }
}
