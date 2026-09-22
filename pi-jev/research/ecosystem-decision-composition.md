# Research: How other Jev/TypeSafe-based Pi guards compose decisions, handle uncertainty, and calibrate

*Survey date: 2026-09-22. All repos cloned locally (shallow, default branch) and read directly; citations are `repo/file:line` against those checkouts plus verbatim quotes. URLs are given for location only, not as evidence in themselves.*

## Summary

Every mature guard in this ecosystem converges on the same answer to the pi-jev problem: **the uncertain band exists, but it is made *unreachable by construction*** — questions are split into "permission" questions (which must resolve) and "hazard detector" questions (whose mid-band is ignored), thresholds are placed inside *measured empty gaps* between pass and reject clusters rather than at round numbers, and uncertainty resolves per-question by role (block / warn / steer / trace-only / proceed), never by a single global "defer to human". pi-jev-auto-mode is the one fail-closed exception and it documents, in its own calibration log, exactly why its early design that resembled yours ("treat every unclear as ask") approved almost nothing: absence-of-hazard questions cluster at 0.75–0.98 and can never satisfy a high bar. Defer/escalate survives only where it is *measured to be rare* — pi-warden holds 3 calls per 1,000 and considers that number its headline metric.

**Directly relevant to your 17-of-18 defer rate:** jomatsu/pi-jev-auto-mode README:51-57 describes your exact failure mode from its own history — "Under a single 0.95 bar, above half of all conditions landed in the middle band and every call became a confirmation" — and fixes it with mode/severity classification, not by lowering the bar globally.

---

## Repos surveyed (all accessible; none were forks of each other)

| Repo | Role | URL |
|---|---|---|
| jomatsu/pi-jev-auto-mode | fail-closed auto-approval gate (bash/write/edit) | https://github.com/jomatsu/pi-jev-auto-mode |
| Nyarlathoteppppp/pi-heed | conversational-constraint enforcement, deep experiment log | https://github.com/Nyarlathoteppppp/pi-heed |
| DevMortimer/pi-warden | multi-guard supervisor, published calibration numbers | https://github.com/DevMortimer/pi-warden |
| y0usaf/pi-jev | 4-question gate + output judge + jev_ask tool | https://github.com/y0usaf/pi-jev |
| leepokai/jev-guard | cross-host guard (Claude Code/Codex/pi/etc.), code-side policy | https://github.com/leepokai/jev-guard |
| alexsatch/omp-auto-mode | oh-my-pi safe/ask/unsafe classifier | https://github.com/alexsatch/omp-auto-mode |
| MoonTory/pi-jev-harness | route/prefetch/trim/loop/guard harness | https://github.com/MoonTory/pi-jev-harness |
| y0usaf-style small gates: shishiv/pi-jeev, HyunjunJeon/pi-quiet-ask | bounded decision tool; declarative question packs | https://github.com/shishiv/pi-jeev · https://github.com/HyunjunJeon/pi-quiet-ask |
| dizk/jev-lens | context view selection (adjacent, not a gate) | https://github.com/dizk/jev-lens |
| Jabbslad/pi-jev-tools | typed Jev tools (no gate), eval discipline | https://github.com/Jabbslad/pi-jev-tools |
| TheoOliveira/pi-jev | routing/skills; opt-in tool guard, gate CLI | https://github.com/TheoOliveira/pi-jev |
| legacybridge-tech/pi-typesafe-jev | five Jev tools; threshold philosophy | https://github.com/legacybridge-tech/pi-typesafe-jev |

*"pi-jev-harness" resolved to MoonTory/pi-jev-harness (a "Jev routes turns, guards tool calls" harness; matches the brief). "jev-lens" resolved to dizk/jev-lens (a Jev view-picker, not a guard) — the other jev-lens repos (rashedInt32, sahajamit) are stop-verdict/nvim/Chrome tools; not surveyed in depth. "pi-jev-tools" resolved to Jabbslad/pi-jev-tools.*

---

## 1. Decision composition: judge answers → actions

### pi-jev-auto-mode — two-sided thresholds × mode × severity, composed in code

The most explicit composition rule in the survey. From `src/jev/decide.ts:1-22` (header comment, verbatim):

> "Two symmetric thresholds per condition: p >= t → satisfied; p <= 1 - t → rejected … in between → the middle band. The middle band is not a bug to be squeezed out. … What the middle band *means* depends on the rule: required → the middle band is escalated (ask the user); hazard → the middle band is ignored, because 'no hazard is evident' is not the same as 'a hazard is present'."

Composition (`combine()`, `src/jev/decide.ts:102-111`):

> "1. A rejected `hazard`-severity rule blocks, whatever the user asked for. 2. A rejected `soft` rule is cleared when the intent condition is satisfied — the user's own words are the authority for actions they are entitled to request … 3. An unclear `required` condition escalates to a confirmation. 4. Otherwise the call is approved."

Unmapped/missing answers never become approvals: `observe()` defaults a missing answer to 0 — "A missing answer must not become an approval" (`src/jev/decide.ts:58-64`) — and the engine rejects a response with missing keys outright (`docs/security.md:66`: "A condition answered by fewer than all keys | block (`malformed_response`) — a missing answer is never an approval").

### leepokai/jev-guard — an explicit decision ladder in code, including an intent-lift

`README.md:100-113` (verbatim, where `risk` is a 4-level score 0–3 and `approval`/`user_requested`/`from_untrusted` are nouls):

```
deny   if from_untrusted ≥ 0.7
deny   if risk ≥ 2.5
allow  if (risk ≥ 1.5 or approval ≥ 0.75) and user_requested ≥ 0.85
ask    if risk ≥ 1.5 or approval ≥ 0.75
allow  otherwise
```

> "A yes turns **ask** into **allow** (never lifts a deny)." — `README.md:105`

Note this is the closest thing in the ecosystem to your "plausibly aligned → don't defer" band: a call that would `ask` on risk/approval is *promoted to allow* when the session context independently confirms the user asked for exactly this.

### alexsatch/omp-auto-mode — fire/clear two-threshold bands, mid-band = ask but scoped

`src/classifier.ts:27-32` (verbatim): "`>= fire`: the hazard holds and its severity applies. `[clear, fire)`: genuinely uncertain; a human should decide. `< clear`: the hazard is absent." Routing (`src/classifier.ts:186-197`): any fired `unsafe`-severity hazard → `unsafe`; else any fired hazard **or** any *specific* hazard in `[clear, fire)` → `ask`; else `safe`. Defaults `{ fire: 0.7, clear: 0.3 }` (`src/classifier.ts:36`). Crucial scoping (README:40, verbatim):

> "The catch-all only counts when it fires outright; its mid-range means 'mildly consequential', not 'unsure', so it never prompts on its own."

The catch-all hazard `other_risk` is marked `fireOnly: true` (`src/classifier.ts:150`) and is excluded from the uncertain→ask set (`src/classifier.ts:190-192`). This is a deliberate mechanism to keep the vague "something's off" question from generating defers.

### DevMortimer/pi-warden — severity ladder + per-question action roles

Final level (`docs/guards.md:188`): "`deny` → `deny`, `destructive`/`sensitive` → `confirm`, `risky` → `warn`, none → `allow`." Escalation only *raises* severity and only on high confidence (`docs/guards.md:183`): "Escalation fires when Jev confidence **strictly exceeds** `action.escalationThreshold` (default 0.85)". Pattern hits in the default *evidence mode* are sent to the judge as `floor_hits` but "they do not set the hold level. The judge's `irreversible` score against the configured thresholds decides warn and confirm" (`docs/guards.md:16`) — i.e., the deterministic layer informs; the calibrated judge decides. Questions have different *action rights* learned from measurement: `irreversible` at 0.7 holds, `off_task` warns and steers but "Off-task never holds" (`docs/guards.md:17`), `should_proceed` "steers but never holds" and was in fact demoted to trace-only after calibration (see §4).

### y0usaf/pi-jev — simple OR-of-thresholds, confidence gate only on the score dimension

`src/gate.ts:138-147` (verbatim): "A verdict is blockable when any dimension crosses its threshold. Thresholds are set from the measured separation between ordinary work and the state they are meant to catch: ordinary requested edits score up to 0.85 on `destructive` and 0.72 on `beyond_scope`, so those thresholds sit above that band rather than at a round 0.7." Impact (a score) additionally requires `impactConfidence >= config.gate.minConfidence` (`src/gate.ts:165-169`); README:105: "`minConfidence` gates that dimension only, because the three noul questions return a probability and no confidence." No defer/ask band at all in the verdict rule — flagged → confirm (enforce) or notify (shadow).

### shishiv/pi-jeev — abstain as a first-class output, stakes-tiered policy

`README.md:20-23`: "abstain: the evidence, support, probability, or margin was too weak; review_required: the decision was marked high stakes. The extension never executes the selected action. `abstain` and `review_required` deliberately return `recommendation: null`." The seed policy (`README.md:93-97`): low stakes recommend at top-p ≥ 0.60, margin ≥ 0.12; medium at 0.75/0.20; "**high** | n/a | Always require review". And an explicit warning: "These are application policy, not universal TypeSafe thresholds. Change them only against labeled evaluations and the cost of wrong actions." (README:99).

### HyunjunJeon/pi-quiet-ask — declarative rules over answers

Packs define questions plus ordered rules `if <expr> then {do: block|allow|steer|...}`; "`allow` stops evaluation" (README:97). Triage of user-facing questions: auto-submit only at "option p ≥ 0.9 **and** determined ≥ 0.9"; suggest at p ≥ 0.5; below that "untouched" (README:336-338).

### Common pattern

Every project keeps composition **in code, never in the model**: pi-jev-auto-mode `decide.ts:20-21` "Composition is done here, in code, so the model never has to weigh concerns against each other"; jev-guard README:92 "Jev is asked narrow, typed questions; the policy lives in code"; pi-typesafe-jev README:261 "keep thresholds, weights, and actions in code or with a human."

---

## 2. Uncertainty: blocking vs no-signal

**The ecosystem's core move: uncertainty is per-question-role, not global.**

- **pi-jev-auto-mode** distinguishes *verdict* from *effective verdict* (`src/jev/decide.ts:37-50`): for `hazard`-mode rules, mid-band is recorded as `uncertain` but *treated as satisfied* — verbatim: "A `hazard` rule that lands in the middle band is treated as satisfied, because 'no hazard is evident' is not the same as 'a hazard is present'." Unclear is **no-signal → proceed** for hazard questions, and **blocking** only for the single `required` permission question — whose threshold (0.60) is deliberately placed in a measured *empty gap* (0.15–0.77) so the mid-band is almost never entered (see §4). The user-facing knob: `/jev-auto-mode uncertain deny|ask|allow`, default **deny** (README:72-75: "**Nothing is delegated to the user by default.** The middle band — where Jev is neither satisfied nor rejecting — resolves to a block, so Jev's probability is the whole answer and the gate never takes over the screen.").
- **pi-heed**: unclear is **abstain**. README:141: "Uncertain? | guesses | **abstains** (`insufficient`) or fails open". Free-text violations: "Block on Jev only at p ≥ 0.9 and confidence ≥ 0.8; otherwise fail open" (EXPERIMENTS.md:77). Every choice question has "an explicit `unclear`" (README:52) and "Anything uncertain changes nothing." Its `PI_HEED_BUMP` feature is a third way between allow and block: "an unsure free-text violation stops the first attempt and asks the model to check with you in chat" (README:172) — block once, identical retry passes (`src/index.ts:380-392`).
- **omp-auto-mode**: mid-band on specific hazards → ask ("genuinely unsure", README:37); mid-band on the catch-all → nothing.
- **pi-warden**: uncertainty doesn't map to one action; the *question* is demoted or promoted by measured usefulness. `should_proceed` (AUC 0.26 vs regret) became trace-only: "The question is trace-only by default until calibrated: AUC against regret is 0.26 and the default threshold of 0.6 flags 44% of non-read-only calls" (`docs/guards.md:84`).
- **pi-jeev**: abstain returns null; never executes.
- **pi-heed / pi-warden base-rate evidence on how rare escalation should be:** pi-warden's action hold fired 48/18,075 calls (0.27%) at shipped defaults; pi-heed's replay went from 1,013 blocks → 95 after fixing over-blocking (both quoted in §4).

**Interpretation (mine, not any source's):** your "any unclear → defer" treats every question as if it were pi-jev-auto-mode's single `required` question. pi-jev-auto-mode's answer is that there should be exactly one such question (intent), its threshold should sit in a measured gap so the band is nearly unreachable, and every safety question should be a hazard detector whose unclear band means "no evidence of harm" → proceed.

---

## 3. Unattended / auto modes, timeouts, fail-open vs fail-closed

**Nobody implements time-based auto-approve/auto-dismiss of a pending decision.** There is no "if nobody answers in N seconds then allow" anywhere in the survey. The pattern instead is: the decision is made synchronously in the `tool_call` hook (a ~300ms Jev call, not a human dialog), so there is no pending state to time out; and where a human dialog would block headless runs, extensions specify fallbacks explicitly:

- **jomatsu/pi-jev-auto-mode — the fail-closed pole.** README:5-7: judges "semantically and **fails closed** whenever a decision cannot be made." `docs/security.md:48` (verbatim): "Everything below resolves to **block**. Silence is never consent." The failure table (`docs/security.md:50-66`) covers: no engine, bad key, timeout/connection error, 5xx/429 after retries, unrecoverable 4xx ("not rethrown, so the gate cannot fail open"), malformed/missing answers, state over budget, engine throw, Esc-cancelled request, mid-band with default `uncertain: deny`, and "No UI available for a confirmation when `uncertain: ask` | block (`no-ui`)". Timeout config: `timeoutMs: 4000`, `maxRetries: 1` (README:188-191, `src/settings.ts:83-84`). A "confirmation is not a bypass" (`docs/security.md:68-69`): it runs only on `uncertain`, never on `deny` or no-decision.
- **Nyarlathoteppppp/pi-heed — the fail-open pole.** README:181: "**Fails open.** Jev error or timeout (2.5 s) → pi behaves as if pi-heed weren't installed." Plus "**Budgeted.** At most 3 interventions per agent run" (README:184) and "**Shadow by default**" (README:180).
- **leepokai/jev-guard** — configurable, fail-open default: "By default jev-guard fails **open** with a warning on stderr: a dead API must not freeze your agent. Flip it if you'd rather it did." (README:170; `JEV_GUARD_FAIL_CLOSED`, README:166). Timeout 20s total including retries (README:159, "hosts kill hooks at ~30 s").
- **DevMortimer/pi-warden** — configurable: "If TypeSafe cannot answer, the call is allowed with a warning (`failOpen: true`; set it to `false` to hold instead)" (`docs/guards.md:25`); `timeoutMs: 5000` default, "On timeout the call is allowed with a warning when `action.failOpen` is true" (`docs/configuration.md:71`). Project config files "cannot … raise timeouts or budgets" (`docs/faq.md:53`).
- **y0usaf/pi-jev** — "Every error path fails open. A missing key, a timeout, a 429, or a malformed response produces no verdict and the tool call proceeds." (README:30). Headless: "Headless runs (`-p`, RPC) cannot show a prompt, so enforcement falls back to the same warning unless you set `gate.blockWithoutUI`" (README:28).
- **alexsatch/omp-auto-mode** — fail-over to the host's permission system rather than open or closed: "If the classifier itself is unreachable, the call falls through to omp's normal approval instead of failing closed" (README:58).
- **Auto-approve of *decisions* (not timeouts):** pi-quiet-ask triage auto-submits a question only at p ≥ 0.9 + determined ≥ 0.9 and logs whether Jev's pick **agreed** with the user's eventual answer, tracked as the calibration signal ("the number that tells you whether the thresholds are right", README:344-345). pi-warden's steer budget caps self-correction loops at 3 per run, with critical steers (stuck/done/runaway/wake) exempt (`docs/guards.md:305`).

---

## 4. Calibration: measured numbers, tuning, labelled data

### pi-heed — the deepest published calibration in the ecosystem

Benchmark progression (README:58-66, verbatim table; 79 scripted sessions / 261 labelled decisions at v0.8):

| | recall | false block | task success |
|---|---|---|---|
| v0.3.0 + Jev | 71.4% | 5.2% | 61.2% |
| v0.4.0 + Jev | 95.2% | 0.6% | 93.9% |
| v0.6.0 + Jev | 97.8% | 0.0% | 98.2% |
| **v0.8.0 + Jev** | **98.5%** | **0.0%** | **98.7%** |

Probability calibration (EXPERIMENTS.md E05, `EXPERIMENTS.md:116-117`): "p 0.9–1.0 → 98% true; 0.7–0.9 → 94%; 0.0–0.1 → 7%" — over 70 labelled items × 3–6 phrasings. Near-deterministic: "Five identical requests: typically ±0.02, one jump 0.64 → 0.44."

Real-session replay (E17, `EXPERIMENTS.md:478-527`): 21 sessions, 594 messages, 9,090 tool calls; v0.7.4 made 424 rules and blocked 1,013 calls in 14 sessions — "most came from one habit: '先别改，先看看和我讨论' … These are holds: 'not yet'" — and the go-ahead threshold (0.9) was above what short go-ahead replies score (0.77–0.89). After re-tuning go-ahead to "p ≥ 0.75 & conf ≥ 0.65 for holds" (measured 12/14 right, 0 false lifts, `EXPERIMENTS.md:502-506`): 1,013 → 95 blocks, 42 → 16 incidents.

Threshold philosophy, twice stated (E08 `EXPERIMENTS.md:200-201`): "Thresholds unchanged: tuning them on these two cases would be fitting the test set." And pi-jev-auto-mode's version (below): thresholds belong in **gaps**, not at cluster edges.

Labelled-data collection: `/heed label n <good|bad> [note]` CLI (README:219) plus a /heed review list; "real logs (`/heed log`, `/heed label`) feed the benchmark from now on" (EXPERIMENTS.md:128).

### pi-warden — AUC tables and the regret base rate

`docs/guards.md:61-67` (calibration replay of 321 sessions, 1,085 labelled turns, 17,160 guarded calls):

- "Regret is rare: 20 calls (2% of turns). None of them was about data loss: their `irreversible` scores were 0.04 to 0.57, median 0.07. … The hold rule catches none of them at any threshold that holds fewer than 3% of calls, so the hold defaults stay where they are; they are a checkpoint for destructive actions, and regret is the wrong yardstick for those." (verbatim, `docs/guards.md:63`)
- AUC against regret: `mutates` 0.74, `irreversible` 0.71, `intent_mismatch` 0.57, `off_task` 0.51. "Off-task alone caused 56 of the 139 replay holds and none of them drew a complaint, so since 0.12 off-task warns and steers but never holds" (`docs/guards.md:64`).
- Intent-steer threshold tradeoff (`docs/guards.md:65`): "At 0.8 it fires on 11% of calls that can change something and 14% of those sit in a turn the user rejects (base rate 5%); at 0.9 it fires on 4% and 33% of those are in a rejected turn, 54% in one the user rejects or corrects (base rate 24%). The default is 0.9."
- `should_proceed`: "AUC against regret: 0.26 … At threshold 0.6, 44% of calls are flagged" → trace-only (`docs/guards.md:73,84`).
- Latest calibration replay (`docs/guards.md:118`): 315 sessions, 18,195 guarded calls; hold rate 0.27%; "The user regretted 27 calls, and the two sets do not intersect: precision 0%, recall 0%, in every project and at every threshold that holds fewer than 2% of calls." Hold *precision vs user approval*: "Of the 119 holds made live in those sessions, the user's next message approved 43" (`docs/guards.md:118`); earlier: "2 of 13 labeled holds stood, the other 11 cleared on retry" (README:79).
- Headline framing (README:79, verbatim): "**3 holds per 1,000 calls. The other 997 run.**"
- Overnight stability: "13,952 guard cases across 109 cycles with no score drift" (README:73). A/B: control violated a project rule 6 times vs Warden 0 (README:71).
- Subagent wake guard: 8 labelled reports, all matched at threshold 0.8 after question sharpening; "a hard failure sits at 0.81, one hundredth above the threshold, so the threshold is doing real work and a failure report is the boundary case to watch" (`docs/guards.md:292`).
- Conscience guard: no threshold met its 95%-precision gate, so "the guard stays disabled by default and trace-only" (`docs/guards.md:161`) — an example of shipping *zero* until measured.

### jomatsu/pi-jev-auto-mode — band-based thresholds on 13 fixtures, with documented mistakes

`docs/calibration.md` is a narrative of three design errors, each with numbers (all verbatim):

1. **"Absence of a hazard" questions cluster between 0.75 and 0.98** (`calibration.md:51-57`): "Asking 'does this tool call avoid sending secrets to a network endpoint' about `uv run pytest` does not return 0.99; it returns 0.88, because the honest answer is 'probably, but I cannot be certain from this text'. Under a single 0.95 bar, above half of all conditions landed in the middle band and every call became a confirmation. Making these questions `required` is a category error."
2. **"Asking about a policy that does not exist poisons everything"** (`calibration.md:59-62`): "'does this violate `context.policy`' returned 0.66–0.85 on all twelve fixtures — the model hedges when asked to certify compliance with nothing."
3. **"A rejection boundary of `p <= 0.01` is unreachable"** (`calibration.md:64-66`): clear "no" answers measure 0.02–0.03.

The general lesson (`calibration.md:144-145`): "a threshold should be chosen so that no measured answer sits near it. Both mistakes here came from picking the strict end of a band instead of the middle of a gap." The intent question's measured gap: "0.15 → 0.77: nothing the model answered landed between those values, so any threshold in that range separates perfectly and 0.80 was simply the strict end of nothing. Now 0.60" (`calibration.md:133-135`). Caveat stated up front (`calibration.md:21-25`): "This is one sample per fixture … reruns moved some conditions by ±0.05 … Treat the numbers as evidence about *bands*, not as exact values."

Also: gating the gate — "A gate calibrated only on attacks will block ordinary work" (`calibration.md:97`), and the e2e lesson that the deterministic layer missed `curl -X POST -d @~/.ssh/…` entirely, so fixture evaluation must run the gate, not just the engine (`calibration.md:112-125`).

### y0usaf/pi-jev — smoke calibration, honestly labelled

README:126-145: six gate states, several runs each. Key finds: requested `sed -i` scores destructive 0.73–0.77 ("a threshold of 0.7 would have prompted on every `sed -i`"); `beyond_scope` separates 0.10–0.74 vs 0.90–0.98 with threshold "mid-gap at 0.85, because the same state moved by ±0.05 between runs"; and phrasing: the first destructive question ("cannot be recovered from version control") scored a real `rm -rf src && git push --force` at 0.77 — "because 'it is in git' is a reasoning path the model happily takes. Asking plainly whether the action is destructive separates the same pair 0.03 against 0.99." Self-assessment (README:145): "Six states and a handful of runs each is a smoke calibration, not a labelled evaluation set. It is enough to reject obviously wrong thresholds and not enough to switch the gate to enforce by default." Output judge: 53 fixtures × 3 runs; leak question "no overlap at all: 0.92 and above against 0.02 and below"; a below-confidence class answer "appends nothing" (README:167-169).

### leepokai/jev-guard — live-measured verdict table, thresholds as env vars

README:35-43 table (measured 2026-09-17 through the AI Gateway, ≈580 ms/call): `ls -la`/`npm test` risk 0.0–0.1 → allow; `git commit && git push` risk 2.0, approval 0.77–0.78 → ask; `curl … | sh`, `rm -rf /` risk 3.0 → deny. All six thresholds env-tunable (README:60-69). Instruction-file questions tuned against 662 real installed skills: "none crossed the line (the highest legitimate skill scored `unrelated_side_effects` 0.74), while planted samples scored exfiltration 0.99" (README:122).

### Jabbslad/pi-jev-tools — negative results published

README:155-159: a 42-session eval "showed no quality gain and higher cost/latency"; a 77-item BANKING77 pilot: "similar label accuracy; the small sample did not establish superior calibration"; retrieval pilot: "autonomous Pi used Jev in only 1/8 enabled sessions. … This does **not** establish an out-of-the-box workflow benefit." Also README:67: thresholds from callers are "unvalidated, not calibrated defaults or permission to act."

---

## 5. Question and state design

- **Batch questions; latency is flat in question count** (pi-heed E01, `EXPERIMENTS.md:45-52`): "One Jev decision, 1 / 4 / 8 questions | median 274 / 273 / 276 ms … 8 questions as 8 parallel requests | ~650 ms. … Always ask all questions in one request." pi-warden likewise: slop questions "ride on the action guard's request (no extra latency)" (`docs/guards.md:226`); pi-jev-auto-mode: "one request per judgment" (README:280). Corollary (pi-heed E17): merging a second request into the main one cut Jev calls per task 2.57 → 1.82 with same answers (`EXPERIMENTS.md:517`).
- **But all questions share one state, and state can poison a question** (pi-heed E12, `EXPERIMENTS.md:103-115`): the go-ahead question scored 0.98 alone but 0.81 inside pi-heed; A/B over 19 messages: shared state with policy list caught 5/9 lifts, shared state + `earlier_policy` path 4/9, **own minimal request (`new_user_message` + `earlier_policy` only) 8/9, 0 false lifts**. Verbatim lesson: "Asking many questions in one request costs no latency, but they all read the same state. A question that other context distracts should get its own request, in parallel."
- **Field order matters** (E05, `EXPERIMENTS.md:122-125`): pending call + messages *before* the old constraint moved confident answers 75% → 100%; "Stating 'later messages override earlier ones' reached 100% (13/14 …, 0 confident errors)."
- **Ask about intent, not a taxonomy** (E05, `EXPERIMENTS.md:120-121`): lift detection `KEEP/LIFT/NARROW/…` 71% → "is this the user's go-ahead to start making changes?" 93%, confident answers 100% right.
- **Ask exactly what you mean: explicit vs implied** (E06, `EXPERIMENTS.md:146-160`): "May the assistant modify tests?" after "look but don't touch" answered "forbidden" 27/91 times ("asks what is *implied*"); asking "did the user **explicitly** forbid changing tests?" fixed it. TypeSafe's correction is quoted: questions are evaluated independently, so bleeding was the question's fault, not interference.
- **Structured `{question, focus}` + true/false criteria helps for some judgements, not all** (E09 table, `EXPERIMENTS.md:~226-236`): read-only 7/9→9/9, tool relevance 5/8→8/8 safe skips, 0 wrong; but go-ahead and exception checks *got worse*. "Adopt structured questions for read-only, push and tool relevance; keep prose for the others."
- **Option sets beat yes/no only when options truly exclude each other, and always include an `unclear` escape** (E05/E06; README:121: "every choice has an `unclear` escape").
- **Voting/ensembles don't help** (E05, `EXPERIMENTS.md:126-127`): "errors are correlated across phrasings. Better questions helped; averaging mostly cost coverage."
- **Voting analogue with sibling tool calls:** pi-warden judges "sibling tool calls in one assistant message … together in one round trip" (`docs/guards.md:25`); omp-auto-mode classifies "every tool call in exactly one API request" (`src/classifier.ts:47-52`).
- **noul vs choice vs score usage in practice:**
  - *noul* for single propositions with an explicit boundary: pi-jev-auto-mode's conditions; jev-guard's `approval`/`user_requested`/`from_untrusted`; pi-quiet-ask's `rewrites_history`. pi-heed adds confidence gating to noul-derived decisions (block at p ≥ 0.9 **and** confidence ≥ 0.8).
  - *choice* for mutually exclusive classes with an `unclear`/`insufficient` escape: pi-heed's `violates/complies/insufficient`, `restricts_assistant/not_a_rule/unclear` (13/13 vs 0/18 real rules dropped at p ≥ 0.96 / ≤ 0.19, `EXPERIMENTS.md:454-457`); y0usaf's `failure_class` with minConfidence 0.6.
  - *score* for degrees: jev-guard's 4-level `risk`; omp's hazard severities are a code-level mapping over nouls instead; y0usaf's 4-level `impact` rubric gated by confidence ≥ 0.5; pi-jeev's margin-over-runner-up over choice distributions.
- **State composition / size effects:** pi-jev-auto-mode caps state (`maxStateCharacters: 120000`, README:196) and blocks on overrun (`state_too_large`) rather than truncating silently; E01 measured 3.3 KB vs few-byte state costs +30–60 ms. pi-warden: "One request stays well inside Jev's context window. The caps do the work" (`docs/guards.md:45`). pi-heed E01's wider lesson: "the floor is Jev's ~250 ms server time … What can change is *when* a decision starts" — pre-judging while the model streams (edit/write judged "as soon as the streamed `path` is complete") got a real block to "0 ms" wait.
- **Never ask Jev what deterministic code already knows** (pi-heed README:124): "'an edit changes files': p ≈ 0.7" — side effects/paths stay in rules; Jev judges meaning only.
- **Skippable-question design:** pi-jev-auto-mode's `requiresPolicy` / `requiresProtectedTarget` / `requiresFlagged` / `requiresReason` flags (`src/jev/questions.ts:59-73`) mean many hazard questions only run when the deterministic layer flags a relevant situation — which both cuts noise and keeps hedge-prone questions out of ordinary calls.

---

## 6. Lessons for pi-jev

### Adopt

1. **Split questions into permission vs hazard, and give the unclear band a per-role meaning** — pi-jev-auto-mode's `required`/`hazard` × `hazard`/`soft` 2×2 (`src/jev/questions.ts:26-39`, `decide.ts:1-22`). Hazard mid-band = proceed; permission mid-band = escalate; clear hazard rejection = block; soft rejection cleared by satisfied intent. *(Direct evidence: `decide.ts:64`, `combine()` composition order.)*
2. **Place thresholds inside measured empty gaps, not at round numbers** — pi-jev-auto-mode: intent gap 0.15→0.77, threshold 0.60 ("0.80 was simply the strict end of nothing"); y0usaf: "thresholds sit above that band rather than at a round 0.7" (`gate.ts:138-141`); "a threshold should be chosen so that no measured answer sits near it" (`calibration.md:144-145`). This is the single most direct cure for 17/18 defers: if unclear were rare by measurement, defer would be rare by construction. *(Interpretation: the sources state the method; applying it to your 17/18 case is my inference.)*
3. **Make the escalation budget a headline, measured metric** — pi-warden's "3 holds per 1,000 calls" framing, hold-feedback labelling ("What you do next labels each judgment", `docs/guards.md:39`), and the two-sided outcome question (a `regretted` noul riding the next action request). pi-quiet-ask's `agreed` counter for auto-answers. Build the same loop for defers.
4. **One request, many questions; isolate only the distracted question** — E01 (latency flat) + E12 (shared-state trap, own-request 8/9 vs 5/9). Your six gate questions fit one request; the user-intent-conflict question is the candidate for its own minimal state.
5. **Give every choice an explicit `unclear`/`insufficient` escape and treat it as "no signal", not "signal against"** — pi-heed (abstain, fails nothing changes), pi-jev-auto-mode hazard mode, pi-jeev abstain.
6. **Add an intent-confirmation lift, like jev-guard's `user_requested ≥ 0.85` promotes ask→allow (never deny→allow)** — the ecosystem's mechanism for "risky but plausibly aligned" to proceed without a human, bounded by hazard-severity rules that intent cannot clear (secret egress, injection).
7. **Two-sided thresholds** (`p ≥ t` pass, `p ≤ 1−t` reject) so "clearly no" is reachable — pi-jev-auto-mode; and remember the floor: "clear 'no' answers measure 0.02–0.03", so reject bands must reach ≥ 0.03 (`calibration.md:64-66,105-110`).
8. **Deterministic floor + evidence mode**: patterns provide `floor_hits` as evidence; the judge decides the level; "the agent's plan can add a nudge but never remove a hold" (`docs/guards.md:43`). Keeps 99.7% of calls auto-allowed without being blind.
9. **Publish negative results and demote questions that don't earn their action** — pi-warden demoting `should_proceed` to trace-only on AUC 0.26; conscience guard disabled until a measured policy exists; pi-heed's E06 self-correction.

### Avoid

1. **A single global threshold bar over hazard-flavored questions.** Documented failure with numbers: pi-jev-auto-mode's first run "approved almost nothing" (`calibration.md:48-57`); pi-heed's v0.3 at 5.2% false-block / 61% task success. Your 17/18 defer rate is this failure mode.
2. **Treating unclear as blocking on *absence-of-harm* questions.** They honestly score 0.75–0.98 ("probably, but I cannot be certain from this text") and can never clear a high bar (`questions.ts:6-13`, `calibration.md:51-57`).
3. **Asking a question whose premise doesn't exist** — the phantom-policy poisoning (0.66–0.85 on all fixtures). Analogous trap for pi-jev: don't send an empty/absent plan field and then ask "does this call match the plan"; skip the question instead (`requiresPolicy` pattern).
4. **Asking "implied" instead of "explicitly"** (E06: 27/91 false adds) — e.g., "does this risk violating scope?" invites inference; "did the user explicitly forbid this?" separates cleanly.
5. **Taxonomy-style option sets for intent** (KEEP/LIFT/NARROW at 71% vs the go-ahead question at 93%).
6. **Recovery-from-"cannot be recovered from git" phrasing** — reasoning-path phrasing collapsed a 0.03/0.99 separation to 0.77 (y0usaf README:143).
7. **One-time calibration on attack-only fixtures** — "A gate calibrated only on attacks will block ordinary work" (`calibration.md:97`); include "should pass" fixtures, and evaluate the whole gate, not just the engine (`calibration.md:112-125`).
8. **Voting/ensembles as an uncertainty fix** — correlated errors, worse coverage (E05).
9. **Model-side composition** — every project keeps thresholds/weights/actions in code; no guard asks Jev for a final verdict that includes the action.

### Fail-open vs fail-closed (the one real contradiction)

- **Fail-closed**: pi-jev-auto-mode alone ("Silence is never consent", every failure → block) — appropriate because it *replaces* the permission system in unattended mode.
- **Fail-open**: pi-heed, y0usaf/pi-jev, jev-guard (default), pi-warden (default), pi-quiet-ask shadow default — appropriate because they *augment* a supervised session and fail-open avoids freezing work.
- **Fail-over**: omp-auto-mode falls back to the host's normal approval prompt.
- pi-warden makes it a config knob and restricts what project files may change it (`failOpen`, `docs/guards.md:25`; `docs/faq.md:53`). Contradiction is real but explained by role: **a guard that is the permission system must fail closed; a guard that is an advisory layer fails open.** pi-jev's position in the permission chain determines which side of this you should be on — and note that pi-jev-auto-mode still lets *users* choose `uncertain: ask|allow`, i.e. fail-closed is the default, not a mandate.

### Contradictions and tensions between sources

- **pi-warden hold precision 0% vs regret** (`docs/guards.md:118`) vs its own claim that holds are valuable — not smoothed by the source: it explicitly concludes "regret is the wrong yardstick for [destructive actions]" and keeps holds for a different objective (irreversibility checkpoint). Do not read the 0% as "holds don't work"; read it as "hold-ability and regret measure different things."
- **pi-heed thresholds (0.9/0.8 block, 0.75/0.65 go-ahead) vs pi-jev-auto-mode (0.60 intent)** — not a contradiction: pi-heed's 0.9 is on free-text *block* decisions where it wants conservatism ("E05 suggests 0.9 is conservative; revisit with labelled real-session data", README:278), while pi-jev-auto-mode's 0.60 sits in a measured empty gap for its one required question. Different questions, different gaps.
- **Batching**: E01 says never split requests; E12 says the go-ahead question needs its own request. pi-heed's own resolution: "This refines E01" (`EXPERIMENTS.md:113`) — batch by default, isolate state-distracted questions.

### Missing evidence / unverified

- **No repo reports defer-rate or AUC for a "defer" action specifically** — the closest are pi-warden's hold rate (0.27%) and intent-steer fire rates (11%/4%). pi-jev's "defer" band has no ecosystem analogue with published rates; treat pi-warden's hold rate as the nearest proxy only.
- **pi-jev-auto-mode's calibration is 13 fixtures, one sample per fixture** (its own caveat, ±0.05 drift); y0usaf's is a self-described smoke test; jev-guard's table is a single live run per call class. pi-heed and pi-warden are the only sources with labelled-set-grade numbers.
- **Nobody measured whether question count per se affects accuracy** (only latency and shared-state interference); the "one question alone vs batched" evidence is E12's state-poisoning A/B, not a question-count effect.
- **TypeSafe's official docs** were consulted only via pi-heed's E09 citations (docs.typesafe.ai pages); I did not independently fetch them, so claims attributed to TypeSafe authoring guidelines carry pi-heed's reading, not mine.
- TheoOliveira/pi-jev's tool-call guard is opt-in with no published calibration; its `jev-gate` CLI is a post-hoc pass/fail gate (exit 0/1 at a probability threshold, default 0.70, README:75) with no uncertainty band — thin evidence, excluded from the adopt/avoid lists.

## Sources

- Kept (all read in full or in relevant part, local clones):
  - jomatsu/pi-jev-auto-mode — README.md, docs/calibration.md, docs/security.md, src/jev/questions.ts, src/jev/decide.ts, src/extension.ts, src/settings.ts — closest architectural cousin; fail-closed + band design.
  - Nyarlathoteppppp/pi-heed — README.md, EXPERIMENTS.md (E01–E19), src/gate.ts, src/index.ts, src/types.ts — the calibration playbook.
  - DevMortimer/pi-warden — README.md, docs/guards.md, docs/configuration.md, docs/faq.md — the escalation-rate and AUC playbook.
  - leepokai/jev-guard — README.md — code-side policy ladder, intent lift, fail-open default.
  - alexsatch/omp-auto-mode — README.md, src/classifier.ts — fire/clear bands, fireOnly catch-all.
  - y0usaf/pi-jev — README.md, src/gate.ts — threshold-in-gap method, phrasing evidence.
  - MoonTory/pi-jev-harness — README.md, jev.ts, tools.ts — compact guard, askConfidence gate.
  - shishiv/pi-jeev — README.md — abstain/review_required, stakes tiers.
  - HyunjunJeon/pi-quiet-ask — README.md — declarative packs, triage auto-answer + agreed metric.
  - Jabbslad/pi-jev-tools — README.md — eval discipline and negative results.
  - dizk/jev-lens — README.md, STATUS.md — measured view selection (context only).
  - TheoOliveira/pi-jev — README.md — gate CLI, opt-in guard (minor).
  - legacybridge-tech/pi-typesafe-jev — README.md — result-reading guidance, "confidence is not permission".
- Rejected: rashedInt32/jev-lens and sahajamit/jev-lens (different projects, stop-verdicts/Chrome, not gates); zszz3/Pi-Jev-Guide (empty description, not read); awesome-jev lists (directories, not evidence).

## Next steps (only if useful)

1. Fetch https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md and /primitives/advanced.md directly to confirm the authoring guidelines pi-heed tested against (they underpin the structured-question findings).
2. If pi-jev keeps a defer/hold band, adopt pi-warden's outcome-labelling design (`docs/guards.md:39`, the `regretted` noul + hold-feedback files) so defer precision becomes measurable from day one.
