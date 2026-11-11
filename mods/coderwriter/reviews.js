// The Reviews side panel: the reviewer's rounds (.coderwriter/review-<n>.md) for
// the shown pair, or for the focused pane's folder when the tab isn't a pair.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme, spaces, panes, focused, exec, readTextFile, home } from "herdr";
import * as P from "./pair.js";

const I = (name) => `mods/coderwriter/icons/${name}.svg`;

function tilde(path) {
  if (!path) return "";
  const h = home();
  return path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}
const join = (folder, rel) => (folder.endsWith("/") ? folder + rel : `${folder}/${rel}`);

function verdictOf(text) {
  const m = /VERDICT:\s*(APPROVED|CHANGES[_ ]REQUESTED)/i.exec(text ?? "");
  return !m ? "unknown" : /^APPROVED$/i.test(m[1]) ? "approved" : "changes";
}

export class Reviews {
  init(_props, cx) {
    this.key = null;      // which folder/machine the list is for
    this.rounds = [];     // [{ n, text, verdict }]
    this.selected = null; // round number, null: the latest
    this.confirm = null;  // the restore asked for once (a second click does it)
    this.loading = false;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
  }

  where() {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const tab = f?.tab ?? space?.tabs.find((x) => x.active)?.id;
    const pair = tab ? P.pair(tab) : null;
    if (pair) return { pair, folder: pair.folder, on: pair.machine ?? null };
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { pair: null, folder: pane?.cwd || f?.cwd || space?.folder || null, on: space?.machine ?? null };
  }

  refresh(cx) {
    if (this.loading) return;
    const { folder, on } = this.where();
    const key = JSON.stringify([folder, on]);
    if (key !== this.key) { this.key = key; this.rounds = []; this.selected = null; }
    if (!folder) { cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const opts = on ? { on } : {};
        const r = await exec("sh", ["-c", `ls -1 ${P.REVIEW_DIR} 2>/dev/null`], { cwd: folder, timeout: 5000, ...opts });
        const nums = (r.stdout ?? "").split("\n").map((l) => /^review-(\d+)\.md$/.exec(l.trim())?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
        const rounds = [];
        for (const n of nums) {
          let text = null;
          try { text = await readTextFile(join(folder, `${P.REVIEW_DIR}/review-${n}.md`), opts); } catch { text = null; }
          if (text != null) rounds.push({ n, text, verdict: verdictOf(text) });
        }
        if (this.key === key) this.rounds = rounds;
      } catch { /* folder gone or machine away: keep what we had */ }
      this.loading = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const { pair, folder } = this.where();
    const key = JSON.stringify([folder, pair?.machine ?? spaces().find((s) => s.active)?.machine ?? null]);
    if (key !== this.key && !this.loading) this.refresh(cx);
    const color = { approved: t.ansi2, changes: t.blocked, unknown: t.dim };
    const label = { approved: "Approved", changes: "Changes requested", unknown: "No verdict" };
    const current = this.rounds.find((r) => r.n === this.selected) ?? this.rounds[this.rounds.length - 1] ?? null;

    const header = v_flex().flex_none().gap(4).px(12).pt(10).pb(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(7).items_center()
        .child(svg(I("search")).size(14).text_color(t.ansi5))
        .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("Reviews"))
        .child(div().id("rv-refresh").size(22).flex().items_center().justify_center().rounded(5).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.refresh(cx))
          .child(svg(I("repeat")).size(12))))
      .child(div().text_size(11.3).text_color(t.dim).truncate()
        .child(pair ? `${pair.writer?.name ?? "Writer"} → ${pair.reviewer?.name ?? "Reviewer"} · round ${pair.round ?? 0}/${pair.max}` : tilde(folder ?? "No folder")))
      .when(Boolean(pair?.note), (el) => el.child(h_flex().gap(6).items_center().text_size(11.3).text_color(t.muted)
        .when(P.isBusy(pair.tab), (el) => el.child(svg(I("spinner")).size(11).flex_none().text_color(t.working).spin(900)))
        .child(div().truncate().child(pair.note))));

    const chips = this.rounds.length < 2 ? null : h_flex().id("rv-rounds").flex_none().flex_wrap().gap(4).px(10).py(7).border_b(1).border_color(t.border)
      .children(this.rounds.map((r) => {
        const on = current?.n === r.n;
        return h_flex().id(`rv-${r.n}`).h(24).px(8).gap(5).flex_none().items_center().rounded(6).text_size(11.8)
          .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
          .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => { this.selected = r.n; this.confirm = null; cx.notify(); })
          .child(div().size(6).rounded(3).bg(color[r.verdict]))
          .child(`Round ${r.n}`);
      }));

    const empty = (title, body) => v_flex().flex_1().items_center().justify_center().gap(6).px(24).text_center()
      .child(svg(I("search")).size(22).text_color(t.border))
      .child(div().text_size(12.8).text_color(t.muted).child(title))
      .child(div().text_size(11.5).text_color(t.dim).child(body));

    // Restore: back to the files this round reviewed (or the start), undoable.
    const busy = pair ? P.isBusy(pair.tab) : false;
    const restoreButton = (n, label) => {
      const asked = this.confirm === n;
      return h_flex().id(`rv-restore-${n}`).h(22).px(7).gap(5).flex_none().items_center().rounded(6).text_size(11.3)
        .border_1().border_color(asked ? t.blocked : t.border).bg(asked ? t.blocked + "1f" : t.background)
        .text_color(asked ? t.blocked : t.muted)
        .when(busy, (el) => el.opacity(0.45))
        .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(asked ? t.blocked : t.foreground)))
        .on_click((_e, cx) => {
          if (busy) return;
          if (!asked) { this.confirm = n; cx.notify(); return; }
          this.confirm = null;
          P.restore(pair.tab, n);
          cx.notify();
        })
        .child(svg(I("restore")).size(11))
        .child(asked ? "Click again: replaces the files" : label);
    };
    const undoBar = !pair?.undo ? null : h_flex().flex_none().gap(8).px(12).py(6).items_center().border_b(1).border_color(t.border)
      .bg(t.selected).text_size(11.5).text_color(t.muted)
      .child(svg(I("restore")).size(12).flex_none().text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().child(`Files restored to ${pair.restored ?? "a snapshot"}`))
      .child(div().id("rv-undo").text_color(busy ? t.dim : t.accent).when(!busy, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)))
        .on_click(() => { if (!busy) P.undoRestore(pair.tab); }).child("Undo"));
    const cps = pair?.checkpoints ?? {};
    const prev = current ? this.rounds.find((r) => r.n === current.n - 1) : null;
    const repeats = current && prev && current.verdict === "changes" ? P.repeatedFindings(prev.text, current.text) : [];

    let content;
    if (!folder) content = empty("No folder", "Focus a terminal to see its reviews.");
    else if (!current) content = empty(this.loading ? "Looking for reviews…" : "No reviews yet",
      pair ? "Press Review in the bar above once the writer is done." : "Start a writer/reviewer pair from the bar above; each review round shows here.");
    else content = v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(12).pt(9).pb(3).gap(8).items_center()
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`Round ${current.n}`))
        .child(div().px(7).h(18).flex().items_center().rounded(5).bg(color[current.verdict] + "26").text_color(color[current.verdict]).text_size(11).font_semibold().child(label[current.verdict]))
        .child(div().flex_1())
        .when(Boolean(cps[current.n]), (el) => el.child(restoreButton(current.n, `Restore round ${current.n}`))))
      .when(repeats.length > 0, (el) => el.child(v_flex().flex_none().mx(12).mt(5).mb(2).px(9).py(6).gap(3).rounded(6)
        .bg(t.blocked + "14").border_1().border_color(t.blocked + "55").text_size(11.5)
        .child(h_flex().gap(6).items_center().text_color(t.blocked).font_semibold()
          .child(svg(I("alert")).size(12))
          .child(`${repeats.length} finding${repeats.length === 1 ? "" : "s"} repeated from round ${current.n - 1}`))
        .children(repeats.map((f) => div().text_color(t.muted).truncate().child(`• ${f}`)))))
      .child(div().id("rv-body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(div().px(12).pb(12).text_size(12.5).text_color(t.foreground)
          .child(TextView.markdown(`rv-md-${current.n}`, current.text).selectable(true))));

    return v_flex().size_full().min_w(0).bg(t.background).rounded(10).border_1().border_color(t.border).overflow_hidden()
      .child(header)
      .when(Boolean(undoBar), (el) => el.child(undoBar))
      .when(Boolean(chips), (el) => el.child(chips))
      .when(Boolean(cps[0]) && !pair?.undo, (el) => el.child(h_flex().flex_none().px(10).pt(7).gap(6).items_center()
        .child(div().flex_1().text_size(11.3).text_color(t.dim).child("Snapshots are kept each round"))
        .child(restoreButton(0, "Restore the start"))))
      .child(content);
  }
}
