// The writer/reviewer engine: start a pair, send it to review, send feedback,
// run the auto loop. Everything talks to herdr-core through `hc`; state lives in
// shared("coderwriter.pairs") keyed by the pair's tab id, so the bar and the pane
// headers (and a reload) see the same thing.
import { exec, shared, setShared, terminals, spaces, run, notify, readTextFile, home } from "herdr";

export const PAIRS = "coderwriter.pairs";
export const PREFS = "coderwriter.prefs";
export const AGENTS = ["claude", "codex"];
export const REVIEW_DIR = ".coderwriter";

export function prefs() {
  const p = { writer: "claude", reviewer: "codex", max: 3, auto: false, ...(shared(PREFS) ?? {}) };
  p.flags = { claude: "", codex: "", ...(p.flags ?? {}) };
  p.menu = { claude: false, codex: false, ...(p.menu ?? {}) };
  p.models = Array.isArray(p.models) ? p.models : [];
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

// Loads the key into the environment, then execs Codex. The key itself never sits in
// argv: a file is read here, and an env var missing from herdr-core's environment is
// asked of the person's interactive shell (where it is usually exported).
const KEY_LOADER = 'mode=$1; name=$2; file=$3; shift 3; ' +
  'case "$mode" in ' +
  'file) if [ -r "$file" ]; then v=$(cat "$file"); export "$name=$v"; else echo "coderwriter: no saved API key ($file)" >&2; fi ;; ' +
  'env) eval "cur=\\${$name:-}"; if [ -z "$cur" ] && [ -n "$SHELL" ]; then cur=$("$SHELL" -ic "printf %s \\"\\$$name\\"" 2>/dev/null </dev/null); ' +
  'if [ -n "$cur" ]; then export "$name=$cur"; else echo "coderwriter: $name is not set" >&2; fi; fi ;; ' +
  'esac; exec "$@"';

export function customArgv(m) {
  const pid = providerId(m);
  const conf = [
    "-c", `model_providers.${pid}.name=${toml(m.name || m.model)}`,
    "-c", `model_providers.${pid}.base_url=${toml(String(m.base_url).replace(/\/+$/, ""))}`,
    "-c", `model_providers.${pid}.wire_api="responses"`,
  ];
  if (m.key !== "none") conf.push("-c", `model_providers.${pid}.env_key=${toml(keyEnvName(m))}`);
  conf.push("-c", `model_provider=${toml(pid)}`, "-m", m.model);
  const codex = [...BASE_RUN.codex, ...conf];
  if (m.key === "none" || (m.key === "env" && !ENV_NAME.test(m.env ?? ""))) return codex;
  return ["sh", "-c", KEY_LOADER, "sh", m.key, keyEnvName(m), keyFile(m), ...codex];
}

// How each agent starts with no extra flags: Herdr's own commands for them.
export const BASE_RUN = { claude: ["claude"], codex: ["codex", "--no-daemon"] };

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

// The argv a pair starts an agent with: its base command plus the person's flags.
export function launchArgv(agent) {
  const m = customModel(agent.key);
  // Custom models run Codex, so they take Codex's flags.
  if (m) return [...customArgv(m), ...splitArgs(prefs().flags.codex ?? "")];
  const base = BASE_RUN[agent.key] ?? agent.run;
  return [...base, ...splitArgs(prefs().flags[agent.key] ?? "")];
}
export function setPrefs(patch) { setShared(PREFS, { ...prefs(), ...patch }); }

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
  update(tab, { auto: false, phase: "stopped", note: "Stopped" });
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
    if (s.status === "idle" || s.status === "done") return;
    if (!told && (s.status === null || s.status === "blocked")) {
      told = true;
      update(tab, { note: `Waiting for the ${role} — answer its prompt if it shows one` });
    }
    await sleep(1000);
  }
}

// Wait until the agent stops working. Blocked means it needs the person: keep
// waiting (politely) until they answer.
async function settle(tab, g, address, role) {
  for (;;) {
    if (gen[tab] !== g) throw new Cancelled();
    const s = status(address);
    if (s.state === "gone" || s.state === "finished") throw new Error(`The ${role} (${address}) exited`);
    if (s.status === "blocked") {
      update(tab, { note: `The ${role} needs you` });
      await sleep(2000);
      continue;
    }
    if (s.status !== "working") return;
    // `ended` means the wait ended; `reason: "exit"` means the program did.
    const w = await hcJson(["wait", "--json", "--timeout", "540", address], 600000);
    if (w.reason === "exit") throw new Error(`The ${role} (${address}) exited`);
  }
}

// Paste a message, press Enter and wait for that turn to end.
async function say(tab, g, address, role, text) {
  await ready(tab, g, address, role);
  const r = await hcJson(["send", "--wait", "--json", "--timeout", "540", address, text], 600000);
  if (r.started === false) throw new Error(`The ${role} did not take the message: ${r.reason ?? "not started"}`);
  if (r.wait?.reason === "exit") throw new Error(`The ${role} (${address}) exited`);
  if (gen[tab] !== g) throw new Cancelled();
  await settle(tab, g, address, role);
}

export function writerBrief(task) {
  return `${task}\n\n(You are the WRITER in a writer/reviewer pair. Make the change in this folder and leave it uncommitted. ` +
    `A reviewer agent reads your uncommitted changes; its reviews arrive as ${REVIEW_DIR}/review-<n>.md.)`;
}
export function reviewBrief(p, round) {
  const file = `${REVIEW_DIR}/review-${round}.md`;
  return `You are the REVIEWER in a writer/reviewer pair (round ${round}).` +
    (p.task ? ` The writer's task: ${p.task.replace(/\s+/g, " ")}.` : "") +
    ` Review the writer's uncommitted changes in this folder (git status, git diff, untracked files; ignore ${REVIEW_DIR}/).` +
    ` Do not edit project files. Write your review to ${file}: the first line exactly "VERDICT: APPROVED" or "VERDICT: CHANGES_REQUESTED",` +
    ` then numbered findings, most important first, each with the file and what to change. Then stop.`;
}
export function feedbackBrief(round) {
  return `The reviewer's round ${round} review is in ${REVIEW_DIR}/review-${round}.md. Read it and address every finding ` +
    `(push back in your reply if you disagree with one). Keep the changes uncommitted.`;
}

function where(p) { return p.machine ? { on: p.machine } : {}; }
function join(folder, rel) { return folder.endsWith("/") ? folder + rel : `${folder}/${rel}`; }

async function verdictOf(p, round) {
  const path = join(p.folder, `${REVIEW_DIR}/review-${round}.md`);
  let text = null;
  try { text = await readTextFile(path, where(p)); } catch { text = null; }
  if (text == null) return { verdict: "missing", summary: `No ${REVIEW_DIR}/review-${round}.md` };
  const m = /VERDICT:\s*(APPROVED|CHANGES[_ ]REQUESTED)/i.exec(text);
  const verdict = !m ? "unknown" : /^APPROVED$/i.test(m[1]) ? "approved" : "changes";
  const findings = text.split("\n").filter((l) => /^\s*\d+[.)]/.test(l)).length;
  return { verdict, summary: verdict === "approved" ? "Approved" : verdict === "changes" ? `${findings} finding${findings === 1 ? "" : "s"}` : "No verdict line" };
}

// Run one job for a pair. `fn(p, g)` does the work; errors become a note + toast.
async function job(tab, fn) {
  if (busy[tab]) return;
  busy[tab] = true;
  const g = (gen[tab] = (gen[tab] ?? 0) + 1);
  try { await fn(g); }
  catch (e) {
    if (!(e instanceof Cancelled)) {
      update(tab, { phase: "error", auto: false, note: String(e.message ?? e) });
      notify({ title: "coderwriter", body: String(e.message ?? e), level: "error" });
    }
  }
  finally { if (gen[tab] === g) busy[tab] = false; }
}

async function reviewRound(tab, g) {
  const p = pair(tab);
  await settle(tab, g, p.writer.t, "writer");
  const round = (p.round ?? 0) + 1;
  update(tab, { round, phase: "reviewing", verdict: null, note: `Round ${round}: reviewing` });
  await say(tab, g, p.reviewer.t, "reviewer", reviewBrief(p, round));
  const v = await verdictOf(pair(tab), round);
  update(tab, { phase: "reviewed", verdict: v.verdict, note: `Round ${round}: ${v.summary}` });
  return v.verdict;
}

async function fixRound(tab, g) {
  const p = pair(tab);
  update(tab, { phase: "fixing", note: `Round ${p.round}: writer is fixing` });
  await say(tab, g, p.writer.t, "writer", feedbackBrief(p.round));
  update(tab, { phase: "written", note: `Round ${p.round}: fixed, ready for review` });
}

async function loop(tab, g) {
  for (;;) {
    let p = pair(tab);
    if (!p?.auto || gen[tab] !== g) return;
    const verdict = await reviewRound(tab, g);
    p = pair(tab);
    if (verdict === "approved") {
      update(tab, { auto: false, phase: "approved", note: `Approved in round ${p.round}` });
      notify({ title: "coderwriter: approved", body: `${p.task || "The change"} — approved in round ${p.round}`, level: "success", action: { name: "tab.select", args: { id: tab } } });
      return;
    }
    if (verdict !== "changes") {
      update(tab, { auto: false, note: `Round ${p.round}: the review has no verdict line; loop paused` });
      notify({ title: "coderwriter", body: `Round ${p.round}: no VERDICT line in the review, loop paused`, level: "warning" });
      return;
    }
    if (p.round >= p.max) {
      update(tab, { auto: false, phase: "limit", note: `Stopped after ${p.round} rounds without approval` });
      notify({ title: "coderwriter: round limit", body: `${p.round} rounds without approval`, level: "warning", action: { name: "tab.select", args: { id: tab } } });
      return;
    }
    await fixRound(tab, g);
  }
}

export function review(tab) { return job(tab, (g) => reviewRound(tab, g)); }
export function feedback(tab) {
  return job(tab, (g) => (pair(tab)?.round ? fixRound(tab, g) : Promise.reject(new Error("No review yet: send to review first"))));
}
export function setAuto(tab, on) {
  update(tab, { auto: on });
  if (on && !busy[tab]) job(tab, (g) => loop(tab, g));
  if (!on) update(tab, { note: "Auto loop off" });
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

// Start a pair: two agents in a new tab of `space`, writer left, reviewer right.
export async function start({ space, folder, task, writer, reviewer, max, auto }) {
  const machine = space.machine ?? null;
  const strip = (id) => (machine && id.startsWith(machine + "/") ? id.slice(machine.length + 1) : id);
  const raw = newTabId();
  const tab = machine ? `${machine}/${raw}` : raw;
  folder = folder || space.folder || home();
  await excludeReviews(folder, machine);
  const launch = async (role, agent) => {
    const args = ["run", "--bg", "--keep", "--json", "--no-parent", "--cwd", folder];
    if (machine) args.push("--on", machine);
    args.push("--label", `herdr.space=${strip(space.id)}`, "--label", `herdr.tab=${raw}`,
      "--label", `coderwriter.role=${role}`, "--label", `coderwriter.pair=${raw}`, "--", ...launchArgv(agent));
    const r = await hcJson(args);
    if (!r.address) throw new Error(`Could not start the ${role} (${agent.name})`);
    return r.address;
  };
  const w = await launch("writer", writer);
  const r = await launch("reviewer", reviewer);
  update(tab, {
    tab, space: space.id, machine, folder, task,
    writer: { agent: writer.key, name: writer.name, t: w },
    reviewer: { agent: reviewer.key, name: reviewer.name, t: r },
    round: 0, max, auto, verdict: null, phase: "starting", note: "Starting agents", started: Date.now(),
  });
  // The tab appears once the app adopts the labelled terminals.
  for (let i = 0; i < 40; i++) {
    if (spaces().some((s) => s.tabs.some((x) => x.id === tab))) break;
    await sleep(250);
  }
  const title = task ? `cw · ${task.replace(/\s+/g, " ").slice(0, 28)}` : "coderwriter";
  run("tab.rename", { id: tab, name: title });
  run("tab.select", { id: tab });
  await job(tab, async (g) => {
    if (task) {
      update(tab, { phase: "writing", note: "Writer is working" });
      await say(tab, g, w, "writer", writerBrief(task));
      update(tab, { phase: "written", note: "Writer finished: send to review" });
    } else {
      update(tab, { phase: "idle", note: "Type the task into the writer" });
    }
  });
  if (pair(tab)?.auto) setAuto(tab, true);
  return tab;
}

// On load, a job from an earlier build is gone: say so instead of pretending.
export function resumeNote() {
  const all = pairs();
  let changed = false;
  for (const [tab, p] of Object.entries(all)) {
    if (["starting", "writing", "reviewing", "fixing"].includes(p.phase) || p.auto) {
      all[tab] = { ...p, auto: false, phase: "paused", note: "Paused (Herdr reloaded): press Review or Auto to go on" };
      changed = true;
    }
  }
  if (changed) setShared(PAIRS, all);
}

// Drop pairs whose agents are both gone (tab closed).
export function prune() {
  const live = new Set(terminals().filter((t) => t.state === "live").map((t) => t.address));
  const all = pairs();
  const keep = Object.fromEntries(Object.entries(all).filter(([, p]) => live.has(p.writer?.t) || live.has(p.reviewer?.t)));
  if (Object.keys(keep).length !== Object.keys(all).length) setShared(PAIRS, keep);
}
