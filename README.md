# <span style="color:#7c3aed">&#9653; Horme</span>

*In Greek mythology, Horme (/ˈhɔːrmiː/; Ancient Greek: Ὁρμή) is the Greek spirit personifying energetic activity, impulse or effort (to do a thing), eagerness, setting oneself in motion, and starting an action, and particularly onrush in battle.*

![Illustration](images/illustration_1.png)

**A professional, privacy-first AI assistant for Obsidian, powered by local LLMs via Ollama and an optimized RAG engine.**

No data leaves your machine. No API keys. No cloud. Just your models, your notes, your rules.

---

## <span style="color:#7c3aed">&#9776; Table of Contents</span>

- [Installation](#-installation)
- [Requirements](#-requirements)
- [Features](#-features)
  - [Vault Brain (Local RAG)](#-vault-brain-local-rag)
  - [Semantic Tagging](#-semantic-tagging)
  - [Privacy Firewall](#-privacy-firewall)
  - [Chat Panel](#-chat-panel)
  - [Right-Click Context Menu](#-right-click-context-menu)
  - [Inline Diff Confirmation](#-inline-diff-confirmation)
  - [Status Bar Progress](#-status-bar-progress)
  - [Token Awareness](#-token-awareness)
  - [Note Context](#-note-context)
  - [Document Upload](#-document-upload)
  - [Chat History](#-chat-history)
  - [Export Conversation](#-export-conversation)
  - [System Prompt Presets](#-system-prompt-presets)
  - [Per-Note Frontmatter Prompts](#-per-note-frontmatter-prompts)
- [Settings](#-settings)
- [Release Files](#-release-files)
- [Author](#-author)
- [License](#-license)

---

## <span style="color:#7c3aed">&#9662; Installation</span>

1. Download `main.js`, `styles.css`, and `manifest.json`.
2. Create a folder named `horme` inside your vault's `.obsidian/plugins/` directory.
3. Place the three files inside that folder.
4. Open Obsidian &#10132; Settings &#10132; Community Plugins &#10132; enable **Horme**.

---

## <span style="color:#7c3aed">&#9670; Requirements</span>

| Dependency | Details |
|---|---|
| **Ollama** | Must be running locally at `http://127.0.0.1:11434` (configurable). |
| **Embedding Model** | Specialized model for RAG (e.g. `ollama pull mxbai-embed-large`). |
| **Chat Model** | Pull a model with `ollama pull <model>` (e.g. `llama3`, `gemma2`). |
| **Obsidian** | v1.0.0 or later. |

---

## <span style="color:#7c3aed">&#9733; Features</span>

### <span style="color:#6d28d9">&#9655; Vault Brain (Local RAG)</span>

The Vault Brain gives the AI "Long-Term Memory" of your entire knowledge base. It uses a high-performance, private Retrieval-Augmented Generation (RAG) engine.

- **Lean Indexing:** Unlike other plugins, Horme does not store your text in the index. It stores character offsets and mathematical "fingerprints" (embeddings), reducing index size by 90% and keeping startup instant.
- **Auto-Pilot indexing:** The system automatically detects when you create or modify a note and updates the index in the background (with a 2-second debounce to save resources).
- **Semantic Search:** When you chat, Horme finds the top 5 most relevant snippets from your vault and injects them as context for the model.
- **Model-Locked Integrity:** The index is versioned. If you change your embedding model in settings, the plugin detects the mismatch and prompts for a rebuild to prevent corrupted results.

---

### <span style="color:#6d28d9">&#9655; Semantic Tagging</span>

Manage large tag collections (3,000+ tags) with ease using the **Hybrid Tag Suggester**.

- **Keyword + Semantic:** Combines traditional word-matching with mathematical topic-matching. It finds specific names (like "Hernán Cortés") AND broad themes (like "Spanish History") simultaneously.
- **Intelligent Candidates:** From a collection of thousands, it selects the 120 most relevant candidates and lets your local LLM make the final, precise selection.
- **Tag Index:** Dedicated "Tag Brain" that maps your entire hierarchy for instant retrieval. Use `Horme: Rebuild Tag Index` in settings to refresh.

---

### <span style="color:#6d28d9">&#9655; Privacy Firewall</span>

Horme is built with a "Privacy-First" architecture to prevent accidental data leakage.

- **Cloud Lock:** If you switch to a cloud provider (Claude, Gemini, etc.), the Vault Brain and background indexer are immediately disabled to ensure no private note content is processed by external servers.
- **Context Warning:** A one-time confirmation dialog is required before sending the current note context to a cloud provider.

---

### <span style="color:#6d28d9">&#9655; Chat Panel</span>

Open the chat panel from the ribbon icon (&#9653;) or the command palette (`Horme: Open chat panel`).

- **Micro-Batching:** Optimized for M4 architecture; handles large context windows by processing embeddings in small, stable groups to avoid memory errors.
- **Streaming UI:** Responses rendered as live Markdown with code blocks, lists, and full text selection.
- **Connection Indicator:** Live coloured dot (● Green / ● Red) showing Ollama status.

---

### <span style="color:#6d28d9">&#9655; Right-Click Context Menu</span>

Select text in any note to access professional editing tools:

| Action | Description |
|---|---|
| **Proofread** | Fixes grammar, spelling, and punctuation. |
| **Rewrite** | Improves clarity and readability. |
| **Expand** | Adds detail while preserving meaning. |
| **Summarize** | Condenses text to key points. |
| **Beautify Format** | Fixes heading hierarchy, normalizes lists and spacing. |
| **Fact check** | Verifies claims as accurate, inaccurate, or unverifiable. |

---

### <span style="color:#6d28d9">&#9655; Inline Diff Confirmation</span>

Before any text is changed, Horme shows a side-by-side **Original vs. Replacement** modal. You review the changes and explicitly click **Accept** or **Cancel**. All changes are fully undoable with `Ctrl+Z`.

---

### <span style="color:#6d28d9">&#9655; Status Bar Progress</span>

A professional progress indicator appears in the Obsidian status bar during background tasks:
- **● Indexing 47 / 3210**
The indicator is color-coded and disappears automatically when the task is finished, ensuring the UI stays clean.

---

### <span style="color:#6d28d9">&#9655; Token Awareness</span>

Horme estimates the total token count of the conversation before sending. If the context (system prompt + note context + documents + history) exceeds **~6,000 tokens**, a warning notice is displayed to prevent silent truncation.

---

### <span style="color:#6d28d9">&#9655; Note Context</span>

Toggle **"Use current note as context"** to inject the active note's content. The plugin tracks the last focused markdown editor live, so switching tabs updates the context automatically.

---

### <span style="color:#6d28d9">&#9655; Chat History</span>

Manage your past conversations via the History panel (&#128337;):
- **Debounced Saving:** History is saved every 2 seconds during active chat to minimize disk I/O and maintain performance.
- **Capped Storage:** Retains up to 200 conversations; oldest entries are automatically trimmed to keep the plugin light.
- **Flush on Close:** In-progress conversations are guaranteed to save when the chat panel is closed.

---

### <span style="color:#6d28d9">&#9655; Export Conversation</span>

Export any conversation as a formatted Markdown note (&#11015;). The file is saved to the configured export folder with a timestamped filename, preserving the distinction between User and Assistant messages.

---

### <span style="color:#6d28d9">&#9655; Per-Note Frontmatter Prompts</span>

Override the global system prompt for specific notes by adding a `horme-prompt` key to the YAML frontmatter. This allows for note-specific personas like "Spanish Tutor" or "Code Auditor" that activate automatically when the note is in context.

---

## <span style="color:#7c3aed">&#9881; Settings</span>

| Setting | Default | Description |
|---|---|---|
| **Ollama base URL** | `http://127.0.0.1:11434` | Endpoint for the Ollama API. |
| **Embedding Model** | `all-minilm` | Model used for indexing (e.g. `mxbai-embed-large`). |
| **Vault Brain** | `Off` | Toggle for the semantic RAG engine and background indexer. |
| **Max Tag Candidates** | `250` | Number of existing tags considered for semantic suggestions. |
| **Export folder** | `HORME` | Vault-relative path for saved notes and exports. |

---

## <span style="color:#7c3aed">&#9744; Release Files</span>

To install Horme, you need exactly three files:

| File | Purpose |
|---|---|
| `main.js` | Bundled plugin logic (includes `pdfjs-dist`). |
| `styles.css` |  Chat panel and modal styling. |
| `manifest.json` |  Plugin metadata for Obsidian. |

---

## <span style="color:#7c3aed">&#9998; Author</span>

**DuckTapeKiller**

---

## <span style="color:#7c3aed">&#9878; License</span>

MIT
