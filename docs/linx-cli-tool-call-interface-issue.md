 # LinX CLI tool calls do not take effect through xpod chat completions

  ## Phenomenon

  LinX CLI uses Pi TUI as the frontend and sends coding-agent requests to xpod through the OpenAI-compatible `/v1/chat/completions` API.

  In the current flow, the assistant can answer in text and may say it will inspect files or run commands, but the Pi TUI does not receive a real tool call event. As a result,
  tools such as `bash` are not executed.

  This should be treated as an xpod API compatibility issue, not as a LinX CLI client-side compatibility shim problem.

  ## Expected Behavior

  When the client sends `tools` with `tool_choice: "auto"` to `/v1/chat/completions`, xpod should preserve the OpenAI-compatible tool-call contract through its API boundary.

  If the model chooses to call a tool, xpod should return `choices[0].message.tool_calls` with `finish_reason: "tool_calls"`.

  ## Minimal Reproduction Request

  ```json
  {
    "model": "linx-lite",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "List the current directory using the bash tool."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "bash",
          "description": "Run a shell command",
          "parameters": {
            "type": "object",
            "properties": {
              "command": { "type": "string" }
            },
            "required": ["command"]
          }
        }
      }
    ],
    "tool_choice": "auto"
  }

  ## Evidence From LinX CLI Side

  LinX CLI already sends OpenAI-compatible tool metadata when Pi provides tools:

  - Request contains tools.
  - Request contains tool_choice: "auto" when tools are present.
  - Response parsing reads choices[0].message.tool_calls.
  - Parsed tool calls are emitted back into Pi as toolcall_start, toolcall_delta, and toolcall_end.

  So the client-side expected contract is: xpod returns real OpenAI-compatible tool_calls; LinX CLI should not infer tool calls from assistant text.

  ## Observed xpod Boundary Behavior

  Local inspection of xpod source and compiled output shows /v1/chat/completions currently narrows the incoming request before passing it to the chat service.

  The request object passed downstream keeps:

  - model
  - messages
  - temperature
  - max_tokens
  - stream

  The following OpenAI-compatible fields are not preserved at that boundary:

  - tools
  - tool_choice
  - assistant history tool_calls
  - tool result messages with tool_call_id
  - other optional OpenAI chat-completions fields

  That means even if LinX CLI sends the correct request, downstream ai-gateway/provider logic may receive a request with the tool fields already stripped.

  ## Scope For xpod Owner

  xpod should own the remaining investigation and fix.

  Suggested checks:

  - Confirm whether live /v1/chat/completions receives tools and tool_choice from LinX CLI.
  - Confirm whether the handler forwards those fields to ai-gateway/provider.
  - Confirm whether linx / linx-lite support tool calling through the configured provider route.
  - Add a regression test that sends tools and tool_choice to /v1/chat/completions and asserts those fields reach the downstream service unchanged.

  LinX CLI should not add text-pattern based fallback behavior such as converting "I will list files" into a synthetic bash ls call.
