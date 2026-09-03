# pi-commandcode

A dynamic Command Code provider for Pi.

Command Code API documentation: <https://commandcode.ai/docs/provider>

## Behavior

- Registers the `commandcode` provider with **zero static models**, mirroring `pi-ollama-cloud`.
- Pi's native `/login` flow is used: choose **Sign in with an API key**, select **Command Code**, then enter the key in the standard login dialog.
- After authentication, Pi automatically refreshes the dynamic model catalog.
- Claude model IDs use the documented Anthropic `/messages` endpoint; other models use OpenAI `/chat/completions`.
- Model names, context windows, max output limits, reasoning hints, and image-input flags are derived from the live `/models` response. Prices remain zero when Command Code does not publish pricing in that response; this is not a billing claim.
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
