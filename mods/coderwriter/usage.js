// Token usage: runs usage.py (Claude Code + Codex session logs) and keeps the
// result in shared("coderwriter.usage"), so the bar's chip and the Usage panel
// read one scan. The bar polls; the panel can ask for a fresh one.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, focused, exec, readTextFile, appHome, home, shared, setShared, run, layout } from "herdr";
import * as P from "./pair.js";

const I = (name) => `mods/coderwriter/icons/${name}.svg`;
export const USAGE = "coderwriter.usage";
const NAMES = { claude: "Claude Code", codex: "Codex" };

let code = null;
let inflight = false;

// Where usage is measured: the shown pair (since it started), else the focused
// pane's folder (since midnight).
export function scope() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const tab = f?.tab ?? space?.tabs.find((x) => x.active)?.id;
  const pair = tab ? P.pair(tab) : null;
  if (pair) return { pair, folder: pair.folder, since: pair.started ?? 0, on: pair.machine ?? null };
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { pair: null, folder: pane?.cwd || f?.cwd || space?.folder || home(), since: 0, on: space?.machine ?? null };
}

export function usage() { return shared(USAGE) ?? null; }

export async function refreshUsage(force = false) {
  if (inflight) return;
  const { folder, since, on } = scope();
  const last = usage();
  if (!force && last && last.folder === folder && last.since_req === since && last.on === on && Date.now() - (last.at ?? 0) < 8000) return;
  inflight = true;
  try {
    code = code ?? (await readTextFile(`${appHome()}/mods/coderwriter/usage.py`));
    if (!code) throw new Error("usage.py is missing");
    // Codex's live limits (what /status shows) cost a codex start: at most every 2 minutes.
    const prevLive = last?.limits?.codex?.source === "live" ? last.limits.codex : null;
    const live = force || !prevLive || Date.now() - (prevLive.at ?? 0) > 120000;
    const r = await exec("python3", ["-c", code, folder ?? "", String(since || 0), live ? "live" : ""], { timeout: 30000, ...(on ? { on } : {}) });
    if (r.code !== 0) throw new Error((r.stderr || "usage scan failed").trim().split("\n").pop());
    const data = JSON.parse(r.stdout);
    // A log snapshot never replaces a newer live reading.
    const got = data.limits?.codex;
    if (prevLive && (!got || (got.source !== "live" && (got.at ?? 0) <= prevLive.at))) data.limits = { ...(data.limits ?? {}), codex: prevLive };
    setShared(USAGE, { ...data, folder, since_req: since, on, at: Date.now(), error: null });
  } catch (e) {
    setShared(USAGE, { ...(last ?? {}), folder, since_req: since, on, at: Date.now(), error: String(e.message ?? e) });
  } finally {
    inflight = false;
  }
}

export function fmt(n) {
  n = n ?? 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}
function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
function until(sec) {
  if (!sec) return "";
  const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
// Reset times as Codex's /status writes them: "14:42", or "14:42 on 18 Nov" when not today.
function resetAt(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${hm} on ${d.getDate()} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]}`;
}
const left = (w) => Math.max(0, Math.min(100, 100 - (w?.used ?? 0)));
const windowName = (min) => (min === 300 ? "5h" : min === 10080 ? "Weekly" : min ? `${Math.round(min / 60)}h` : "");

export function openUsagePanel() {
  const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  if (panel && !panel.hidden && body?.active === "usage") run("layout.hide", { id: "panel" });
  else { run("layout.select", { stack: "panel-body", child: "usage" }); run("layout.show", { id: "panel" }); }
}

// The compact chip in the coderwriter bar: today's tokens (+ Codex's 5h limit).
export function usageChip(t) {
  const u = usage();
  const today = (u?.today?.claude?.total ?? 0) + (u?.today?.codex?.total ?? 0);
  const prim = u?.limits?.codex?.primary;
  const hot = prim && left(prim) <= 20;
  return h_flex().id("usage-chip").h(28).px(9).gap(6).items_center().flex_none().rounded(7)
    .border_1().border_color(t.border).bg(t.background).text_size(12.3).text_color(t.muted)
    .hover((s) => s.bg(t.hover)).cursor_pointer()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(() => openUsagePanel())
    .child(svg(I("gauge")).size(13).text_color(t.dim))
    .child(div().text_color(t.foreground).child(u ? fmt(today) : "…"))
    .child(div().text_color(t.dim).child("today"))
    .when(prim?.used != null, (el) => el.child(div().w(1).h(14).bg(t.border))
      .child(div().text_color(hot ? t.blocked : t.muted).child(`Codex ${Math.round(left(prim))}% left`)));
}

// ---- the panel -----------------------------------------------------------------
export class Usage {
  init(_props, cx) {
    cx.spawn(async (cx) => { await refreshUsage(true); cx.notify(); });
    cx.timer.every(15000, (cx) => { cx.spawn(async (cx) => { await refreshUsage(); cx.notify(); }); });
  }

  breakdown(t, tok) {
    const total = tok?.total ?? 0;
    const parts = [[tok?.input ?? 0, t.ansi4, "input"], [tok?.cached ?? 0, t.ansi6, "cache read"], [tok?.cache_write ?? 0, t.ansi3, "cache write"], [tok?.output ?? 0, t.ansi5, "output"]];
    return v_flex().gap(5)
      .child(h_flex().h(6).w_full().rounded(3).overflow_hidden().bg(t.border)
        .children(parts.filter(([v]) => v > 0).map(([v, c]) => div().h_full().flex_none().bg(c).w(`${(100 * v) / Math.max(total, 1)}%`))))
      .child(h_flex().flex_wrap().gap_x(10).gap_y(2).text_size(11).text_color(t.dim)
        .children(parts.map(([v, c, label]) => h_flex().gap(4).items_center()
          .child(div().size(6).rounded(3).bg(c)).child(`${label} ${fmt(v)}`))));
  }

  card(t, children) {
    return v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.background).children(children);
  }

  title(t, text, right) {
    return h_flex().items_center().gap(6).pt(4)
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(text))
      .when(Boolean(right), (el) => el.child(div().text_size(11).text_color(t.dim).child(right)));
  }

  render(cx) {
    const t = theme();
    const u = usage();
    const sc = scope();
    const stale = !u || u.folder !== sc.folder || u.since_req !== sc.since;
    if (stale) cx.spawn(async (cx) => { await refreshUsage(); cx.notify(); });
    const agentRow = (key, tok) => this.card(t, [
      h_flex().gap(8).items_center()
        .child(image(`icons/${key}.svg`).size(14).flex_none())
        .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(NAMES[key]))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(fmt(tok?.total))),
      this.breakdown(t, tok),
    ]);

    const limitRow = (w) => {
      if (!w || w.used == null) return null;
      const pct = left(w);
      const c = pct <= 10 ? t.blocked : pct <= 30 ? t.ansi3 : t.accent;
      return v_flex().gap(4)
        .child(h_flex().text_size(11.8).text_color(t.muted)
          .child(div().flex_1().child(`${windowName(w.minutes)} limit`))
          .child(div().text_color(t.foreground).child(`${Math.round(pct)}% left`))
          .child(div().pl(6).text_color(t.dim).child(w.resets_at ? `resets ${resetAt(w.resets_at)}` : "")))
        .child(div().h(6).w_full().rounded(3).bg(t.border).child(div().h_full().rounded(3).bg(c).w(`${pct}%`)));
    };

    const sessions = (u && !stale ? u.sessions : []) ?? [];
    const writerKey = sc.pair?.writer?.agent, reviewerKey = sc.pair?.reviewer?.agent;
    const role = (s) => !sc.pair ? null : s.agent === writerKey && s.agent === reviewerKey ? null : s.agent === writerKey ? "writer" : s.agent === reviewerKey ? "reviewer" : null;
    const sessionRow = (s) => {
      const r = role(s);
      const ctx = s.window ? `${fmt(s.context)} / ${fmt(s.window)} context` : `${fmt(s.context)} context`;
      return this.card(t, [
        h_flex().gap(7).items_center()
          .child(image(`icons/${s.agent}.svg`).size(14).flex_none())
          .child(div().text_size(12.3).text_color(t.foreground).child(NAMES[s.agent]))
          .when(Boolean(r), (el) => el.child(div().px(5).h(16).flex().items_center().rounded(4).text_size(10.3).font_semibold()
            .bg(t[r === "writer" ? "ansi4" : "ansi5"] + "26").text_color(t[r === "writer" ? "ansi4" : "ansi5"]).child(r.toUpperCase())))
          .child(div().flex_1())
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(fmt(s.tokens?.total))),
        h_flex().gap(8).text_size(11).text_color(t.dim)
          .child(div().truncate().child(s.model ?? ""))
          .child(div().flex_1())
          .child(div().flex_none().child(ctx))
          .child(div().flex_none().child(ago(s.last))),
        this.breakdown(t, s.tokens),
      ]);
    };

    const scopeLabel = sc.pair ? "This pair (since it started)" : "This folder (today)";
    const codexLimits = u?.limits?.codex;

    return v_flex().size_full().min_w(0).bg(t.background).rounded(10).border_1().border_color(t.border).overflow_hidden()
      .child(v_flex().flex_none().gap(3).px(12).pt(10).pb(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(7).items_center()
          .child(svg(I("gauge")).size(14).text_color(t.accent))
          .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("Usage"))
          .child(div().id("us-refresh").size(22).flex().items_center().justify_center().rounded(5).text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => cx.spawn(async (cx) => { await refreshUsage(true); cx.notify(); }))
            .child(svg(I("repeat")).size(12))))
        .child(div().text_size(11.3).text_color(t.dim).truncate()
          .child(u?.error ? `Couldn't read usage: ${u.error}` : u ? `Tokens from the agents' local session logs · updated ${ago(u.at)}` : "Reading session logs…")))
      .child(div().id("us-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().gap(8).p(10)
          .child(this.title(t, scopeLabel.toUpperCase(), sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : null))
          .children(sessions.length ? sessions.map(sessionRow)
            : [div().px(2).text_size(11.8).text_color(t.dim).child(stale ? "Loading…" : "No Claude Code or Codex activity here yet.")])
          .child(this.title(t, "TODAY · ALL FOLDERS", u ? fmt((u.today?.claude?.total ?? 0) + (u.today?.codex?.total ?? 0)) : null))
          .child(agentRow("claude", u?.today?.claude))
          .child(agentRow("codex", u?.today?.codex))
          .when(Boolean(codexLimits?.primary || codexLimits?.secondary), (el) => el
            .child(this.title(t, `CODEX LIMITS${codexLimits?.plan ? " · " + String(codexLimits.plan).toUpperCase() : ""}`,
              codexLimits?.at ? `${codexLimits.source === "live" ? "live" : "from logs"} · ${ago(codexLimits.at)}` : null))
            .child(this.card(t, [limitRow(codexLimits.primary), limitRow(codexLimits.secondary)].filter(Boolean))))
          .child(div().px(2).pt(2).text_size(10.8).text_color(t.dim)
            .child("Totals include cached input, which most plans bill at a discount. Claude plan limits aren't in its local logs; use /usage in Claude Code."))));
  }
}
