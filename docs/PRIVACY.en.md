# Privacy

[中文](PRIVACY.zh-CN.md) | [English](PRIVACY.en.md)

Ulyzer stores application data locally by default, but some features call third-party services that you configure.

## Local Data

On macOS, Ulyzer stores data under:

- `~/Library/Application Support/Ulyzer/ulyzer.db`
- `~/Library/Application Support/Ulyzer/ulyzer-content/`

The SQLite database contains courses, DAG nodes, chat history, settings, and token usage metadata. The content folder contains generated or user-created learning files.

## API Keys

Provider keys are stored with the operating system keychain via `keytar`. They are not intended to be written into project files, generated learning files, or logs.

## Third-Party Requests

When you use cloud model providers, Ulyzer sends the relevant prompt, conversation context, and supported attachments to the provider you selected. When search features are enabled, search queries may be sent to Tavily, Exa, or YouTube Data API.

To reduce third-party data transfer, use a local provider such as Ollama and leave search API keys unconfigured.

## Attachments

Text/code attachments may be included in prompts. Images are sent only to models that support vision. PDFs are currently intended for providers that support PDF/document inputs.

Review attachments before sending if they may contain private or sensitive information.
