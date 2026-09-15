import { z } from "zod";

const classificationSchema = z.enum([
  "prerequisite",
  "idiomaticUse",
  "dependencyCurrency",
  "configurationCorrectness",
]);

const criterionSchema = z.object({
  name: z.string().min(1),
  classification: classificationSchema,
  instructions: z.string().min(1),
});

const gateSchema = z
  .object({
    prompt: z.string().min(1).optional(),
  })
  .optional();

export const scopeGraderConfigSchema = z
  .object({
    model: z.string().min(1),
    scenario_type: z.enum(["code", "response"]),
    criteria: z.array(criterionSchema).min(1),
    gates: z
      .object({
        build: gateSchema,
        test: gateSchema,
        run: gateSchema,
      })
      .default({}),
    behavior: z
      .object({
        enabled: z.boolean().default(true),
      })
      .default({ enabled: true }),
  })
  .superRefine((value, context) => {
    const prerequisiteCount = value.criteria.filter(
      (criterion) => criterion.classification === "prerequisite",
    ).length;
    if (prerequisiteCount < 1 || prerequisiteCount > 2) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Scope requires one or two prerequisite criteria",
      });
    }
  });

export type ScopeGraderConfig = z.infer<typeof scopeGraderConfigSchema>;

export function parseScopeGraderConfig(config: Record<string, unknown>): ScopeGraderConfig {
  return scopeGraderConfigSchema.parse(config);
}
