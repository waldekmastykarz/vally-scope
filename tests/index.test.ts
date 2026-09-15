import { describe, expect, it, vi } from "vitest";
import { registerGraders, ScopeGrader } from "../src/index.js";

describe("registerGraders", () => {
  it("registers exactly one composite Scope grader", () => {
    const register = vi.fn();
    registerGraders({ register } as never);

    expect(register).toHaveBeenCalledOnce();
    const grader = register.mock.calls[0]?.[0] as ScopeGrader;
    expect(grader).toBeInstanceOf(ScopeGrader);
    expect(grader.metadata.behavior).toEqual({
      requiresLlmClient: true,
      requiresWorkspace: true,
    });
  });
});