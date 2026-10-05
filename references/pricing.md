# GitHub Copilot model pricing

All prices are **per 1 million tokens**, in USD. 1 AI credit = $0.01 USD.

**Source:** <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>
**Last updated:** 2026-10-04

> Tiered models (with a **Long context** tier) switch tiers based on the **input token count** crossing the listed threshold.

## OpenAI

GPT-5.6 and GPT-6 family models include a **cache write** cost in addition to cached input. Earlier OpenAI models have no cache write cost.

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
| GPT-5.6 Luna  | Default      | ≤ 200K          |  $0.20 |        $0.02 |       $0.25 |  $1.20 |
| GPT-5.6 Luna  | Long context | > 200K          |  $0.40 |        $0.04 |       $0.50 |  $1.80 |
| GPT-5.6 Sol   | Default      | ≤ 272K          |  $4.00 |        $0.40 |       $5.00 | $20.00 |
| GPT-5.6 Sol   | Long context | > 272K          |  $8.00 |        $0.80 |      $10.00 | $30.00 |
| GPT-5.6 Terra | Default      | ≤ 272K          |  $2.00 |        $0.20 |       $2.50 | $12.00 |
| GPT-5.6 Terra | Long context | > 272K          |  $4.00 |        $0.40 |       $5.00 | $18.00 |
| GPT-6 Astra   | Default      | ≤ 272K          | $10.00 |        $1.00 |      $12.50 | $50.00 |
| GPT-6 Astra   | Long context | > 272K          | $20.00 |        $2.00 |      $25.00 | $75.00 |
| GPT-6 Luna    | Default      | ≤ 272K          |  $0.10 |        $0.01 |      $0.125 |  $0.50 |
| GPT-6 Luna    | Long context | > 272K          |  $0.20 |        $0.02 |       $0.25 |  $0.75 |
| GPT-6 Sol     | Default      | ≤ 272K          |  $2.00 |        $0.20 |       $2.50 | $10.00 |
| GPT-6 Sol     | Long context | > 272K          |  $4.00 |        $0.40 |       $5.00 | $15.00 |
| GPT-6.1 Sol   | Default      | ≤ 272K          |  $2.00 |        $0.10 |       $2.50 | $10.00 |
| GPT-6.1 Sol   | Long context | > 272K          |  $4.00 |        $0.20 |       $5.00 | $15.00 |

## Anthropic

Anthropic models include a **cache write** cost in addition to cached input.

| Model                       |  Input | Cached input | Cache write | Output |
| --------------------------- | -----: | -----------: | ----------: | -----: |
| Claude Haiku 4.5            |  $1.00 |        $0.10 |       $1.25 |  $5.00 |
| Claude Sonnet 4             |  $3.00 |        $0.30 |       $3.75 | $15.00 |
| Claude Sonnet 4.6           |  $3.00 |        $0.30 |       $3.75 | $15.00 |
| Claude Opus 4.8             |  $5.00 |        $0.50 |       $6.25 | $25.00 |
| Claude Opus 5               |  $5.00 |        $0.50 |       $6.25 | $25.00 |
| Claude Opus 5.5             |  $4.00 |        $0.20 |       $5.00 | $20.00 |
| Claude Sonnet 5             |  $2.00 |        $0.20 |       $2.50 | $10.00 |
| Claude Sonnet 5.5           |  $2.00 |        $0.20 |       $2.50 | $10.00 |
| Claude Opus 4.8 (fast mode) | $10.00 |        $1.00 |      $12.50 | $50.00 |
| Claude Fable 5              | $10.00 |        $1.00 |      $12.50 | $50.00 |
| Claude Fable 5.1            | $10.00 |        $0.25 |      $12.50 | $50.00 |

> Claude Opus 4.8 (fast mode) is in preview.

## Google

| Model            | Tier    | Input threshold | Input | Cached input | Output |
| ---------------- | ------- | --------------- | ----: | -----------: | -----: |
| Gemini 3.7 Flash | Default | n/a             | $0.75 |       $0.075 |  $3.75 |
| Gemini 3.8 Flash | Default | n/a             | $0.75 |       $0.075 |  $3.75 |

> Gemini 3.7 Flash and Gemini 3.8 Flash rates are promotional through December 31, 2026.

## Microsoft

| Model              | Input | Cached input | Output |
| ------------------ | ----: | -----------: | -----: |
| MAI-Code-1.1-Flash | $0.20 |        $0.02 |  $1.20 |

## xAI

| Model    | Tier         | Input threshold | Input | Cached input | Output |
| -------- | ------------ | --------------- | ----: | -----------: | -----: |
| Grok 4.5 | Default      | ≤ 200K          | $2.00 |        $0.50 |  $6.00 |
| Grok 4.5 | Long context | > 200K          | $4.00 |        $1.00 | $12.00 |
| Grok 4.6 | Default      | ≤ 200K          | $2.00 |        $0.50 |  $6.00 |
| Grok 4.6 | Long context | > 200K          | $4.00 |        $1.00 | $12.00 |
| Grok 4.7 | Default      | ≤ 200K          | $2.00 |        $0.50 |  $6.00 |
| Grok 4.7 | Long context | > 200K          | $4.00 |        $1.00 | $12.00 |

## Moonshot AI

| Model   | Input | Cached input | Output |
| ------- | ----: | -----------: | -----: |
| Kimi K3 | $3.00 |        $0.30 | $15.00 |
