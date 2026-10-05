# Vally Scope

This package exposes a composite Vally grader named `scope` and an experiment-level
Scope reporter. The grader preserves
Scope's per-run method: independent criterion judges, Select qualification,
conditional Build/Test/Run verification, and trajectory-based behavior analysis.
The reporter owns cross-profile aggregation, deterministic cost calculation,
evidence-backed intervention generation, and the structured readout.

## Build and test

```sh
npm install
npm run build
npm test
```

## Configuration

```yaml
defaults:
  judge_model: claude-opus-4.8

graders:
  - type: scope
    config:
      scenario_type: code
      gates:
        build:
          prompt: Build this project.
        test:
          prompt: Run the tests generated for this project.
        run:
          prompt: Run this project and verify it starts successfully.
      criteria_instructions: Judge only the files under src/.
      criteria:
        - name: Uses the required product
          classification: prerequisite
          instructions: Pass only when the implementation uses Contoso DB.
        - name: Uses current APIs
          classification: dependencyCurrency
          instructions: Pass only when all dependencies and APIs are current.
```

Vally injects `defaults.judge_model` into the Scope grader and uses it for every
judge session. `scenario_type` is `code` or `response`. Optional
`criteria_instructions` are prepended to every criterion judge prompt, before
the criterion's own `instructions`, so shared context such as definitions and
judging rules is authored once. Scope requires one or
two `prerequisite` criteria; all must pass.
Select controls comparison eligibility, not evidence collection. Remaining
criteria are still judged when Select fails so a reporter receives the complete
per-run record, while Select-failed runs remain comparison-ineligible.

Select runs before the mechanical gates. When Select fails or errors, Build,
Test, and Run do not execute and are recorded as failed. Remaining quality
criteria are still judged to preserve the intentionally complete per-run record.

Build with an explicit prompt uses a structured workspace judge to execute the
authored success criteria, including dependency restoration when requested.
Without a Build prompt, Scope detects and executes a deterministic command; a
code scenario fails Build when no command can be determined. Standalone Python
files use `python3 -m compileall .` by default. Test is deterministic and is
reserved for actual generated tests; when none are present, Test is
inapplicable. When Run has an explicit prompt, a structured workspace judge
executes the safe checks needed to apply those success criteria and returns
pass, fail, or inapplicable. Without an explicit Run prompt, Scope executes the
detected start command and passes only when it exits with code 0; a process that
remains active past the startup window fails.

The prompt defaults are:

- Build: `Build this project.`
- Test: `Run the tests generated for this project. If the agent generated no tests, report this check as inapplicable.`

Run intentionally has no default prompt because absence selects zero-exit
semantics. Configure `gates.run.prompt` when success requires a different
observable condition, a safe execution path, or an explicit inapplicable case.

Each gate runs in a fresh workspace copy. Test runs only after Build passes.
Run runs only after Build passes and Test passes or is inapplicable. For
code scenarios, a failed gate prevents following gates from executing and those
gates are also recorded as failed. For `response` scenarios, all three execution
gates are inapplicable. A quality criterion can still fail when tests were
required but absent.

Criterion judging is retried up to three times. Every attempt receives a fresh
judge session and workspace copy.

Set `behavior.enabled: false` to disable behavior analysis. Scope consumes
Vally's normalized trajectory events and metrics, so it works with live
executor runs and persisted trajectories used for re-grading. Original ATIF
input is normalized by Vally before the grader runs.

Behavior analysis is diagnostic enrichment. A behavior-analysis failure is
recorded in `metadata.scope.errors` with `affectsVerdict: false` and does not
turn an otherwise valid grader verdict into an error. Failed gates or criteria
prevent the behavior judge from labeling execution as `CorrectOutcome` or
`CorrectButInefficient`.

The grader declares `requiresWorkspace` and `requiresLlmClient` in code. Vally
always passes the normalized trajectory and preserves the final workspace for
this grader. Scope consumes Vally's captured `workspacePatch`, `diff`, or
`diffPath` when available; no executor output selection belongs in the eval
configuration. For live runs, Scope preserves `trajectory.json` and
`workspace.patch` under each `.scope-*/scope/evidence` directory and copies
both into the isolated behavior judge workspace.

## Run with Vally

Vally 0.16 loads grader plugins for `lint`, `eval`, and `grade`:

```sh
vally lint \
  --eval-spec tests/fixtures/scope-grader/eval.yaml \
  --grader-plugin ../../../dist/index.js

cat tests/fixtures/scope-grader/trajectory.atif.json | vally grade \
  --eval-spec tests/fixtures/scope-grader/eval.yaml \
  --stimulus scope-fixture \
  --workspace tests/fixtures/scope-grader/workspace \
  --artifact-dir .evals/scope-grader/.artifacts \
  --grader-plugin ../../../dist/index.js
```

Plugin paths resolve relative to the eval file's directory.

Vally 0.16 can load both plugin entry points from `.vally.yaml`:

```yaml
plugins:
  grader:
    - ./dist/index.js
  reporter:
    - ./dist/index.js
```

The reporter is also available through `--reporter-plugin ./dist/index.js`.
No Vally core changes, custom executor, or dashboard integration are included.

## Grade result reporter

The reporter writes each trial's complete parsed grade to `grade-result.json` in
that trial's existing Vally output directory. This preserves the aggregate
verdict, recursively nested grader evidence, and structured metadata outside the
combined `results.jsonl` file. For retried trials, the file is written to the
final attempt directory.

The grade result reporter is registered independently from the ATIF reporter and
requires no environment setting. Vally exposes its output root at run completion,
so the reporter retains completed grade results until then and locates trial
directories through their Vally-generated `metadata.json` files.

## ATIF reporter

The reporter converts each completed Vally trajectory to ATIF v1.8 with
`atifact`. The root agent is written as `trajectory.json` in the trial's existing
Vally output directory; subagents are written beside it as
`trajectory.<agent-id>.json`. For retried trials, files are written to the final
attempt directory. Trials that fail before producing a trajectory do not produce
ATIF files.

The ATIF reporter is always registered and requires no environment setting. It
retains converted trajectories until Vally exposes its output root at run
completion, then locates trial directories through their `metadata.json` files.

## Scope reporter

The reporter treats experiment variants as profiles and writes two files beside
Vally's run artifacts:

- `scope-readout.manifest.json` contains immutable trial inputs, the complete
  agent environment, exact Scope grader configuration, trajectory metadata,
  criterion verdicts and evidence, artifact references, usage, expected and
  missing counts, duplicate IDs, policy provenance, and explicit finalization
  status.
- `readout.json` contains the schema-validated three-layer Scope readout. It is
  written only after all validation succeeds.

The readout surfaces criterion evidence in criteria breakdowns and per-run
results. Its run metadata retains the lossless environment, grader configuration,
trajectory metadata, typed criterion evidence, artifact references, and usage
from the sidecar. This keeps the readout schema-compatible while preserving data
that does not have a dedicated top-level schema field.

For code scenarios, the grader records `outputMetrics.codeGenerated` from
Vally's preserved baseline-to-final `workspace.patch`. Any non-empty patch means
the agent created, changed, renamed, or deleted at least one file. Build, Test,
and Run also record compiler, linter, and runtime diagnostics as a raw defect
count grouped by diagnostic code or message. The reporter surfaces these as
per-run `results.codeGenerated` and `results.defects`, profile-level average
defects and code-generation rate, and Select-qualified defect deltas.

Declare the bare baseline explicitly for multi-profile experiments:

```sh
SCOPE_BASELINE_VARIANT=bare vally experiment run experiment.yaml
```

Set `SCOPE_TARGET_PROFILE` when an experiment has more than one non-baseline
profile. It accepts a profile ID or a unique profile name (the variant name);
profile IDs are stable composites printed in the manifest. Profiles in one
readout may use different models, so a model-comparison experiment produces a
single readout with per-profile cost priced at each profile's model. Set
`SCOPE_READOUT_OUTPUT` to persist collection checkpoints during the run; without
it, the terminal manifest is written beside Vally's run artifacts. The reporter
always synthesizes experiment-wide findings and Layer 3 diagnosis with Copilot;
optionally select the synthesis model with `SCOPE_READOUT_MODEL`.
If synthesis fails, finalization fails and no partial `readout.json` is emitted.

For standalone replay, call `finalizeScopeReadoutFromJsonl(jsonlPath,
manifestPath, options)` from this package. The sidecar supplies profile and
baseline metadata that Vally's JSONL does not persist. Replay never reruns the
agent or grader.

```ts
import { finalizeScopeReadoutFromJsonl } from "vally-scope";

const result = await finalizeScopeReadoutFromJsonl(
  ".evals/results.jsonl",
  ".evals/scope-readout.manifest.json",
  { outputDirectory: ".evals", targetProfileId: "<profile-id>" },
);
if (result.status === "failed") throw new Error(result.error);
```

Select-failed runs remain in `runs` and behavior aggregation. They contribute
zero through the headline score's cascade rule, and are excluded only from
token, defect, and cost delta cohorts. Cost arithmetic is loaded from the
bundled `references/pricing.md`; the manifest records the policy version,
source, and SHA-256 digest.

Layer 3 uses an explicit suitable-host assessment recorded with each new root
cause. A Fix names the existing relevant artifact. A Create action is rejected
unless the evidence explicitly establishes that no suitable target-profile host
exists. Arbitrary extension presence does not suppress Create.

Vally isolates reporter exceptions, so the reporter records success or failure
in `scope-readout.manifest.json` and does not alter Vally's verdict or exit code.
Cancelled, failed, duplicate, missing, incompatible, or schema-invalid
experiments do not produce `readout.json`. A successful manifest finalization
therefore guarantees that the emitted `readout.json` validates against the
bundled `references/readout.schema.json` using JSON Schema Draft 2020-12.

## Vally projection

The grader projects Scope into Vally's `passed` and `score` fields as follows:

- `score` is passed criteria divided by all configured criteria.
- Select must pass. Other criteria do not control the Vally pass/fail projection.
- Results with authoritative grading errors are not eligible for comparison.
- `score` still reports the fraction of all configured criteria that passed.
- Infrastructure, judge, capture, or evidence errors force `passed: false` and
  `status: error` without converting them into criterion failures.

This projection is for Vally compatibility. The Scope reporter owns the
authoritative experiment-level score and comparisons.

## Shared result contract

Every result carries `metadata.scope`, a `ScopeResult` with
`schemaVersion: "2.0"`. It contains:

- gate states: `passed`, `failed`, `inapplicable`, `prerequisite-blocked`, or
  `error`
- criterion verdicts, reasons, classifications, and evidence
- Select eligibility for downstream quality/cost comparison
- behavior observations and root causes with Vally trajectory/event identities
- patch-derived code generation and execution-diagnostic defect metrics
- original usage metrics and durable artifact references
- typed capture/evidence/judge/infrastructure errors
- the documented Vally projection

See `tests/fixtures/scope-grader/scope-result.v2.json` for a reporter-consumable example.
