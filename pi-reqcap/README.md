# pi-reqcap

Records every provider payload Pi sends, diffs it against the previous request in
the same session and model, and reports what the provider billed for it. It exists
to answer one question a cache re-bill raises: **what changed in the prompt, and
which part of it did I pay for twice?**

Pi's own notice says a request missed the cache and what it cost.
pi-cache-optimizer reports hit rates. Neither names the cause. This one does:

```
[2026-10-04T12:12:18.114Z] seq=412 model=claude-opus-5-5 RE-BILL read=33716 write=133924 (1h=133924) input=0 prompt=167640
    divergence vs previous request: system[2] — tools 2700->2700ch (0); mcp_servers 502ch->absent; advertised_subagents 1402ch->absent
```

## What it classifies

| kind | meaning |
| --- | --- |
| `tools` | the tools array changed (membership, order or schemas) |
| `params` | a request parameter changed (model, max_tokens, thinking, tool_choice, stream) |
| `system[i]` | a system block changed, with the inner section named and sized — `<skills>`, `<addendum>`, `<tools>`, `<mcp_servers>`, … |
| `mutate messages[i]` | a message already sent was rewritten |
| `truncate` | the prompt got shorter (compaction, branch, rewind) |
| `append` | new messages only — the healthy case, and free |

Breakpoint movement is not a change: content is hashed with `cache_control` stripped,
because the breakpoint moves on every request by design.

Beyond the divergence it records the causes Pi raises — `session_compact`,
`mcp_servers_change`, `model_select`, `thinking_level_select`,
`cache_warming_decision` — so a re-bill can be attributed without reading the
transcript afterwards.

## Output

```
$PI_REQCAP_DIR (default ~/.local/share/pi-reqcap/out)
  requests.jsonl   one line per request, response and cause, joined by seq
  rewrites.log     the cost-bearing divergences and causes, human readable
  bodies/*.json    the wire body of a request that paid, and the one it diverged from
  state/*.json     the last fingerprint and body per session and model
  traces/*.txt     the prefix comparison behind a warning
```

Live view: `tail -f ~/.local/share/pi-reqcap/out/rewrites.log`.

## Notices and commands

A re-bill worth interrupting a session for raises a warning and updates the footer:

```
reqcap: cache re-bill 213.6k tok · system[2] — mcp_servers 502ch → absent  (/reqcap diff 412)
reqcap: 3 busts · 412k tok          ← footer status
```

The threshold counts re-billed tokens rather than cost, because the plugin cannot
know a provider's prices: `PI_REQCAP_NOTICE_MIN_TOKENS` (default 20000; `0` warns on
every one).

| command | what it shows |
| --- | --- |
| `/reqcap` | this session: totals, cache verdicts, last re-bills, causes, breakpoints |
| `/reqcap all` | the same over every session in `requests.jsonl` |
| `/reqcap trace [n]` | one line per request: verdict, tokens read and written, divergence |
| `/reqcap diff [seq]` | the full prefix comparison against the previous request |
| `/reqcap where` | output paths and the environment knobs |
| `/reqcap help` | the list, plus this process's running bust tally |

Every warning and every `diff` renders the same trace: the prompt part by part, in
wire order, with the first divergence marked.

```
prefix trace   #411 claude-opus-5-5 → #412 claude-opus-5-5
  breakpoints  same  system[1](1h), system[2](1h), messages[45].content[0](1h)
  tools        same  41 tools 1cc11ddf8d
  params       same  {"model":"claude-opus-5-5","max_tokens":32000}
  system[0]    same      34952ch
  system[2]    !! changed 40773ch → 37501ch (-3272)  bbbb → cccc
      mcp_servers            502ch → absent
      advertised_subagents   1402ch → absent
  messages     !! first divergence at messages[46] of 47
      46 assistant 1204ch 3f2a → assistant 1180ch 9b1c
      matched 46 messages, array 46 → 47
```

A long trace is written to `traces/` too, so its tail is not lost to a toast.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `PI_REQCAP_DIR` | `~/.local/share/pi-reqcap/out` | output root |
| `PI_REQCAP_BODIES` | `1` | `0` writes no payloads at all |
| `PI_REQCAP_MAX_BODIES` | `200` | payload files kept, oldest rotated out |
| `PI_REQCAP_MAX_LOG_BYTES` | `16777216` | `requests.jsonl` rotates to `.1` past this |
| `PI_REQCAP_NOTICE_MIN_TOKENS` | `20000` | re-billed tokens worth a warning toast |

Payloads are full prompts on disk, so they are written only for a request that
actually paid, and `PI_REQCAP_BODIES=0` removes them entirely.

## Cost

No extra model calls and no extra tokens. Per chat request it hashes the message
array and the tools array once — on a 200k-token prompt that is order ~1 MB of
hashing, against the request itself. Everything runs inside `try`/`catch`: a
diagnostics failure must never break a request, so a Pi change that moves an event
makes this plugin silent rather than fatal. `rewrites.log` opens with a `start` line
per process, which is how you tell silence from a plugin that is not loaded.

## Install

Loaded like any Pi extension. From this repository:

```json
{ "pi": { "extensions": ["./extensions/index.ts"] } }
```

or ad hoc for one session: `pi -e <path>/extensions/index.ts`.
