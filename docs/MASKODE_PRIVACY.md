# Maskode privacy layer

Maskode is an unofficial fork of OpenCode that anonymizes sensitive spans in attached text files before those files are sent to the coding model. It uses OpenAI's [`privacy-filter`](https://huggingface.co/openai/privacy-filter) and restores placeholders locally in model responses and tool arguments.

Only attached text-file content is filtered. Ordinary chat messages, binary/media attachments, system prompts, and general tool output are not filtered. Treat detection as defense in depth: a classifier can miss sensitive data.

## Enable or disable

Privacy is enabled by default. It can be controlled persistently in `opencode.json`:

```json
{
  "privacy": {
    "enabled": true,
    "backend": "local",
    "scope": "attachments",
    "executable": "/absolute/path/to/opf-local"
  }
}
```

Or override it for one run:

```bash
maskode --privacy
maskode --no-privacy
```

Inside the full TUI, run `/privacy` to open the attachment-privacy controls. The dialog shows the current state without changing it; use its `enable` or `disable` action to persist a new project setting. The update contains only the boolean setting, so a resolved `HF_TOKEN` is never written back by this command.

`MASKODE_PRIVACY_FILTER=off maskode` also disables filtering. Legacy `BOGU_PRIVACY_*` environment variables and an existing Bogu managed-model installation remain supported as migration fallbacks.

## Local backend (recommended)

The local backend keeps attached file content on your machine. Build or install the companion `opf-local` executable and either put it on `PATH` or configure its absolute path as shown above.

For a managed installation:

```bash
maskode privacy install
maskode privacy status
```

Maskode downloads the public model without requiring `HF_TOKEN`, installs it under `~/.local/share/maskode/privacy`, and discovers it automatically. Python 3.10 or newer is required; the standard macOS installer can install Python 3.12 through Homebrew.

The executable must accept UTF-8 text on stdin and support:

```bash
opf-local --format json --no-print-color-coded-text
```

Its stdout must include a JSON object containing `detected_spans`, where every span has `label`, `start`, and `end`. Maskode tolerates diagnostic lines around that JSON, although diagnostics should preferably go to stderr.

You can also select the executable for one run:

```bash
MASKODE_PRIVACY_FILTER=/absolute/path/to/opf-local maskode
```

## Hugging Face backend

The Hugging Face backend sends the original attached text to Hugging Face's inference service for classification. Use the local backend if the file itself must never leave your machine.

Create a Hugging Face token with Inference Providers permission, export it in your shell, and reference it from configuration. Do not commit the actual token.

```bash
export HF_TOKEN=hf_your_token
cp opencode.example.json opencode.json
maskode
```

`opencode.example.json` contains:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "privacy": {
    "enabled": true,
    "backend": "huggingface",
    "scope": "attachments",
    "api_key": "{env:HF_TOKEN}",
    "model": "openai/privacy-filter",
    "log": "/tmp/maskode-privacy.jsonl"
  }
}
```

The default endpoint is `https://router.huggingface.co/hf-inference/models`. It can be replaced with `privacy.endpoint` for an API-compatible deployment.

## Audit the anonymized provider text

Set `privacy.log` or `MASKODE_PRIVACY_LOG`. The JSON Lines audit contains only the anonymized text and detected labels, never the placeholder mapping or API token:

```bash
MASKODE_PRIVACY_LOG=/tmp/maskode-privacy.jsonl maskode
tail -f /tmp/maskode-privacy.jsonl | jq .
```

The log can still contain sensitive text the classifier failed to detect, so protect or delete it appropriately.

Placeholder mappings exist only in memory and are isolated per session. They are lost when Maskode exits and are never persisted.
