// Custom models: OpenAI-compatible endpoints run through Codex (its model_providers),
// usable as writer or reviewer. A dialog lists them and edits one; Test checks that
// the endpoint answers and serves the Responses API Codex needs.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, exec, readTextFile, writeTextFile, appHome, notify } from "herdr";
import * as P from "./pair.js";

const I = (name) => `mods/coderwriter/icons/${name}.svg`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Common OpenAI-compatible endpoints (each must serve /responses for Codex).
const PRESETS = [
  { label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key: "env", env: "OPENROUTER_API_KEY" },
  { label: "OpenAI", base_url: "https://api.openai.com/v1", key: "env", env: "OPENAI_API_KEY" },
  { label: "Ollama", base_url: "http://localhost:11434/v1", key: "none" },
  { label: "LM Studio", base_url: "http://localhost:1234/v1", key: "none" },
  { label: "LiteLLM", base_url: "http://localhost:4000/v1", key: "env", env: "LITELLM_API_KEY" },
  { label: "vLLM", base_url: "http://localhost:8000/v1", key: "none" },
];

function newId() {
  let s = "";
  for (let i = 0; i < 8; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}
const host = (url) => { try { return String(url).replace(/^https?:\/\//, "").split("/")[0]; } catch { return url; } };

export function modelLabel(m) { return m?.name || m?.model || "Custom model"; }

// Save a pasted key: a 700 folder, a 600 file, outside Herdr's folder (never shared or committed).
async function saveKey(m, key) {
  const dir = P.keyDir(), file = P.keyFile(m);
  const r = await exec("sh", ["-c", 'umask 077; mkdir -p "$1" && chmod 700 "$1" && : > "$2" && chmod 600 "$2"', "sh", dir, file]);
  if (r.code !== 0) throw new Error((r.stderr || "could not create the key file").trim());
  await writeTextFile(file, key.trim() + "\n", "");
  await exec("chmod", ["600", file]);
}
export async function removeKey(m) { await exec("rm", ["-f", P.keyFile(m)]).catch(() => null); }

export class Models {
  init(_props, cx) {
    this.draft = null;   // the model being edited (a copy), null: the list
    this.isNew = false;
    this.test = null;
    this.testing = false;
    this.saving = false;
    const make = (placeholder, field) => {
      const s = InputState.new({ placeholder });
      s.on("change", (_e, cx) => { if (this.draft) { this.draft[field] = s.value(); this.test = field === "name" ? this.test : null; } cx.notify(); });
      return s;
    };
    this.inName = make("Name shown in the pickers, e.g. Qwen Coder", "name");
    this.inBase = make("Base URL, e.g. https://openrouter.ai/api/v1", "base_url");
    this.inModel = make("Model id, e.g. qwen/qwen3-coder", "model");
    this.inEnv = make("Environment variable, e.g. OPENROUTER_API_KEY", "env");
    this.inKey = InputState.new({ placeholder: "Paste the API key (saved to ~/.config/coderwriter/keys, mode 600)" });
    this.inKey.set_masked(true);
    this.inKey.on("change", (_e, cx) => { if (this.draft) { this.draft.pasted = this.inKey.value(); this.test = null; } cx.notify(); });
    if (props()?.new) this.edit({ key: "env", env: "" }, true);
    if (props()?.edit) {
      const m = P.prefs().models.find((x) => x.id === props().edit);
      if (m) this.edit(m, false);
    }
  }

  edit(m, isNew) {
    this.draft = { key: "env", env: "", ...m, pasted: "", hasKey: !isNew && m.key === "file" };
    this.isNew = isNew;
    this.test = null;
    this.inName.set_value(this.draft.name ?? "");
    this.inBase.set_value(this.draft.base_url ?? "");
    this.inModel.set_value(this.draft.model ?? "");
    this.inEnv.set_value(this.draft.env ?? "");
    this.inKey.set_value("");
  }

  applyPreset(p) {
    this.draft.base_url = p.base_url; this.inBase.set_value(p.base_url);
    this.draft.key = p.key;
    if (p.env) { this.draft.env = p.env; this.inEnv.set_value(p.env); }
    if (!this.draft.name) { this.draft.name = ""; }
    this.test = null;
  }

  problems() {
    const d = this.draft;
    if (!/^https?:\/\/\S+$/.test(d.base_url ?? "")) return "Enter a base URL starting with http:// or https://";
    if (!(d.model ?? "").trim()) return "Enter the model id";
    if (d.key === "env" && !ENV_NAME.test(d.env ?? "")) return "Enter an environment variable name (letters, digits, _)";
    if (d.key === "file" && !d.hasKey && !(d.pasted ?? "").trim()) return "Paste the API key";
    return null;
  }

  async keyReady() {
    const d = this.draft;
    if (d.key === "file" && d.pasted?.trim()) { await saveKey(d, d.pasted); d.pasted = ""; this.inKey.set_value(""); d.hasKey = true; }
  }

  runTest(cx) {
    if (this.testing || this.problems()) return;
    this.testing = true; this.test = null; cx.notify();
    const d = this.draft;
    cx.spawn(async (cx) => {
      try {
        if (!d.id) d.id = newId();
        await this.keyReady();
        const code = await readTextFile(`${appHome()}/mods/coderwriter/probe.py`);
        const r = await exec("python3", ["-c", code, d.base_url.trim(), d.model.trim(), d.key, P.keyEnvName(d), P.keyFile(d)], { timeout: 90000 });
        this.test = r.code === 0 ? JSON.parse(r.stdout) : { error: (r.stderr || "the test failed").trim().split("\n").pop() };
      } catch (e) {
        this.test = { error: String(e.message ?? e) };
      }
      this.testing = false; cx.notify();
    });
  }

  save(cx) {
    if (this.saving || this.problems()) return;
    this.saving = true; cx.notify();
    const d = this.draft;
    cx.spawn(async (cx) => {
      try {
        if (!d.id) d.id = newId();
        await this.keyReady();
        const m = { id: d.id, name: (d.name ?? "").trim() || d.model.trim(), base_url: d.base_url.trim().replace(/\/+$/, ""), model: d.model.trim(),
          key: d.key, env: d.key === "env" ? d.env.trim() : undefined };
        const list = P.prefs().models.filter((x) => x.id !== m.id);
        const at = P.prefs().models.findIndex((x) => x.id === m.id);
        if (at >= 0) list.splice(at, 0, m); else list.push(m);
        P.setPrefs({ models: list });
        if (m.key !== "file") await removeKey(m);
        this.draft = null;
      } catch (e) {
        notify({ title: "coderwriter", body: `Could not save the model: ${e.message ?? e}`, level: "error" });
      }
      this.saving = false; cx.notify();
    });
  }

  remove(m, cx) {
    const pr = P.prefs();
    const patch = { models: pr.models.filter((x) => x.id !== m.id) };
    if (pr.writer === `m:${m.id}`) patch.writer = "claude";
    if (pr.reviewer === `m:${m.id}`) patch.reviewer = "codex";
    P.setPrefs(patch);
    removeKey(m);
    if (this.draft?.id === m.id) this.draft = null;
    cx.notify();
  }

  // ---- drawing ---------------------------------------------------------------------
  field(t, label, input, hint) {
    return v_flex().gap(4)
      .child(div().text_size(11.3).text_color(t.muted).child(label))
      .child(Input.new(input).h(28).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12.3).text_color(t.foreground))
      .when(Boolean(hint), (el) => el.child(div().text_size(10.8).text_color(t.dim).child(hint)));
  }
  chip(t, id, label, on, onClick, tint) {
    const c = tint ?? t.accent;
    return h_flex().id(id).h(24).px(8).gap(5).items_center().flex_none().rounded(6).text_size(11.8)
      .border_1().border_color(on ? c : t.border).bg(on ? c + "1f" : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(label);
  }
  button(t, id, label, onClick, { primary = false, enabled = true, danger = false } = {}) {
    return h_flex().id(id).h(28).px(12).items_center().flex_none().rounded(7).text_size(12.3).font_medium()
      .border_1().border_color(primary ? t.solid : danger ? t.blocked : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : danger ? t.blocked : t.foreground)
      .when(!enabled, (el) => el.opacity(0.45))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .child(label);
  }

  testView(t) {
    const r = this.test;
    if (this.testing) return h_flex().gap(6).items_center().text_size(11.8).text_color(t.muted)
      .child(svg(I("spinner")).size(12).text_color(t.working).spin(900)).child("Testing the endpoint (one tiny request)…");
    if (!r) return null;
    const line = (ok, text) => h_flex().gap(6).items_start().text_size(11.8)
      .child(div().pt(4).child(div().size(7).rounded(4).bg(ok === null ? t.dim : ok ? t.ansi2 : t.blocked)))
      .child(div().flex_1().text_color(ok === false ? t.foreground : t.muted).child(text));
    if (r.error) return v_flex().gap(3).child(line(false, r.error));
    const rows = [];
    if (r.key) rows.push(line(!/not set|no saved/.test(r.key), `API key: ${r.key}`));
    if (r.models) rows.push(line(r.models.ok, r.models.ok
      ? `Endpoint answers: ${r.model_count ?? "?"} models listed${r.model_listed === false ? " (this model id isn't among them)" : ""}`
      : `GET /models: ${r.models.status ?? "no answer"} ${r.models.message}`));
    if (r.responses) rows.push(line(r.responses.ok, r.responses.ok
      ? "Responses API works: Codex can use this model"
      : `POST /responses: ${r.responses.status ?? "no answer"} ${r.responses.message}`));
    if (r.chat) rows.push(line(r.chat.ok ? false : null, r.chat.ok
      ? "Only Chat Completions works here. Codex needs the Responses API: put a proxy such as LiteLLM in front, or use a provider that serves /responses."
      : `POST /chat/completions: ${r.chat.status ?? "no answer"} ${r.chat.message}`));
    return v_flex().gap(4).p(8).rounded(7).bg(t.chrome).children(rows);
  }

  form(t) {
    const d = this.draft;
    const problem = this.problems();
    const ids = (this.test?.model_ids ?? []).filter((x) => !d.model || x.toLowerCase().includes(String(d.model).toLowerCase())).slice(0, 14);
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().id("back").text_size(12).text_color(t.muted).hover((s) => s.text_color(t.foreground)).cursor_pointer()
          .on_click((_e, cx) => { this.draft = null; cx.notify(); }).child("‹ Models"))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(this.isNew ? "New model" : modelLabel(d))))
      .child(v_flex().gap(4)
        .child(div().text_size(11.3).text_color(t.muted).child("Provider"))
        .child(h_flex().flex_wrap().gap(5).children(PRESETS.map((p, i) => this.chip(t, `preset-${i}`, p.label, d.base_url === p.base_url, () => this.applyPreset(p))))))
      .child(this.field(t, "Base URL", this.inBase, "OpenAI-compatible, ending in /v1. Codex calls <base>/responses, so the endpoint must serve the Responses API."))
      .child(this.field(t, "Model", this.inModel))
      .when(ids.length > 0, (el) => el.child(h_flex().flex_wrap().gap(4).children(ids.map((id, i) =>
        this.chip(t, `mid-${i}`, id, d.model === id, () => { d.model = id; this.inModel.set_value(id); })))))
      .child(this.field(t, "Name", this.inName))
      .child(v_flex().gap(4)
        .child(div().text_size(11.3).text_color(t.muted).child("API key"))
        .child(h_flex().gap(5)
          .child(this.chip(t, "k-env", "Environment variable", d.key === "env", () => { d.key = "env"; this.test = null; }))
          .child(this.chip(t, "k-file", "Paste key", d.key === "file", () => { d.key = "file"; this.test = null; }))
          .child(this.chip(t, "k-none", "No key (local)", d.key === "none", () => { d.key = "none"; this.test = null; }))))
      .when(d.key === "env", (el) => el.child(this.field(t, "Variable", this.inEnv, "Read from Herdr's environment, else from your shell's (~/.bashrc, config.fish, …).")))
      .when(d.key === "file", (el) => el.child(this.field(t, d.hasKey ? "Key (saved; paste to replace)" : "Key", this.inKey,
        "Stored only on this computer, in ~/.config/coderwriter/keys (700/600). Not in Herdr's shared state or the layout.")))
      .child(this.testView(t) ?? div())
      .child(h_flex().gap(8).items_center().pt(2)
        .child(div().flex_1().min_w(0).text_size(11.3).text_color(t.dim).child(problem ?? ""))
        .child(this.button(t, "test", this.testing ? "Testing…" : "Test", (cx) => this.runTest(cx), { enabled: !problem && !this.testing }))
        .child(this.button(t, "save", this.saving ? "Saving…" : "Save", (cx) => this.save(cx), { primary: true, enabled: !problem && !this.saving })));
  }

  list(t) {
    const models = P.prefs().models;
    const pr = P.prefs();
    const used = (m) => [pr.writer === `m:${m.id}` ? "writer" : null, pr.reviewer === `m:${m.id}` ? "reviewer" : null].filter(Boolean).join(" + ");
    return v_flex().gap(10)
      .child(v_flex().gap(3)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Custom models"))
        .child(div().text_size(11.5).text_color(t.dim).child("Any OpenAI-compatible endpoint that serves the Responses API, run through Codex as writer or reviewer. They take Codex's launch flags and have no Codex plan limits: the provider bills them.")))
      .children(models.length ? models.map((m) => h_flex().id(`m-${m.id}`).gap(9).p(9).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(svg(I("cpu")).size(15).flex_none().text_color(t.accent))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center()
            .child(div().truncate().text_size(12.5).text_color(t.foreground).child(modelLabel(m)))
            .when(Boolean(used(m)), (el) => el.child(div().px(5).h(16).flex().items_center().rounded(4).bg(t.selected).text_size(10.3).text_color(t.muted).child(used(m)))))
          .child(div().truncate().text_size(11.3).text_color(t.dim).child(`${m.model} · ${host(m.base_url)} · ${m.key === "env" ? "$" + m.env : m.key === "file" ? "saved key" : "no key"}`)))
        .child(this.button(t, `edit-${m.id}`, "Edit", (cx) => { this.edit(m, false); cx.notify(); }))
        .child(this.button(t, `del-${m.id}`, "Delete", (cx) => this.remove(m, cx), { danger: true })))
        : [div().p(12).rounded(8).border_1().border_color(t.border).text_size(12).text_color(t.dim).child("No custom models yet.")])
      .child(h_flex().gap(8)
        .child(div().flex_1())
        .child(this.button(t, "close", "Close", () => closeOverlay(props().overlay)))
        .child(this.button(t, "add", "Add model", (cx) => { this.edit({ key: "env", env: "" }, true); cx.notify(); }, { primary: true })));
  }

  render() {
    const t = theme();
    return div().id("models-scroll").size_full().bg(t.popover).overflow_y_scrollbar()
      .child(div().p(16).child(this.draft ? this.form(t) : this.list(t)));
  }
}
