// The Plan dialog (role "plan", props.tab): the PM's .coderwriter/plan.md, a box to ask
// the PM for changes, and Approve & start. Like the other dialogs it doesn't act itself:
// it leaves the answer in shared(PLAN_REQ) and sends "coderwriter.plan" to the bar.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextView } from "gpui-base";
import { theme, closeOverlay, props, run, setShared, readTextFile } from "herdr";
import * as P from "./pair.js";
import { I, ROLE_COLOR } from "./agents.js";

export const PLAN_REQ = "coderwriter.planRequest";
const join = (folder, rel) => (folder.endsWith("/") ? folder + rel : `${folder}/${rel}`);

export class Plan {
  init(_props, cx) {
    this.tab = props().tab;
    this.text = null;
    this.loaded = false;
    this.input = InputState.new({ placeholder: "What should the PM change? (Enter sends)" });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", () => this.send("revise"));
    this.load(cx);
    cx.timer.every(3000, (cx) => this.load(cx)); // the PM may still be writing it
  }

  load(cx) {
    const p = P.pair(this.tab);
    if (!p) return;
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(join(p.folder, P.PLAN), p.machine ? { on: p.machine } : {}); } catch { text = null; }
      if (text !== this.text || !this.loaded) { this.text = text; this.loaded = true; cx.notify(); }
    });
  }

  send(action) {
    const text = this.input.value().trim();
    if (action === "revise" && !text) return;
    setShared(PLAN_REQ, { tab: this.tab, action, text, at: Date.now() });
    run("coderwriter.plan");
    closeOverlay(props().overlay);
  }

  button(t, id, label, onClick, { primary = false, enabled = true, icon = null } = {}) {
    return h_flex().id(id).h(30).px(12).gap(6).items_center().flex_none().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(!enabled, (el) => el.opacity(0.45))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_click(() => { if (enabled) onClick(); })
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(13)))
      .child(label);
  }

  render() {
    const t = theme();
    const p = P.pair(this.tab);
    const tasks = P.planTasks(this.text);
    const running = Boolean(p?.plan?.approved && !p.plan.done);
    const status = !p ? "This team is gone."
      : running ? (p.plan.final ? "Every subtask approved: final check of the whole change"
        : `Approved and running: subtask ${p.plan.at + 1} of ${p.plan.tasks.length}`)
      : p.plan?.done ? "Done: every subtask was approved"
      : this.text == null ? (this.loaded ? "The PM hasn't written the plan yet" : "Reading the plan…")
      : tasks.length ? `${tasks.length} subtask${tasks.length === 1 ? "" : "s"}: approve to start the team (Auto)`
      : 'No subtasks found: they are "## 1. Title" headings. Ask the PM to fix it.';
    const canApprove = Boolean(p) && !running && !p?.plan?.done && tasks.length > 0;
    const canRevise = Boolean(p) && !running && !p?.plan?.done && this.input.value().trim().length > 0;
    const canNudge = Boolean(p) && !running && !p?.plan?.done && tasks.length === 0;

    return v_flex().size_full().bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(v_flex().flex_none().gap(4).px(18).pt(16).pb(10).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(svg(I("list")).size(15).text_color(t[ROLE_COLOR.pm]))
          .child(div().text_size(14).font_semibold().child("The PM's plan")))
        .child(div().text_size(11.8).text_color(running || canApprove ? t.dim : t.blocked).child(status)))
      .child(div().id("plan-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().px(18).py(10).text_size(12.5)
          .child(this.text == null ? div().text_color(t.dim).child(`Waiting for ${P.PLAN}. If the PM asked you something, answer it in the PM pane.`)
            : TextView.markdown("plan-md", this.text).selectable(true))))
      .when(!running && !p?.plan?.done, (el) => el.child(h_flex().flex_none().gap(8).px(18).pt(10).items_center().border_t(1).border_color(t.border)
        .child(Input.new(this.input).flex_1().h(30).px(9).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(this.button(t, "plan-revise", "Ask PM to change", () => this.send("revise"), { enabled: canRevise }))))
      .child(h_flex().flex_none().gap(8).px(18).py(12).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`You can also edit ${P.PLAN} yourself · Esc closes`))
        .child(this.button(t, "plan-close", "Close", () => closeOverlay(props().overlay)))
        .when(canNudge, (el) => el.child(this.button(t, "plan-nudge", "Tell PM to write plan", () => this.send("nudge"), { icon: "list" })))
        .child(this.button(t, "plan-approve", "Approve & start", () => this.send("approve"), { primary: true, enabled: canApprove, icon: "play" })));
  }
}
