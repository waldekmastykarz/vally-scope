import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRICING_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "references", "pricing.md");

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface PricingRate {
  model: string;
  tier: "default" | "long";
  threshold?: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

const pricingPolicy = readFileSync(PRICING_PATH, "utf8");
const rates = parsePricing(pricingPolicy);

export const pricingPolicySha256 = createHash("sha256").update(pricingPolicy).digest("hex");

export function calculateModelCost(model: string, usage: TokenUsage): number {
  const normalized = normalizeModel(model);
  const candidates = rates.filter((rate) => rate.model === normalized);
  if (candidates.length === 0) throw new Error(`No current pricing policy for model: ${model}`);
  const defaultRate = candidates.find((rate) => rate.tier === "default") ?? candidates[0]!;
  const longRate = candidates.find((rate) => rate.tier === "long");
  const rate = longRate && defaultRate.threshold != null && usage.inputTokens > defaultRate.threshold
    ? longRate
    : defaultRate;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  return (
    uncachedInput * rate.input +
    usage.cacheReadTokens * rate.cachedInput +
    usage.cacheWriteTokens * rate.cacheWrite +
    usage.outputTokens * rate.output
  ) / 1_000_000;
}

function parsePricing(markdown: string): PricingRate[] {
  const parsed: PricingRate[] = [];
  let provider = "";
  let headers: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      provider = line.slice(3).trim();
      headers = [];
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (cells[0] === "Model") {
      headers = cells;
      continue;
    }
    if (headers.length === 0 || !cells[0]) continue;
    const values = Object.fromEntries(headers.map((header, index) => [header.toLowerCase(), cells[index] ?? ""]));
    const threshold = parseThreshold(values["input threshold"]);
    parsed.push({
      model: normalizeModel(cells[0]),
      tier: values.tier?.toLowerCase() === "long context" ? "long" : "default",
      ...(threshold != null ? { threshold } : {}),
      input: parsePrice(values.input),
      cachedInput: parsePrice(values["cached input"]),
      cacheWrite: parsePrice(values["cache write"]),
      output: parsePrice(values.output),
    });
  }
  if (parsed.length === 0) throw new Error(`No rates found in pricing policy for ${provider || "any provider"}`);
  return parsed;
}

function parseThreshold(value: string | undefined): number | undefined {
  const match = value?.match(/([\d.]+)K/i);
  return match?.[1] ? Number(match[1]) * 1_000 : undefined;
}

function parsePrice(value: string | undefined): number {
  if (!value || value.toLowerCase() === "n/a") return 0;
  const parsed = Number(value.replace(/[$,]/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid pricing value: ${value}`);
  return parsed;
}

function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/\(fast mode\)/g, "fast-mode")
    .replace(/[_.\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
