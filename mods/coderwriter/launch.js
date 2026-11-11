// Launch flags: extra command-line flags for Claude Code and Codex when a pair
// starts them (and, if asked, for the tab bar's + menu via programs.json).
// Empty flags = each agent's own default.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, appHome, readTextFile, writeTextFile, notify, shared, setShared } from "herdr";
import * as P from "./pair.js";

const I = (name) => `mods/coderwriter/icons/${name}.svg`;

// Presets toggle their args inside the flags text. One preset per group at a time.
export const PRESETS = {
  claude: [
    { id: "skip", label: "Skip permissions", args: ["--dangerously-skip-permissions"], group: "perm", danger: true },
    { id: "accept", label: "Accept edits", args: ["--permission-mode", "acceptEdits"], group: "perm" },
    { id: "auto", label: "Auto mode", args: ["--permission-mode", "auto"], group: "perm" },
    { id: "plan", label: "Plan mode", args: ["--permission-mode", "plan"], group: "perm" },
  ],
  codex: [
    { id: "bypass", label: "Bypass approvals + sandbox", args: ["--dangerously-bypass-approvals-and-sandbox"], group: "perm", danger: true },
    { id: "approve", label: "Auto-approve", args: ["--approve-for-me"], group: "perm" },
    { id: "write", label: "Workspace write", args: ["--sandbox", "workspace-write"], group: "perm" },
    { id: "ro", label: "Read-only", args: ["--sandbox", "read-only"], group: "perm" },
    { id: "search", label: "Web search", args: ["--search"] },
  ],
};
const NAMES = { claude: "Claude Code", codex: "Codex" };
const HINTS = { claude: "more flags, e.g. --model opus --effort high", codex: "more flags, e.g. -m <model> --search" };
const DANGER = ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--allow-dangerously-skip-permissions"];

function indexOfSeq(tokens, seq) {
  outer: for (let i = 0; i + seq.length <= tokens.length; i++) {
    for (let j = 0; j < seq.length; j++) if (tokens[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
const isOn = (tokens, preset) => indexOfSeq(tokens, preset.args) >= 0;
function removeSeq(tokens, seq) {
  const i = indexOfSeq(tokens, seq);
  return i < 0 ? tokens : [...tokens.slice(0, i), ...tokens.slice(i + seq.length)];
}

export function isDangerous(key) {
  return P.splitArgs(P.prefs().flags[key]).some((a) => DANGER.includes(a) || a === "bypassPermissions");
}
export function customized(key) { return P.splitArgs(P.prefs().flags[key]).length > 0; }

// ---- the + menu: programs.json `run` overrides we own --------------------------
const OWNED = "coderwriter.menuRuns"; // { key: argv we wrote }, so we never remove the person's own

export async function syncMenu(key) {
  const path = `${appHome()}/programs.json`;
  const before = await readTextFile(path);
  let doc = {};
  if (before != null) {
    try { doc = JSON.parse(before); } catch { notify({ title: "coderwriter", body: "programs.json is not valid JSON; the + menu was left alone", level: "warning" }); return; }
  }
  const owned = { ...(shared(OWNED) ?? {}) };
  const programs = { ...(doc.programs ?? {}) };
  const entry = { ...(programs[key] ?? {}) };
  const pr = P.prefs();
  const want = pr.menu[key] && customized(key) ? P.launchArgv({ key, run: P.BASE_RUN[key] }) : null;
  const ours = owned[key] && JSON.stringify(entry.run) === JSON.stringify(owned[key]);
  if (want) {
    if (entry.run && !ours) {
      notify({ title: "coderwriter", body: `programs.json already sets ${key}'s command; left it as is`, level: "warning" });
      return;
    }
    entry.run = want;
    owned[key] = want;
  } else {
    if (!ours) return;
    delete entry.run;
    delete owned[key];
  }
  if (Object.keys(entry).length) programs[key] = entry; else delete programs[key];
  const next = { ...doc, programs };
  if (!Object.keys(programs).length) delete next.programs;
  if (before == null && !Object.keys(next).length) { setShared(OWNED, owned); return; }
  try {
    await writeTextFile(path, JSON.stringify(next, null, 2) + "\n", before);
    setShared(OWNED, owned);
  } catch (e) {
    notify({ title: "coderwriter", body: `Could not update programs.json: ${e.message ?? e}`, level: "error" });
  }
}

// ---- the popup -------------------------------------------------------------------
export class Launch {
  init(_props, cx) {
    this.inputs = {};
    for (const key of P.AGENTS) {
      const input = InputState.new({ placeholder: HINTS[key] });
      input.set_value(P.prefs().flags[key] ?? "");
      input.on("change", (_e, cx) => { this.setFlags(key, input.value(), false); cx.notify(); });
      // The + menu's copy is written when typing settles (blur / Enter), not per keystroke.
      input.on("blur", () => { if (P.prefs().menu[key]) syncMenu(key); });
      input.on("submit", () => { if (P.prefs().menu[key]) syncMenu(key); });
      this.inputs[key] = input;
    }
  }

  setFlags(key, text, updateInput = true) {
    const pr = P.prefs();
    P.setPrefs({ flags: { ...pr.flags, [key]: text } });
    if (updateInput) {
      this.inputs[key].set_value(text);
      if (pr.menu[key]) syncMenu(key);
    }
  }

  toggle(key, preset) {
    let tokens = P.splitArgs(P.prefs().flags[key]);
    const on = isOn(tokens, preset);
    tokens = removeSeq(tokens, preset.args);
    if (!on) {
      if (preset.group) for (const other of PRESETS[key]) if (other.group === preset.group) tokens = removeSeq(tokens, other.args);
      tokens = [...preset.args, ...tokens];
    }
    this.setFlags(key, P.joinArgs(tokens));
  }

  section(t, key) {
    const pr = P.prefs();
    const tokens = P.splitArgs(pr.flags[key]);
    const argv = P.launchArgv({ key, run: P.BASE_RUN[key] });
    const danger = isDangerous(key);
    const menuOn = pr.menu[key];
    const chip = (preset) => {
      const on = isOn(tokens, preset);
      const tint = preset.danger ? t.blocked : t.accent;
      return h_flex().id(`preset-${key}-${preset.id}`).h(24).px(8).gap(5).items_center().flex_none().rounded(6).text_size(11.8)
        .border_1().border_color(on ? tint : t.border).bg(on ? tint + "1f" : t.background)
        .text_color(on ? (preset.danger ? t.blocked : t.foreground) : t.muted)
        .hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => { this.toggle(key, preset); cx.notify(); })
        .when(on, (el) => el.child(svg(I("check")).size(11)))
        .child(preset.label);
    };
    return v_flex().gap(7).px(12).py(10)
      .child(h_flex().gap(8).items_center()
        .child(image(`icons/${key}.svg`).size(15).flex_none())
        .child(div().flex_1().text_size(12.8).font_semibold().text_color(t.foreground).child(NAMES[key]))
        .child(tokens.length
          ? div().id(`reset-${key}`).text_size(11.3).text_color(t.muted).hover((s) => s.text_color(t.foreground)).cursor_pointer()
            .on_click((_e, cx) => { this.setFlags(key, ""); cx.notify(); }).child("Reset to default")
          : div().px(6).h(18).flex().items_center().rounded(5).bg(t.selected).text_size(10.8).text_color(t.muted).child("default")))
      .child(h_flex().flex_wrap().gap(5).children(PRESETS[key].map(chip)))
      .child(Input.new(this.inputs[key]).h(28).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground))
      .child(div().px(8).py(5).rounded(6).bg(t.chrome).text_size(11.3).text_color(t.muted).font_family("JetBrains Mono").child(`$ ${P.joinArgs(argv)}`))
      .when(danger, (el) => el.child(div().text_size(11.3).text_color(t.blocked)
        .child("Runs without asking before edits and commands. Use only in folders you trust.")))
      .child(h_flex().id(`menu-${key}`).gap(7).items_center().text_size(11.8).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          P.setPrefs({ menu: { ...P.prefs().menu, [key]: !menuOn } });
          syncMenu(key);
          cx.notify();
        })
        .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
          .border_color(menuOn ? t.accent : t.border).bg(menuOn ? t.accent : t.background)
          .when(menuOn, (el) => el.child(svg(I("check")).size(10).text_color(t.accent_foreground))))
        .child("Also use these flags for the tab bar's + menu"));
  }

  render() {
    const t = theme();
    return v_flex().size_full().bg(t.popover).text_size(12.5).overflow_hidden()
      .child(div().px(12).pt(10).pb(2).text_size(11).text_color(t.dim).child("Launch flags for new pairs"))
      .child(this.section(t, "claude"))
      .child(div().h(1).bg(t.border).mx(12))
      .child(this.section(t, "codex"));
  }
}
