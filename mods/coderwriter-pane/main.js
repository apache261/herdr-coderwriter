// coderwriter's pane header (a clone of Herdr's `pane`). A terminal labelled
// coderwriter.role=writer|reviewer gets a colored role chip (WRITER / REVIEWER),
// a tinted header and a status badge for every agent status; any other pane
// looks like Herdr's own header. Props from the app: { pane, terminal }.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, terminals, shared } from "herdr";

const ROLE = {
  writer: { label: "WRITER", icon: "mods/coderwriter/icons/pen.svg", color: "ansi4" },
  reviewer: { label: "REVIEWER", icon: "mods/coderwriter/icons/search.svg", color: "ansi5" },
};
const STATUS = { working: "working", blocked: "needs you", done: "done", idle: "idle" };

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/coderwriter-pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    const term = p.terminal ? terminals().find((x) => x.address === p.terminal) : null;
    const role = ROLE[term?.labels?.["coderwriter.role"]];
    const pairId = term?.labels?.["coderwriter.pair"];
    const pair = pairId ? Object.values(shared("coderwriter.pairs") ?? {}).find((x) => x.tab === pairId || x.tab?.endsWith("/" + pairId)) : null;
    const tint = role ? t[role.color] : null;
    const badge = (color, text, spin) => h_flex().flex_none().gap(5).px(7).h(18).items_center().rounded(5).bg(color + "26")
      .text_size(10.5).font_semibold().text_color(color)
      .when(spin, el => el.child(svg("mods/coderwriter/icons/spinner.svg").size(10).text_color(color).spin(900)))
      .when(!spin, el => el.child(div().size(6).rounded(3).bg(color)))
      .child(text);
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(role ? tint + "14" : t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(role ? tint + "66" : t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(role), el => el.child(h_flex().flex_none().gap(5).px(7).h(20).items_center().rounded(5).bg(tint).text_color(t.background)
        .text_size(10.5).font_bold().child(svg(role.icon).size(11)).child(role.label)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(role && pair?.round), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`round ${pair.round}/${pair.max}`)))
      .when(Boolean(role), el => el.child(st ? badge(t[st] ?? t.dim, STATUS[st] ?? st, st === "working") : badge(t.dim, "starting", false)))
      .when(!role && st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(!role && st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(!role && st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
