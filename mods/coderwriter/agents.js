// Helpers the bar, the agent picker and the New pair dialog share: which agents a
// machine has, how to show them, and paths as ~/….
import { div, svg, image } from "gpui-kit";
import { knownAgents, shared, setShared, home } from "herdr";
import * as P from "./pair.js";
import { modelLabel } from "./models.js";

export const I = (name) => `mods/coderwriter/icons/${name}.svg`;
const KNOWN = "coderwriter.agents";
export const ROLE_COLOR = { writer: "ansi4", reviewer: "ansi5", tester: "ansi3", pm: "ansi6" };

export function tilde(path) {
  if (!path) return "";
  const h = home();
  return path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

export function agentIcon(a, size, color) {
  if (!a?.icon) return div().size(size);
  return a.tint ? svg(a.icon).size(size).flex_none().text_color(color) : image(a.icon).size(size).flex_none();
}

// Claude and Codex as knownAgents() reports them, cached per machine.
export function known(machine) { return shared(KNOWN)?.[machine ?? ""] ?? []; }
export async function refreshKnown(machine) {
  const list = await knownAgents({ on: machine });
  const ours = list.filter((a) => P.AGENTS.includes(a.key));
  setShared(KNOWN, { ...(shared(KNOWN) ?? {}), [machine ?? ""]: ours });
  return ours;
}

// Claude, Codex, or a custom model (which runs Codex, so it's installed when Codex is).
export function agentFor(key, list) {
  const m = P.customModel(key);
  if (m) {
    const codex = list.find((a) => a.key === "codex");
    return { key, name: modelLabel(m), icon: I("cpu"), tint: true, installed: codex ? codex.installed : null, custom: m };
  }
  if (P.isCustom(key)) return { key, name: "Removed model", icon: I("cpu"), tint: true, installed: false };
  return list.find((a) => a.key === key) ?? { key, name: key === "claude" ? "Claude Code" : "Codex", icon: `icons/${key}.svg`, tint: false, installed: null };
}

// Every agent a pair can use: Claude Code, Codex, then the custom models.
export function allAgents(list) {
  return [...P.AGENTS, ...P.prefs().models.map((m) => `m:${m.id}`)].map((key) => agentFor(key, list));
}
