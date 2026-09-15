export const SCOPE_RESULT_VERSION = "2.0" as const;

export type ScopeScenarioType = "code" | "response";
export type ScopeClassification =
  | "prerequisite"
  | "idiomaticUse"
  | "dependencyCurrency"
  | "configurationCorrectness";
export type ScopeCheckState =
  | "passed"
  | "failed"
  | "inapplicable"
  | "prerequisite-blocked"
  | "error";

export interface ScopeEvidenceReference {
  kind: "trajectory" | "diff" | "artifact" | "workspace" | "judge";
  path?: string;
  trajectoryId?: string;
  eventIndex?: number;
  description?: string;
}

export interface ScopeCriterionResult {
  name: string;
  classification: ScopeClassification;
  state: ScopeCheckState;
  reason: string;
  evidence: ScopeEvidenceReference[];
}

export interface ScopeGateResult {
  name: "select" | "build" | "test" | "run";
  state: ScopeCheckState;
  reason: string;
  prompt?: string;
  evidence: ScopeEvidenceReference[];
  defects?: ScopeDefectSummary;
}

export interface ScopeDefectRootCause {
  category: string;
  count: number;
  description: string;
}

export interface ScopeDefectSummary {
  rawCount: number;
  rootCauses: ScopeDefectRootCause[];
}

export interface ScopeOutputMetrics {
  codeGenerated: boolean;
  defects: ScopeDefectSummary;
}

export interface ScopeBehaviorObservation {
  behavior: string;
  category: string;
  extensionPointSurface: string;
  sourceArtifact: string;
  evidence: string;
  trajectoryId: string;
  eventIndex: number;
}

export interface ScopeRootCause {
  label: string;
  section: "fix" | "create" | "constraint";
  source: string;
  hostAssessment?: {
    status: "suitable" | "no-suitable-host" | "not-applicable";
    artifact?: string | undefined;
    rationale: string;
  } | undefined;
  affectedDimensions: Array<Exclude<ScopeClassification, "prerequisite">>;
  behaviorChain: string;
  evidence: string;
  trajectoryId?: string;
  eventIndex?: number;
}

export interface ScopeUsageEvidence {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost?: { provider: string; unit: string; amount: number };
  trajectories: Array<{ trajectoryId: string; eventIndexes: number[] }>;
}

export interface ScopeError {
  stage: "capture" | "evidence" | "judge" | "infrastructure";
  message: string;
  criterion?: string;
  gate?: string;
  affectsVerdict?: boolean;
}

export interface ScopeProjection {
  passed: boolean;
  score: number;
  selectPassed: boolean;
  eligibleForComparison: boolean;
  description: string;
}

export interface ScopeResult {
  schemaVersion: typeof SCOPE_RESULT_VERSION;
  scenarioType: ScopeScenarioType;
  trajectoryId: string;
  gates: {
    select: ScopeGateResult;
    build: ScopeGateResult;
    test: ScopeGateResult;
    run: ScopeGateResult;
  };
  criteria: ScopeCriterionResult[];
  eligibleForComparison: boolean;
  behaviorObservations: ScopeBehaviorObservation[];
  rootCauses: ScopeRootCause[];
  outputMetrics?: ScopeOutputMetrics;
  usage: ScopeUsageEvidence;
  artifacts: ScopeEvidenceReference[];
  errors: ScopeError[];
  projection: ScopeProjection;
}
