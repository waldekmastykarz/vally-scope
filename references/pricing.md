# GitHub Copilot model pricing

All prices are **per 1 million tokens**, in USD. 1 AI credit = $0.01 USD.

**Source:** <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>
**Last updated:** 2026-09-11

> Tiered models (with a **Long context** tier) switch tiers based on the **input token count** crossing the listed threshold.

## OpenAI

| Model         | Tier         | Input threshold |  Input | Cached input | Cache write | Output |
| ------------- | ------------ | --------------- | -----: | -----------: | ----------: | -----: |
| GPT-5 mini    | Default      | n/a             |  $0.25 |       $0.025 |         n/a |  $2.00 |
| GPT-5.3-Codex | Default      | n/a             |  $1.75 |       $0.175 |         n/a | $14.00 |
| GPT-5.4       | Default      | ≤ 272K          |  $2.50 |        $0.25 |         n/a | $15.00 |
| GPT-5.4       | Long context | > 272K          |  $5.00 |        $0.50 |         n/a | $22.50 |
| GPT-5.4 mini  | Default      | n/a             |  $0.75 |       $0.075 |         n/a |  $4.50 |
| GPT-5.4 nano  | Default      | n/a             |  $0.20 |        $0.02 |         n/a |  $1.25 |
| GPT-5.5       | Default      | ≤ 272K          |  $5.00 |        $0.50 |         n/a | $30.00 |
| GPT-5.5       | Long context | > 272K          | $10.00 |        $1.00 |         n/a | $45.00 |
| GPT-6 Astra   | Default      | ≤ 272K          | $10.00 |        $1.00 |      $12.50 | $50.00 |
| GPT-6 Astra   | Long context | > 272K          | $20.00 |        $2.00 |      $25.00 | $75.00 |

## Anthropic

Anthropic models include a **cache write** cost in addition to cached input.

| Model             |  Input | Cached input | Cache write | Output |
| ----------------- | -----: | -----------: | ----------: | -----: |
| Claude Haiku 4.5  |  $1.00 |        $0.10 |       $1.25 |  $5.00 |
| Claude Sonnet 4   |  $3.00 |        $0.30 |       $3.75 | $15.00 |
| Claude Sonnet 4.5 |  $3.00 |        $0.30 |       $3.75 | $15.00 |
| Claude Sonnet 4.6 |  $3.00 |        $0.30 |       $3.75 | $15.00 |
| Claude Opus 4.5   |  $5.00 |        $0.50 |       $6.25 | $25.00 |
| Claude Opus 4.6   |  $5.00 |        $0.50 |       $6.25 | $25.00 |
| Claude Opus 4.7   |  $5.00 |        $0.50 |       $6.25 | $25.00 |
| Claude Opus 4.8   |  $5.00 |        $0.50 |       $6.25 | $25.00 |
| Claude Sonnet 5      |  $2.00 |        $0.20 |       $2.50 | $10.00 |
| Claude Opus 4.8 (fast mode) | $10.00 |        $1.00 |      $12.50 | $50.00 |
| Claude Fable 5    | $10.00 |        $1.00 |      $12.50 | $50.00 |

> Note: Claude Fable 5 may be temporarily unavailable in Copilot; rates listed for reference.

## Google

| Model            | Tier         | Input threshold | Input | Cached input | Output |
| ---------------- | ------------ | --------------- | ----: | -----------: | -----: |
| Gemini 2.5 Pro   | Default      | n/a             | $1.25 |       $0.125 | $10.00 |
| Gemini 3 Flash   | Default      | n/a             | $0.50 |        $0.05 |  $3.00 |
| Gemini 3.1 Pro   | Default      | ≤ 200K          | $2.00 |        $0.20 | $12.00 |
| Gemini 3.1 Pro   | Long context | > 200K          | $4.00 |        $0.40 | $18.00 |
| Gemini 3.5 Flash | Default      | n/a             | $1.50 |        $0.15 |  $9.00 |

## Fine-tuned (GitHub)

| Model       | Input | Cached input | Output |
| ----------- | ----: | -----------: | -----: |
| Raptor mini | $0.25 |       $0.025 |  $2.00 |

## Microsoft

| Model            | Input | Cached input | Output |
| ---------------- | ----: | -----------: | -----: |
| MAI-Code-1-Flash | $0.75 |       $0.075 |  $4.50 |

## Moonshot AI

| Model          | Input | Cached input | Output |
| -------------- | ----: | -----------: | -----: |
| Kimi K2.7 Code | $0.95 |        $0.19 |  $4.00 |
