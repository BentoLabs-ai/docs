---
name: bentolabs
description: Use when integrating Bento into a Python app — wiring the Google ADK integration (`bento.instrument()`), manually tracking LLM calls with `bento.track_ai`, registering identity getters at `bento.init`, grouping multi-step agent flows with `bento.begin` trajectories, mapping OpenTelemetry GenAI / OpenInference semantic conventions to Bento dashboard columns, debugging missing traces or empty dashboard columns, or migrating from Raindrop. Covers Python SDK install, the `bl_pk_` API key, the four must-pass arguments to `track_ai` (`user_id`, `convo_id`, `model`, `provider`), input/output capture, properties type fidelity, the `flush()` / `shutdown()` lifecycle, and the lower-level OTel transport for apps with an existing TracerProvider.
metadata:
  version: "1.2"
---

# Bento

Bento is production infrastructure for AI agents. It ships as a Python SDK that emits OpenTelemetry spans with `gen_ai.*` and `openinference.*` semantic conventions. The dashboard turns those spans into traces, signals (English-language failure-mode detectors), alerts, evaluations, and versioned improvements. The TypeScript SDK is in active development and not yet GA.

Two paths, picked per call site:

- **Integration** (`bento.instrument()`) — One line. Captures every model call, tool call, and agent step from **Google ADK**. Default path when ADK is present.
- **Manual tracking** (`bento.track_ai`) — One call per LLM site. Default path for everything else (OpenAI / Anthropic / Bedrock / Vertex / etc.).

The two compose: manual `track_ai` and tool spans inside a `bento.begin(...)` block share `trace_id` with any spans the integration captures.

## Integration workflow

Copy this checklist into the response and check items off while integrating:

```
Bento integration progress:
- [ ] Step 1: Discover — map the codebase (language, framework, LLM SDK, existing OTel, env config). Note whether ADK is in use — that changes Step 3.
- [ ] Step 2: Install — add bentolabs-sdk (plus the [adk] extra if applicable) and set BENTOLABS_API_KEY
- [ ] Step 3: Wire it up — either bento.instrument() once at startup (ADK) OR wrap each LLM call site with bento.track_ai (everything else). Often both.
- [ ] Step 4: Identify — register user_id/session_id getters at bento.init(), or thread them through to each call site
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

# Agent frameworks
grep -rnE "ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|llm\.(invoke|ainvoke|predict|apredict)|\.bind_tools\(" --include="*.py" . 2>/dev/null
grep -rnE "from llama_index|Settings\.llm|VectorStoreIndex|query_engine" --include="*.py" . 2>/dev/null
```

### 1d. Check for Google ADK (priority signal for Step 3)

This is the deciding signal for Step 3. If ADK is present, the integration is a three-line `bento.instrument()` install and most of the manual `track_ai` patterns become unnecessary.

```bash
grep -rnE "from google\.adk|google\.adk\.|import google\.adk" --include="*.py" . 2>/dev/null
grep -nE "google-adk|google\.adk" pyproject.toml requirements*.txt 2>/dev/null
```

If ADK is present, follow Step 3 Path A (the integration). Other LLM SDK usage in the same project still needs `track_ai` (Path B); the two paths compose.

### 1e. Check for existing OpenTelemetry setup

```bash
grep -rnE "TracerProvider|set_tracer_provider|add_span_processor|trace\.get_tracer" --include="*.py" . 2>/dev/null
grep -nE "opentelemetry|otlp|OTLPSpanExporter" pyproject.toml requirements*.txt 2>/dev/null
```

If a `TracerProvider` is already configured, prefer the OTel transport path (see the "Lower-level: the OTel transport" section under Reference): add `BentoLabsSpanProcessor()` to the existing provider instead of running two tracer providers. If nothing is found, use the analytics layer (`bento.track_ai`).

### 1f. Find environment-variable config

```bash
find . -maxdepth 3 \( -name ".env*" -o -name "settings.py" -o -name "config.py" -o -name "config.yaml" -o -name "config.toml" \) -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null

grep -rnE "load_dotenv|from dotenv|pydantic_settings|BaseSettings" --include="*.py" . 2>/dev/null | head -5
```

The env file is where `BENTOLABS_API_KEY` should be added (with a placeholder value; the real secret lives in the user's secret manager).

### 1g. Detect existing competing SDKs (Raindrop, Langfuse)

```bash
# Raindrop (raindrop-ai, import raindrop.analytics)
grep -rnE "import raindrop|from raindrop|raindrop\.(init|track_ai|begin|identify|track_signal|flush)" --include="*.py" . 2>/dev/null
grep -nE "raindrop" pyproject.toml requirements*.txt 2>/dev/null

# Langfuse (langfuse Python SDK v3)
grep -rnE "from langfuse|import langfuse|@observe|from langfuse\.(openai|langchain)" --include="*.py" . 2>/dev/null
grep -nE "^langfuse|^\s*langfuse" pyproject.toml requirements*.txt 2>/dev/null
```

**If any match — ASK the user before proceeding.** Do not assume migration vs. fresh integration; the answer changes Step 3 fundamentally. Present this exact question:

> I found existing **`<Raindrop|Langfuse>`** usage at `<file:line>` (and N more sites). Do you want me to:
>
> 1. **Migrate** the existing code from `<Raindrop|Langfuse>` to Bento (port every call site, then remove the old SDK)
> 2. **Fresh integration** — keep `<Raindrop|Langfuse>` in place and add Bento alongside it (e.g. you're A/B'ing or only instrumenting new code)
>
> Which one?

Then:

- If **migrate**: jump to the Migrations section below. Follow the per-SDK guide (Raindrop or Langfuse) — full translation tables live at `https://docs.bentolabs.ai/migrations/raindrop.md` and `https://docs.bentolabs.ai/migrations/langfuse.md`. Both SDKs can coexist in the process during the port; only uninstall the old one after Step 5 verify passes.
- If **fresh integration**: continue with the greenfield Step 3 patterns. Note in your summary that the project also runs `<Raindrop|Langfuse>` so the reviewer knows two SDKs will emit spans (potentially duplicate traces if both wrap the same call site).

Never silently pick one path. Ask, wait for the answer, then proceed.

### 1h. Summarize before continuing

Write a short summary back to the user with: language and Python version, framework, **whether ADK is in use (drives Step 3 path A)**, list of LLM call sites (file:line + which provider), whether OTel is already wired, where env vars live, **whether Raindrop or Langfuse is present and which path the user picked in Step 1g**. Confirm before editing.

## Step 2: Install and authenticate

```bash
pip install bentolabs-sdk
# or, if the project uses uv / poetry / pdm:
#   uv add bentolabs-sdk
#   poetry add bentolabs-sdk
#   pdm add bentolabs-sdk
```

If Step 1d found ADK, install the extra so `bento.instrument()` can activate the integration:

```bash
pip install "bentolabs-sdk[adk]"
# uv / poetry / pdm: same name, same extras syntax
```

Add the key to the env file from Step 1f:

```bash
echo 'BENTOLABS_API_KEY=bl_pk_...' >> .env
```

Keys come from `https://platform.bentolabs.ai`. The prefix is `bl_pk_` and the SDK validates it up front. A bad key raises `BentoAuthError("invalid_api_key_format")` before any network I/O.

`bento.init()` is optional in the pure `track_ai` flow — the first call lazy-initializes from `BENTOLABS_API_KEY` and `BENTOLABS_BASE_URL` (defaults to `https://api.bentolabs.ai`). For an integration, call `bento.init()` explicitly at startup so identity getters are registered before the first captured span.

## Step 3: Instrument

Pick the path that matches what Step 1d found.

- **Path A — integration** (ADK in use): three lines at startup. Zero per-call-site code. Default path when applicable.
- **Path B — manual `track_ai`** (everything else, or any uncovered SDK in a project that also uses ADK): one call per LLM site.

The two paths compose. Open a `bento.begin(...)` trajectory and any spans the integration captures inside it share `trace_id` with your manual `track_ai` and `tool_span` calls.

## Step 3 Path A: Google ADK integration

If Step 1d found ADK, this replaces most of the per-call-site wrapping.

### A1. One-time setup at app startup

```python
import bentolabs_sdk as bento

bento.init(
    user_id=lambda: get_current_user_id(),        # see Step 4
    session_id=lambda: get_current_session_id(),
)
bento.instrument()                                 # auto-detects ADK
```

`bento.instrument()` returns `"adk"` when activated, or `None` when the `[adk]` extra isn't installed. To pin the pick: `bento.instrument("adk")`. Unknown names raise `ValueError`. A missing extra logs a warning and returns `None` — it does NOT raise.

Idempotent: a second `bento.instrument()` call with the same target is a no-op.

### A2. Where to put it

Wherever the app initializes itself — once, at the boundary, before any LLM call:

- **FastAPI** — module-level call before `app = FastAPI()`, or in a `lifespan` startup handler.
- **Django** — `apps.py:ready()` or `wsgi.py` / `asgi.py`.
- **Flask** — module-level, before `create_app()`.
- **Worker / CLI** — top of the entry-point module, before any task runs.

Do NOT call `bento.init` / `bento.instrument` per-request — they're idempotent but a partial `init()` per request would churn identity registration.

### A3. What you get for free

Every span the integration captures — ADK agent runs, ADK tool calls, and the LLM calls ADK makes — lands in the dashboard with:

- `gen_ai.user.id` from your `user_id` getter
- `gen_ai.conversation.id` from your `session_id` getter
- `gen_ai.request.model` and `gen_ai.system` from the framework
- `input.value` and `output.value` from the prompt/completion
- `openinference.span.kind` set so tool spans get the right icon

No code changes anywhere else. Validate with Step 5.

### A4. Mixing the integration with `track_ai`

If the same project also calls OpenAI / Anthropic / Bedrock directly (Step 1c found matches outside ADK), wrap those sites with `track_ai` (Path B). Inside a `bento.begin(...)` trajectory, integration-captured spans and manual `track_ai` calls share one `trace_id`.

```python
with bento.begin(event="user_turn", convo_id=conv_id) as i:
    # ADK agent run — captured by the integration
    result = await runner.run(query)

    # Direct OpenAI call — needs track_ai
    raw = openai_client.embeddings.create(model="text-embedding-3-small", input=text)
    bento.track_ai(event="embed", model="text-embedding-3-small", provider="openai",
                   input=text, output=str(raw.data[0].embedding[:5]) + "...")
```

### A5. Reverse / shutdown

```python
bento.uninstrument()        # remove every active integration
bento.uninstrument("adk")   # specific one
bento.shutdown()            # calls uninstrument() automatically
```

`shutdown()` is what you want for credential rotation and test isolation. After `shutdown()`, a subsequent `bento.init()` re-creates a fresh provider; you must re-call `bento.instrument()` to re-attach.

### A6. When Bento can't claim the library

If another component already instrumented ADK (e.g. the host app called `GoogleADKInstrumentor().instrument(...)` directly), `bento.instrument("adk")` logs a warning and returns `None`. The existing wrappers stay intact. Either remove the host-side wiring, or skip `bento.instrument(...)` and live with the spans landing in the host's pipeline only.

## Step 3 Path B: Manual `track_ai` (everything else)

For each `file:line` match from Step 1c that is NOT covered by ADK, pick the closest pattern below and apply. Always pass all four of `user_id`, `convo_id`, `model`, `provider`.

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

These two identifiers unlock the dashboard's user filter and conversation timeline. Two patterns; pick one and apply consistently.

### Pattern 1: Init-time getters (preferred for Path A; works for Path B too)

Register zero-arg callables at `bento.init(...)` once. Bento invokes them on every span — whether captured by an integration or emitted by `bento.track_ai` — and writes the result to `gen_ai.user.id` / `gen_ai.conversation.id` / `langfuse.tags`.

```python
# FastAPI / Starlette: from a ContextVar set by auth middleware
from contextvars import ContextVar
current_user: ContextVar[str | None] = ContextVar("current_user", default=None)
current_convo: ContextVar[str | None] = ContextVar("current_convo", default=None)

bento.init(user_id=current_user.get, session_id=current_convo.get)

# In middleware:
@app.middleware("http")
async def attach_identity(request, call_next):
    current_user.set(await resolve_user_id(request))
    current_convo.set(request.path_params.get("convo_id"))
    return await call_next(request)
```

Why a callable, not a value: the SDK calls the function on every span. A static value would only fit single-tenant apps. A getter that raises is swallowed; the field is dropped for that span and the host app is never affected.

Partial `bento.init(...)` calls preserve previously registered getters. Bare `init()` no-ops on identity. `init(user_id=None)` explicitly clears just `user_id`.

### Pattern 2: Per-call kwargs (Path B only)

Thread `user_id` and `convo_id` from the request entry point down to each `bento.track_ai(...)` call site.

| Framework | `user_id` typically lives in | `convo_id` typically lives in |
|---|---|---|
| FastAPI / Starlette | `request.state.user.id` after auth middleware, or a `Depends(get_current_user)` | path param `/chats/{convo_id}/messages`, or a request body field |
| Django | `request.user.id` (via `AuthenticationMiddleware`) | URL kwarg or POST body |
| Flask | `g.user.id` or `flask_login.current_user.id` | request arg or session |
| CLI / script | argparse arg or `os.getlogin()` | a UUID minted at script start |

If no auth exists yet, pass a stable anonymous id (`request.client.host`, a cookie, or a `uuid.uuid4()` per session). Never pass `None` — a missing `user_id` silently disables the user filter.

`convo_id` must be the **same string across every turn of one conversation**. A common bug is minting a new UUID per request, which fragments the conversation timeline.

### Late-binding identity (either pattern)

When identity becomes known mid-flow (e.g. authentication completes inside an open trajectory):

```python
with bento.begin(event="user_turn") as interaction:
    user_id, session_id = await authenticate(request)
    bento.update_current_trace(user_id=user_id, session_id=session_id)
    # rest of the work — root span has identity now
```

For per-task scoped overrides (worker that received identity over a queue):

```python
with bento.propagate_attributes(user_id="u_42", session_id="conv_99"):
    await agent.run(query)        # every span tagged automatically
```

Each `propagate_attributes` kwarg takes three values: omitted (inherit), a value (override), or explicit `None` (clear for the scope, shadowing the outer source).

## Step 5: Verify the install

### 5a. Smoke test (manual path)

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

### 5a-alt. Smoke test (integration path)

If Step 3 Path A was used, the smoke test is "run one ADK agent call and confirm the framework's span lands":

```python
import bentolabs_sdk as bento
bento.init()
activated = bento.instrument()
print(f"activated: {activated!r}")   # expect "adk"; None means the [adk] extra isn't installed
# ...invoke one ADK agent run here...
bento.flush()
```

`activated is None` means `bento.instrument()` couldn't find ADK — re-run `pip install "bentolabs-sdk[adk]"` and confirm the package landed in the same venv the script is using.

### 5b. Confirm the daemon worker is alive

```python
import threading, bentolabs_sdk.analytics as bento
bento.init()
print([t.name for t in threading.enumerate()])
# Expected to include: 'OtelBatchSpanRecordProcessor'
```

If the worker thread is missing, `init()` failed silently or SDK calls are happening before init resolved. Re-check Step 2.

### 5c. Check the dashboard

Open `https://platform.bentolabs.ai`. The `hello_world` event (manual path) or the ADK span (integration path) should appear within seconds. If it does not, walk the "Troubleshooting checklist" section below.

### 5d. Validation loop

For every real call site instrumented in Step 3, run the user flow once and confirm one row appears with: correct `provider`, correct `model`, non-empty `input` and `output`, `user_id` populated, `convo_id` populated. If any column is empty, return to Step 3 for that call site. Do not move on until every column is filled.

For integration-captured spans, if `user_id` or `convo_id` is empty: the init-time getter (Step 4 Pattern 1) returned `None`. Either the ContextVar wasn't set before the LLM call (middleware/ordering bug) or the getter swallowed an exception. Add a `print(...)` inside the getter to confirm it's firing at the right time.

## Reference

### Integration surface

Public API on `bentolabs_sdk` (not `.analytics`):

| Call | Effect |
|---|---|
| `bento.instrument()` | Auto-detect and activate the Google ADK integration. Returns `"adk"` or `None`. |
| `bento.instrument("adk")` | Explicit pick. Raises `ValueError` on unknown names. Logs a warning + returns `None` if the extra isn't installed. |
| `bento.uninstrument()` | Reverse every active integration. Returns the names removed as `list[str]`. |
| `bento.uninstrument("adk")` | Specific reverse. |

Currently supported names: `"adk"`. Install with `pip install "bentolabs-sdk[adk]"`.

One-integration-at-a-time invariant: a second `instrument()` with a different target while one is active logs a warning and is ignored. Call `uninstrument(name)` first to switch.

Bento never calls `trace.set_tracer_provider()` — every integration is passed `tracer_provider=` explicitly. The host app's existing OTel stack keeps working.

### Identity getters at `init()`

`bento.init(user_id=..., session_id=..., tags=...)` accepts:

- A static value (single-tenant apps): `bento.init(user_id="org_42")`.
- A zero-arg callable (per-request apps): `bento.init(user_id=lambda: current_user.get())`.
- Omitted: keep whatever was previously registered (partial `init()` preserves identity).
- Explicit `None`: clear that field's source.

Bento invokes the callable on every span and writes the result to `gen_ai.user.id` / `gen_ai.conversation.id` / `langfuse.tags`. ADK integration-captured spans get tagged the same way — no per-call-site code.

A getter that raises is swallowed; the field is dropped for that span. The host app is never affected.

### Late-binding identity

| Call | Targets |
|---|---|
| `bento.update_current_trace(user_id=, session_id=, tags=, properties=)` | The open `bento.begin(...)` trajectory's root span. No-op if no trajectory is open. |
| `bento.update_current_span(properties=)` | The innermost open OTel span (could be a tool span, a framework span captured by an integration, or the trajectory root). |
| `with bento.propagate_attributes(user_id=, session_id=, tags=): ...` | Per-task scope; takes precedence over init-time getters. Restores on exit. |

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

- `track_ai` and `begin` detach from any outer OTel context on purpose. That keeps a Bento span out of the caller's FastAPI / Django trace. Do not "fix" this by reattaching; the ingest mapper depends on it.
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

If the app already has a `TracerProvider`, skip the analytics layer and wire the Bento exporter into the existing pipeline.

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

## Migrations

Reach this section only after **Step 1g** found Raindrop or Langfuse AND the user explicitly picked **migrate** (not "fresh integration alongside"). If the user picked fresh, return to the greenfield Step 3 patterns and leave the old SDK in place.

Once you're here, **pick the smoothest applicable path first** — manual per-call translation is the last resort. Full per-SDK translation tables and copy-prompt blocks live at:

- `https://docs.bentolabs.ai/migrations/raindrop.md`
- `https://docs.bentolabs.ai/migrations/langfuse.md`

### The three migration paths (apply in order, fall through on miss)

| Path | When it applies | How it works |
|---|---|---|
| **A — `bento.instrument()`** | App uses Google ADK | Three lines at startup. No per-call code. |
| **B — OpenInference instrumentor** | App used Raindrop's auto-instrumentation OR Langfuse's `langfuse.openai` / `langfuse.langchain` drop-ins | Register `openinference-instrumentation-<openai\|anthropic\|bedrock\|langchain>` with a `BentoLabsSpanProcessor`. Call sites stay untouched. |
| **C — manual translation** | Everything else | Per-call-site rename per the tables below. |

Most migrations end up using Path B for the bulk of the auto-captured LLM calls plus Path C for the handful of bespoke decorators/spans the old SDK had.

### Path A setup (Google ADK)

```bash
pip install "bentolabs-sdk[adk]"
```

```python
import bentolabs_sdk as bento

bento.init(
    user_id=lambda: get_current_user_id(),
    session_id=lambda: get_current_session_id(),
)
bento.instrument()
```

### Path B setup (OpenInference instrumentors)

Install the matching instrumentor(s) for each LLM SDK the migrator's app uses:

```bash
pip install openinference-instrumentation-openai
# Other libs as needed: -anthropic, -bedrock, -langchain, -llama-index
```

Register them once at app startup, against a `BentoLabsSpanProcessor`:

```python
from openinference.instrumentation.openai import OpenAIInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry import trace

from bentolabs_sdk import BentoLabsSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BentoLabsSpanProcessor())
trace.set_tracer_provider(provider)

OpenAIInstrumentor().instrument(tracer_provider=provider)
# Repeat for AnthropicInstrumentor / BedrockInstrumentor / LangChainInstrumentor / etc.
```

After this:
- For **Langfuse migrators**: replace every `from langfuse.openai import OpenAI` with stock `from openai import OpenAI` (instrumentor wraps the stock client). Drop `from langfuse.langchain import CallbackHandler` — the instrumentor takes its place.
- For **Raindrop migrators**: drop `raindrop.init(..., auto_instrument=True, instruments={...})`. The instrumentor replaces Traceloop's auto-capture; the LLM call sites stay untouched.

No `bento.track_ai` calls needed for anything Path B covers.

### From Raindrop (`raindrop-ai`, import `raindrop.analytics`)

1. `pip install bentolabs-sdk` (don't uninstall Raindrop until verify passes).
2. **Path A first.** If ADK is in use, add `bento.init(...)` + `bento.instrument()` at startup; that captures ADK's runs immediately.
3. **Path B next.** Raindrop's `auto_instrument=True` covered OpenAI/Anthropic/Bedrock via Traceloop. Preserve that auto-capture by registering the matching OpenInference instrumentor with a `BentoLabsSpanProcessor` — `OpenAIInstrumentor().instrument(tracer_provider=provider)` and friends. Call sites stay untouched.
4. **Path C for the rest:**
   - Replace `import raindrop.analytics as raindrop` with `import bentolabs_sdk as bento`.
   - Replace `raindrop.init(write_key)` (or `api_key=`) with `bento.init(api_key=...)` or set `BENTOLABS_API_KEY`.
   - **Add `provider="..."` to every remaining `bento.track_ai` call.** Bento does not auto-infer provider.
   - Delete every `raindrop.identify(...)` and `raindrop.track_signal(...)` call. Move user traits to `properties=` or init-time `tags=`.
   - `@raindrop.task` → `@bento.tool`. Bento collapses task and tool into one kind.
5. Run the verification flow from Step 5. Then `pip uninstall raindrop-ai`.

Full translation table at `/migrations/raindrop.md`.

### From Langfuse (`langfuse`, v3 Python SDK)

1. `pip install bentolabs-sdk` (don't uninstall Langfuse until verify passes).
2. **Path A first.** If ADK is in use, add `bento.init(...)` + `bento.instrument()` at startup.
3. **Path B next.** For each Langfuse drop-in or callback handler, register the matching OpenInference instrumentor with a `BentoLabsSpanProcessor`:
   - `from langfuse.openai import OpenAI` → `openinference-instrumentation-openai` (call sites use the stock `from openai import OpenAI`)
   - `from langfuse.langchain import CallbackHandler` → `openinference-instrumentation-langchain`
   - Anthropic, LlamaIndex, etc.: same pattern.
4. **Path C for the rest:**
   - Replace `Langfuse(public_key=..., secret_key=..., host=...)` / `get_client()` with `bento.init(api_key=...)`. Single key; format `bl_pk_...`; env var `BENTOLABS_API_KEY`.
   - `@observe()` on top-level handlers → `@bento.interaction`. `@observe()` on tool/helper functions → `@bento.tool`. `@observe(as_type="generation", ...)` → replace body with `bento.track_ai(event=, model=, provider=, input=, output=)`.
   - `propagate_attributes(user_id=, session_id=, tags=, metadata=)` → `bento.propagate_attributes(user_id=, session_id=, tags=)`. Drop `metadata=` (use `properties=` on per-call kwargs).
   - `langfuse.update_current_trace(metadata=...)` → `bento.update_current_trace(properties=...)`. Same rename for `update_current_observation` → `update_current_span`.
   - `session_id` is `session_id` on `init` / `begin` / `update_current_trace` / `propagate_attributes`, but **`convo_id` on `track_ai`** — the single biggest footgun.
   - Delete every `langfuse.score(...)`, `langfuse.get_prompt(...)`, and dataset call. No equivalents. Move score values to `properties={"score_<name>": value}`.
5. Run the verification flow from Step 5. Then `pip uninstall langfuse` and remove `LANGFUSE_*` env vars.

Full translation table at `/migrations/langfuse.md`.

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
- `https://docs.bentolabs.ai/python/integrations.md`
- `https://docs.bentolabs.ai/python/track-ai.md`
- `https://docs.bentolabs.ai/python/trajectories.md`
- `https://docs.bentolabs.ai/python/identity.md`
- `https://docs.bentolabs.ai/python/properties.md`
- `https://docs.bentolabs.ai/python/otel-transport.md`
- `https://docs.bentolabs.ai/python/threading-model.md`
- `https://docs.bentolabs.ai/migrations/langfuse.md`
- `https://docs.bentolabs.ai/migrations/raindrop.md`
- `https://docs.bentolabs.ai/concepts/data-model.md`
- `https://docs.bentolabs.ai/concepts/trajectories.md`
- `https://docs.bentolabs.ai/concepts/attributes.md`
- `https://docs.bentolabs.ai/concepts/sessions.md`
- `https://docs.bentolabs.ai/concepts/troubleshooting.md`

The full index is at `https://docs.bentolabs.ai/llms.txt`.
