import { describe, expect, it } from "vitest";
import { parseScopeGraderConfig } from "../src/config.js";

const prerequisite = (name: string) => ({
  name,
  classification: "prerequisite",
  instructions: "required",
});

describe("Scope grader configuration", () => {
  it.each([1, 2])("accepts %i prerequisite criteria", (count) => {
    expect(() =>
      parseScopeGraderConfig({
        model: "judge",
        scenario_type: "code",
        criteria: Array.from({ length: count }, (_, index) => prerequisite(`p${index}`)),
      }),
    ).not.toThrow();
  });

  it.each([0, 3])("rejects %i prerequisite criteria", (count) => {
    const criteria = [
      ...Array.from({ length: count }, (_, index) => prerequisite(`p${index}`)),
      { name: "quality", classification: "idiomaticUse", instructions: "quality" },
    ];
    expect(() =>
      parseScopeGraderConfig({ model: "judge", scenario_type: "code", criteria }),
    ).toThrow(/one or two prerequisite/);
  });

  it("accepts gate prompt overrides without a pass threshold", () => {
    const parsed = parseScopeGraderConfig({
      model: "judge",
      scenario_type: "code",
      criteria: [prerequisite("p")],
      gates: { build: { prompt: "npm install" } },
    });
    expect(parsed).not.toHaveProperty("pass_threshold");
    expect(parsed.gates.build?.prompt).toBe("npm install");
  });
});