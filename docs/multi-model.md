# Multi-Model Support: Per-Role Model Configuration

## Why

Single-model architecture wastes money and limits flexibility:
- Compact (summarize history) doesn't need opus — flash/mini is fine
- Reflection (extract memory) is fire-and-forget — cheapest model works
- Sub-Agent tasks vary in complexity — some need strong models, some don't
- Users may want MainAgent on Anthropic but sub-tasks on OpenAI

## Design

### Config Structure

Two sections: `providers` (credentials + endpoint) and `roles` (who uses what).

```yaml
llm:
  # ── Provider credentials & endpoints ──
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      baseURL: ${OPENAI_BASE_URL:-}         # optional proxy/OpenRouter
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      baseURL: ${ANTHROPIC_BASE_URL:-}      # optional
    ollama:
      type: openai                          # SDK protocol (required for custom names)
      apiKey: dummy
      baseURL: http://localhost:11434/v1
    deepseek:
      type: openai
      apiKey: ${DEEPSEEK_API_KEY}
      baseURL: https://api.deepseek.com/v1

  # ── Role → provider/model ──
  roles:
    default: anthropic/claude-sonnet-4      # MainAgent conversation
    subAgent: openai/gpt-4o-mini            # spawn_subagent child agents
    compact: openai/gpt-4o-mini             # session summarization
    reflection: openai/gpt-4o-mini          # post-task memory extraction

  # Global settings
  maxConcurrentCalls: 3
  timeout: 120
  contextWindow: ${LLM_CONTEXT_WINDOW:-}    # override auto-detection
```

### Provider Type Resolution

Each provider needs a `type` to determine which SDK to use. Resolution:

| Provider key | `type` field | Resolved SDK |
|-------------|-------------|--------------|
| `openai` | (omitted) | openai — inferred from key name |
| `anthropic` | (omitted) | anthropic — inferred from key name |
| `ollama` | `openai` | openai — explicit type |
| `deepseek` | `openai` | openai — explicit type |
| `my-proxy` | `anthropic` | anthropic — explicit type |

Rule: key `openai` → defaults to openai SDK; key `anthropic` → defaults to anthropic SDK; anything else → `type` is **required**.

### Role Resolution

`roles.default` is **required**. Other roles (`subAgent`, `compact`, `reflection`) fall back to `default` when omitted.

```
get("compact")
  → roles.compact = "openai/gpt-4o-mini"
  → split: provider="openai", model="gpt-4o-mini"
  → providers.openai = { apiKey: "sk-...", type: "openai" }
  → cache key = "openai/gpt-4o-mini"
  → cache hit? return it : create client, cache, return
```

### Breaking Change: Old config format removed

Old top-level `provider` / `model` fields are **removed**. Migration is straightforward:

```yaml
# Before (v1)
llm:
  provider: openai
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o

# After (v2)
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
  roles:
    default: openai/gpt-4o
```

## Implementation: ModelRegistry

```typescript
type ModelRole = "default" | "subAgent" | "compact" | "reflection";

class ModelRegistry {
  private providers: Map<string, ProviderConfig>;  // from config
  private roles: Map<ModelRole, string>;           // role → "provider/model"
  private cache: Map<string, LanguageModel>;       // "provider/model" → instance

  constructor(settings: Settings) {}

  /** Get model for a role. Lazy-creates on first call. */
  get(role: ModelRole): LanguageModel;

  /** Get the modelId string for a role (for context window lookup). */
  getModelId(role: ModelRole): string;
}
```

### Lazy Creation

Same `provider/model` string → same cached instance. If `roles.compact` and `roles.reflection` both point to `openai/gpt-4o-mini`, only one client is created.

## Injection Points

| Location | Current | After |
|----------|---------|-------|
| `cli.ts` | `createModel(settings)` → single model | `new ModelRegistry(settings)` |
| `MainAgent` constructor | `model: LanguageModel` | `models: ModelRegistry` |
| `MainAgent._think()` | `this.model` | `this.models.get("default")` |
| `MainAgent._generateSummary()` | `this.model` | `this.models.get("compact")` |
| `MainAgent` → `new Agent(deps)` | passes `model` | passes `models.get("subAgent")` |
| `Agent._runPostReflection()` | uses same model | `PostTaskReflector` gets `models.get("reflection")` |

### Key Decision: Agent stays single-model internally

Agent's cognitive stages (think/plan/act) share one model. Only reflection is separate because it runs outside the cognitive loop (fire-and-forget after task completion).

## Config Schema Changes

```typescript
const ProviderConfigSchema = z.object({
  type: z.enum(["openai", "anthropic"]).optional(),  // SDK type; inferred from key if omitted
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
});

const RolesConfigSchema = z.object({
  default: z.string(),                    // required: "provider/model"
  subAgent: z.string().optional(),        // falls back to default
  compact: z.string().optional(),         // falls back to default
  reflection: z.string().optional(),      // falls back to default
});

const LLMConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  roles: RolesConfigSchema,
  maxConcurrentCalls: z.coerce.number().int().positive().default(3),
  timeout: z.coerce.number().int().positive().default(120),
  contextWindow: z.coerce.number().int().positive().optional(),
});
```

## File Changes

| File | Change |
|------|--------|
| `src/infra/config-schema.ts` | Rewrite `LLMConfigSchema` with `ProviderConfigSchema` + `RolesConfigSchema` |
| `src/infra/config-loader.ts` | Simplify `configToSettings` (remove old provider resolution logic) |
| `src/infra/model-registry.ts` | **New** — `ModelRegistry` class with lazy creation + caching |
| `src/cli.ts` | Replace `createModel()` with `new ModelRegistry(settings)` |
| `src/agents/main-agent.ts` | Accept `ModelRegistry`, use role-based `get()` |
| `src/agents/agent.ts` | Accept `model` + `reflectionModel` in constructor |
| `config.yml` | Rewrite `llm` section with new structure |
| Tests | New: `model-registry.test.ts`; Update: config-loader, main-agent, agent tests |

## Example Configs

### Minimal (single provider)
```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
  roles:
    default: openai/gpt-4o
```

### Cost-optimized (cross-provider)
```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
  roles:
    default: anthropic/claude-sonnet-4
    subAgent: anthropic/claude-sonnet-4
    compact: openai/gpt-4o-mini
    reflection: openai/gpt-4o-mini
```

### Local dev + cloud fallback
```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    ollama:
      type: openai
      apiKey: dummy
      baseURL: http://localhost:11434/v1
  roles:
    default: openai/gpt-4o
    subAgent: ollama/llama3.2:latest
    compact: ollama/llama3.2:latest
    reflection: ollama/llama3.2:latest
```
