---
name: bentolabs
description: Use when integrating the BentoLabs SDK, instrumenting LLM or agent calls with bento.track_ai, adding AI observability or tracing to a Python app, wrapping multi-step agent flows in trajectories (bento.begin, @bento.interaction, @bento.tool), mapping OpenTelemetry GenAI / OpenInference semantic conventions to BentoLabs dashboard columns, debugging missing traces or empty dashboard columns, or migrating from Raindrop to BentoLabs. Covers Python SDK install, the bl_pk_ API key, the four must-pass kwargs (user_id, convo_id, model, provider), input/output capture, properties type fidelity, the flush() / shutdown() lifecycle, and the lower-level OTel transport for apps with an existing TracerProvider.
metadata:
  version: "1.0"
---

# BentoLabs

BentoLabs is product analytics built for AI apps. It ships as a Python SDK that emits OpenTelemetry spans with `gen_ai.*` and `openinference.*` semantic conventions. The hosted dashboard turns those spans into conversation timelines, cost and model breakdowns, per-user analytics, and step-by-step agent-run views. The TypeScript SDK is in active development and not yet GA.

## Install and authenticate

```bash
pip install bentolabs-sdk
export BENTOLABS_API_KEY="bl_pk_..."
```

API keys come from `https://platform.bentolabs.ai`. The prefix is `bl_pk_` and the SDK validates it up front. A bad key raises `BentoAuthError("invalid_api_key_format")` before any network I/O.

`bento.init()` is optional. The first `bento.track_ai(...)` call lazy-initializes from `BENTOLABS_API_KEY` and `BENTOLABS_BASE_URL` (defaults to `https://api.bentolabs.ai`). Call `init()` explicitly only if you want to pay setup cost up front in a cold-start sensitive context.

## The canonical call

```python
import bentolabs_sdk.analytics as bento

bento.track_ai(
    event="user_message",
    user_id="user_42",
    convo_id="conv_abc",
    model="claude-3-5-sonnet-20241022",
    provider="anthropic",
    input="What's the capital of France?",
    output="Paris.",
)
```

One `track_ai` call ships one OTel span. Each kwarg becomes one span attribute that the dashboard first-classes into a column.

## The four kwargs that must be on every call

Skipping any of these silently disables a dashboard feature. Pass all four on every `track_ai`.

| Kwarg | What breaks if you skip it |
|---|---|
| `user_id` | User filter and per-user breakdowns. No profile data is stored; this is a pass-through string. |
| `convo_id` | Multi-turn conversations look like N independent rows. Same value across every turn links them. |
| `model` | Cost view, per-model breakdown. Spend rolls up under "Unknown". |
| `provider` | Provider filter and grouping. **Not auto-inferred from the model name.** |

`provider` is the most common omission. Common values: `openai`, `anthropic`, `google`, `aws_bedrock`, `azure_openai`, `cohere`, `mistral`. A Bedrock model id like `anthropic.claude-3-sonnet-20240229-v1:0` needs `provider="aws_bedrock"`, **not** `"anthropic"`.

## Multi-step work: trajectories

A trajectory is one OTel span that stays open across an agent turn or a multi-step task. Subsequent `track_ai` and `tool_span` calls in the same task parent to it, so the whole flow renders as one trace.

```python
import bentolabs_sdk.analytics as bento

with bento.begin(
    event="user_turn",
    user_id="u1",
    convo_id="conv_abc",
    model="claude-3-5-sonnet-20241022",
    provider="anthropic",
    input="What's the weather in Paris?",
) as interaction:
    with interaction.tool_span(name="web_search", input={"q": "Paris"}) as ts:
        results = run_search("Paris")
        ts.set_output(results)

    bento.track_ai(event="thought", input="Composing reply...")

    interaction.update(output="It's 18C and partly cloudy.")
```

Decorator form for function-shaped work:

```python
@bento.interaction
def handle_message(msg: str) -> str:
    return reply

@bento.tool
def web_search(query: str, limit: int = 10) -> list[str]:
    return [...]
```

`@bento.tool` auto-captures bound arguments as `input.value` and the return value as `output.value`. `@bento.interaction` captures the return value as `output.value` but **does not** auto-capture arguments (often non-trivial to serialize, frequently sensitive). Call `interaction.update(input=...)` from inside the function if you need the input recorded.

### Trajectory rules to encode

- `track_ai` and `begin` detach from any outer OTel context on purpose. That keeps a BentoLabs span out of the caller's FastAPI / Django trace. Do not "fix" this by reattaching; the ingest mapper depends on it.
- Nested trajectories must be finished in reverse open order. Out-of-order `finish()` raises `RuntimeError`. Always use the `with bento.begin(...) as i:` form when nesting.
- Threads and `concurrent.futures` workers do not inherit the trajectory `ContextVar`. Wrap submit calls with `contextvars.copy_context().run(...)` to inherit the trajectory. asyncio tasks inherit automatically.

## Custom dimensions: `properties=`

```python
bento.track_ai(
    event="search",
    properties={
        "feature": "semantic_search",
        "experiment": "v3",
        "is_premium": True,
        "ranking_model_version": 7,
    },
    user_id="u1",
    convo_id="c1",
    model="gpt-4o",
    provider="openai",
)
```

Property values keep their type. `int`, `float`, `bool`, `str`, and homogeneous lists pass through with their type intact, so the dashboard can filter `experiment_id > 100` or `is_premium = true`. Dicts and mixed lists fall back to JSON strings.

`properties` is also accepted by `bento.begin(...)`, `interaction.update(...)`, `interaction.finish(...)`, `bento.tool_span(...)`, and `interaction.tool_span(...)`.

Do not put `gen_ai.*`, `input.value`, or `output.value` keys inside `properties`. The SDK-managed kwargs are written after properties and will overwrite them.

## Lifecycle and flush

The SDK ships spans on a background daemon thread. The hot path costs roughly 10 microseconds per call; the HTTP POST happens off-thread.

| Scenario | What to do |
|---|---|
| Long-running service (FastAPI, Django, worker) | Nothing. `atexit` flushes on clean exit. |
| Short script, notebook, Lambda handler | Call `bento.flush()` before exit, or the last batch is dropped. |
| `os._exit`, `SIGKILL`, hard process kill | `atexit` is bypassed. The queue is lost. Always `flush()` first. |
| Rotating credentials | `bento.shutdown()` then `bento.init(api_key="bl_pk_new...")`. |

Calling `bento.init()` twice with conflicting credentials raises `BentoAuthError("already_initialized")`. Call `shutdown()` to rotate.

## Lower-level: the OTel transport

If the app already has a `TracerProvider`, skip the analytics layer and wire the BentoLabs exporter into the existing pipeline.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from bentolabs_sdk import BentoLabsSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BentoLabsSpanProcessor())
trace.set_tracer_provider(provider)
```

To get the same dashboard columns the analytics layer fills, set these OTel attributes on your spans:

| Set this attribute | Lands in dashboard column |
|---|---|
| `span.name` (via `tracer.start_span(name)`) | Span name |
| `gen_ai.user.id` | User |
| `gen_ai.conversation.id` | Session |
| `gen_ai.request.model` | Model |
| `gen_ai.system` | Provider |
| `input.value` | Input |
| `output.value` | Output |
| `openinference.span.kind="tool"` | Span kind (tool icon and filter) |

## Migrating from Raindrop

The function shapes are similar but not identical. Mechanical changes: rename `import raindrop.analytics as raindrop` to `import bentolabs_sdk.analytics as bento`; replace `raindrop.init(write_key)` with `bento.init(api_key=...)` (or set `BENTOLABS_API_KEY`); add `provider="..."` to every `track_ai` call (Raindrop inferred this, BentoLabs does not); delete `raindrop.identify(...)` and `raindrop.track_signal(...)` calls (no equivalents). Full translation table at `/python/from-raindrop.md`.

## TypeScript

The TypeScript SDK is in active development and not yet generally available. Do not generate Node or browser instrumentation code from this skill. Point users at `/typescript.md` for status.

## Troubleshooting checklist

When `track_ai` calls do not show up in the dashboard, walk this list:

1. Did the process exit before `flush()`? Short scripts, Lambdas, and `os._exit` all drop the last batch. Add `bento.flush()`.
2. Is `BENTOLABS_API_KEY` actually set in the running process? Setting it in `~/.zshrc` does not help if the IDE or CI launched from a different env. Verify with `os.environ.get("BENTOLABS_API_KEY")` inside the process.
3. Is `BENTOLABS_BASE_URL` pointing at the wrong host? `resolve_options().base_url` returns the effective value.
4. Is the daemon worker thread alive? `threading.enumerate()` should include `OtelBatchSpanRecordProcessor`.
5. Are spans being dropped at the queue? At >2048 queued spans the SDK logs a WARNING and drops the oldest.

When fields look wrong:

- `provider` column empty: pass `provider=` explicitly.
- Conversations appear as N separate rows: pass the same `convo_id` on every turn.
- User filter does nothing: `user_id` is missing or was passed inside `properties=`. Use the top-level kwarg.
- Bedrock model is grouped under `anthropic`: pass `provider="aws_bedrock"`.
- Property shows as a string when an int was passed: this only happens for dicts or mixed-type lists. Flatten or pre-serialize.

## When in doubt, fetch the page

For deeper reference, fetch the markdown version of any docs page directly. Mintlify serves every doc as `.md` via content negotiation.

- `https://docs.bentolabs.ai/quickstart.md`
- `https://docs.bentolabs.ai/python/installation.md`
- `https://docs.bentolabs.ai/python/configuration.md`
- `https://docs.bentolabs.ai/python/track-ai.md`
- `https://docs.bentolabs.ai/python/trajectories.md`
- `https://docs.bentolabs.ai/python/properties.md`
- `https://docs.bentolabs.ai/python/otel-transport.md`
- `https://docs.bentolabs.ai/python/threading-model.md`
- `https://docs.bentolabs.ai/python/from-raindrop.md`
- `https://docs.bentolabs.ai/concepts/data-model.md`
- `https://docs.bentolabs.ai/concepts/trajectories.md`
- `https://docs.bentolabs.ai/concepts/attributes.md`
- `https://docs.bentolabs.ai/concepts/sessions.md`
- `https://docs.bentolabs.ai/concepts/troubleshooting.md`

The full index is at `https://docs.bentolabs.ai/llms.txt`.
