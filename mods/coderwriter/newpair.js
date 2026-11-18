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
import { I, ROLE_COLOR, tilde, agentIcon, known, refreshKnown, agentFor, allAgents } from "./agents.js";

export const NEW_PAIR = "coderwriter.newPairRequest";

const activeSpace = () => spaces().find((s) => s.active) ?? null;
const shortName = (a) => a.name.replace(" Code", "");

export function openNewPair() {
  openOverlay({ mod: "coderwriter", kind: "dialog", width: 540, height: 590, props: { role: "newpair" } });
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
    const w = agentFor(pr.writer, list), r = agentFor(pr.reviewer, list);
    return v_flex().size_full().bg(t.popover).p(5).gap(1).text_size(12.8)
      .child(div().px(9).pt(4).pb(4).text_size(11).text_color(t.dim).child("Pair coding"))
      .child(this.row(t, "new-pair", svg(I("pen")).size(14).text_color(t[ROLE_COLOR.writer]), "New pair…", `${shortName(w)} → ${shortName(r)}`, openNewPair))
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
    this.input = InputState.new({ placeholder: "What should the writer do?" });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.input.focus();
    cx.timer.after(50, () => this.input.focus());
    cx.spawn(async (cx) => { try { await refreshKnown(this.machine); } catch { this.failed = true; } cx.notify(); });
  }

  chosen() {
    const pr = P.prefs(), list = known(this.machine);
    return { pr, w: agentFor(pr.writer, list), r: agentFor(pr.reviewer, list), tt: pr.team ? agentFor(pr.tester, list) : null };
  }

  problem() {
    const { w, r, tt } = this.chosen();
    for (const [role, a] of [["writer", w], ["reviewer", r], ...(tt ? [["tester", tt]] : [])]) {
      if (a.installed === false) return a.custom ? `The ${role} model runs through Codex, which is not installed` : `The ${role} agent (${a.name}) is not installed`;
    }
    return null;
  }

  start(cx) {
    if (this.problem()) { cx.notify(); return; }
    setShared(NEW_PAIR, { task: this.input.value(), folder: this.folder, at: Date.now() });
    run("coderwriter.newpair");
    closeOverlay(props().overlay);
  }

  label(t, text) { return div().text_size(11.5).font_medium().text_color(t.muted).child(text); }

  // One row of agents to choose from for a role.
  agents(t, which) {
    const chosen = P.prefs()[which];
    return h_flex().flex_wrap().gap(6).children(allAgents(known(this.machine)).map((a) => {
      const on = a.key === chosen, ok = a.installed !== false;
      return h_flex().id(`${which}-${a.key}`).h(30).px(10).gap(7).items_center().flex_none().rounded(7)
        .border_1().border_color(on ? t[ROLE_COLOR[which]] : t.border).bg(on ? t.selected : t.background)
        .text_size(12.3).text_color(ok ? t.foreground : t.dim)
        .when(ok, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .when(!ok, (el) => el.tooltip(a.custom ? "Needs Codex" : "Not installed"))
        .on_click((_e, cx) => { if (ok) { P.setPrefs({ [which]: a.key }); cx.notify(); } })
        .child(agentIcon(a, 14, t.foreground))
        .child(a.name)
        .when(on, (el) => el.child(svg(I("check")).size(12).text_color(t[ROLE_COLOR[which]])));
    }));
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
    const keys = [...new Set([pr.writer, pr.reviewer, ...(pr.team ? [pr.tester] : [])].map((k) => (P.isCustom(k) ? "codex" : k)))];
    const danger = keys.some(isDangerous);
    const setMax = (n) => P.setPrefs({ max: Math.max(1, Math.min(10, n)) });
    const auto = Boolean(pr.auto), lens = Boolean(pr.lens), team = Boolean(pr.team);

    return v_flex().size_full().bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(v_flex().flex_1().min_h(0).gap(14).px(18).pt(16).pb(14)
        .child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center()
            .child(svg(I("pen")).size(15).text_color(t[ROLE_COLOR.writer]))
            .child(div().text_size(14).font_semibold().child("New pair")))
          .child(div().text_size(11.8).text_color(t.dim)
            .child("A writer makes the change and leaves it uncommitted; a reviewer reviews the uncommitted diff, round after round.")))
        .child(v_flex().gap(6)
          .child(this.label(t, "Task"))
          .child(Input.new(this.input).h(32).px(9).rounded(7).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
          .child(div().text_size(11).text_color(t.dim).child("Leave it empty to type the task into the writer yourself.")))
        .child(v_flex().gap(6).child(h_flex().gap(6).items_center()
          .child(svg(I("pen")).size(12).text_color(t[ROLE_COLOR.writer])).child(this.label(t, "Writer")))
          .child(this.agents(t, "writer")))
        .child(v_flex().gap(6).child(h_flex().gap(6).items_center()
          .child(svg(I("search")).size(12).text_color(t[ROLE_COLOR.reviewer])).child(this.label(t, "Reviewer")))
          .child(this.agents(t, "reviewer")))
        .when(team, (el) => el.child(v_flex().gap(6).child(h_flex().gap(6).items_center()
          .child(svg(I("flask")).size(12).text_color(t[ROLE_COLOR.tester])).child(this.label(t, "Tester")))
          .child(this.agents(t, "tester"))))
        .child(v_flex().gap(6)
          .child(this.label(t, "Folder"))
          .child(h_flex().id("folder").h(30).px(10).gap(7).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => cx.spawn(async (cx) => {
              const picked = await pickFolder({ prompt: "Use for the pair" });
              if (picked) { this.folder = picked; cx.notify(); }
            }))
            .child(svg(I("folder")).size(13).text_color(t.dim))
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(tilde(this.folder)))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child("Change…"))))
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
            .tooltip("A tester agent writes and runs the tests, then the test command and the reviewer; all failures go to the writer in one note")
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
          .child("Launch flags skip permission prompts for these agents (change them in the bar's Launch chip)."))))
      .child(h_flex().flex_none().gap(8).px(18).py(12).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(problem ? t.blocked : t.dim)
          .child(problem ?? (this.failed ? "Could not check installed agents" : "Esc closes")))
        .child(this.button(t, "cancel", "Cancel", () => closeOverlay(props().overlay)))
        .child(this.button(t, "start", "Start pair", (cx) => this.start(cx), { primary: true, enabled: !problem, icon: "play" })));
  }
}
