// coderwriter: a writer agent and a reviewer agent side by side, or a team.
// props.role: "bar" (default; the strip above the panes), "reviews" (the side
// panel of review rounds), "usage" (the token usage panel), "launch" (the
// launch-flags popup), "models" (custom models), "tests" (the test command popup),
// "new" (the tab bar's + menu), "newpair" (the New pair / New team dialog),
// "audit" (the Audit dialog, props.tab) or "plan" (the PM's Plan dialog, props.tab).
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, spaces, panes, focused, openOverlay, props, notify, home, shared, setShared, nextCommand, run, window, layout, settings } from "herdr";
import * as P from "./pair.js";
import { Reviews } from "./reviews.js";
import { Launch } from "./launch.js";
import { Usage } from "./usage.js";
import { Models } from "./models.js";
import { Tests } from "./tests.js";
import { I, ROLE_COLOR, known, refreshKnown, agentFor } from "./agents.js";
import { NewMenu, NewPair, NEW_PAIR, openNewPair } from "./newpair.js";
import { Audit, AUDIT_REQ } from "./audits.js";
import { Plan, PLAN_REQ } from "./plan.js";

export { ROLE_COLOR };

class Bar {
  init(_props, cx) {
    this.starting = false;
    P.resumeNote();
    const machine = spaces().find((s) => s.active)?.machine ?? null;
    cx.spawn(async (cx) => { try { await refreshKnown(machine); } catch { /* shown on Start */ } cx.notify(); });
    cx.timer.every(15000, () => P.prune());
    // Key commands ("coderwriter.<command>" in keys.json, or herdr-app do).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const p = this.current();
        if (c === "start" || c === "task" || c === "new") openNewPair(); // the dialog holds every setting
        else if (c === "newpair") { const req = shared(NEW_PAIR); setShared(NEW_PAIR, null); if (req) this.start(cx, req); }
        else if (c === "plan") {
          const req = shared(PLAN_REQ); setShared(PLAN_REQ, null);
          if (req?.action === "approve") P.approvePlan(req.tab); else if (req?.action === "revise") P.revisePlan(req.tab, req.text);
        }
        else if (c === "audit") { const req = shared(AUDIT_REQ); setShared(AUDIT_REQ, null); if (req) P.audit(req.tab, req.kinds); }
        else if (c === "team") { P.setPrefs({ team: !P.prefs().team }); notify({ title: "coderwriter", body: `Team mode ${P.prefs().team ? "on" : "off"} for the next pair`, level: "info" }); }
        else if (c === "show-plan" && p) P.askPlan(p.tab);
        else if (c === "show-audit" && p) P.askAudit(p.tab);
        else if (!p) notify({ title: "coderwriter", body: "This tab is not a writer/reviewer pair", level: "info" });
        else if (c === "review") P.review(p.tab);
        else if (c === "feedback") P.feedback(p.tab);
        else if (c === "auto") P.setAuto(p.tab, !p.auto);
        else if (c === "stop") P.stop(p.tab);
        cx.notify();
      }
    });
  }

  space() { return spaces().find((s) => s.active) ?? null; }
  autoFolder() {
    const f = focused();
    const s = this.space();
    return f?.cwd || panes().find((p) => p.focused)?.cwd || s?.folder || home();
  }
  current() {
    const tab = focused()?.tab ?? this.space()?.tabs.find((x) => x.active)?.id;
    return tab ? P.pair(tab) : null;
  }

  // req: { task, folder, worktree } from the New pair dialog (which only leaves the request:
  // it closes, and a pair's jobs outlive it). With worktree, the pair gets a new git worktree
  // and a space of its own there.
  start(cx, req) {
    if (this.starting) return;
    const pr = P.prefs();
    let folder = req.folder || this.autoFolder();
    this.starting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // No space open yet: open one in the pair's folder rather than refusing.
        let space = this.space() ?? await P.openSpace(folder);
        let list = known(space.machine);
        try { list = await refreshKnown(space.machine); } catch { /* use the cached list */ }
        const pick = (key, role) => agentFor(key, list, role);
        const w = pick(pr.writer, "writer"), r = pick(pr.reviewer, "reviewer"), tt = pr.team ? pick(pr.tester, "tester") : null, pm = pr.team ? pick(pr.pm, "pm") : null;
        for (const [role, a, key] of [["writer", w, pr.writer], ["reviewer", r, pr.reviewer], ...(tt ? [["tester", tt, pr.tester], ["PM", pm, pr.pm]] : [])]) {
          if (P.isCustom(key) && !a.custom) throw new Error(`The ${role} model was removed: pick another`);
          if (a?.cmd && !a.command) throw new Error(`The ${role}'s command is empty: type it in New pair…`);
          if (!a || !a.installed) throw new Error(a?.custom ? `The ${role} model ${a.name} runs through Codex, which is not installed on ${space.machine ?? "this computer"}`
            : `The ${role} agent (${key}) is not installed on ${space.machine ?? "this computer"}`);
        }
        const task = (req.task ?? "").trim();
        let worktree = null;
        if (req.worktree) {
          worktree = await P.makeWorktree(folder, space.machine ?? null, task);
          folder = worktree.path;
          space = await P.openSpace(folder, space.machine ?? null);
        }
        this.starting = false;
        cx.notify();
        await P.start({ space, folder, task, writer: w, reviewer: r, tester: tt, pm, max: pr.max, auto: pr.auto && Boolean(task),
          lens: Boolean(pr.lens), team: Boolean(pr.team), worktree, turnLimit: pr.turnLimit ?? 30 });
      } catch (e) {
        notify({ title: "coderwriter", body: String(e.message ?? e), level: "error" });
      }
      this.starting = false;
      cx.notify();
    });
  }

  chip(t, id, children, onClick, { active = false, enabled = true, title, tip } = {}) {
    return h_flex().id(id).h(28).px(9).gap(6).items_center().flex_none().rounded(7)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .border_1().border_color(active ? t.accent : t.border).bg(active ? t.selected : t.background)
      .text_size(12.3).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.hover((s) => s.bg(t.hover)).cursor_pointer())
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { if (enabled) onClick(e, cx); })
      .children(children);
  }

  iconButton(t, id, icon, onClick, enabled = true) {
    return div().id(id).size(22).flex().items_center().justify_center().rounded(5)
      .text_color(enabled ? t.muted : t.border)
      .when(enabled, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { if (enabled) onClick(); })
      .child(svg(I(icon)).size(13));
  }

  button(t, id, icon, label, onClick, { primary = false, enabled = true } = {}) {
    return h_flex().id(id).h(28).px(10).gap(6).items_center().flex_none().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.3).font_medium()
      .when(!enabled, (el) => el.opacity(0.45))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(13)))
      .child(label);
  }

  rounds(t, p) {
    const max = p ? p.max : P.prefs().max;
    const set = (n) => {
      n = Math.max(1, Math.min(10, n));
      if (p) P.update(p.tab, { max: n }); else P.setPrefs({ max: n });
    };
    return h_flex().h(28).px(4).gap(2).items_center().flex_none().rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12.3)
      .child(this.iconButton(t, "max-minus", "minus", () => set(max - 1), max > 1))
      .child(div().px(2).text_color(t.foreground).child(p ? `${p.round ?? 0}/${max}` : `${max} rounds`))
      .child(this.iconButton(t, "max-plus", "plus", () => set(max + 1), max < 10));
  }

  autoToggle(t, p) {
    const on = p ? Boolean(p.auto) : Boolean(P.prefs().auto);
    return this.chip(t, "auto", [
      svg(I("repeat")).size(13).text_color(on ? t.accent : t.dim),
      div().child("Auto"),
      div().w(26).h(15).rounded(8).p(2).flex().items_center().bg(on ? t.accent : t.border).when(on, (el) => el.justify_end())
        .child(div().size(11).rounded(6).bg(on ? t.accent_foreground : t.background)),
    ], () => { if (p) P.setAuto(p.tab, !on); else P.setPrefs({ auto: !on }); }, { active: on });
  }

  // The Ponytail review lens: the pair's own, or the next pair's (icon only in a pair tab).
  lensChip(t, p) {
    const on = p ? Boolean(p.lens) : Boolean(P.prefs().lens);
    return this.chip(t, "lens", [svg(I("glasses")).size(13).text_color(on ? t.accent : t.dim), ...(p ? [] : [div().child("Ponytail")])],
      () => { if (p) P.update(p.tab, { lens: !on }); else P.setPrefs({ lens: !on }); },
      { active: on, tip: `Ponytail review lens ${on ? "on" : "off"}: the reviewer follows the ponytail-review skill each round (if installed)` });
  }

  // The test gate: its last result, and the popup that sets the command.
  testsChip(t, p) {
    const cmd = P.testCommand(p.folder);
    const s = p.tests?.state;
    const ok = t.done ?? t.ansi2;
    const icon = !cmd ? svg(I("flask")).size(13).text_color(t.dim)
      : s === "running" ? svg(I("spinner")).size(13).text_color(t.working).spin(900)
      : s === "pass" ? svg(I("check")).size(13).text_color(ok)
      : s === "fail" ? svg(I("x")).size(13).text_color(t.blocked)
      : svg(I("flask")).size(13).text_color(t.accent);
    return this.chip(t, "tests", [icon, div().text_color(cmd ? t.foreground : t.muted).child("Tests")],
      () => openOverlay({ mod: "coderwriter", kind: "popup", width: 440, height: 360, props: { role: "tests", tab: p.tab } }),
      { tip: cmd ? `Test gate: ${cmd}` : "Set a test command to run before each review", active: s === "fail" });
  }

  // A team's flow, left to right: PM, Coder, then each check of the round, colored by
  // state (working, passed, failed, waiting on you), with the subtask count once a plan runs.
  teamStrip(t, p) {
    const ok = t.done ?? t.ansi2;
    const icons = { tester: "flask", tests: "terminal", quality: "glasses", security: "shield", review: "search", guard: "alert" };
    const checking = ["reviewing", "auditing"].includes(p.phase);
    const res = p.stageResults ?? {};
    const steps = [];
    if (p.roles?.pm) {
      const s = ["planning", "reporting"].includes(p.phase) ? "active" : p.phase === "plan_ready" ? "you"
        : p.plan?.approved ? "pass" : "pending";
      steps.push({ id: "pm", icon: "list", name: "PM", s, tip: { active: p.phase === "reporting" ? "writing the report" : "planning", you: "plan ready: approve it", pass: "plan approved", pending: "" }[s] });
    }
    steps.push({ id: "coder", icon: "pen", name: "Coder", s: ["writing", "fixing"].includes(p.phase) ? "active" : (p.round ?? 0) > 0 || p.phase === "written" ? "pass" : "pending",
      tip: ["writing", "fixing"].includes(p.phase) ? "working" : "" });
    const ids = [...(res.guard ? ["guard"] : []), ...(p.stages ?? []).filter((id) => id !== "tests" || P.testCommand(p.folder))];
    for (const id of ids) {
      const r = res[id];
      const s = checking && p.stage === id ? "active" : r === "pass" ? "pass" : r === "fail" ? "fail" : r ? "unknown" : "pending";
      steps.push({ id, icon: icons[id] ?? "search", name: P.STAGES[id]?.name ?? id, s,
        tip: { active: "checking", pass: `passed round ${p.round}`, fail: `failed round ${p.round}`, unknown: "no result", pending: "" }[s] });
    }
    const color = { active: t.working, pass: ok, fail: t.blocked, you: t.accent, unknown: t.dim, pending: t.dim };
    const plan = p.plan?.approved && !p.plan.done ? `${p.plan.at + 1}/${p.plan.tasks.length}` : null;
    return h_flex().id("team-strip").flex_none().gap(1).items_center()
      .when(Boolean(plan), (el) => el.child(div().pr(5).text_size(11.3).font_semibold().text_color(t.muted).child(plan)))
      .children(steps.flatMap((x, i) => [
        ...(i ? [div().text_size(10).text_color(t.border).child("›")] : []),
        div().id(`ts-${x.id}`).size(22).flex().items_center().justify_center().rounded(6)
          .bg(x.s === "pending" ? t.background : color[x.s] + "22").border_1().border_color(x.s === "pending" ? t.border : color[x.s] + "88")
          .tooltip(x.tip ? `${x.name}: ${x.tip}` : x.name)
          .child(x.s === "active" ? svg(I("spinner")).size(12).text_color(color.active).spin(900) : svg(I(x.icon)).size(12).text_color(color[x.s])),
      ]));
  }

  verdictPill(t, p) {
    if (!p?.verdict) return null;
    const map = { approved: ["Approved", t.done ?? t.ansi2], changes: ["Changes requested", t.blocked], missing: ["No review file", t.dim], unknown: ["No verdict", t.dim] };
    const [label, color] = map[p.verdict] ?? map.unknown;
    return div().flex_none().px(8).h(20).flex().items_center().rounded(6).bg(color + "26").text_color(color).text_size(11.3).font_semibold().child(label);
  }

  render() {
    const t = theme();
    const p = this.current();
    const busy = p ? P.isBusy(p.tab) : false;
    const sep = () => div().w(1).h(22).flex_none().bg(t.border);

    // A pair or team tab: its own controls, the full width. Any other tab: the buttons that
    // start one (the dialog holds every setting: agents, folder, task, rounds, flags).
    const body = p ? h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .when(busy, (el) => el.child(svg(I("spinner")).size(12).flex_none().text_color(t.working).spin(900)))
        .child(div().min_w(0).truncate().text_size(11.8).text_color(t.muted).child(p.note ?? "")))
      .child(p.kind === "team" ? this.teamStrip(t, p) : this.verdictPill(t, p) ?? div())
      .child(this.testsChip(t, p))
      .when(p.kind !== "team", (el) => el.child(this.lensChip(t, p))) // a team's quality check always uses Ponytail
      .child(this.rounds(t, p))
      .child(this.button(t, "to-review", "arrow-right", "Review", () => P.review(p.tab), { enabled: !busy }))
      .child(this.button(t, "to-writer", "arrow-left", "Feedback", () => P.feedback(p.tab), { enabled: !busy && ((p.round ?? 0) > 0 || p.phase === "tests_failed") }))
      .when(Boolean(p.roles?.pm), (el) => el.child(this.button(t, "plan", "list", "Plan", () => P.askPlan(p.tab))))
      .child(this.button(t, "audit", "shield", "Audit", () => P.askAudit(p.tab), { enabled: !busy }))
      .child(this.autoToggle(t, p))
      .child(this.button(t, "stop", "stop", "Stop", () => P.stop(p.tab), { enabled: busy || Boolean(p.auto) }))
      : h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.8).text_color(t.dim)
          .child(this.starting ? "Starting…" : "No pair or team in this tab"))
        .child(this.button(t, "new-pair", "plus", "New pair…", () => { P.setPrefs({ team: false }); openNewPair(); }, { enabled: !this.starting }))
        .child(this.button(t, "new-team", "plus", "New team…", () => { P.setPrefs({ team: true }); openNewPair(); }, { primary: true, enabled: !this.starting }));

    // As the window's top row (props.controls): the window buttons where the system draws
    // none, and room for macOS's traffic lights when the sidebar is too narrow to hold them.
    const controls = Boolean(props()?.controls), w = window();
    const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
    const root = layout(), sidebar = find(root, "sidebar");
    const lights = controls && w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / (settings().zoom ?? 1) - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0)) : 10;
    const winButton = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    const winIcon = (name, size) => svg(`mods/coderwriter-tabs/${name}.svg`).size(size);
    const windowButtons = !(controls && w?.buttons) ? null : h_flex().flex_none().gap(3).items_center().pl(4)
      .child(winButton("minimize", w.platform === "windows" ? winIcon("win-min", 16) : "−", () => run("window.minimize")))
      .child(winButton("maximize", w.platform === "windows" ? winIcon(w.maximized ? "win-restore" : "win-max", 16) : "□", () => run("window.maximize")))
      .child(winButton("close-window", w.platform === "windows" ? winIcon("win-close", 16) : svg("mods/pane/close.svg").size(13), () => run("window.close")));

    return h_flex().id("cw-bar").size_full().min_w(0).px(10).pl(lights).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().flex_none().gap(6).items_center().pr(2)
        .child(svg(I("pen")).size(14).text_color(t[ROLE_COLOR.writer]))
        .child(div().text_size(12.8).font_semibold().text_color(t.foreground).child("coderwriter")))
      .child(sep())
      .child(body)
      .when(Boolean(windowButtons), (el) => el.child(windowButtons));
  }
}

export default class CoderWriter extends View {
  init(initProps, cx) {
    const role = props()?.role;
    this.inner = role === "reviews" ? new Reviews() : role === "usage" ? new Usage()
      : role === "launch" ? new Launch() : role === "models" ? new Models() : role === "tests" ? new Tests()
      : role === "new" ? new NewMenu() : role === "newpair" ? new NewPair() : role === "audit" ? new Audit() : role === "plan" ? new Plan() : new Bar();
    this.inner.init(initProps, cx);
  }
  render(cx) { return this.inner.render(cx); }
}
