# Refreshable artifacts

A one-off artifact bakes data into the HTML at build time. A refreshable artifact keeps the **same HTML** and gets its `<script id="artifact-data" type="application/json">` blob rewritten by a small **generator script** that pulls fresh numbers through the Latitude API. The user opens the same file every morning and sees today's data.

Never make the HTML fetch the API from the browser. The Latitude API rejects cross-origin browser requests by default, and it would mean shipping an organization API key inside a static file.

## Layout

```
artifacts/
  <slug>.html            # the artifact, rendered from template.html
  <slug>.refresh.mjs     # or .py / .sh: rewrites the data blob in <slug>.html
```

The generator does three things: **fetch** (API / SDK / CLI), **shape** the responses into the blob contract the HTML's `render()` expects, **splice** the JSON back between the `<script id="artifact-data" …>` tags and update `meta.generatedAt`. Keep the shaping logic in the script, so the HTML never changes on refresh.

Auth comes from `LATITUDE_API_KEY` in the environment or a gitignored `.env` next to the script. The script must never print the key or write it into the HTML.

## Pick the runtime

| Runtime | When | Fetch with |
| --- | --- | --- |
| **Node** (`.mjs`) | The repo is JS/TS, or nothing else is installed | `@latitude-data/sdk` or plain `fetch` |
| **Python** (`.py`) | The repo is Python | stdlib `urllib` (or `latitude-sdk`) |
| **Shell** (`.sh`) | The user already has the `latitude` CLI and wants zero dependencies | `latitude <group> <command> --format json` + `jq` |

Splicing the blob is the same in all three: read the file, replace everything between `<script id="artifact-data" type="application/json">` and the next `</script>`, write it back.

### Node (plain `fetch`, no dependencies)

```js
// artifacts/reliability.refresh.mjs
import { readFile, writeFile } from "node:fs/promises"

const API = process.env.LATITUDE_BASE_URL ?? "https://api.latitude.so"
const KEY = process.env.LATITUDE_API_KEY
const PROJECT = process.env.LATITUDE_PROJECT_SLUG
const FILE = new URL("./reliability.html", import.meta.url)
if (!KEY || !PROJECT) throw new Error("Set LATITUDE_API_KEY and LATITUDE_PROJECT_SLUG")

const to = new Date()
const from = new Date(to.getTime() - 7 * 86_400_000)
const range = { fromIso: from.toISOString(), toIso: to.toISOString() }

async function query(body) {
  const res = await fetch(`${API}/v1/projects/${PROJECT}/analytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range, ...body }),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()).series
}

const [traces, errorRate, p95, spend, errorByModel] = await Promise.all([
  query({ stream: "traces", metric: { kind: "count" } }),
  query({ stream: "traces", metric: { kind: "errorRate" } }),
  query({ stream: "traces", metric: { kind: "percentile", field: "duration", p: 95 } }),
  query({ stream: "traces", metric: { kind: "sum", field: "cost" } }),
  query({ stream: "traces", metric: { kind: "errorRate" }, breakdown: "model", timeBucket: { unit: "day" }, limit: 500 }),
])

const days = [...new Set(errorByModel.map((p) => p.bucketStart))].sort()
const models = [...new Set(errorByModel.map((p) => p.key))]
const data = {
  meta: { title: "Reliability and cost", project: PROJECT, range: { from: range.fromIso, to: range.toIso }, generatedAt: new Date().toISOString(), sources: ["queryAnalytics"] },
  kpis: [
    { label: "Traces", value: traces[0]?.value ?? 0, format: "count" },
    { label: "Error rate", value: errorRate[0]?.value ?? 0, format: "rate" },
    { label: "p95 latency", value: p95[0]?.value ?? 0, format: "duration" },
    { label: "Spend", value: spend[0]?.value ?? 0, format: "cost" },
  ],
  charts: {
    errorRateByModel: {
      kind: "line", format: "rate",
      categories: days.map((d) => d.slice(0, 10)),
      series: models.map((m) => ({ name: m, values: days.map((d) => errorByModel.find((p) => p.key === m && p.bucketStart === d)?.value ?? null) })),
    },
  },
  tables: {},
  findings: [],
}

const html = await readFile(FILE, "utf8")
const open = '<script id="artifact-data" type="application/json">'
const start = html.indexOf(open) + open.length
const end = html.indexOf("</script>", start)
await writeFile(FILE, `${html.slice(0, start)}\n${JSON.stringify(data, null, 2)}\n${html.slice(end)}`)
console.log(`Refreshed ${FILE.pathname} at ${data.meta.generatedAt}`)
```

With the SDK instead of `fetch`: `npm i @latitude-data/sdk`, then `const client = new LatitudeClient({ apiKey: KEY })` and `await client.analytics.query(PROJECT, { body: { range, ...body } })`.

### Python (stdlib only)

```python
# artifacts/reliability.refresh.py
import json, os, re, urllib.request
from datetime import datetime, timedelta, timezone

API = os.environ.get("LATITUDE_BASE_URL", "https://api.latitude.so")
KEY = os.environ["LATITUDE_API_KEY"]
PROJECT = os.environ["LATITUDE_PROJECT_SLUG"]
PATH = os.path.join(os.path.dirname(__file__), "reliability.html")

to = datetime.now(timezone.utc)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
rng = {"fromIso": iso(to - timedelta(days=7)), "toIso": iso(to)}

def query(**body):
    req = urllib.request.Request(
        f"{API}/v1/projects/{PROJECT}/analytics/query",
        data=json.dumps({"range": rng, **body}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)["series"]

first = lambda series: series[0]["value"] if series else 0
data = {
    "meta": {"title": "Reliability and cost", "project": PROJECT, "range": {"from": rng["fromIso"], "to": rng["toIso"]}, "generatedAt": rng["toIso"], "sources": ["queryAnalytics"]},
    "kpis": [
        {"label": "Traces", "value": first(query(stream="traces", metric={"kind": "count"})), "format": "count"},
        {"label": "Error rate", "value": first(query(stream="traces", metric={"kind": "errorRate"})), "format": "rate"},
    ],
    "charts": {}, "tables": {}, "findings": [],
}

html = open(PATH).read()
html = re.sub(r'(<script id="artifact-data" type="application/json">)(.*?)(</script>)', lambda m: f"{m.group(1)}\n{json.dumps(data, indent=2)}\n{m.group(3)}", html, count=1, flags=re.S)
open(PATH, "w").write(html)
print(f"Refreshed {PATH} at {rng['toIso']}")
```

The `latitude-sdk` package (`pip install latitude-sdk`) works too, but its request objects are typed pydantic models (`AnalyticsQuery_Traces`, `AnalyticsQueryTracesMetric_Count`, …); check `help(client.analytics.query)` before using it. Plain HTTP keeps the script dependency-free.

### Shell + CLI

```bash
#!/usr/bin/env bash
# artifacts/reliability.refresh.sh: needs the `latitude` CLI (latitude-cli skill) and jq
set -euo pipefail
cd "$(dirname "$0")/.."            # run from the app root so the CLI picks up .env
set -a; [ -f .env ] && . ./.env; set +a   # the script itself needs LATITUDE_PROJECT_SLUG
FILE=artifacts/reliability.html
TO=$(date -u +%Y-%m-%dT%H:%M:%SZ); FROM=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
q() { latitude analytics query --project-slug "$LATITUDE_PROJECT_SLUG" --format json --json "$(jq -nc --arg f "$FROM" --arg t "$TO" "$1 + {range:{fromIso:\$f,toIso:\$t}}")" | jq '.series'; }

TRACES=$(q '{stream:"traces",metric:{kind:"count"}}')
ERRORS=$(q '{stream:"traces",metric:{kind:"errorRate"}}')
DATA=$(jq -n --argjson traces "$TRACES" --argjson errors "$ERRORS" --arg from "$FROM" --arg to "$TO" --arg project "$LATITUDE_PROJECT_SLUG" '{
  meta:{title:"Reliability and cost",project:$project,range:{from:$from,to:$to},generatedAt:$to,sources:["queryAnalytics"]},
  kpis:[{label:"Traces",value:($traces[0].value//0),format:"count"},{label:"Error rate",value:($errors[0].value//0),format:"rate"}],
  charts:{},tables:{},findings:[]}')

python3 - "$FILE" "$DATA" <<'PY'
import re, sys
path, data = sys.argv[1], sys.argv[2]
html = open(path).read()
html = re.sub(r'(<script id="artifact-data" type="application/json">)(.*?)(</script>)', lambda m: f"{m.group(1)}\n{data}\n{m.group(3)}", html, count=1, flags=re.S)
open(path, "w").write(html)
PY
echo "Refreshed $FILE at $TO"
```

## Findings on refresh

The written "What stands out" bullets are the one thing a script cannot regenerate. Options, in order of preference:

1. **Rule-based findings** in the script: threshold checks the user cares about ("error rate above 5%", "spend up more than 20% week over week") emitted as bullets. Deterministic, cheap, honest.
2. **Leave findings empty** on refresh and let the user ask their agent to interpret the current numbers when they want commentary.
3. **Agent-in-the-loop refresh**: the user runs the agent (or a scheduled agent run) with the prompt "refresh `artifacts/<slug>.html` using the `latitude-artifacts` skill and update the findings". The agent runs the script, reads the new blob, and rewrites the bullets.

Do not fake findings with template strings that restate the numbers.

## Scheduling

Offer exactly one of these based on where the user works; default to **on demand**.

- **On demand**: `node artifacts/<slug>.refresh.mjs && open artifacts/<slug>.html` (macOS) / `xdg-open` (Linux). Add it as an npm script or Makefile target if the repo has one.
- **cron** (local machine): `0 8 * * 1-5 cd /path/to/app && node artifacts/<slug>.refresh.mjs` with `LATITUDE_API_KEY` available to cron (source `.env` in the command, or set it in the crontab, never inline it in the HTML).
- **GitHub Actions**: a workflow on `schedule: cron` that runs the script with `LATITUDE_API_KEY` from repository secrets and either commits the refreshed HTML back or publishes `artifacts/` to GitHub Pages. Mention that a Pages-hosted artifact is public unless the repo is private and Pages access is restricted.
- **Scheduled agent runs**: if the user's harness supports scheduled agents (cloud routines, cron-driven CLI sessions), the prompt from "Findings on refresh" → option 3 makes the refresh fully autonomous, findings included.

## Validation after each refresh

- The file still parses: `node -e "JSON.parse(require('fs').readFileSync('artifacts/<slug>.html','utf8').split('<script id=\"artifact-data\" type=\"application/json\">')[1].split('</script>')[0])"`.
- `meta.generatedAt` moved.
- Open it once (headless or in a browser) and confirm no console errors and that every chart has data. Empty series usually means a bad range, a wrong breakdown for the stream, or units that were not normalized.
