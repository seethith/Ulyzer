# Ulyzer

[中文](README.md) | [English](README.en.md)

**An AI-powered personal knowledge graph learning tool.** Ulyzer turns any learning goal into a DAG-based roadmap, then helps you learn node by node with AI tutors, generated materials, practice, and review.

> 🚧 In development · macOS first · Stars and feedback are welcome

![Ulyzer screenshot](docs/assets/ulyzer-screenshot.png)

---

## Core Features

- **Learning roadmap (DAG)** — Generate a visual dependency graph from your goals, background, and time budget.
- **Knowledge component outlines** — Each node can evolve from v1 to v3 outlines, from beginner-friendly coverage to deeper survey-level structure.
- **AI tutor conversations** — A main tutor plans and adjusts the roadmap; a node tutor creates explanations, exercises, and reference answers.
- **Feynman review** — Generate review checklists to test whether you truly understand a node.
- **Local-file-first workspace** — Generated materials are stored as editable local Markdown files, with Mermaid diagram rendering.
- **RAG retrieval** — Retrieve existing node materials to reduce repeated generation.
- **Multi-model support** — Switch between cloud providers, OpenAI-compatible endpoints, and local Ollama models.

---

## Supported AI Providers

Anthropic · OpenAI · DeepSeek · Google Gemini · xAI Grok · Alibaba Qwen · MiniMax · OpenRouter · Ollama (local) · Any OpenAI-compatible endpoint

---

## Run Locally

### Requirements

- Node.js 18+
- macOS recommended. Windows and Linux may work but are not fully tested yet.

### Install and Start

```bash
git clone https://github.com/seethith/Ulyzer.git
cd Ulyzer
npm install
npm run dev
```

### Build

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

---

## Configure API Keys

After launching Ulyzer, open **Settings → Model** and add the API key for the provider you want to use.

Keys are stored in the operating system keychain and are not intended to be written into files or logs.

If you want a local-only setup, configure [Ollama](https://ollama.com) and use a local model.

---

## Documentation

- [Privacy](docs/PRIVACY.en.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

---

## Data Storage

Application data is stored locally by default:

- **Database**: `~/Library/Application Support/Ulyzer/ulyzer.db` (SQLite)
- **Learning files**: `~/Library/Application Support/Ulyzer/ulyzer-content/` (Markdown files)

When you use cloud model providers or web search, relevant prompts, attachment snippets, and search queries are sent to the third-party services you configure. To reduce third-party data transfer, use Ollama or another local provider and leave Tavily / Exa / YouTube search keys unconfigured.

---

## Sponsorship

If this project helps you, sponsorship is welcome:

<!-- Sponsor QR placeholder
![Sponsor QR](docs/sponsor.png)
-->

---

## License

[MIT](LICENSE) © 2025 seethith
