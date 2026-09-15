# Readout Generation Guide

Detailed computation rules, delta formulas, evidence linking, and worked examples for generating a structured readout JSON from benchmark run data.

## Folder discovery

### Layout detection

The scenario folder has two possible layouts:

- **Layout A (batch-timestamp wrapper):** Scenario folder contains ISO-timestamp subdirectories (e.g., `2026-04-28T131841068Z/`), each containing profile directories.
- **Layout B (flat):** Scenario folder contains profile directories directly (each has a `batch.json`).

To detect: list the scenario folder. If any immediate subdirectory contains `batch.json`, it's Layout B. Otherwise, treat subdirectories as batch-timestamp directories (Layout A).

### Batch selection (Layout A only)

A scenario folder may contain multiple batch-timestamp directories. Use the **lexicographically last** directory — ISO timestamps sort correctly.

### Profiles root

- Layout A: `<scenario-folder>/<latest-batch-timestamp>/`
- Layout B: `<scenario-folder>/`

All subsequent steps reference the **profiles root** as the directory containing profile subdirectories.

### Profile identification

Within the batch directory, each subdirectory is a profile. The directory name encodes the profile configuration but is not machine-parseable — extract profile metadata from the `run.json` files inside.

The **bare baseline** profile is identified by:
- `run.profile.isBaseline === true`, OR
- `run.profile.configuration.extensions === null` AND `run.profile.configuration.mcpServers === null`

### Layer 3 target selection

Layer 1 and Layer 2 include every profile. Layer 3 recommends changes for exactly one **target profile** so actions and denominators are unambiguous.

Select the target as follows:

1. One profile total: use that profile.
2. Bare plus one non-baseline profile: use the non-baseline profile.
3. Bare plus multiple non-baseline profiles: STOP and ask the user which single profile the action list should improve.
4. If the user says no profile is intended to address bare-model gaps: use bare as the target and generate extension opportunities from bare failures.
5. If no bare profile exists: select the only profile, or ask the user to choose when several profiles exist. Do not compute baseline comparisons without bare.

The action list remains schema-compatible by naming the selected target and baseline in `actionList.narrative`. All action evidence and frequency denominators must come from the selected target profile.

### Run discovery

Each profile directory contains:
- `batch.json` — pre-aggregated stats (use for cross-checking, not as sole source)
- One subdirectory per run, named by run ID, each containing `run.json` and `trajectory.json`

## Key data mappings

### run.json → readout schema

| run.json field | Readout schema location |
|---|---|
| `_id` | `runs[].id`, `evidenceRef.runId`, `profileResult.runIds[]` |
| `profile._id` | `metadata.profiles[].id`, `runs[].profileId` |
| `profile.name` | `metadata.profiles[].name` when a concise display override is useful |
| `profile.metadata.agent` | `metadata.profiles[].harness` |
| `profile.metadata.languageModel` | `metadata.profiles[].model` |
| `profile.metadata.extensions` | `metadata.profiles[].extensions` (split by ", ") |
| `profile.isBaseline` | `metadata.profiles[].isBaseline` |
| `profile.additionalInstructions` | `metadata.profiles[].additionalInstructions` |
| `scenario.name` | `metadata.title` |
| `scenario.scenarioType` | `metadata.scenarioType` |
| `scenario.instruction` | `metadata.instruction` |
| `criteria[].name` | Criterion identifiers for grouping |
| `criteria[].classification` | Maps to dimensions: `"prerequisite"` → Select gate, `"idiomaticUse"` → idiomatic, `"dependencyCurrency"` → dependencyCurrency, `"configurationCorrectness"` → configurationCorrectness |
| `results.gates` | `runs[].results.gates` |
| `results.criteriaResults` | `runs[].results.criteriaResults` |
| `results.tokens` | `runs[].results.tokens` |
| `results.requests` | `runs[].results.requests` |
| `results.defects` | `runs[].results.defects` |
| `results.codeGenerated` | `runs[].results.codeGenerated` |
| `results.durationsSeconds` | `runs[].results.durations` |
| `results.behaviorObservations` | `runs[].results.behaviorObservations` |
| `results.rootCauses` | `runs[].results.rootCauses` |
| `results.actions` | `runs[].results.actions` |
| `results.reason` | `runs[].results.reason` |

### batch.json → readout schema (cross-check source)

| batch.json field | Readout schema location |
|---|---|
| `gates.select.passed / .total` | `profileResult.select` |
| `gates.build` (when object) | `profileResult.build` |
| `dimensions.idiomaticUse` / `dimensions.dependencyCurrency` / `dimensions.configurationCorrectness` | ⚠️ **Do NOT feed into the Score.** These `batch.json` values are criteria-sums and the dimension rollup is retired for scoring. The Score pools per-criterion results directly (see "Score (headline)" below). If you populate the optional diagnostic `profileResult.idiomatic` / `.dependencyCurrency` / `.configurationCorrectness`, compute them dimension-level (x/N) from per-run criteria; they are context only, never scoring inputs. |
| `avgTokens` | `profileResult.tokens` |
| `avgRequests` | `profileResult.requests` |
| `avgDefects` | `profileResult.defects` |
| `codeGenerationRate` | `profileResult.codeGenerationRate` (divide by 100 to get 0-1) |
| `numRuns` | `metadata.runsPerProfile` |

## Scorecard computation

### Gate pass rates

For each gate (`select`, `build`, `test`, `run`, `deploy`):

```
passed = count of runs where gate.status === "pass"
total  = N (total runs for this profile)
```

The denominator is always N — the total number of runs for the profile. This keeps denominators constant across all profiles for the same scenario, so lift deltas are directly comparable. Runs where the gate was not reached (status `"fail"`, `"skipped"`, or downstream of a failed gate) contribute 0 to the numerator.

If **all** runs have gate status `"na"` (the gate is genuinely inapplicable to this scenario type), **omit** the gate from the profile result entirely.

**Special case:** `batch.json` may store gate values as the string `"na"` rather than an object `{ passed, total }`. This means all runs had that gate as `na` — omit it.

### Score (headline) — pooled pass rate over all checks

The headline **Score** is a single pooled pass rate over **all checks** for a profile: every gate and every quality criterion counted together.

```
gate_passes    = sum over gates g in {select, build, run, test, deploy} of g.passed   (each denom N)
gate_total     = sum over the SAME applicable gates of N
crit_passes    = sum over every quality criterion c of (count of the N runs where c passed)
crit_total     = sum over every quality criterion c of N

score = (gate_passes + crit_passes) / (gate_total + crit_total)          # 0-1
```

Rules:
- **Quality criteria** = every partner criterion classified as `idiomaticUse`, `dependencyCurrency`, or `configurationCorrectness`. **Exclude the `prerequisite` criterion** — it is the Select gate, already counted under gates.
- **Denominator is N with cascade.** Each criterion is counted over all N runs. A run that failed Select contributes 0 to every criterion (it produced nothing to satisfy it). A criterion with `result === "skipped"` in a run is excluded from both numerator and denominator for that run only.
- **Report fully inapplicable gates as `"N/A"`** and exclude them from both numerator and denominator. For a mixed cohort, include only applicable runs in that gate's denominator.
- Store as `profileResult.score`.

Also store the two diagnostic splits:

```
reliabilityScore = gate_passes / gate_total          # gates only
qualityScore     = crit_passes / crit_total           # criteria only
```

**Dimensions are diagnostic, not a scoring axis.** The classification (`idiomaticUse` / `dependencyCurrency` / `configurationCorrectness`) groups criteria for Layer 2 behavioral analysis and for `criteriaBreakdowns` — it does **not** produce a scorecard pass rate that feeds the Score. The old all-or-nothing dimension rollup ("a dimension passes a run only if all its criteria pass") is **retired for scoring**: it destroyed signal (e.g. an Idiomatic dimension where every run passes 18 of 19 criteria scored 0/5, hiding a 95%+ per-criterion pass rate). `profileResult.idiomatic` / `.dependencyCurrency` / `.configurationCorrectness` are optional diagnostic fields only; never let them drive the Score or Δ lift.

**Criteria-level pass rates** (for `criteriaBreakdowns`):

```
For criterion C:
  passed = count of Select-passing runs where C.result === "pass"
  total  = count of Select-passing runs where C.result !== "skipped"
```

Only include Select-passing runs in criteria breakdowns — runs that failed Select didn't attempt the correct task.

### Tokens, requests, defects (averages)

**Display averages** (shown in the scorecard row — computed over all runs):

```
profileResult.tokens   = round(mean(run.results.tokens for all runs))
profileResult.requests = round(mean(run.results.requests for all runs), 1)
profileResult.defects  = round(mean(defect_count for all runs), 1)
```

**Delta averages** (used only for Δ defects and Δ tokens computation — computed over Select-passing runs only):

```
delta_avg_tokens  = mean(run.results.tokens for runs where Select gate === "pass")
delta_avg_defects = mean(defect_count for runs where Select gate === "pass")
```

Runs that failed Select didn't attempt the correct task — their token counts and defect counts reflect a fundamentally different workload and would distort the comparison.

If a profile has 0 Select-passing runs, `delta_avg_tokens` and `delta_avg_defects` are undefined — the corresponding deltas are `null`.

Where `defect_count` is:
- `run.results.defects.rawCount` (if defects is an object)
- `run.results.defects` (if defects is an integer)
- `0` (if defects is null — response scenarios)

### Cost (USD) — the headline cost figure

The scorecard reports cost in **dollars**, not raw tokens. Reuse the pricing logic from the **calculate-model-cost** skill (`.github/skills/calculate-model-cost/`); its `references/pricing.md` is the source of truth for per-token rates (per 1M tokens), and it defines the exact token-category mapping.

Per run, read the trajectory's per-turn `metrics` and sum each category across all turns:

```
uncached_input = Σ (metrics.prompt_tokens - metrics.cached_tokens)
cached_input   = Σ metrics.cached_tokens
cache_write    = Σ metrics.extra.cache_creation_input_tokens        # Anthropic only; 0 if absent
output         = Σ metrics.completion_tokens
```

Then price with the profile's model rates from `pricing.md`:

```
run_cost_usd = uncached_input / 1e6 * input_rate
             + cached_input   / 1e6 * cached_input_rate
             + cache_write    / 1e6 * cache_write_rate      # Anthropic only
             + output         / 1e6 * output_rate
```

Rules:
- **Model rates:** look up the profile's `model` in `pricing.md`. For tiered models (a **Long context** tier), pick the tier by comparing the run's input token count against the listed threshold, exactly as the calculate-model-cost skill specifies. Claude models are not tiered.
- **If the model is missing from `pricing.md`,** the table may be stale — refresh it per that skill's "Keeping Pricing Current" before computing. Do not guess rates.
- **Averages:** `profileResult.avgCostUsd = mean(run_cost_usd over all runs)`.
- **Delta:** `deltaCostUsd = extension.avgCostUsd - baseline.avgCostUsd`, computed over **Select-passing runs only** (same rule as `deltaTokens` / `deltaDefects`), null for the baseline.
- Keep `profileResult.tokens` / `deltaTokens` as diagnostic context; the headline cost is `avgCostUsd`.

### Code generation rate

```
profileResult.codeGenerationRate = count(run.results.codeGenerated === true) / total_runs
```

Store as a decimal (0–1), not a percentage.

## Delta computation

All deltas compare an extension profile against the **bare baseline** profile (same scenario).

### Δ lift

Δ lift is simply the delta of the pooled Score vs. the bare baseline:

```
deltaLift = extension.score - baseline.score          # decimal; 0.096 = +9.6pp
```

Stored as a decimal in `profileResult.deltaLift` (null for the baseline). Because saturated gates add the same constant to every profile's Score, they cancel in the delta; non-saturated gates (e.g. bare fails to build, the extension makes it build) show up as real lift. There is no per-dimension averaging — the Score already pools every check.

### Δ defects

Uses **Select-passing runs only** for both profiles:

```
deltaDefects = (extension_delta_avg_defects - baseline_delta_avg_defects) / baseline_delta_avg_defects
```

Where `extension_delta_avg_defects` and `baseline_delta_avg_defects` are the averages computed from Select-passing runs (see "Delta averages" above).

If `baseline_delta_avg_defects === 0`, `deltaDefects` is `null` (division by zero — no baseline defects to compare against). If either profile has 0 Select-passing runs, `deltaDefects` is `null`.

Store as a decimal: `-0.89` means 89% reduction.

Code scenarios only. Omit for response scenarios.

### Δ tokens

Uses **Select-passing runs only** for both profiles:

```
deltaTokens = round(extension_delta_avg_tokens - baseline_delta_avg_tokens)
```

Where `extension_delta_avg_tokens` and `baseline_delta_avg_tokens` are the averages computed from Select-passing runs (see "Delta averages" above).

If either profile has 0 Select-passing runs, `deltaTokens` is `null`.

Absolute difference in token count (integer).

### Baseline profile

The baseline profile row has `null` for all delta fields — it is the reference point.

## Target-profile comparison

Compare every target criterion with baseline before building Layer 3. These classifications provide lift context; they are not additional JSON fields and do not determine whether a target gap is actionable.

| Status | Rule | Layer 3 treatment |
|---|---|---|
| `addressed` | Baseline is below 100% and target is 100% | No active action; target reached full success |
| `improved` | Target pass rate is higher than baseline but below 100% | Use failed target runs to identify residual fixes |
| `unchanged` | Target and baseline pass rates are equal | Act when target is below 100%; no action when target is 100% |
| `regressed` | Target pass rate is lower than baseline | Use failed target runs and attribute the regression to the target profile |

The target's gap to 100% success is the Layer 3 action threshold. Baseline explains comparative lift or drag only. Do not carry baseline root causes or actions into the target's action list; target-profile failures determine what remains actionable.

When bare itself is the target, retain baseline action mechanics: failures may produce Create opportunities when no suitable extension point exists.

## Behavior aggregation

### Grouping key

Behaviors from individual runs are aggregated by this composite key:

```
(behavior, category, extensionPointSurface, sourceArtifact_normalized)
```

`sourceArtifact_normalized`: Group by the **tool or artifact name**, not the full evidence text. For example, all `SkippedInvocation` behaviors targeting `mcp_azure_mcp_documentation` across runs are one group.

### Rate computation

```
rate.passed = count of runs exhibiting this behavior
rate.total  = total runs for this profile
```

### Mapping to readout schema

```
behaviorObservation.behavior    → behaviors[].behavior
behaviorObservation.category    → behaviors[].category (lowercase in readout schema)
behaviorObservation.extensionPointSurface → behaviors[].surface
behaviorObservation.sourceArtifact → behaviors[].source
```

Note: `category` in run.json uses PascalCase (`"Invocation"`), but the readout schema uses lowercase (`"invocation"`). Convert during mapping.

## Root cause aggregation and action list

### Action routing

Build Layer 3 from every criterion below 100% in the selected target profile only. For each failed target criterion, connect the target run's root cause and behavior chain to the failed criterion before creating an action. When the run has no precomputed root cause or action, inspect its trajectory and final output and derive an evidence-backed root cause; an empty precomputed field is not a reason to discard a measured failure.

Do not copy `rootCause.section` or `run.results.actions` into the readout without checking the target profile's available artifacts. The target context can change a bare Create proposal into an addressed gap or a Fix against an existing artifact.

Use this decision table:

| Target-profile situation | Readout treatment |
|---|---|
| Target criterion reaches 100% | Exclude from active actions |
| Target criterion is below 100%, regardless of baseline rate | Analyze failed target runs and emit a Fix, Create, or Constraint |
| Suitable artifact exists and contains adjacent content | Fix: extend the existing artifact |
| Suitable artifact exists but was not discovered | Fix its discovery surface or description |
| Suitable artifact was discovered but not invoked | Fix its invocation instructions |
| Suitable artifact contains misleading, stale, or incomplete guidance | Fix that artifact |
| No suitable host exists in the target profile | Create a new extension point |
| Evidence shows authored content cannot mitigate the issue | Constraint |

### Suitable host test

A suitable host is an existing target-profile artifact that is relevant to the failed criterion or covers adjacent scenario content. Determine suitability from profile configuration, behavior observations, source attribution, and the artifact content when available.

- A skill that was discovered and correctly invoked for the scenario is normally a suitable host for adjacent static or procedural guidance.
- A broadly related extension may still be unsuitable for a distinct capability it does not cover.
- The presence of any arbitrary skill is not enough to suppress Create.
- When a suitable host exists, follow the readout design's extend-first rule. Do not propose a second general-purpose skill for the same domain.

### Stale training data

`StaleTrainingData` is the bare-model condition authored extensions are intended to mitigate. Never emit it as a fixed constraint solely because it appears in bare runs.

- If the target resolves the associated criterion failure, omit it from Layer 3.
- If the target fails and a suitable host exists, emit a Fix against that host, its discovery surface, or its invocation guidance.
- If the target is bare or no suitable host exists, emit Create.
- Emit Constraint only when evidence shows the remaining behavior cannot be mitigated through authored content or a product surface change.

### Grouping and frequency

Root causes from individual runs are aggregated by:

```
(label, final_section, normalized_source_artifact_or_fix_target)
```

Aggregate only within the selected target profile. Findings with the same label but different source artifacts remain separate.

Count distinct affected run IDs, not root-cause occurrences:

```
runs.passed = count(distinct target run IDs exhibiting the grouped finding)
runs.total  = total runs in the target profile
```

One run may contain several root-cause records in the same group, but it contributes at most one to `runs.passed`.

### Mapping to action list sections

| `rootCause.section` | Action list section | Required fields |
|---|---|---|
| `"fix"` | `actionList.fix[]` | priority, rootCause, runs, description, fixTarget |
| `"create"` | `actionList.create[]` | priority, gap, runs, whatToBuild |
| `"constraint"` | `actionList.constraints[]` | priority, rootCause, runs, description, affected |

### Populating fix items

For each fix root cause group:

```json
{
  "priority": <computed>,
  "rootCause": "<rootCause.label>",
  "runs": { "passed": <distinct_affected_target_runs>, "total": <target_profile_runs> },
  "description": "<merge run.results.actions.fix[].behaviorChain texts>",
  "fixTarget": "<merge run.results.actions.fix[].fixTarget + description>",
  "ownership": "<from run.results.actions.fix[].ownership>",
  "evidence": [<evidenceRefs>]
}
```

### Populating create items

```json
{
  "priority": <computed>,
  "gap": "<rootCause.source or actions.create[].gap>",
  "runs": { "passed": <count>, "total": <total> },
  "whatToBuild": "<from run.results.actions.create[].proposal>",
  "type": "<from run.results.actions.create[].type>",
  "rationale": "<from run.results.actions.create[].rationale>",
  "evidence": [<evidenceRefs>]
}
```

### Populating constraint items

```json
{
  "priority": <computed>,
  "rootCause": "<rootCause.label>",
  "runs": { "passed": <count>, "total": <total> },
  "description": "<from rootCause.behaviorChain or actions.constraints[].description>",
  "affected": "<join rootCause.affectedDimensions>",
  "mitigation": "<from run.results.actions.constraints[].mitigation>",
  "evidence": [<evidenceRefs>]
}
```

### Priority formula

```
priority_score = runs_affected × count(affectedDimensions)
```

Sort descending by `priority_score`. Assign integer priorities starting at 1. Items in `fix`, `create`, and `constraints` share a global priority namespace.

Priority is computed only across the selected target profile's unresolved actions. Criteria where the target reaches 100% are excluded before ranking.

## Evidence linking

### Principle

Every aggregate claim in the readout is backed by per-run evidence. The `evidenceRef` object creates a traceable chain:

```
readout claim → evidenceRef.runId → runs[].id → run.json → trajectory.json
```

### Constructing evidenceRef objects

**For criteria pass rates:**

For each criterion in `criteriaBreakdowns`, add one `evidenceRef` per run that contributed to the pass rate:

```json
{
  "runId": "<run._id>",
  "criterionName": "<criterion name>",
  "excerpt": "<run.results.criteriaResults[name].reason>"
}
```

Include ALL runs (both passing and failing) — failing runs are evidence too.

When a criterion has many runs (e.g., 5), include evidence for all of them. When generating for a large number of criteria × runs, it is acceptable to include only the **failing** runs' evidence (since pass reasons are less diagnostic) plus a sample of passing runs.

**For behavior observations:**

```json
{
  "runId": "<run._id>",
  "turnNumber": "<behaviorObservation.turnNumber>",
  "excerpt": "<behaviorObservation.evidence>"
}
```

**For action items (fix, create, constraints):**

Use the root cause evidence and the action's behaviorChain:

```json
{
  "runId": "<run._id where rootCause was observed>",
  "excerpt": "<rootCause.evidence>"
}
```

### When to include trajectory stepId

Including `stepId` requires reading `trajectory.json`, which is large. Include it when:

1. The user explicitly asks for trajectory-level traceability
2. The behavior has a `turnNumber` and the trajectory is small enough to scan

To find the stepId: read `trajectory.json`, find `steps[turnNumber]` (0-indexed), and use its `step_id`.

## Worked example: criteria breakdown with evidence

Given a profile with 5 runs where criterion "Uses @azure/cosmos" results are:

| Run ID | Result | Reason |
|---|---|---|
| aaa111 | pass | "package.json declares @azure/cosmos ^4.2.0..." |
| bbb222 | pass | "Found @azure/cosmos import in src/db.js..." |
| ccc333 | pass | "Uses CosmosClient from @azure/cosmos..." |
| ddd444 | fail | "Code still uses mongodb driver..." |
| eee555 | pass | "package.json includes @azure/cosmos..." |

Produces:

```json
{
  "description": "Uses @azure/cosmos",
  "passRate": { "passed": 4, "total": 5 },
  "evidence": [
    { "runId": "aaa111", "criterionName": "Uses @azure/cosmos", "excerpt": "package.json declares @azure/cosmos ^4.2.0..." },
    { "runId": "bbb222", "criterionName": "Uses @azure/cosmos", "excerpt": "Found @azure/cosmos import in src/db.js..." },
    { "runId": "ccc333", "criterionName": "Uses @azure/cosmos", "excerpt": "Uses CosmosClient from @azure/cosmos..." },
    { "runId": "ddd444", "criterionName": "Uses @azure/cosmos", "excerpt": "Code still uses mongodb driver..." },
    { "runId": "eee555", "criterionName": "Uses @azure/cosmos", "excerpt": "package.json includes @azure/cosmos..." }
  ]
}
```

## Worked example: behavior aggregation with evidence

Given 5 runs for the "Azure MCP + Skills" profile where 3 runs show SkippedInvocation for the documentation tool:

| Run ID | Behavior | Turn | Evidence excerpt |
|---|---|---|---|
| aaa111 | SkippedInvocation | 5 | "Agent never named or considered this tool..." |
| bbb222 | SkippedInvocation | 4 | "Agent provided explanation from base model..." |
| ccc333 | SkippedInvocation | 6 | "Documentation tool available but not invoked..." |

Produces:

```json
{
  "category": "invocation",
  "behavior": "SkippedInvocation",
  "rate": { "passed": 3, "total": 5 },
  "surface": "MCPTools",
  "source": "mcp_azure_mcp_documentation",
  "evidence": [
    { "runId": "aaa111", "turnNumber": 5, "excerpt": "Agent never named or considered this tool..." },
    { "runId": "bbb222", "turnNumber": 4, "excerpt": "Agent provided explanation from base model..." },
    { "runId": "ccc333", "turnNumber": 6, "excerpt": "Documentation tool available but not invoked..." }
  ]
}
```

## Narrative generation guidance

### scorecard.keyFinding

Summarize in 2-3 sentences: which profile performs best on Select, whether extension points provide positive or negative lift vs. bare baseline, and the token cost tradeoff. Lead with the most surprising finding.

### scorecard.criteriaAnalysis

Identify criteria that are:
- **Persistent failures** (0/N or 1/N across all profiles) — these remain unresolved, but may have different profile-specific root causes
- **Addressed or improved baseline gaps** — target pass rate is higher than bare
- **Extension regressions** — target pass rate is lower than bare
- **Universally passing** (N/N across all profiles) — these confirm the model handles them without help

Do not infer a shared root cause from pass rates alone. Root cause and action attribution comes from the selected target profile's behavior chains and source artifacts.

### behaviorAnalysis.profiles[].narrative

For each profile, state:
1. What the agent did consistently (5/5 behaviors)
2. What it skipped or misused (and why — connect to extension point design)
3. The execution outcome pattern

### actionList.narrative

Begin with: "This action list targets <target profile> and compares it with <baseline profile>." Then bridge every target criterion below 100% to its root cause. Use baseline to explain lift or drag, but do not suppress an unresolved target gap because it improved over baseline. Do not present target criteria at 100% as active actions.

### summary.profileVerdicts

One-line per profile: "Best performer", "No improvement over bare", "Net drag — skill actively diverts agent", etc. Include the Select rate and key metric.

## Response vs. code scenarios

For **response scenarios** (`scenarioType: "response"`):

- Omit `build`, `test`, `run`, `deploy` gates from `profileResult` (they are all `na`)
- Omit `defects` and `deltaDefects`
- Omit `codeGenerationRate` (or set to null)
- Dimensions are evaluated against the response text, not generated code

For **code scenarios** (`scenarioType: "code"`):

- Include all gates
- Include `defects` and `deltaDefects`
- Include `codeGenerationRate`

## Edge cases

### Empty rootCauses / actions

When a run has `rootCauses: []` and no `actions` field, that run contributes no root causes. The action list aggregates only from runs that have findings.

### Multiple profiles

Do not merge root causes or action frequencies across profiles in a scenario readout. Other profiles remain visible in Layer 1 and Layer 2, but Layer 3 uses the selected target only. A separate action list per target requires a future schema extension or a separate readout.

### Target profile contains a relevant skill

If a relevant skill is discovered and correctly invoked, do not emit a generic "create a skill for this product" action. Attribute remaining failures to missing or misleading content in the existing skill, its supporting references, the product CLI/API, or a genuinely uncovered capability.

## Final validation

After writing `readout.json`, validate it with a JSON Schema Draft 2020-12 validator and format checking enabled. Validation must be executable, not mental. Also assert:

1. Every action evidence `runId` belongs to the selected target profile.
2. Every action `runs.passed` is at most `runs.total`.
3. `runs.total` equals the selected target profile's run count.
4. Every target criterion below 100% has an action or evidence-backed constraint, and no target criterion at 100% appears as an active action.
5. No Create item proposes a new artifact when a suitable host exists.
6. Every local `runs[].trajectoryRef` resolves relative to the scenario folder.

### Criteria with "skipped" result

A criterion result of `"skipped"` means the criterion is not applicable to this run (e.g., "Uses @azure/cosmos" when the agent recommended staying on MongoDB API). Exclude from both numerator and denominator.

### batch.json gate as string

When `batch.json` stores a gate as the string `"na"` instead of `{ passed, total }`, all runs had that gate as `na`. Write it to `profileResult` as `"N/A"`.

### Missing trajectory.json

If `trajectory.json` doesn't exist or can't be parsed, omit `stepId` from evidence references. The readout is still valid without trajectory-level linking.
