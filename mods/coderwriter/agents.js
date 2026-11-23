// Helpers the bar, the agent picker and the New pair dialog share: which agents a
// machine has, how to show them, and paths as ~/….
import { div, svg, image } from "gpui-kit";
import { knownAgents, shared, setShared, home } from "herdr";
import * as P from "./pair.js";
import { modelLabel } from "./models.js";

export const I = (name) => `mods/coderwriter/icons/${name}.svg`;
const KNOWN = "coderwriter.agents";
export const ROLE_COLOR = { writer: "ansi4", reviewer: "ansi5", tester: "ansi3", pm: "ansi6", docs: "ansi2" };

export function tilde(path) {
  if (!path) return "";
  const h = home();
  return path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

export function agentIcon(a, size, color) {
  if (!a?.icon) return div().size(size);
  return a.tint ? svg(a.icon).size(size).flex_none().text_color(color) : image(a.icon).size(size).flex_none();
}

// The agents Herdr can start (knownAgents(): its program table's entries with a `run`),
// Claude and Codex first, cached per machine.
export function known(machine) { return shared(KNOWN)?.[machine ?? ""] ?? []; }
export async function refreshKnown(machine) {
  const list = await knownAgents({ on: machine });
  const rank = (a) => { const i = P.AGENTS.indexOf(a.key); return i < 0 ? P.AGENTS.length : i; };
  const ours = [...list].sort((a, b) => rank(a) - rank(b));
  setShared(KNOWN, { ...(shared(KNOWN) ?? {}), [machine ?? ""]: ours });
  return ours;
}

const FALLBACK = {
  claude: { name: "Claude Code", icon: "icons/claude.svg", tint: false },
  codex: { name: "Codex", icon: "icons/codex.svg", tint: false },
  gemini: { name: "Gemini", icon: "icons/gemini.svg", tint: true },
  antigravity: { name: "Antigravity", icon: "icons/antigravity.svg", tint: false },
};

// An agent Herdr knows, a custom model (which runs Codex, so it's installed when Codex is),
// or (key "cmd") the role's own command line.
export function agentFor(key, list, role = null) {
  if (key === P.CMD) {
    const command = (P.prefs().commands[role] ?? "").trim();
    return { key, name: command ? command.split(/\s+/)[0] : "Command", command, icon: I("terminal"), tint: true, installed: Boolean(command), cmd: true };
  }
  const m = P.customModel(key);
  if (m) {
    const codex = list.find((a) => a.key === "codex");
    return { key, name: modelLabel(m), icon: I("cpu"), tint: true, installed: codex ? codex.installed : null, custom: m };
  }
  if (P.isCustom(key)) return { key, name: "Removed model", icon: I("cpu"), tint: true, installed: false };
  const fb = FALLBACK[key];
  return list.find((a) => a.key === key) ?? { key, name: fb?.name ?? key, icon: fb?.icon ?? `icons/${key}.svg`, tint: fb?.tint ?? false, installed: null };
}

// Every agent a role can use: the known agents (the built-in ones even before the list
// arrives), the custom models, then, with a role, its own command line.
export function allAgents(list, role = null) {
  const keys = [...new Set([...P.AGENTS, ...list.map((a) => a.key)])];
  return [...keys, ...P.prefs().models.map((m) => `m:${m.id}`), ...(role ? [P.CMD] : [])].map((key) => agentFor(key, list, role));
}
// A command line that skips the agent's permission prompts.
export const riskyCommand = (cmd) => /--dangerously|--yolo|(?:\s|^)-y(?:\s|$)|--approval-mode[=\s]+yolo|bypass|skip-permissions|--approve-for-me/i.test(cmd ?? "");
