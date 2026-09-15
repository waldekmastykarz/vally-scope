import type { ScopeResult } from "./contract.js";

export const SCOPE_REPORTER_MANIFEST_VERSION = "1.0" as const;
export const READOUT_POLICY_VERSION = "2026-09-11" as const;
export const PRICING_POLICY_VERSION = "2026-09-11" as const;

export interface ScopeReporterProfile {
  id: string;
  name: string;
  harness: string;
  model: string;
  extensions: string[];
  isBaseline: boolean;
  environment: Record<string, unknown>;
}

export interface ScopeReporterCriterion {
  name: string;
  classification: string;
  instructions?: string;
}

export interface ScopeReporterTrial {
  itemId: string;
  runId: string;
  evalName: string;
  evalFilePath: string;
  variant: string;
  stimulusName: string;
  instruction: string;
  trialIndex: number;
  totalTrials: number;
  status: "success" | "error" | "skipped";
  error?: string;
  skipReason?: string;
  durationMs: number;
  profile: ScopeReporterProfile;
  criteria: ScopeReporterCriterion[];
  graderConfig: Record<string, unknown>;
  trajectoryMetadata: Record<string, unknown>;
  scope?: ScopeResult;
  trajectoryRef?: string;
  artifactRefs: ScopeResult["artifacts"];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    requests: number;
  };
  trajectoryEvents: unknown[];
}

export interface ScopeReporterManifest {
  schemaVersion: typeof SCOPE_REPORTER_MANIFEST_VERSION;
  createdAt: string;
  updatedAt: string;
  status: "collecting" | "completed" | "failed" | "cancelled";
  finalization: {
    status: "pending" | "succeeded" | "failed";
    readoutPath?: string;
    error?: string;
  };
  provenance: {
    graderContract: string;
    readoutPolicy: string;
    pricingPolicy: string;
    pricingSource: string;
    pricingSha256: string;
    producer?: { name: string; version: string };
    synthesis?: { model: string; policy: string };
  };
  expected: {
    totalItems: number;
    itemIds: string[];
    missingCount: number;
  };
  diagnostics: {
    duplicateItemIds: string[];
    missingItemIds: string[];
    messages: string[];
  };
  profiles: ScopeReporterProfile[];
  trials: ScopeReporterTrial[];
}

export interface ScopeFinalizeOptions {
  outputDirectory: string;
  targetProfileId?: string;
  judgeModel?: string;
}

export interface ScopeFinalizationResult {
  status: "succeeded" | "failed";
  readoutPath?: string;
  manifestPath: string;
  error?: string;
}
