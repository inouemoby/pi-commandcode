# pi-commandcode

A dynamic Command Code provider for Pi.

Command Code API documentation: <https://commandcode.ai/docs/provider>

## Behavior

- Registers the `commandcode` provider with no built-in model list, mirroring `pi-ollama-cloud`.
- Pi's native `/login` flow is used: choose **Sign in with an API key**, select **Command Code**, then enter the key in the standard login dialog.
- The live catalog is fetched from `/provider/v1/models` and cached at `~/.pi/agent/commandcode-models.json` (or `COMMANDCODE_MODELS_CACHE`). Cached models are used on restart while the live catalog refreshes.
- After authentication, Pi automatically refreshes the dynamic model catalog and persists the successful result.
- Claude model IDs use the documented Anthropic `/messages` endpoint; other models use OpenAI `/chat/completions`.
- Model names and context windows come from the live `/models` response. Known Command Code reasoning efforts and image-input capabilities supplement fields missing from that response. Prices remain zero when Command Code does not publish pricing in that response; this is not a billing claim.
- Known reasoning models, including Gemini, GLM, Claude, DeepSeek, Qwen, Kimi, and GPT families, receive valid Pi thinking-level mappings so selected thinking levels are sent as `reasoning_effort`.
- `COMMAND_CODE_API_KEY` and the legacy `COMMANDCODE_API_KEY` environment variable are supported.
- `CMD_ZDR=1` or `COMMANDCODE_ZDR=1` sends Command Code's documented `x-cmd-zdr: 1` header.

## Install

```text
pi install git:github.com/inouemoby/pi-commandcode
```

Then reload Pi and run `/login`.

## Development

```bash
npm install
npm run check
```
