---
name: bentolabs
description: Use when integrating the BentoLabs SDK, instrumenting LLM or agent calls with bento.track_ai, adding AI observability or tracing to a Python app, wrapping multi-step agent flows in trajectories (bento.begin, @bento.interaction, @bento.tool), mapping OpenTelemetry GenAI / OpenInference semantic conventions to BentoLabs dashboard columns, debugging missing traces or empty dashboard columns, or migrating from Raindrop to BentoLabs. Covers Python SDK install, the bl_pk_ API key, the four must-pass kwargs (user_id, convo_id, model, provider), input/output capture, properties type fidelity, the flush() / shutdown() lifecycle, and the lower-level OTel transport for apps with an existing TracerProvider.
metadata:
  version: "1.0"
---

# BentoLabs

BentoLabs is product analytics built for AI apps. It ships as a Python SDK that emits OpenTelemetry spans with `gen_ai.*` and `openinference.*` semantic conventions. The hosted dashboard turns those spans into conversation timelines, cost and model breakdowns, per-user analytics, and step-by-step agent-run views. The TypeScript SDK is in active development and not yet GA.

## Integration workflow

Copy this checklist into the response and check items off while integrating:

```
BentoLabs integration progress:
- [ ] Step 1: Discover — map the codebase (language, framework, LLM SDK, existing OTel, env config)
- [ ] Step 2: Install — add bentolabs-sdk and set BENTOLABS_API_KEY
- [ ] Step 3: Wrap — instrument every LLM call site with bento.track_ai or a trajectory
- [ ] Step 4: Identify — thread user_id and convo_id from the request handler to the call site
- [ ] Step 5: Verify — run the verify snippet, confirm the trace lands in the dashboard
```

Walk these in order. Do not skip Step 1; the discovery output drives every later decision.

## Step 1: Discover the codebase

Before writing any instrumentation, map what is already there. Run these bash commands from the repo root and note what each one returns. The output determines which wrap pattern to use in Step 3.

### 1a. Confirm language and Python version

```bash
ls pyproject.toml setup.py setup.cfg requirements.txt requirements*.txt 2>/dev/null
grep -E '^\s*(python|requires-python)\s*=' pyproject.toml 2>/dev/null
python3 --version 2>/dev/null
```

If only `package.json` is present and no Python sources exist, stop. Point the user at `/typescript.md` and explain the TS SDK is not yet GA.

### 1b. Detect the web framework

The framework's request object is where `user_id` and `convo_id` typically live.

```bash
grep -rlE "from fastapi|FastAPI\(|@app\.(get|post|put|delete)" --include="*.py" . 2>/dev/null | head -5
grep -rlE "from flask|Flask\(|@app\.route" --include="*.py" . 2>/dev/null | head -5
grep -rlE "from django|django\.|DJANGO_SETTINGS" --include="*.py" . 2>/dev/null | head -5
grep -rlE "from starlette|Starlette\(" --include="*.py" . 2>/dev/null | head -5
```

### 1c. Find every LLM call site

These are the lines that need wrapping. Read each match before deciding the pattern; the call is sometimes inside a helper that already has a clean wrap point.

```bash
# OpenAI (sync + async clients, completions and responses APIs)
grep -rnE "openai\.|OpenAI\(|AsyncOpenAI\(|\.chat\.completions\.create|\.responses\.create|\.completions\.create" --include="*.py" . 2>/dev/null

# Anthropic
grep -rnE "anthropic\.|Anthropic\(|AsyncAnthropic\(|\.messages\.create|\.completions\.create" --include="*.py" . 2>/dev/null

# Google (Gemini / Vertex)
grep -rnE "google\.genai|google\.generativeai|GenerativeModel|generate_content|vertexai" --include="*.py" . 2>/dev/null

# AWS Bedrock (model id is ambiguous; provider must be aws_bedrock, not the vendor)
grep -rnE "bedrock-runtime|invoke_model|converse" --include="*.py" . 2>/dev/null

# Aggregators and agent frameworks
grep -rnE "litellm\.|completion\(|acompletion\(" --include="*.py" . 2>/dev/null
grep -rnE "ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|llm\.(invoke|ainvoke|predict|apredict)|\.bind_tools\(" --include="*.py" . 2>/dev/null
grep -rnE "from llama_index|Settings\.llm|VectorStoreIndex|query_engine" --include="*.py" . 2>/dev/null
```

### 1d. Check for existing OpenTelemetry setup

```bash
grep -rnE "TracerProvider|set_tracer_provider|add_span_processor|trace\.get_tracer" --include="*.py" . 2>/dev/null
grep -nE "opentelemetry|otlp|OTLPSpanExporter" pyproject.toml requirements*.txt 2>/dev/null
```

If a `TracerProvider` is already configured, prefer the OTel transport path (see the "Lower-level: the OTel transport" section under Reference): add `BentoLabsSpanProcessor()` to the existing provider instead of running two tracer providers. If nothing is found, use the analytics layer (`bento.track_ai`).

### 1e. Find environment-variable config

```bash
find . -maxdepth 3 \( -name ".env*" -o -name "settings.py" -o -name "config.py" -o -name "config.yaml" -o -name "config.toml" \) -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null

grep -rnE "load_dotenv|from dotenv|pydantic_settings|BaseSettings" --include="*.py" . 2>/dev/null | head -5
```

The env file is where `BENTOLABS_API_KEY` should be added (with a placeholder value; the real secret lives in the user's secret manager).

### 1f. Detect existing Raindrop usage

```bash
grep -rnE "import raindrop|from raindrop|raindrop\.(init|track_ai|begin|identify|track_signal|flush)" --include="*.py" . 2>/dev/null
grep -nE "raindrop" pyproject.toml requirements*.txt 2>/dev/null
```

If any matches, the integration is a migration. Follow the "Migrating from Raindrop" section below instead of the greenfield Step 3 patterns.

### 1g. Summarize before continuing

Write a short summary back to the user with: language and Python version, framework, list of LLM call sites (file:line + which provider), whether OTel is already wired, where env vars live, whether Raindrop is present. Confirm before editing.

## Step 2: Install and authenticate

```bash
pip install bentolabs-sdk
# or, if the project uses uv / poetry / pdm:
#   uv add bentolabs-sdk
#   poetry add bentolabs-sdk
#   pdm add bentolabs-sdk
```

Add the key to the env file from Step 1e:

```bash
echo 'BENTOLABS_API_KEY=bl_pk_...' >> .env
```

Keys come from `https://platform.bentolabs.ai`. The prefix is `bl_pk_` and the SDK validates it up front. A bad key raises `BentoAuthError("invalid_api_key_format")` before any network I/O.

`bento.init()` is optional. The first `bento.track_ai(...)` call lazy-initializes from `BENTOLABS_API_KEY` and `BENTOLABS_BASE_URL` (defaults to `https://api.bentolabs.ai`). Call `init()` explicitly only when paying setup cost up front matters (Lambda cold start, ASGI startup hook).

## Step 3: Wrap LLM call sites

For each `file:line` match from Step 1c, pick the closest pattern below and apply. Always pass all four of `user_id`, `convo_id`, `model`, `provider`.

### Canonical shape

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

One `track_ai` call ships one OTel span. Each kwarg becomes one span attribute the dashboard first-classes into a column.

### Pattern A: Single LLM call, no surrounding agent loop

The most common shape. Wrap one call in one `track_ai`.

**OpenAI chat completions** — before:
```python
resp = client.chat.completions.create(model="gpt-4o", messages=messages)
reply = resp.choices[0].message.content
```

After:
```python
import bentolabs_sdk.analytics as bento

resp = client.chat.completions.create(model="gpt-4o", messages=messages)
reply = resp.choices[0].message.content

bento.track_ai(
    event="chat_completion",
    user_id=request.user.id,
    convo_id=conversation_id,
    model="gpt-4o",
    provider="openai",
    input=messages,
    output=reply,
)
```

**Anthropic messages** — same shape, change `provider="anthropic"` and the model id.

**Bedrock** — `provider="aws_bedrock"` even when the model id starts with `anthropic.`. The Bedrock model id is ambiguous on purpose.

### Pattern B: Multi-step or tool-calling agent

Open a trajectory so the whole turn renders as one trace. Inner `track_ai` and `tool_span` calls parent to it automatically.

```python
import bentolabs_sdk.analytics as bento

with bento.begin(
    event="user_turn",
    user_id=request.user.id,
    convo_id=conversation_id,
    model="claude-3-5-sonnet-20241022",
    provider="anthropic",
    input=user_message,
) as interaction:
    plan = client.messages.create(model="claude-3-5-sonnet-20241022", messages=[...])
    bento.track_ai(event="plan", input=user_message, output=plan.content[0].text)

    with interaction.tool_span(name="web_search", input={"q": query}) as ts:
        results = run_search(query)
        ts.set_output(results)

    final = client.messages.create(model="claude-3-5-sonnet-20241022", messages=[...])
    interaction.update(output=final.content[0].text)
```

Nested trajectories must finish LIFO. The context-manager form guarantees correct nesting; the imperative `interaction.finish()` form does not.

### Pattern C: Tool / function-shaped work

Decorate the tool function. Bound arguments become `input.value`; the return value becomes `output.value`.

```python
@bento.tool
def web_search(query: str, limit: int = 10) -> list[str]:
    return [...]

@bento.tool(name="search", capture_input=False)  # for sensitive args
def search_with_secrets(api_key: str, query: str) -> list[str]:
    return [...]
```

### Pattern D: LangChain / LlamaIndex

These frameworks emit OTel spans natively. Wire `BentoLabsSpanProcessor` into the existing tracer provider (see the "Lower-level: the OTel transport" section under Reference). Do not wrap individual LangChain calls in `track_ai` — that would double-count.

### Pattern E: Streaming responses

`track_ai` once after the stream completes. Accumulate output, then call once:

```python
chunks = []
stream = client.chat.completions.create(model="gpt-4o", messages=messages, stream=True)
for chunk in stream:
    chunks.append(chunk.choices[0].delta.content or "")
full = "".join(chunks)

bento.track_ai(
    event="streamed_chat",
    user_id=user_id, convo_id=convo_id,
    model="gpt-4o", provider="openai",
    input=messages, output=full,
)
```

Per-token spans are not the right pattern; one span per completed exchange is.

## Step 4: Source user_id and convo_id

These two identifiers unlock the dashboard's user filter and conversation timeline. Thread them from the request entry point down to the call site.

| Framework | `user_id` typically lives in | `convo_id` typically lives in |
|---|---|---|
| FastAPI / Starlette | `request.state.user.id` after auth middleware, or a `Depends(get_current_user)` | path param `/chats/{convo_id}/messages`, or a request body field |
| Django | `request.user.id` (via `AuthenticationMiddleware`) | URL kwarg or POST body |
| Flask | `g.user.id` or `flask_login.current_user.id` | request arg or session |
| CLI / script | argparse arg or `os.getlogin()` | a UUID minted at script start |

If no auth exists yet, pass a stable anonymous id (`request.client.host`, a cookie, or a `uuid.uuid4()` per session). Never pass `None` — a missing `user_id` silently disables the user filter.

`convo_id` must be the **same string across every turn of one conversation**. A common bug is minting a new UUID per request, which fragments the conversation timeline.

## Step 5: Verify the install

### 5a. Smoke test

Add to a scratch script, set `BENTOLABS_API_KEY`, run once:

```python
import bentolabs_sdk.analytics as bento

bento.track_ai(
    event="hello_world",
    user_id="verify_user",
    convo_id="verify_conv",
    model="claude-3-5-sonnet-20241022",
    provider="anthropic",
    input="ping",
    output="pong",
)
bento.flush()
```

### 5b. Confirm the daemon worker is alive

```python
import threading, bentolabs_sdk.analytics as bento
bento.init()
print([t.name for t in threading.enumerate()])
# Expected to include: 'OtelBatchSpanRecordProcessor'
```

If the worker thread is missing, `init()` failed silently or SDK calls are happening before init resolved. Re-check Step 2.

### 5c. Check the dashboard

Open `https://platform.bentolabs.ai`. The `hello_world` event should appear within seconds. If it does not, walk the "Troubleshooting checklist" section below.

### 5d. Validation loop

For every real call site instrumented in Step 3, run the user flow once and confirm one row appears with: correct `provider`, correct `model`, non-empty `input` and `output`, `user_id` populated, `convo_id` populated. If any column is empty, return to Step 3 for that call site. Do not move on until every column is filled.

## Reference

### The four kwargs that must be on every call

Skipping any of these silently disables a dashboard feature.

| Kwarg | What breaks if you skip it |
|---|---|
| `user_id` | User filter and per-user breakdowns. No profile data is stored; this is a pass-through string. |
| `convo_id` | Multi-turn conversations look like N independent rows. Same value across every turn links them. |
| `model` | Cost view, per-model breakdown. Spend rolls up under "Unknown". |
| `provider` | Provider filter and grouping. **Not auto-inferred from the model name.** |

`provider` is the most common omission. Common values: `openai`, `anthropic`, `google`, `aws_bedrock`, `azure_openai`, `cohere`, `mistral`. A Bedrock model id like `anthropic.claude-3-sonnet-20240229-v1:0` needs `provider="aws_bedrock"`, **not** `"anthropic"`.

### Multi-step work: trajectories

A trajectory is one OTel span that stays open across an agent turn or a multi-step task. Subsequent `track_ai` and `tool_span` calls in the same task parent to it, so the whole flow renders as one trace. See Step 3 Pattern B for the canonical shape.

`@bento.tool` auto-captures bound arguments as `input.value` and the return value as `output.value`. `@bento.interaction` captures the return value as `output.value` but **does not** auto-capture arguments (often non-trivial to serialize, frequently sensitive). Call `interaction.update(input=...)` from inside the function if you need the input recorded.

**Trajectory rules to encode:**

- `track_ai` and `begin` detach from any outer OTel context on purpose. That keeps a BentoLabs span out of the caller's FastAPI / Django trace. Do not "fix" this by reattaching; the ingest mapper depends on it.
- Nested trajectories must be finished in reverse open order. Out-of-order `finish()` raises `RuntimeError`. Always use the `with bento.begin(...) as i:` form when nesting.
- Threads and `concurrent.futures` workers do not inherit the trajectory `ContextVar`. Wrap submit calls with `contextvars.copy_context().run(...)` to inherit the trajectory. asyncio tasks inherit automatically.

### Custom dimensions: `properties=`

```python
bento.track_ai(
    event="search",
    properties={"feature": "semantic_search", "experiment_id": 7, "is_premium": True},
    user_id="u1", convo_id="c1", model="gpt-4o", provider="openai",
)
```

Property values keep their type. `int`, `float`, `bool`, `str`, and homogeneous lists pass through with type intact, so the dashboard can filter `experiment_id > 100` or `is_premium = true`. Dicts and mixed lists fall back to JSON strings.

`properties` is also accepted by `bento.begin(...)`, `interaction.update(...)`, `interaction.finish(...)`, `bento.tool_span(...)`, and `interaction.tool_span(...)`.

Do not put `gen_ai.*`, `input.value`, or `output.value` keys inside `properties`. The SDK-managed kwargs are written after properties and will overwrite them.

### Lifecycle and flush

The SDK ships spans on a background daemon thread. The hot path costs roughly 10 microseconds per call; the HTTP POST happens off-thread.

| Scenario | What to do |
|---|---|
| Long-running service (FastAPI, Django, worker) | Nothing. `atexit` flushes on clean exit. |
| Short script, notebook, Lambda handler | Call `bento.flush()` before exit, or the last batch is dropped. |
| `os._exit`, `SIGKILL`, hard process kill | `atexit` is bypassed. The queue is lost. Always `flush()` first. |
| Rotating credentials | `bento.shutdown()` then `bento.init(api_key="bl_pk_new...")`. |

Calling `bento.init()` twice with conflicting credentials raises `BentoAuthError("already_initialized")`. Call `shutdown()` to rotate.

### Lower-level: the OTel transport

If the app already has a `TracerProvider`, skip the analytics layer and wire the BentoLabs exporter into the existing pipeline.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from bentolabs_sdk import BentoLabsSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BentoLabsSpanProcessor())
trace.set_tracer_provider(provider)
```

For the same dashboard columns the analytics layer fills, upstream spans must carry:

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

Mechanical translation. Apply in order:

1. `pip install bentolabs-sdk && pip uninstall raindrop` (after migration is complete).
2. Replace `import raindrop.analytics as raindrop` with `import bentolabs_sdk.analytics as bento`.
3. Replace `raindrop.init(write_key)` with `bento.init(api_key=...)` or set `BENTOLABS_API_KEY`.
4. **Add `provider="..."` to every `bento.track_ai` call.** Raindrop inferred this; BentoLabs does not.
5. Delete every `raindrop.identify(...)` and `raindrop.track_signal(...)` call. No equivalents. If profile data was used for filtering, attach traits as `properties=` on each `track_ai` instead.
6. Run the verification flow from Step 5.

Full translation table at `/python/from-raindrop.md`.

## TypeScript

The TypeScript SDK is in active development and not yet generally available. Do not generate Node or browser instrumentation code from this skill. Point users at `/typescript.md` for status.

## Troubleshooting checklist

When `track_ai` calls do not show up in the dashboard, walk this list top to bottom — the fix is almost always one of these five:

1. **`flush()` missing before exit.** Short scripts, notebooks, Lambdas, and `os._exit` all drop the last batch. Add `bento.flush()`.
2. **`BENTOLABS_API_KEY` not in the running process.** Setting it in `~/.zshrc` does not help if the IDE or CI launched from a different env. Verify inside the process with `os.environ.get("BENTOLABS_API_KEY")`. Must start with `bl_pk_`.
3. **`BENTOLABS_BASE_URL` pointing at the wrong host.** `from bentolabs_sdk import resolve_options; print(resolve_options().base_url)` shows the effective value.
4. **Daemon worker not alive.** `threading.enumerate()` should include `OtelBatchSpanRecordProcessor`.
5. **Queue full.** Past 2048 queued spans the SDK drops the oldest and logs a WARNING. Enable `logging.basicConfig(level=logging.WARNING)`.

When fields look wrong:

- `provider` column empty: pass `provider=` explicitly on every call.
- Conversations appear as N separate rows: same `convo_id` is not being passed on every turn.
- User filter does nothing: `user_id` is missing, or was passed inside `properties=`. Use the top-level kwarg.
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
