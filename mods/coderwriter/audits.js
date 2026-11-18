// The Audit dialog (role "audit", props.tab): asked when a round is approved, or from
// the bar's Audit button. It offers Cloudflare's security audit and Ponytail's code audit,
// each only when its skill is installed (else it shows how to install it). Like New
// pair, it doesn't run the audit itself: it leaves the answer in shared(AUDIT_REQ) and
// sends "coderwriter.audit" to the bar, which outlives the dialog.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme, closeOverlay, props, run, setShared } from "herdr";
import * as P from "./pair.js";
import { I, tilde } from "./agents.js";

export const AUDIT_REQ = "coderwriter.auditRequest";

export class Audit {
  init(_props, cx) {
    this.tab = props().tab;
    this.picked = new Set(); // nothing runs unless asked for
    this.found = null;       // { security, ponytail }: SKILL.md paths, null while looking
    const p = P.pair(this.tab);
    cx.spawn(async (cx) => { this.found = p ? await P.findSkills(p.folder, p.machine) : {}; cx.notify(); });
  }

  run() {
    setShared(AUDIT_REQ, { tab: this.tab, kinds: P.AUDITS.filter((k) => this.picked.has(k)), at: Date.now() });
    run("coderwriter.audit");
    closeOverlay(props().overlay);
  }

  option(t, k) {
    const s = P.SKILLS[k], path = this.found?.[k], on = this.picked.has(k) && Boolean(path);
    return h_flex().id(`audit-${k}`).gap(10).px(11).py(9).items_start().rounded(8)
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
      .when(Boolean(path), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)))
      .on_click((_e, cx) => { if (!path) return; on ? this.picked.delete(k) : this.picked.add(k); cx.notify(); })
      .child(div().mt(1).size(16).flex_none().flex().items_center().justify_center().rounded(4)
        .border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
        .when(on, (el) => el.child(svg(I("check")).size(12).text_color(t.accent_foreground))))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(7).items_center()
          .child(svg(I(k === "security" ? "shield" : "glasses")).size(13).text_color(t.muted))
          .child(div().font_medium().child(s.name))
          .child(div().text_size(11.3).text_color(t.dim).child(s.by)))
        .child(this.found === null ? div().text_size(11.3).text_color(t.dim).child("Looking for the skill…")
          : path ? div().text_size(11.3).text_color(t.dim).truncate().child(tilde(path))
          : v_flex().gap(3)
            .child(h_flex().gap(5).items_center().text_size(11.3).text_color(t.blocked)
              .child(svg(I("alert")).size(12)).child(`Not installed (${s.skill}). To install:`))
            .child(div().text_size(11.3).text_color(t.muted).child(TextView.markdown(`audit-install-${k}`, "`" + s.install + "`").selectable(true)))));
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
    const any = P.AUDITS.some((k) => this.picked.has(k) && this.found?.[k]);
    const approved = p?.verdict === "approved";
    return v_flex().size_full().bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(v_flex().flex_1().min_h(0).gap(12).px(18).pt(16).pb(14)
        .child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center()
            .child(svg(I("shield")).size(15).text_color(t.accent))
            .child(div().text_size(14).font_semibold().child(approved ? `Approved in round ${p.round}: audit it too?` : "Audit the code?")))
          .child(div().text_size(11.8).text_color(t.dim)
            .child(`The reviewer${p?.reviewer?.name ? ` (${p.reviewer.name})` : ""} audits the whole repository, starting with the files this change touches, ` +
              "and writes one review round. Audits take much longer than a review; findings go to the writer with Feedback.")))
        .child(p ? v_flex().gap(8).child(this.option(t, "security")).child(this.option(t, "ponytail"))
          : div().text_color(t.dim).child("This pair is gone.")))
      .child(h_flex().flex_none().gap(8).px(18).py(12).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child("Esc closes"))
        .child(this.button(t, "audit-skip", "Not now", () => closeOverlay(props().overlay)))
        .child(this.button(t, "audit-run", "Run audit", () => this.run(), { primary: true, enabled: any && Boolean(p), icon: "play" })));
  }
}
