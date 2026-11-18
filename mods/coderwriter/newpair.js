// The tab bar's + menu (role "new": New pair…, Terminal, or Herdr's own menu) and the
// New pair dialog (role "newpair"). The dialog doesn't start the pair itself: an
// overlay goes away when it closes, and a pair's jobs run for a long time. It leaves the
// request in shared(NEW_PAIR) and sends "coderwriter.newpair" to the bar, which starts it
// like its own Start button does.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, spaces, panes, focused, openOverlay, closeOverlay, props, pickFolder, run, home, setShared } from "herdr";
import * as P from "./pair.js";
import { isDangerous } from "./launch.js";
import { I, ROLE_COLOR, tilde, agentIcon, known, refreshKnown, agentFor, allAgents, riskyCommand } from "./agents.js";

export const NEW_PAIR = "coderwriter.newPairRequest";

const activeSpace = () => spaces().find((s) => s.active) ?? null;
const shortName = (a) => a.name.replace(" Code", "");

export function openNewPair() {
  openOverlay({ mod: "coderwriter", kind: "dialog", width: 560, height: 700, props: { role: "newpair" } });
}

export class NewMenu {
  init() {}

  row(t, id, icon, name, hint, action) {
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none().text_color(t.foreground)
      .hover((s) => s.bg(t.selected)).cursor_pointer()
      .on_click(() => { closeOverlay(props().overlay); action(); })
      .child(icon).child(div().flex_1().min_w(0).truncate().child(name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    const t = theme();
    const pr = P.prefs(), list = known(activeSpace()?.machine ?? null);
    const w = agentFor(pr.writer, list, "writer"), r = agentFor(pr.reviewer, list, "reviewer");
    return v_flex().size_full().bg(t.popover).p(5).gap(1).text_size(12.8)
      .child(div().px(9).pt(4).pb(4).text_size(11).text_color(t.dim).child("Pair coding"))
      .child(this.row(t, "new-pair", svg(I("pen")).size(14).text_color(t[ROLE_COLOR.writer]), "New pair…", `${shortName(w)} → ${shortName(r)}`,
        () => { P.setPrefs({ team: false }); openNewPair(); }))
      .child(this.row(t, "new-team", svg(I("list")).size(14).text_color(t[ROLE_COLOR.pm]), "New team…", "PM, coder, tester, reviewer",
        () => { P.setPrefs({ team: true }); openNewPair(); }))
      .child(div().h(1).mx(4).my(4).bg(t.border))
      .child(this.row(t, "new-terminal", svg("icons/shell.svg").size(14).text_color(t.foreground), "Terminal", "",
        () => run("tab.new", { space: activeSpace()?.id })))
      .child(this.row(t, "new-more", svg(I("plus")).size(14).text_color(t.foreground), "Agent, space or worktree…", "",
        () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })));
  }
}

export class NewPair {
  init(_props, cx) {
    const space = activeSpace();
    this.machine = space?.machine ?? null;
    this.folder = focused()?.cwd || panes().find((p) => p.focused)?.cwd || space?.folder || home();
    this.input = InputState.new({ placeholder: "What should be done?" });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.input.focus();
    cx.timer.after(50, () => this.input.focus());
    // Each role's own command line (used when its agent is "Command").
    this.cmds = {};
    for (const role of ["writer", "reviewer", "tester", "pm"]) {
      const input = InputState.new({ placeholder: "Command line, e.g. claude --model sonnet" });
      input.set_value(P.prefs().commands[role] ?? "");
      input.on("change", (_e, cx) => { P.setPrefs({ commands: { ...P.prefs().commands, [role]: input.value() } }); cx.notify(); });
      this.cmds[role] = input;
    }
    cx.spawn(async (cx) => { try { await refreshKnown(this.machine); } catch { this.failed = true; } cx.notify(); });
  }

  chosen() {
    const pr = P.prefs(), list = known(this.machine);
    return { pr, w: agentFor(pr.writer, list, "writer"), r: agentFor(pr.reviewer, list, "reviewer"),
      tt: pr.team ? agentFor(pr.tester, list, "tester") : null, pm: pr.team ? agentFor(pr.pm, list, "pm") : null };
  }

  problem() {
    const { w, r, tt, pm } = this.chosen();
    for (const [role, a] of [[tt ? "coder" : "writer", w], ["reviewer", r], ...(tt ? [["tester", tt], ["PM", pm]] : [])]) {
      if (a.installed === false) return a.cmd ? `Type the ${role}'s command` : a.custom ? `The ${role} model runs through Codex, which is not installed` : `The ${role} agent (${a.name}) is not installed`;
    }
    return null;
  }

  start(cx) {
    if (this.problem()) { cx.notify(); return; }
    setShared(NEW_PAIR, { task: this.input.value(), folder: this.folder, at: Date.now() });
    run("coderwriter.newpair");
    closeOverlay(props().overlay);
  }

  // One role: its name (in a team the writer is the Coder) and its agents.
  roleRow(t, role, team) {
    const head = { writer: ["pen", team ? "Coder" : "Writer"], reviewer: ["search", team ? "Reviewer: quality, then security" : "Reviewer"],
      tester: ["flask", "Tester: writes and runs the tests"], pm: ["list", "PM: you give it the task; it plans, you approve"] }[role];
    return v_flex().gap(6)
      .child(h_flex().gap(6).items_center().child(svg(I(head[0])).size(12).text_color(t[ROLE_COLOR[role]])).child(this.label(t, head[1])))
      .child(this.agents(t, role));
  }

  link(t, id, icon, text, onClick) {
    return h_flex().id(id).gap(5).items_center().text_color(t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click(() => onClick())
      .child(svg(I(icon)).size(12)).child(text);
  }

  label(t, text) { return div().text_size(11.5).font_medium().text_color(t.muted).child(text); }

  // One row of agents to choose from for a role.
  // A role's agents: the installed ones (and the chosen one), then Command, whose text box
  // shows under the row when it is chosen.
  agents(t, which) {
    const chosen = P.prefs()[which];
    const list = allAgents(known(this.machine), which).filter((a) => a.cmd || a.installed !== false || a.key === chosen);
    const row = h_flex().flex_wrap().gap(6).children(list.map((a) => {
      const on = a.key === chosen, ok = a.cmd || a.installed !== false;
      return h_flex().id(`${which}-${a.key}`).h(30).px(10).gap(7).items_center().flex_none().rounded(7)
        .border_1().border_color(on ? t[ROLE_COLOR[which]] : t.border).bg(on ? t.selected : t.background)
        .text_size(12.3).text_color(ok ? t.foreground : t.dim)
        .when(ok, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .when(!ok, (el) => el.tooltip(a.custom ? "Needs Codex" : "Not installed"))
        .on_click((_e, cx) => { if (ok) { P.setPrefs({ [which]: a.key }); cx.notify(); } })
        .child(agentIcon(a, 14, t.foreground))
        .child(a.cmd ? "Command" : a.name)
        .when(on, (el) => el.child(svg(I("check")).size(12).text_color(t[ROLE_COLOR[which]])));
    }));
    if (chosen !== P.CMD) return row;
    return v_flex().gap(6).child(row)
      .child(Input.new(this.cmds[which]).h(30).px(9).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12.3).text_color(t.foreground))
      .child(div().text_size(11).text_color(t.dim).child("Runs in the folder in place of an agent. Use an agent Herdr shows a status for (its badge goes working → idle), or the team waits for ever."));
  }

  iconButton(t, id, icon, onClick, enabled) {
    return div().id(id).size(22).flex().items_center().justify_center().rounded(5)
      .text_color(enabled ? t.muted : t.border)
      .when(enabled, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer())
      .on_click(() => { if (enabled) onClick(); })
      .child(svg(I(icon)).size(13));
  }

  button(t, id, label, onClick, { primary = false, enabled = true, icon = null } = {}) {
    return h_flex().id(id).h(30).px(12).gap(6).items_center().flex_none().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(!enabled, (el) => el.opacity(0.45))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(13)))
      .child(label);
  }

  render() {
    const t = theme();
    const { pr } = this.chosen();
    const problem = this.problem();
    const keys = [...new Set([pr.writer, pr.reviewer, ...(pr.team ? [pr.tester, pr.pm] : [])].map((k) => (P.isCustom(k) ? "codex" : k)))];
    const danger = keys.some(isDangerous) || [["writer", pr.writer], ["reviewer", pr.reviewer], ...(pr.team ? [["tester", pr.tester], ["pm", pr.pm]] : [])]
      .some(([role, k]) => k === P.CMD && riskyCommand(pr.commands[role]));
    const setMax = (n) => P.setPrefs({ max: Math.max(1, Math.min(10, n)) });
    const auto = Boolean(pr.auto), lens = Boolean(pr.lens), team = Boolean(pr.team);

    return v_flex().size_full().bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(div().id("np-body").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().gap(14).px(18).pt(16).pb(14)
        .child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center()
            .child(svg(I("pen")).size(15).text_color(t[ROLE_COLOR.writer]))
            .child(div().text_size(14).font_semibold().child(team ? "New team" : "New pair")))
          .child(div().text_size(11.8).text_color(t.dim)
            .child(team ? "A team: the PM plans the task with you; then for each subtask the coder writes, the tester tests, the reviewer checks quality and security, round after round. Nothing is committed."
              : "A writer makes the change and leaves it uncommitted; a reviewer reviews the uncommitted diff, round after round.")))
        .child(v_flex().gap(6)
          .child(this.label(t, "Folder: where the agents work"))
          .child(h_flex().id("folder").h(30).px(10).gap(7).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => cx.spawn(async (cx) => {
              const picked = await pickFolder({ prompt: team ? "Use for the team" : "Use for the pair" });
              if (picked) { this.folder = picked; cx.notify(); }
            }))
            .child(svg(I("folder")).size(13).text_color(t.dim))
            .child(div().flex_none().font_medium().text_color(t.foreground).child(this.folder.replace(/\/+$/, "").split("/").pop() || "/"))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(tilde(this.folder)))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child("Change…"))))
        .child(v_flex().gap(6)
          .child(this.label(t, "Task"))
          .child(Input.new(this.input).h(32).px(9).rounded(7).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
          .child(div().text_size(11).text_color(t.dim).child(team ? "Leave it empty to tell the PM yourself, in its pane." : "Leave it empty to type the task into the writer yourself.")))
        .children((team ? ["pm", "writer", "tester", "reviewer"] : ["writer", "reviewer"]).map((role) => this.roleRow(t, role, team)))
        .child(h_flex().gap(14).items_center().text_size(11.8)
          .child(this.link(t, "np-launch", "terminal", "Launch flags…",
            () => openOverlay({ mod: "coderwriter", kind: "popup", width: 470, height: 486, props: { role: "launch" } })))
          .child(this.link(t, "np-models", "cpu", "Custom models…",
            () => openOverlay({ mod: "coderwriter", kind: "dialog", width: 600, height: 640, props: { role: "models" } }))))
        .child(h_flex().gap(10).items_center()
          .child(this.label(t, "Rounds"))
          .child(h_flex().h(28).px(4).gap(2).items_center().flex_none().rounded(7).border_1().border_color(t.border).bg(t.background)
            .child(this.iconButton(t, "max-minus", "minus", () => setMax(pr.max - 1), pr.max > 1))
            .child(div().px(4).child(String(pr.max)))
            .child(this.iconButton(t, "max-plus", "plus", () => setMax(pr.max + 1), pr.max < 10)))
          .child(div().flex_1())
          .child(h_flex().id("team").h(28).px(9).gap(7).items_center().flex_none().rounded(7)
            .border_1().border_color(team ? t.accent : t.border).bg(team ? t.selected : t.background)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .tooltip("A PM plans the task with you; then, per subtask, each round: the tester writes and runs tests, the test command, the reviewer's quality (Ponytail) and security checks; all failures go to the coder in one note")
            .on_click((_e, cx) => { P.setPrefs({ team: !team }); cx.notify(); })
            .child(svg(I("repeat")).size(13).text_color(team ? t.accent : t.dim))
            .child("Team")
            .when(team, (el) => el.child(svg(I("check")).size(12).text_color(t.accent))))
          .child(h_flex().id("lens").h(28).px(9).gap(7).items_center().flex_none().rounded(7)
            .border_1().border_color(lens ? t.accent : t.border).bg(lens ? t.selected : t.background)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .tooltip("The reviewer follows the ponytail-review skill each round (if installed)")
            .on_click((_e, cx) => { P.setPrefs({ lens: !lens }); cx.notify(); })
            .child(svg(I("glasses")).size(13).text_color(lens ? t.accent : t.dim))
            .child("Ponytail review")
            .when(lens, (el) => el.child(svg(I("check")).size(12).text_color(t.accent))))
          .child(h_flex().id("auto").h(28).px(9).gap(7).items_center().flex_none().rounded(7)
            .border_1().border_color(auto ? t.accent : t.border).bg(auto ? t.selected : t.background)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .tooltip("With a task: write → review → fix, by itself, until approved or out of rounds")
            .on_click((_e, cx) => { P.setPrefs({ auto: !auto }); cx.notify(); })
            .child(svg(I("repeat")).size(13).text_color(auto ? t.accent : t.dim))
            .child("Auto")
            .child(div().w(26).h(15).rounded(8).p(2).flex().items_center().bg(auto ? t.accent : t.border).when(auto, (el) => el.justify_end())
              .child(div().size(11).rounded(6).bg(auto ? t.accent_foreground : t.background)))))
        .when(danger, (el) => el.child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.blocked)
          .child(svg(I("alert")).size(13))
          .child("Launch flags or a command skip permission prompts (Launch flags… above, or the command).")))))
      .child(h_flex().flex_none().gap(8).px(18).py(12).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(problem ? t.blocked : t.dim)
          .child(problem ?? (this.failed ? "Could not check installed agents" : "Esc closes")))
        .child(this.button(t, "cancel", "Cancel", () => closeOverlay(props().overlay)))
        .child(this.button(t, "start", team ? "Start team" : "Start pair", (cx) => this.start(cx), { primary: true, enabled: !problem, icon: "play" })));
  }
}
