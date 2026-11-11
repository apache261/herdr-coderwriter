// coderwriter: a writer agent and a reviewer agent side by side.
// props.role: "bar" (default; the strip above the panes), "reviews" (the side
// panel of review rounds), "usage" (the token usage panel), "launch" (the
// launch-flags popup) or "pick" (the agent dropdown popup,
// props.which = "writer" | "reviewer").
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, spaces, panes, focused, knownAgents, openOverlay, closeOverlay, props, pickFolder, notify, home, shared, setShared, nextCommand, run, window, layout, settings } from "herdr";
import * as P from "./pair.js";
import { Reviews } from "./reviews.js";
import { Launch, isDangerous, customized } from "./launch.js";
import { Usage, usageChip, refreshUsage } from "./usage.js";
import { Models, modelLabel } from "./models.js";

const I = (name) => `mods/coderwriter/icons/${name}.svg`;
const KNOWN = "coderwriter.agents";

function tilde(path) {
  if (!path) return "";
  const h = home();
  return path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

function agentIcon(a, size, color) {
  if (!a?.icon) return div().size(size);
  return a.tint ? svg(a.icon).size(size).flex_none().text_color(color) : image(a.icon).size(size).flex_none();
}

// Claude and Codex as knownAgents() reports them, cached per machine.
function known(machine) { return shared(KNOWN)?.[machine ?? ""] ?? []; }
async function refreshKnown(machine) {
  const list = await knownAgents({ on: machine });
  const ours = list.filter((a) => P.AGENTS.includes(a.key));
  setShared(KNOWN, { ...(shared(KNOWN) ?? {}), [machine ?? ""]: ours });
  return ours;
}

export const ROLE_COLOR = { writer: "ansi4", reviewer: "ansi5" };

// Claude, Codex, or a custom model (which runs Codex, so it's installed when Codex is).
function agentFor(key, list) {
  const m = P.customModel(key);
  if (m) {
    const codex = list.find((a) => a.key === "codex");
    return { key, name: modelLabel(m), icon: I("cpu"), tint: true, installed: codex ? codex.installed : null, custom: m };
  }
  if (P.isCustom(key)) return { key, name: "Removed model", icon: I("cpu"), tint: true, installed: false };
  return list.find((a) => a.key === key) ?? { key, name: key === "claude" ? "Claude Code" : "Codex", icon: `icons/${key}.svg`, tint: false, installed: null };
}
const pickerHeight = () => 112 + 31 * P.prefs().models.length + 40;

class Picker {
  init(_props, cx) {
    const machine = spaces().find((s) => s.active)?.machine ?? null;
    this.machine = machine;
    cx.spawn(async (cx) => { try { await refreshKnown(machine); } catch { this.failed = true; } cx.notify(); });
  }
  render() {
    const t = theme();
    const which = props().which;
    const chosen = P.prefs()[which];
    const list = known(this.machine);
    const rows = [...P.AGENTS, ...P.prefs().models.map((m) => `m:${m.id}`)].map((key) => agentFor(key, list));
    return v_flex().size_full().bg(t.popover).p(5).gap(1).text_size(12.8)
      .child(div().px(9).pt(4).pb(5).text_size(11).text_color(t.dim).child(which === "writer" ? "Writer agent" : "Reviewer agent"))
      .children(rows.map((a) => {
        const ok = a.installed !== false;
        return h_flex().id(`pick-${a.key}`).h(31).px(9).gap(10).rounded(7).items_center()
          .text_color(ok ? t.foreground : t.dim)
          .when(ok, (el) => el.hover((s) => s.bg(t.selected)))
          .on_click(() => { if (!ok) return; P.setPrefs({ [which]: a.key }); closeOverlay(props().overlay); })
          .child(agentIcon(a, 14, t.foreground))
          .child(div().flex_1().child(a.name))
          .child(a.installed === false ? div().text_size(11).text_color(t.dim).child(a.custom ? "needs Codex" : "not installed")
            : chosen === a.key ? svg(I("check")).size(14).text_color(t.accent) : div());
      }))
      .child(div().h(1).mx(6).my(3).bg(t.border))
      .child(h_flex().id("pick-manage").h(31).px(9).gap(10).rounded(7).items_center().text_color(t.muted)
        .hover((s) => s.bg(t.selected).text_color(t.foreground))
        .on_click(() => { closeOverlay(props().overlay); openOverlay({ mod: "coderwriter", kind: "dialog", width: 600, height: 640, props: { role: "models" } }); })
        .child(svg(I("plus")).size(14))
        .child(div().flex_1().child("Custom models…")))
      .when(Boolean(this.failed), (el) => el.child(div().px(9).py(4).text_size(11).text_color(t.dim).child("Could not check installed agents")));
  }
}

class Bar {
  init(_props, cx) {
    this.task = "";
    this.input = InputState.new({ placeholder: "Task for the writer… (Enter starts a pair)" });
    this.input.on("change", (_e, cx) => { this.task = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.folder = null; // null: follow the focused pane's folder
    this.starting = false;
    P.resumeNote();
    const machine = spaces().find((s) => s.active)?.machine ?? null;
    cx.spawn(async (cx) => { try { await refreshKnown(machine); } catch { /* shown on Start */ } cx.notify(); });
    cx.timer.every(15000, () => P.prune());
    // Token usage for the chip (and the Usage panel, which reads the same scan).
    cx.spawn(async (cx) => { await refreshUsage(true); cx.notify(); });
    cx.timer.every(30000, (cx) => { cx.spawn(async (cx) => { await refreshUsage(); cx.notify(); }); });
    // Key commands ("coderwriter.<command>" in keys.json, or herdr-app do).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const p = this.current();
        if (c === "start") this.start(cx);
        else if (c === "task") this.input.focus();
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

  start(cx) {
    if (this.starting) return;
    const space = this.space();
    if (!space) { notify({ title: "coderwriter", body: "Open a space first", level: "warning" }); return; }
    const pr = P.prefs();
    this.starting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let list = known(space.machine);
        try { list = await refreshKnown(space.machine); } catch { /* use the cached list */ }
        const pick = (key) => agentFor(key, list);
        const w = pick(pr.writer), r = pick(pr.reviewer);
        for (const [role, a, key] of [["writer", w, pr.writer], ["reviewer", r, pr.reviewer]]) {
          if (P.isCustom(key) && !a.custom) throw new Error(`The ${role} model was removed: pick another`);
          if (!a || !a.installed) throw new Error(a?.custom ? `The ${role} model ${a.name} runs through Codex, which is not installed on ${space.machine ?? "this computer"}`
            : `The ${role} agent (${key}) is not installed on ${space.machine ?? "this computer"}`);
        }
        const task = this.task.trim();
        this.input.set_value("");
        this.task = "";
        this.starting = false;
        cx.notify();
        await P.start({ space, folder: this.folder ?? this.autoFolder(), task, writer: w, reviewer: r, max: pr.max, auto: pr.auto && Boolean(task) });
      } catch (e) {
        notify({ title: "coderwriter", body: String(e.message ?? e), level: "error" });
      }
      this.starting = false;
      cx.notify();
    });
  }

  chip(t, id, children, onClick, { active = false, enabled = true, title } = {}) {
    return h_flex().id(id).h(28).px(9).gap(6).items_center().flex_none().rounded(7)
      .border_1().border_color(active ? t.accent : t.border).bg(active ? t.selected : t.background)
      .text_size(12.3).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.hover((s) => s.bg(t.hover)).cursor_pointer())
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { if (enabled) onClick(e, cx); })
      .children(children);
  }

  agentChip(t, which) {
    const key = P.prefs()[which];
    const machine = this.space()?.machine ?? null;
    const a = agentFor(key, known(machine));
    const color = t[ROLE_COLOR[which]];
    return this.chip(t, `chip-${which}`, [
      svg(I(which === "writer" ? "pen" : "search")).size(13).text_color(color),
      div().text_color(t.muted).child(which === "writer" ? "Writer" : "Reviewer"),
      agentIcon(a, 14, t.foreground),
      div().font_medium().child(a.name.replace(" Code", "")),
      svg(I("chevron-down")).size(12).text_color(t.dim),
    ], () => openOverlay({ mod: "coderwriter", kind: "popup", width: 250, height: pickerHeight(), props: { role: "pick", which } }));
  }

  // Extra launch flags for the pair's agents: "default" when none, red when one skips permissions.
  launchChip(t) {
    const pr = P.prefs();
    // Custom models run Codex, so Codex's flags are theirs.
    const keys = [...new Set([pr.writer, pr.reviewer].map((k) => (P.isCustom(k) ? "codex" : k)))];
    const danger = keys.some(isDangerous);
    const custom = keys.filter(customized);
    const label = !custom.length ? "default" : custom.map((k) => (k === "claude" ? "Claude" : "Codex")).join(" + ") + " flags";
    return h_flex().id("launch").h(28).px(9).gap(6).items_center().flex_none().rounded(7)
      .border_1().border_color(danger ? t.blocked : custom.length ? t.accent : t.border)
      .bg(danger ? t.blocked + "14" : t.background).text_size(12.3).text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => openOverlay({ mod: "coderwriter", kind: "popup", width: 470, height: 486, props: { role: "launch" } }))
      .child(svg(I(danger ? "alert" : "terminal")).size(13).text_color(danger ? t.blocked : t.dim))
      .child(div().text_color(t.muted).child("Launch"))
      .child(div().max_w(160).truncate().text_color(danger ? t.blocked : custom.length ? t.foreground : t.dim).child(label))
      .child(svg(I("chevron-down")).size(12).text_color(t.dim));
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
    const folder = this.folder ?? this.autoFolder();
    const sep = () => div().w(1).h(22).flex_none().bg(t.border);

    const setup = h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(this.agentChip(t, "writer"))
      .child(this.agentChip(t, "reviewer"))
      .child(this.launchChip(t))
      .child(this.chip(t, "folder", [
        svg(I("folder")).size(13).text_color(this.folder ? t.accent : t.dim),
        div().max_w(170).truncate().text_color(t.muted).child(tilde(folder)),
        ...(this.folder ? [div().id("folder-reset").text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.folder = null; cx.notify(); })
          .child(svg(I("x")).size(11))] : []),
      ], (_e, cx) => cx.spawn(async (cx) => {
        const chosen = await pickFolder({ prompt: "Use for the pair" });
        if (chosen) { this.folder = chosen; cx.notify(); }
      }), { title: "Folder" }))
      .child(Input.new(this.input).flex_1().min_w(120).h(28).px(9).rounded(7).border_1()
        .border_color(this.inputFocused ? t.accent : t.border).bg(t.background).text_size(12.5).text_color(t.foreground))
      .when(!p, (el) => el.child(this.rounds(t, null)).child(this.autoToggle(t, null)))
      .child(this.button(t, "start", "play", this.starting ? "Starting…" : "Start", (cx) => this.start(cx), { primary: true, enabled: !this.starting }))
      .child(usageChip(t));

    const pairGroup = !p ? null : h_flex().flex_none().gap(6).items_center()
      .child(sep())
      .child(h_flex().flex_none().gap(6).items_center().max_w(260)
        .when(busy, (el) => el.child(svg(I("spinner")).size(12).flex_none().text_color(t.working).spin(900)))
        .child(div().truncate().text_size(11.8).text_color(t.muted).child(p.note ?? "")))
      .child(this.verdictPill(t, p) ?? div())
      .child(this.rounds(t, p))
      .child(this.button(t, "to-review", "arrow-right", "Review", () => P.review(p.tab), { enabled: !busy }))
      .child(this.button(t, "to-writer", "arrow-left", "Feedback", () => P.feedback(p.tab), { enabled: !busy && (p.round ?? 0) > 0 }))
      .child(this.autoToggle(t, p))
      .child(this.button(t, "stop", "stop", "Stop", () => P.stop(p.tab), { enabled: busy || Boolean(p.auto) }));

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
      .child(setup)
      .when(Boolean(pairGroup), (el) => el.child(pairGroup))
      .when(Boolean(windowButtons), (el) => el.child(windowButtons));
  }
}

export default class CoderWriter extends View {
  init(initProps, cx) {
    const role = props()?.role;
    this.inner = role === "pick" ? new Picker() : role === "reviews" ? new Reviews() : role === "usage" ? new Usage()
      : role === "launch" ? new Launch() : role === "models" ? new Models() : new Bar();
    this.inner.init(initProps, cx);
  }
  render(cx) { return this.inner.render(cx); }
}
