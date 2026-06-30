---
name: om-model-optimize
description: Mipham-exclusive model optimization — context window management, prompt caching, token budgeting, and model selection
version: 2.0.0
---

# OM Model Optimize

Mipham-exclusive skill for intelligent model usage optimization.

## Context Window Management

### Compaction Strategy

When context approaches the model's window limit:

1. **Auto-trigger**: System detects token usage >80% of context window
2. **Summarize**: Generate a concise conversation summary via the current model
3. **Preserve**: Keep the last 20 messages intact for continuity
4. **Inject**: Prepend the summary as a system-level context message

### Token Budgeting

Track token usage per session:

- Input tokens consumed per request
- Output tokens generated per response
- Cumulative session total
- Estimated cost based on provider pricing

## Prompt Caching

### Anthropic Prompt Caching

Mark reusable content blocks (system prompts, long tool results) with `cache_control`:

- Minimum cacheable tokens: 1024 (Claude Sonnet), 2048 (Claude Haiku)
- Cache TTL: ~5 minutes; refresh on each use
- Priority targets: system prompt, large file contents, tool definitions

### OpenAI Prompt Caching

OpenAI automatically caches the longest prefix match; ensure consistent message ordering to maximize cache hits.

## Model Selection Optimization

Route tasks to the appropriate model tier:

| Task Complexity       | Recommended Tier | Example Models                          |
| --------------------- | ---------------- | --------------------------------------- |
| Simple (1-2 steps)    | Flash / Lite     | Claude Haiku, GPT Flash, Qwen Flash     |
| Moderate (multi-step) | Plus / Pro       | Claude Sonnet, GPT-4o, DeepSeek V3      |
| Complex (reasoning)   | Ultra / Max      | Claude Opus, GPT-5, DeepSeek-R1         |
| Vision tasks          | Visual tier      | Claude Sonnet (vision), GPT-4o (vision) |

### Decision Factors

- **Latency requirements**: Flash models respond in <1s; Ultra models may take 10-30s
- **Cost sensitivity**: Premium models can be 10-50x more expensive per token
- **Accuracy needs**: Reasoning models (DeepSeek-R1) for math, logic, and complex analysis
- **Context size**: Large contexts (>100K tokens) only supported by select models

## Usage

Automatically invoked when:

- Token usage exceeds 80% of context window
- User explicitly requests optimization (`/optimize` or "optimize model usage")
- Switching between models of different capability tiers
