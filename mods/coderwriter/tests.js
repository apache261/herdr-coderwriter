// The Tests popup: the test command a pair's folder runs before every review (the
// test gate), the last run's result and its output.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, props, exec, readTextFile, home } from "herdr";
import * as P from "./pair.js";

const I = (name) => `mods/coderwriter/icons/${name}.svg`;
const tilde = (path) => {
  const h = home();
  return !path ? "" : path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
};
const join = (folder, rel) => (folder.endsWith("/") ? folder + rel : `${folder}/${rel}`);

// What a folder's files suggest, first match per kind.
const GUESSES = [
  ["package.json", "npm test"],
  ["pyproject.toml", "pytest -q"],
  ["pytest.ini", "pytest -q"],
  ["setup.py", "pytest -q"],
  ["Cargo.toml", "cargo test"],
  ["go.mod", "go test ./..."],
  ["build.gradle.kts", "./gradlew test"],
  ["build.gradle", "./gradlew test"],
  ["pom.xml", "mvn -q test"],
  ["Makefile", "make test"],
];

export class Tests {
  init(_props, cx) {
    this.tab = props()?.tab ?? null;
    this.output = null;  // last run's output, the tail of it
    this.outputKey = null;
    this.guesses = [];
    const p = this.pair();
    this.input = InputState.new({ placeholder: "e.g. pytest -q, npm test, cargo test" });
    this.input.set_value(p ? P.testCommand(p.folder) : "");
    this.input.on("change", (_e, cx) => { const p = this.pair(); if (p) P.setTestCommand(p.folder, this.input.value()); cx.notify(); });
    if (p) cx.spawn(async (cx) => {
      try {
        const r = await exec("ls", ["-1"], { cwd: p.folder, timeout: 5000, ...(p.machine ? { on: p.machine } : {}) });
        const files = new Set((r.stdout ?? "").split("\n").map((l) => l.trim()));
        this.guesses = [...new Set(GUESSES.filter(([f]) => files.has(f)).map(([, c]) => c))];
      } catch { /* no suggestions */ }
      cx.notify();
    });
    cx.timer.every(1500, (cx) => this.loadOutput(cx));
    this.loadOutput(cx);
  }

  pair() { return this.tab ? P.pair(this.tab) : null; }

  loadOutput(cx) {
    const p = this.pair();
    const t = p?.tests;
    const key = t?.file && t.state !== "running" ? `${t.file}@${t.at}` : null;
    if (key === this.outputKey) return;
    this.outputKey = key;
    if (!key) { this.output = null; cx.notify(); return; }
    cx.spawn(async (cx) => {
      let text = null;
      try { text = await readTextFile(join(p.folder, t.file), p.machine ? { on: p.machine } : {}); } catch { text = null; }
      const lines = (text ?? "").replace(/\s+$/, "").split("\n");
      this.output = text == null ? null : (lines.length > 60 ? ["…", ...lines.slice(-60)] : lines).join("\n");
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const p = this.pair();
    if (!p) return v_flex().size_full().bg(t.popover).p(14).text_size(12.5).text_color(t.muted).child("Open a pair's tab to set its tests.");
    const cmd = P.testCommand(p.folder);
    const run = p.tests;
    const busy = P.isBusy(p.tab);
    const ok = t.done ?? t.ansi2;
    const status = !run ? null
      : run.state === "running" ? [svg(I("spinner")).size(12).text_color(t.working).spin(900), "Running…", t.muted]
      : run.state === "pass" ? [svg(I("check")).size(12).text_color(ok), "Passed", ok]
      : [svg(I("x")).size(12).text_color(t.blocked), run.error ? `Did not finish: ${run.error}` : `Failed (exit ${run.code})`, t.blocked];

    const guess = (c) => h_flex().id(`guess-${c}`).h(22).px(7).flex_none().items_center().rounded(6).text_size(11.5)
      .border_1().border_color(c === cmd ? t.accent : t.border).bg(c === cmd ? t.selected : t.background)
      .text_color(t.muted).font_family("JetBrains Mono").hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { this.input.set_value(c); P.setTestCommand(p.folder, c); cx.notify(); })
      .child(c);

    const runButton = h_flex().id("run-tests").h(26).px(9).gap(6).flex_none().items_center().rounded(6).text_size(12).font_medium()
      .border_1().border_color(t.input).bg(t.raised).text_color(t.foreground)
      .when(!cmd || busy, (el) => el.opacity(0.45))
      .when(Boolean(cmd) && !busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_click(() => { if (cmd && !busy) P.testNow(p.tab); })
      .child(svg(I("play")).size(12)).child("Run now");

    return v_flex().size_full().bg(t.popover).text_size(12.5).overflow_hidden()
      .child(v_flex().gap(7).px(12).pt(11).pb(10)
        .child(h_flex().gap(8).items_center()
          .child(svg(I("flask")).size(14).text_color(t.accent))
          .child(div().text_size(12.8).font_semibold().text_color(t.foreground).child("Test gate"))
          .child(div().flex_1().min_w(0).truncate().text_size(11.3).text_color(t.dim).child(tilde(p.folder))))
        .child(Input.new(this.input).h(28).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground).font_family("JetBrains Mono"))
        .when(this.guesses.length > 0, (el) => el.child(h_flex().flex_wrap().gap(5).children(this.guesses.map(guess))))
        .child(div().text_size(11.3).text_color(t.dim).child(cmd
          ? `Runs in the folder before every review. A failure goes to the writer, not the reviewer (Auto tries ${P.TEST_FIX_MAX} times, then pauses).`
          : "No test command: reviews run without a test gate.")))
      .child(div().h(1).bg(t.border))
      .child(h_flex().flex_none().gap(7).px(12).py(8).items_center()
        .child(status ? h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12).text_color(status[2])
          .child(status[0]).child(div().truncate().child(status[1]))
          .when(Boolean(run?.file), (el) => el.child(div().text_size(11).text_color(t.dim).child(run.file)))
          : div().flex_1().text_size(12).text_color(t.dim).child("Not run yet"))
        .child(runButton))
      .child(div().id("tests-out").flex_1().min_h(0).overflow_y_scrollbar().mx(12).mb(12).rounded(6).bg(t.chrome)
        .child(div().px(8).py(6).text_size(11).text_color(t.muted).font_family("JetBrains Mono")
          .child(this.output ?? (run?.state === "running" ? "…" : "The output shows here after a run."))));
  }
}
