# Token Input Comparison: crafted_cli + base vs local_browser + base

This note compares what reaches the OpenAI Responses API on each turn for these two config stacks:

- `base.yaml + crafted_cli.yaml + model_openai.yaml`
- `base.yaml + local_browser.yaml + model_openai.yaml`

It is based on code-path tracing, with saved trajectory metrics used only to ground the cumulative effect.

## Shared request path

Both stacks follow the same high-level path:

1. The CLI merges YAML configs and instantiates the agent/model/environment.
2. `DefaultAgent.run()` seeds the conversation with the system prompt and instance prompt.
3. After each action, `DefaultAgent.execute_actions()` appends observation messages produced by `model.format_observation_messages(...)`.
4. `BaseModel._query_async()` sends the full message history every turn, not just the newest observation.
5. `OpenAIModel._serialize_response_input()` converts those messages into Responses API input parts.

That means token growth is cumulative transcript growth in both cases.

## What crafted_cli + base sends

`crafted_cli.yaml` mainly changes the agent prompts. It adds a longer system prompt and instance prompt with workflow instructions about planning, reusable scripts, logging, and benchmark behavior.

It does **not** replace the environment or the base observation mechanism. The dynamic per-step observation still comes from the local workspace environment, which contributes text fields such as:

- workspace and working directory
- command
- return code
- exception text
- command output
- `final_script.py` path and related workspace metadata
- recent screenshot path text when present

Important consequence: this stack has a **larger static prompt floor** than plain base local-workspace runs, but its **per-turn growth** is still mostly driven by shell output and workspace metadata.

## What local_browser + base sends

`local_browser.yaml` changes the action surface and the observation surface.

Its environment captures and injects much richer per-step text, including:

- URL
- page title
- Python execution output
- browser console output
- body ARIA snapshot
- screenshot path text

This is the main token-cost difference. The body ARIA snapshot can be large, and it is added as text every step. Because the full transcript is resent every turn, old ARIA snapshots keep getting paid for again on later requests.

## Screenshots are not image inputs here

Both compared stacks inherit `attach_observation_screenshot: false` from `base.yaml`.

`BaseModel.format_observation_messages()` only appends an `input_image` part when both of these are true:

- `attach_observation_screenshot` is enabled
- `screenshot_path` exists for the observation

So in these compared configs, screenshots are saved on disk by the environment, but they are **not** sent to OpenAI as image bytes. What the model sees is only screenshot path text inside the observation template.

## Practical comparison

The cleanest way to think about the difference is:

- `crafted_cli + base`: heavier initial prompt, lighter step-to-step observations
- `local_browser + base`: similar initial shape, much heavier step-to-step observations

So:

- if you care about first-turn overhead, `crafted_cli` is the extra cost driver
- if you care about long-run cumulative cost, `local_browser` is the extra cost driver

## Grounding from saved runs

There was no saved `crafted_cli` trajectory in the repo to quote directly, so the closest available local-workspace run is used only as a proxy for the dynamic observation behavior.

Saved `local_browser` sample:

- first request: 2 messages, 2 text parts, 0 image parts, 5,375 input tokens, 2,944 cached input tokens
- late request: 26 messages, 146,995 input tokens, 136,960 cached input tokens
- cumulative request total: 3,960,410 input tokens, 3,599,232 cached input tokens

Saved base/local-workspace sample:

- first request: 2 messages, 2 text parts, 0 image parts, 5,254 input tokens, 0 cached input tokens
- late request: 12 messages, 9,068 input tokens, 7,808 cached input tokens
- cumulative request total: 42,552 input tokens, 32,640 cached input tokens

Those numbers line up with the code path:

- the local-workspace path stays relatively compact because each step mostly adds command output text
- the local-browser path explodes because each step adds page-state text, especially ARIA snapshots, and all of it is replayed on later turns

## Bottom line

If you compare these two stacks purely by what is passed to OpenAI at each turn:

- `crafted_cli + base` differs mainly in prompt instructions
- `local_browser + base` differs mainly in observation payload size
- screenshots do not contribute image tokens in either compared config
- ARIA snapshots are the standout recurring token driver in `local_browser`

## Code references

- `src/webwright/agents/default.py`
- `src/webwright/models/base.py`
- `src/webwright/models/openai_model.py`
- `src/webwright/environments/local_workspace.py`
- `src/webwright/environments/local_browser.py`
- `src/webwright/config/base.yaml`
- `src/webwright/config/crafted_cli.yaml`
- `src/webwright/config/local_browser.yaml`