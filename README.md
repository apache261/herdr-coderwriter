# coderwriter: a writer/reviewer agent pair layout for Herdr

Pair two coding agents in [Herdr](https://herdr.dev): a **writer** (Claude Code by default)
makes the change, a **reviewer** (Codex by default) reviews the uncommitted diff, and they
loop until the reviewer approves or a round limit is reached. Side panels show the review
rounds, token usage for both agents and Codex's plan limits, next to Herdr's Files and
Changes panels.

![coderwriter](preview.png)

- Writer and reviewer side by side, each pane marked `WRITER` / `REVIEWER` with a live status.
- Review →, ← Feedback, or **Auto** for hands-off rounds (1–10, default 3).
- **Test gate**: a test command per folder (`npm test`, `pytest -q`, …) runs before every
  review. A failure goes back to the writer instead of the reviewer; Auto tries 3 times, then
  pauses.
- **Round snapshots**: the files are saved at the start and at every review, so the reviewer
  can check just what changed since its last round, and the Reviews panel can put the files
  back to any round (undoable).
- **Stuck-loop detection**: a finding that comes back unchanged from the round before pauses
  Auto, and Feedback sends it back to the writer with a nudge.
- **Team** (preview, toggle in New pair): four agents, like working with a team. You give
  the task to the **PM**, which asks you what's unclear and writes a plan of subtasks
  (`.coderwriter/plan.md`); you approve it in the Plan dialog or ask for changes. Then each
  subtask goes to the **Coder** (the writer), and the **Tester** and the reviewer check it
  round after round until it passes; then the next subtask, and at the end the PM's report
  (`.coderwriter/report.md`) and the offer of a full audit. Every round runs all the checks one after another, even when
  one fails: the tester writes and runs unit and functional tests, then the test command, then
  the reviewer's **Quality** check (with Ponytail's `ponytail-review` when installed) and its
  **Security** check of the change (with the principles of Cloudflare's skill when installed;
  the full audit is offered once approved); every failure goes to the coder in one note. Test
  files are the tester's: a coder that changes one gets it back as a finding. Each check
  reports PASS or FAIL in `.coderwriter/round-<n>/`; the coder keeps its own notes in
  `.coderwriter/coder.md`. Nothing is committed: you review and commit.
  On screen: the team's tab is a 2×2 grid in the order the work flows (PM over Coder, Tester
  over Reviewer); the bar shows the flow as a strip (`PM › Coder › Tester › Tests › Quality ›
  Security`, each working, passed, failed or waiting on you, plus the subtask count); and the
  Reviews panel shows each round's summary, the coder's notes and every check's own report,
  and the PM's plan and report.
- **Any agent per role**: each role (writer, reviewer, and a team's tester and PM) can be any
  agent Herdr knows and finds installed (Claude Code, Codex, Copilot, …), a custom model, or
  **Command**: a command line of your own for that role (`claude --model sonnet`,
  `codex -m gpt-5 -c model_reasoning_effort=high`, …). Pick them in New pair…. Use agents Herdr shows a status for: coderwriter waits for each turn
  to end by it.
- **Ponytail review**: a toggle (bar and New pair) that has the reviewer follow
  [Ponytail](https://github.com/DietrichGebert/ponytail)'s `ponytail-review` skill each round
  (correct, safe, holds under load, tested, fast, lean), keeping the verdict format.
- **Audits after approval**: when a round is approved, a dialog asks whether the reviewer
  should also run Cloudflare's [security audit](https://github.com/cloudflare/security-audit-skill)
  and/or Ponytail's code audit (`ponytail-audit`) over the repository; nothing is checked by
  default. The audit is one more round (`.coderwriter/review-<n>.md`, shield in Reviews), so
  Feedback sends its findings to the writer. **Audit** in the bar asks again any time. A skill
  that isn't installed is shown with its install command; coderwriter installs nothing.
- **Launch** flags per agent: skip permissions, permission modes, sandbox, web search or any
  flags of your own; empty means each agent's default. Optionally also used by the + menu.
- **Custom models**: any OpenAI-compatible endpoint that serves the Responses API
  (OpenRouter, OpenAI, Ollama, LM Studio, vLLM, llama.cpp, LiteLLM, …) as writer or reviewer,
  run through Codex via a small local relay that folds Codex's several system messages into
  one (some chat templates, such as Gemma's in llama.cpp, accept only one). A Test button
  checks the endpoint before you use it.
- **Starting**: **New pair…** / **New team…** in the bar (in a tab without one) or the tab
  bar's **+** menu open one dialog with every setting (task, an agent per role, folder,
  rounds, Team, Ponytail, Auto, launch flags, custom models). The bar itself only shows the
  shown tab's pair or team: its status and Review, Feedback, Plan, Audit, Auto, Stop. The
  + menu also has **Terminal** and **Agent, space or worktree…** (Herdr's own menu).
- **Reviews** panel: every round's verdict and findings, rendered.
- **Usage** panel: tokens per session and per day from the agents' local logs (custom models
  counted separately), plus each plan's limits where they apply: Claude's current session and
  weekly limits (all models and per model) as `/usage` shows them, and Codex's 5h and weekly
  limits as `/status` shows them. A bar chip shows `Claude 35% used · Codex 64% left`.
- **Files** panel with **New folder** (nested `a/b/c` too), **New file** and **Rename**, inline in
  the tree; it never overwrites an existing name. Files and folders are colored by git
  state: modified, staged, new, deleted, conflicted, committed but not pushed, and ignored
  (dimmed), with a key under the tree.
- Herdr's spaces and agents sidebar, Changes panel and status bar.

## Install

Needs Herdr with Claude Code and/or Codex installed, and `python3` for the Usage panel.

```sh
git clone https://github.com/apache261/herdr-coderwriter
cd herdr-coderwriter
cp layouts/coderwriter.json layouts/coderwriter.svg ~/.config/herdr-app/layouts/
cp -r mods/coderwriter mods/coderwriter-tabs mods/coderwriter-pane mods/coderwriter-files ~/.config/herdr-app/mods/
herdr-app do layout.switch '{"name":"coderwriter"}'
```

If any of these names is already taken in your Herdr folder, rename the new one (its file or
folder, the `mod` names in the layout, and the `mods/<name>/` paths inside it) instead of
overwriting. `ctrl-shift-l` switches back to your previous layout; deleting the files
removes it.

## What it runs and reads

- Starts the agents and sends them messages with Herdr's `hc` (`hc run`, `hc send`, `hc wait`).
- Runs `sh` in the pair folder to list `.coderwriter/` and to add `.coderwriter/` to
  `.git/info/exclude`.
- The Usage panel runs `python3` to read `~/.claude/projects/**/*.jsonl` and
  `~/.codex/sessions/**/*.jsonl` (read only, files changed today or since the pair started),
  and, at most every 2 minutes, reads the live plan limits the way the agents do: Claude Code's
  `/usage` endpoint (`api.anthropic.com/api/oauth/usage`) with Claude Code's own sign-in from
  `~/.claude/.credentials.json` (macOS: the keychain), read only and never refreshed or sent
  anywhere else; and `codex app-server`, which contacts OpenAI as Codex's `/status` does.
  Each is skipped when that agent isn't installed or isn't signed in with a plan.
- Test gate: runs your test command with `sh -c` in the pair folder before each review (10
  minute limit), output to `.coderwriter/tests-<round>.txt`.
- Round snapshots: commits made with `git commit-tree` from a temporary index (your staging is
  untouched), kept only under `refs/coderwriter/<pair>/`, never on a branch, and deleted when
  the pair's tab closes. Restoring rewrites the working tree from one (after saving the current
  files as `before-restore`, for Undo); outside a git repo there are no snapshots.
- The Files panel runs `sh` (`mkdir -p`, `mv`, creating an empty file) only when you create or
  rename something, in the folder you're browsing.
- Ponytail review and audits: runs `sh` to look for each skill's `SKILL.md` in the pair folder's
  `.claude/skills`, `.agents/skills`, `.codex/skills`, the same under your home folder, and
  Claude Code's and Codex's plugin caches; the reviewer is told that file's path. The security
  audit keeps its working files in `.coderwriter/security-audit/`.
- Writes `~/.config/herdr-app/programs.json` only if you check "Also use these flags for the
  tab bar's + menu".
- Custom models: **Test** sends `GET <base>/models` and one tiny `POST <base>/responses`
  (and `/chat/completions` if that fails) to the endpoint you enter. A pasted API key is
  saved only in `~/.config/coderwriter/keys/<id>.key` (folder 700, file 600), never in Herdr's
  shared state, the layout or a command line; an environment-variable key is read from
  Herdr's environment or, if missing there, from your interactive shell. Each custom-model agent
  runs `python3` as a relay on `127.0.0.1` (a free port) that lives as long as the agent.

See [RECIPE.md](RECIPE.md) for the full description, the build notes and what "done" looks like.
