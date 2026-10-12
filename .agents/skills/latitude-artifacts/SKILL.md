---
name: latitude-artifacts
description: Build Latitude Artifacts, self-contained HTML reports and KPI dashboards rendered by the agent from Latitude observability data (traces, sessions, tools, users, memory, signals, cost) pulled through the Latitude MCP, CLI, API or SDKs. Use when someone asks for a report, dashboard, summary, KPI page, or "how is my agent doing" view of their Latitude data, wants a one-off answer rendered as a page, or wants a dashboard they can reopen every morning with fresh numbers. Guides the agent to ask short requirement questions when the ask is unclear, and renders every artifact in the shared Latitude design language with light and dark themes.
---

# Latitude Artifacts

An **Artifact** is a single HTML file your agent builds from Latitude data: a one-off report that answers a specific question, or a KPI dashboard the user reopens every morning. Latitude provides the data through the MCP, CLI, API and SDKs; the agent picks the queries, renders the page, and writes the findings. The user may never open the Latitude web app.

This skill covers the whole loop: figure out what the user wants, pull the right data, render it in the shared Latitude design language (light + dark), interpret it, and, when asked, make it refreshable.

Files in this skill:

- `data-sources.md`: which Latitude operation answers which question, `queryAnalytics` reference, units, filters, privacy rules. **Read it before fetching anything.**
- `template.html`: the starter artifact with the Latitude theme, building blocks and an example data blob. **Every artifact starts from this file.**
- `refresh.md`: generator-script recipes (Node, Python, shell + CLI) and scheduling for refreshable artifacts.

## Entry points

- **Invoked directly.** The user asks for a report, dashboard or "how is X doing" page. Run the intake below, skipping any question the request already answers.
- **After `latitude-setup`.** Setup builds its own first Artifact (a single-session page from its bundled `first-artifact.html`) and does not call this skill. Use this entry when the user, having just finished setup, asks for more: a report over a window, a comparison, or a refreshable dashboard. Auth (`LATITUDE_API_KEY`, `LATITUDE_PROJECT_SLUG` in `.env`) is in place, so skip the preflight; run the intake with the project already known, and treat the **first-artifact default** (below) as the suggested answer to question 1. Remember the project is minutes old: say the window is small and the numbers are a baseline, not a trend.
- **Refreshing an existing artifact.** The user points at an `artifacts/<slug>.html` that has a refresh script. Run the script, reload the blob, rewrite the findings, done. No intake.

## Preflight: how will you read Latitude?

Check, in order, and use the first that works:

1. **Latitude MCP connected** in this harness → call tools directly (`listProjects` first). Best for one-off artifacts.
2. **`latitude` CLI + `LATITUDE_API_KEY`** (in the shell or a `.env` in the app root) → `latitude <group> <command> --format json`. See the `latitude-cli` skill for install/auth. Best for shell refresh scripts.
3. **API key only** → plain HTTP against `https://api.latitude.so/v1/...` (or `LATITUDE_BASE_URL` for self-hosted). Best for Node/Python refresh scripts.

Nothing available? Say so and offer the two fixes: connect the MCP (`https://api.latitude.so/v1/mcp`, OAuth) or create an API key in **Settings → Keys** and put it in `.env`. If the user has **no Latitude account at all**, stop and hand off to `latitude-setup`.

Resolve the **project slug**: `LATITUDE_PROJECT_SLUG` in `.env`, else `listProjects` / `latitude projects list`. One project → use it silently. Several → ask (question 0 below).

A **refreshable** artifact always needs an API key in the environment, even if you built the first version over MCP. Say that before choosing the modality.

## Intake: ask only what the request doesn't answer

Keep it short. The four core questions below are the whole intake; the project and refresh questions are conditional and only appear when they apply. Ask only the ones the request left open, in one message, each with two to four options and a marked default. Accept "defaults" or "just do it" as answering everything. Never ask a question the user already answered, and never ask about implementation choices (chart library, script runtime, file format). If the harness has a structured question tool (option pickers), use it with the default preselected; otherwise list the options with the default marked `(default)`.

**0. Project** (only if several): list the slugs, default to the one in `.env` or the most recently active.

**1. What should the artifact answer?** Offer four starters, default first, and take a free-text answer as-is:

- Reliability, latency and cost overview `(default)`
- Tool usage and failures
- Users and memory activity
- Signals, incidents and quality

**2. Report or dashboard?**

- One-off report: data baked in, a snapshot for this question `(default)`
- Refreshable dashboard: same page, a script re-pulls fresh data whenever it runs

**3. Time window?** Last 7 days `(default)` · Last 30 days · Last 24 hours · Custom range

**4. Where should it live?** `artifacts/<slug>.html` in the current repo `(default)` · a path the user names. Suggest a slug from the question ("reliability-overview", "memory-activity").

**Only if refreshable, one more:** how does it refresh? On demand with a command `(default)` · Daily on a schedule (cron or CI) · An agent run that also rewrites the findings. Details in `refresh.md` → Scheduling.

State any remaining assumptions in one line and start. No plan approval step: creating a new HTML file is low-risk. Do ask before overwriting an existing artifact the user did not mention.

**First-artifact default** (the user says "surprise me", or has just finished `latitude-setup`): one-off *Reliability, latency and cost overview* for the last 7 days (or since the first trace if younger), saved to `artifacts/overview.html`. If the project is hours old, say the window is small and the numbers are a baseline, not a trend.

## Modalities

| Modality | How data gets in | Best for | Needs |
| --- | --- | --- | --- |
| **One-off report** | You call the MCP/CLI in the conversation and embed the results | A specific question, a post-mortem, "what happened this week" | MCP or CLI |
| **Refreshable dashboard** | A generator script rewrites the data blob on each run | KPIs the user opens every morning | API key in the environment, `refresh.md` |
| **Agent-refreshed** | A scheduled agent run executes the script and rewrites the findings | A dashboard with fresh commentary | The above, plus a scheduled runner |

The artifact file is the same in all three. Only the data blob and its author differ.

## Workflow

### 1. Frame the artifact

Write the title and three to six one-line questions the artifact must answer (for example, "How are users interacting with my agent's memory?" → *Which stores exist and how big are they? · How much churn per day? · Who reads and writes? · What gets retrieved most? · What does memory cost per session?*). Each question becomes a section, a chart, or a table. This list is your spec; show it to the user only if they asked to review first.

### 2. Map questions to operations

Use `data-sources.md`. Aggregates come from `queryAnalytics` (metric × breakdown × time bucket). Rows come from list operations with a `limit`. Entity-specific views (tools, users, memory, signals) have dedicated operations that already roll things up; prefer them over rebuilding the rollup from rows. Read each operation's schema before calling.

### 3. Fetch

- Use one explicit `range` for the whole artifact, UTC ISO-8601, and put it in `meta.range`.
- For every KPI, also fetch the previous period of equal length and compute the delta.
- Fill missing time buckets so series line up on one x-axis.
- Normalize units at fetch time: seconds, dollars, 0–1 rates (`data-sources.md` → Units).
- Keep the embedded JSON small (tens of KB). Cap lists, aggregate first, no raw conversations unless asked.
- If a call fails or returns nothing, keep going: the section renders an honest empty state, and you mention it in the findings.

### 4. Interpret

This is the part no dashboard builder does. Write three to six **findings**: specific, quantified, causal where the data supports it, with a suggested next step when there is one.

- Good: "p95 latency doubled on Sep 3 (2.1s → 4.4s), entirely on `search_docs` calls; the 3 slowest sessions all hit the same timeout. Consider a 5s tool timeout."
- Bad: "Latency increased. Monitor the situation."

Never restate a chart in words, never pad, never invent causes the data does not show. If the window is too short or the volume too low to conclude anything, say exactly that.

### 5. Render

Copy `template.html` to the target path and:

1. Replace the `<script id="artifact-data" type="application/json">` blob with your data. Keep the `id` and the `type`; it is the refresh boundary.
2. Edit only the `render()` function to compose sections from the building blocks: `section`, `kpiRow`, `chartCard`, `tableCard`, `findingsCard`. `kpiRow` sizes the tiles for 2, 3, 4 or 6 KPIs. Add a block only if none fits; style it with the existing tokens.
3. Set `meta.title`, `meta.subtitle` (one sentence on what the page answers), `meta.project`, `meta.range`, `meta.generatedAt`, `meta.sources` (operation names used).

Blob contract the building blocks expect:

```jsonc
{
  "meta": { "title", "subtitle"?, "project", "range": { "from", "to" }, "generatedAt", "sources": [] },
  "kpis": [{ "label", "value", "format": "count|rate|cost|duration|tokens|number", "delta"?, "deltaGood"?: "up|down", "hint"? }],
  "charts": { "<id>": { "kind": "line|area|bar|pie", "format", "categories": [], "series": [{ "name", "values": [], "color"? }], "stacked"?, "horizontal"? } },
  "tables": { "<id>": { "columns": [{ "key", "label", "format"?: "count|rate|cost|duration|tokens|number|text|date|datetime", "bar"?, "badge"?: { "<value>": "ok|warn|error|info" } }], "rows": [] } },
  "findings": ["..."]
}
```

`delta` is a fraction for `count`/`cost` (+0.12 = up 12%), a point difference for `rate`, an absolute difference otherwise. `deltaGood` says which direction is good, so the pill colors correctly (error rate: `"down"`).

### 6. Verify

- The blob parses and the page renders with **no console errors** in both themes. If a headless browser is available, load the file and check; otherwise at least parse the JSON out of the file.
- Every chart and table has data, or an honest empty state. No `undefined`, `NaN`, `4200%`.
- Every number in the findings appears in the data.
- The theme toggle works and the page reads well in both themes (no hard-coded colors).
- No secrets in the file: grep for `LATITUDE_API_KEY`, `Bearer`, `lat_sandbox_`, and the UUID-shaped key value from `.env`.

### 7. Deliver

Tell the user the path, how to open it (`open artifacts/<slug>.html` on macOS, `xdg-open` on Linux, or double-click), what each section answers in one line each, and the top finding. For refreshable artifacts, add the refresh command and the schedule you set up. Keep it to a short message; the artifact is the deliverable.

## Design language

The template carries the Latitude design system (`packages/ui/src/styles/globals.css` in `latitude-dev/latitude-llm`): Inter for text, JetBrains Mono for identifiers, the `#0080FF` primary, neutral surfaces, `0.5rem` radius, hairline borders, tabular numerals. Both themes ship; the page follows the OS preference and remembers the toggle. Rules that keep every artifact looking like the same product:

- **Use the tokens, never literal colors.** Series colors come from `--series-1..8` in order; semantic colors (`--series-positive`, `--series-negative`, `--series-other`) only for good/bad/remainder, never for decoration.
- **Layout:** header (title, subtitle, project, window, generated-at, theme toggle) → KPI row (4 tiles; 2, 3 or 6 also fine) → charts in a 12-column grid (`col-6` pairs, `col-12` for dense series) → tables → findings → footer with sources. Sections answer questions in the order the user would ask them.
- **Chart choice:** line for trends, bar for breakdowns, horizontal bar when labels are long, stacked only when parts sum to a meaningful whole, donut only for five or fewer shares. Never 3D, gradients, dual axes without labels, or decorative icons.
- **Tables** for top-N rows: at most eight columns, numbers right-aligned, an inline bar on the one column that carries the ranking, a badge for statuses.
- **Density:** one page for a report, scroll is fine for a dashboard; no card without a purpose, no chart with one data point (use a KPI instead).
- **Text:** sentence case, no exclamation marks, no emoji, units in the axis label or the formatter, never in the title. Findings are plain prose bullets.
- **Print:** the template has a print stylesheet; do not break it with fixed heights or viewport units.

The template loads ECharts and the Inter webfont from a CDN. Text, KPIs and tables render offline; charts need network once and show a short notice when the library could not load. If the user needs a fully offline file, inline the ECharts build in place of the `<script src>` and drop the font link (system fonts are configured as fallbacks). Dates on the page are UTC, matching the query range, and printing switches to the light theme automatically.

## Do not

- Ask the user to choose a chart library, script runtime, or file format.
- Build a page with charts and no findings, or findings that restate the charts.
- Embed raw conversation content, user emails or tool payloads unless explicitly asked; link to Latitude instead.
- Put an API key, OAuth token or `.env` contents anywhere in the HTML or in a committed script.
- Make the HTML call the Latitude API from the browser.
- Invent colors, fonts or layouts outside the template.
- Start a refreshable dashboard without an API key in the environment.
