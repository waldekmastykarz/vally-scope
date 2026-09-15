import type { GraderRegistry } from "@microsoft/vally";
import { ScopeGrader } from "./grader.js";

export * from "./contract.js";
export * from "./config.js";
export * from "./projection.js";
export * from "./readout.js";
export * from "./narrative.js";
export * from "./reporter-contract.js";
export * from "./reporter.js";
export * from "./atif-reporter.js";
export * from "./grade-result-reporter.js";
export { ScopeGrader } from "./grader.js";

export function registerGraders(registry: GraderRegistry): void {
  registry.register(new ScopeGrader());
}
