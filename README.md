[![GitHub Repo stars](https://img.shields.io/github/stars/DuckTapeKiller/horme?style=flat&logo=obsidian&color=%2327ae60)](https://github.com/DuckTapeKiller/horme/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/DuckTapeKiller/horme?logo=obsidian&color=%2327ae60)](https://github.com/DuckTapeKiller/horme/issues)
[![GitHub closed issues](https://img.shields.io/github/issues-closed/DuckTapeKiller/horme?logo=obsidian&color=%2327ae60)](https://github.com/DuckTapeKiller/horme/issues?q=is%3Aissue+is%3Aclosed)
[![GitHub manifest version](https://img.shields.io/github/manifest-json/v/DuckTapeKiller/horme?logo=obsidian&color=%2327ae60)](https://github.com/DuckTapeKiller/horme/blob/main/manifest.json)
[![Downloads](https://img.shields.io/github/downloads/DuckTapeKiller/horme/total?logo=obsidian&color=%2327ae60)](https://github.com/DuckTapeKiller/horme/releases)

# <span style="color:#7c3aed">&#9653; Horme</span>

**AVAILABLE IN OBSIDIAN COMMUNITY PLUGINS**

_In Greek mythology, Horme (/ˈhɔːrmiː/; Ancient Greek: Ὁρμή) is the Greek spirit personifying energetic activity, impulse or effort (to do a thing), eagerness, setting oneself in motion, and starting an action, and particularly onrush in battle._

![Illustration](images/illustration.jpeg)

---

> [!IMPORTANT]
>
> # Quick start
>
> ## TLDR — For Non-Technical Users
>
> To use this plugin's full capabilities, you need two local models:
>
> 1.  **An Indexing Model:** This model allows the plugin to interact with and index your notes.
> 2.  **An Interaction Model:** This is the model you will actually chat or “speak” with.
>
> ---
>
> ### Prerequisites: Setting up LM Studio
>
> We recommend using **LM Studio* to manage your local models. You can download it here: [Download LM Studio]([https://ollama.com/download](https://lmstudio.ai/download).
>
> **1. Download the Indexing Model:**
> This model is _only_ for indexing your vault in a compressed format; you cannot chat with it.
>
> - **Recommended Model:**
>
> - `nomic-embed-text:latest` (274 MB) **if** your vault contains text in one language;
> - `nomic-embed-text-v2-moe` (957 MB) **if** you have a multilingual vault.
>
> Open LM Studio, go to "Model search", type one of the models described above.
> 
> **2. Download the Interaction Model:**
>
> This is the model you will use for asking questions.
>
> - **Strong Recommendation:** `gemma-4-e4b` (9.6 GB)
>
> In LM Studio, go to "Model search", type one of the models described above.
>
> ### Manual Installation Steps
>
> Once both models are downloaded, follow these steps to install Horme:
>
> 1.  **Create Plugin Folder:**
>     - Navigate to your hidden Obsidian folder: `.obsidian/plugins`
>     - Create a new folder named `horme`.
> 2.  **Download Plugin Files:**
>     - Go to the repository releases page: [Horme Releases](https://github.com/DuckTapeKiller/horme/releases).
>     - Download the three files from the most recent release:
>       - `main.js`
>       - `manifest.json`
>       - `styles.css`
> 3.  **Activate in Obsidian:**
>     - Go to **Settings** in Obsidian.
>     - Scroll down and toggle on **“Enable Local Vault Memory”**.
>     - Select the indexing model you just downloaded: **`nomic-embed-text:latest`**.
>     - Wait for the count in the status bar to finish processing.
>
> ### Ready to Use
>
> Once the indexing is complete, go to the **Horme chat box** and ask any question about your notes.
>
> **Example Query:**
>
> > “I want to write an essay on modern art, help me find which of my notes can help me.”
>
> When using local providers (Ollama/LM Studio), no data leaves your machine and no API keys are required. If you use a cloud provider, Horme stores API keys via Obsidian Secret Storage (not in `data.json`).

---

## <span style="color:#7c3aed">&#9776; Table of Contents</span>

- [Installation](#-installation)
- [Requirements](#-requirements)
- [Features](#-features)
  - [Vault Brain (Local RAG)](#-vault-brain-local-rag)
    - [Search Relevance & Mathematics](#-search-relevance--mathematics)
  - [Live Connections](#-live-connections)
  - [Semantic Tagging](#-semantic-tagging)
  - [Grammar Proofreading Engine](#-grammar-proofreading-engine)
  - [Frontmatter Summary Generation](#-frontmatter-summary-generation)
  - [AI Skills](#-ai-skills)
  - [Privacy Firewall](#-privacy-firewall)
  - [Chat Panel](#-chat-panel)
  - [Multi-Note Context](#-multi-note-context)
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
- [Providers](#-providers)
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

| Dependency          | Details                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| **Ollama**          | Must be running locally at `http://127.0.0.1:11434` (configurable).                     |
| **Embedding Model** | Specialized model for RAG (e.g. `ollama pull nomic-embed-text` or `mxbai-embed-large`). |
| **Chat Model**      | Pull a model with `ollama pull <model>` (e.g. `gemma3`, `llama3`).                      |
| **Obsidian**        | v1.11.4 or later (required for Secret Storage API keys).                                |

---

## <span style="color:#7c3aed">&#9733; Features</span>

### <span style="color:#6d28d9">&#9655; Vault Brain (Local RAG)</span>

The Vault Brain gives the AI long-term memory of your entire knowledge base. It uses a high-performance, private Retrieval-Augmented Generation (RAG) engine.

- **Lean Indexing:** Horme does not store your text in the index. It stores character offsets and mathematical "fingerprints" (embeddings), reducing index size by 90% and keeping startup instant.
- **Auto-Pilot Indexing:** The system automatically detects when you create or modify a note and updates the index in the background (with a 2-second debounce to save resources).
- **Heading-Aware Chunking:** Notes are split into semantically meaningful chunks that preserve heading context, so the model knows which section a passage belongs to.
- **Model-Aware Prefixes:** The indexer automatically applies the correct asymmetric prefix convention for your embedding model (nomic-embed-text, mxbai-embed-large, or symmetric models), ensuring high-fidelity retrieval.
- **Multi-Query Fusion:** Search runs dual-embedding (full query + keyword distillation) for improved recall across your vault.
- **Model-Locked Integrity:** The index is versioned. If you change your embedding model in settings, the plugin detects the mismatch and prompts for a rebuild to prevent corrupted results.
- **Session Toggle:** A "Use Vault Brain" checkbox in the chat header lets you disable vault search per-session for faster responses when you don't need it.

#### <span style="color:#6d28d9">&#9655; Search Relevance & Mathematics</span>

The search engine uses a hybrid relevance scoring formula combining semantic embeddings, structured metadata matching, and a content-aware "deep scan".

The total score for any candidate chunk is:
$$\text{Total Score} = \text{Vector Score} + \text{Metadata Bonus} + \text{Content Bonus}$$

With a maximum possible score of **$1.45$**, the relevance weights are precisely allocated as follows:

| Element                                       | Max Score Contribution | Precise Relative Weight |
| :-------------------------------------------- | :--------------------: | :---------------------: |
| **Semantic Vector Similarity (Embeddings)**   |         `1.00`         |      **$69.0\%$**       |
| **Metadata Keyword Matching**                 |         `0.25`         |      **$17.2\%$**       |
| **Content Body Keyword Matching (Deep Scan)** |         `0.20`         |      **$13.8\%$**       |
| **Total**                                     |       **`1.45`**       |       **$100\%$**       |

##### Precise Breakdown of the Scoring Components

1. **Semantic Vector Score (Max Contribution: `1.00`, $69\%$ Weight):**
   - Calculated using cosine similarity between the query embedding and the chunk embedding (which mathematically ranges from `-1.0` to `1.0`).
2. **Metadata Keyword Bonus (Max Cap: `0.25`, $17.2\%$ Weight):**
   - Rewards exact matches in the note's structured fields (File Path, Summary, Tags, Headings).
   - **Quoted Terms Boost (e.g., `"exact search"`):** `+0.15` per term.
   - **Regular Keyword Terms Boost:**
     - File Path (Title): `+0.05` per matching word.
     - YAML Summary (`resumen`): `+0.04` per matching word.
     - Heading Hierarchy: `+0.04` per matching word.
     - Tags: `+0.03` per matching word.
3. **Content Body Keyword Bonus (Max Cap: `0.20`, $13.8\%$ Weight):**
   - Done as a "Deep Scan" on the actual body text for the top 50 candidates:
   - **Quoted Terms Boost inside body:** `+0.15` per term.
   - **Regular Keyword Terms inside body:** `+0.05` per term.

### <span style="color:#6d28d9">&#9655; Live Connections</span>

Horme can magically surface notes semantically related to what you're currently reading or writing in real-time. This feature runs entirely locally on top of the Vault Brain.

- **Real-time Discovery:** As you switch notes, a sidebar panel updates to show you related content across your vault.
- **Granular Control:** Adjust the similarity threshold, limit the maximum number of results, and exclude specific folders (like Templates or Daily Notes) directly from settings.
- **Privacy First:** Connections are generated locally using your indexed vector embeddings. No data is sent to the cloud.

---

### <span style="color:#6d28d9">&#9655; Semantic Tagging</span>

Manage large tag collections (3,000+ tags) with ease using the **Hybrid Tag Suggester**.

- **Keyword + Semantic:** Combines traditional word-matching with mathematical topic-matching. It finds specific names (like "Hernán Cortés") AND broad themes (like "Spanish History") simultaneously.
- **Intelligent Candidates:** From a collection of thousands, it selects the most relevant candidates and lets your local LLM make the final, precise selection.
- **Shadow Tagging (Bilingual):** Translate your tags automatically during indexing. Keep your vault in one language (e.g. Spanish `#pájaros`) but retrieve them using another (e.g. English "birds"). This is fully decoupled from the chat model, allowing you to use a dedicated local model just for translations. This does not affect your real tags in any way. It is just for the index.
- **Tag Index:** Dedicated tag brain that maps your entire hierarchy for instant retrieval. Use `Rebuild Tag Index` in settings to refresh.
- **Tag Button:** Quick access via the "Tags" button in the chat header.

---

### <span style="color:#6d28d9">&#9655; Grammar Proofreading Engine</span>

Feed the AI your own grammar manuals and style guides. Horme indexes them locally and consults them during proofreading.

- **Local Grammar Index:** Point the plugin to a folder containing your grammar reference notes. Horme chunks and indexes them for semantic retrieval.
- **Language-Aware Activation:** Set your grammar language in settings (e.g. "Español"). The grammar skill is only triggered when proofreading text in that language — English text won't invoke Spanish grammar rules.
- **Academic Precision:** When proofreading, the AI is explicitly instructed to consult your grammar manuals for non-obvious errors like false cognates, prepositional regimes, and orthotypography.

---

### <span style="color:#6d28d9">&#9655; Frontmatter Summary Generation</span>

Automatically generate concise summaries and write them directly into your notes' YAML frontmatter.

- **Configurable Field:** Choose the frontmatter key (e.g. `summary`, `resumen`, `abstract`) in settings.
- **Configurable Language:** Summaries are generated in your chosen language.
- **Two Access Points:** Use the "Summary" button in the chat header or the command palette (`Horme: Generate frontmatter summary`).
- **Overwrite Protection:** If a summary already exists, a confirmation dialog shows old vs. new before replacing.

---

### <span style="color:#6d28d9">&#9655; AI Skills</span>

Horme extends the LLM with modular skills that it can invoke autonomously during conversations and actions. Skills are tool calls the model emits when it needs external information.

| Skill                         | Type            | Description                                                                                                                                                          |
| ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wikipedia Search**          | &#127760; Web   | Searches Wikipedia for factual verification. Supports multiple languages (`en`, `es`, `fr`, etc.). Returns summaries and relevant article sections with source URLs. |
| **Wiktionary Lookup**         | &#127760; Web   | Looks up word definitions, etymology, and usage notes. Useful for distinguishing false friends and verifying word existence. Multi-language.                         |
| **DuckDuckGo Instant Answer** | &#127760; Web   | Quick facts and topic summaries for recent events, technical specs, and niche topics not covered by Wikipedia. No API key required.                                  |
| **Date Calculator**           | &#128187; Local | Computes time differences between dates, verifies day-of-week for historical dates, and checks chronological consistency. Pure computation, zero latency.            |
| **Vault Linker**              | &#128218; Index | Finds semantically related notes within your vault. Privacy-guarded — only available to local providers (or with explicit cloud opt-in).                             |
| **Taxonomy Scholar**          | &#128218; Index | Retrieves the full list of existing tags to ensure consistent tagging.                                                                                               |
| **Grammar Scholar**           | &#128218; Index | Consults your local grammar and orthography manuals for precision checks on syntax, false friends, and orthotypography.                                              |

#### Custom HTTP Skills

Beyond the built-in skills, you can create your own HTTP-based skills to connect Horme to any REST API (local or public). You just configure the URL, method, headers, and a response path.

**Example: Open Library Book Search**

- **Method:** `GET`
- **URL:** `https://openlibrary.org/search.json?q={{query}}&limit=3`
- **Response Path:** `docs`

When armed, typing a query (e.g., "Don Quixote") replaces the `{{query}}` placeholder, makes the request, extracts the `docs` array, and injects it directly into the AI's context so it can answer your question using real-time data.

---

### <span style="color:#6d28d9">&#9655; Privacy Firewall</span>

Horme is built with a "Privacy-First" architecture with four layers of protection on vault data.

- **Cloud Lock:** If you switch to a cloud provider (Claude, Gemini, etc.), the Vault Brain, background indexer, and Vault Linker skill are immediately disabled. No private note content is processed by external servers.
- **Skill Suppression:** When vault search is locked, the Vault Linker skill is hidden from the model's instructions entirely — the model never even knows it exists.
- **Defence in Depth:** Even if a prompt-injected model somehow attempts to call the vault skill, the skill itself refuses to execute when access is locked.
- **Context Warning:** A one-time confirmation dialog is required before sending the current note context to a cloud provider.
- **Explicit Opt-In:** An "Allow Cloud Provider Access" toggle (with a confirmation prompt) is required before any vault content can be sent to cloud providers.
- **Tag & Grammar indexes** are available to all providers — they contain only tag names and grammar manual excerpts, not private vault content.

---

### <span style="color:#6d28d9">&#9655; Chat Panel</span>

Open the chat panel from the ribbon icon (&#9653;) or the command palette (`Horme: Open chat panel`).

- **Streaming UI:** Responses rendered as live Markdown with code blocks, lists, and full text selection.
- **Connection Indicator:** Live coloured dot showing LM Studio status.
- **Model Selector:** Switch between available models directly from the chat header.
- **Micro-Batching:** Optimized for Apple Silicon; handles large context windows by processing embeddings in small, stable groups.

---

### <span style="color:#6d28d9">&#9655; Multi-Note Context</span>

Send multiple notes as context to the AI in a single conversation.

- **Note Picker:** Click "+ Add notes" in the chat header to open a fuzzy search modal. Select up to 5 notes.
- **Folder Picker:** Click "+ Add folders" to include all notes inside a folder (and its subfolders) as context. If the folder is too large, Horme truncates it to the configured character budget.
- **Selected Notes Label:** A compact label shows which notes are currently included as context.
- **Clear All:** One-click button to remove all selected notes.
- **Per-Session:** Selections persist across messages within the same chat session and are cleared on new conversations.

---

### <span style="color:#6d28d9">&#9655; Right-Click Context Menu</span>

Select text in any note to access professional editing tools via right-click &#10132; **Horme**:

| Action              | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| **Proofread**       | Fixes grammar, spelling, and punctuation. Consults your grammar manuals for the configured language. |
| **Rewrite**         | Opens a tone picker: Formal, Friendly, Academic, Sarcastic, Aggressive, or Humanise.                 |
| **Expand**          | Adds detail while preserving meaning.                                                                |
| **Summarize**       | Condenses text to key points.                                                                        |
| **Beautify Format** | Fixes heading hierarchy, normalizes lists and spacing.                                               |
| **Fact Check**      | Verifies each claim against Wikipedia. Returns structured verdicts with source citations.            |
| **Translate**       | Opens a language input modal. Translates to any language.                                            |

---

### <span style="color:#6d28d9">&#9655; Inline Diff Confirmation</span>

Before any text is changed, Horme shows a side-by-side **Original vs. Replacement** modal. You review the changes and explicitly click **Accept** or **Cancel**. All changes are fully undoable with `Ctrl+Z`.

---

### <span style="color:#6d28d9">&#9655; Status Bar Progress</span>

A professional progress indicator appears in the Obsidian status bar during background tasks:

- **&#9679; Indexing 47 / 3210**

The indicator is color-coded and disappears automatically when the task is finished.

---

### <span style="color:#6d28d9">&#9655; Token Awareness</span>

Horme estimates the total token count of the conversation before sending. If the context (system prompt + note context + documents + history) exceeds **~6,000 tokens**, a warning notice is displayed to prevent silent truncation.

---

### <span style="color:#6d28d9">&#9655; Note Context</span>

Toggle **"Use current note as context"** to inject the active note's content. The plugin tracks the last focused markdown editor live, so switching tabs updates the context automatically.

---

### <span style="color:#6d28d9">&#9655; Document Upload</span>

Upload `.txt` and `.md` files directly into the chat. Horme injects the file content as context for the model.

---

### <span style="color:#6d28d9">&#9655; Chat History</span>

Manage your past conversations via the History panel (&#128337;):

- **Debounced Saving:** History is saved every 2 seconds during active chat to minimize disk I/O.
- **Capped Storage:** Retains up to 200 conversations; oldest entries are automatically trimmed.
- **Flush on Close:** In-progress conversations are guaranteed to save when the chat panel is closed.

---

### <span style="color:#6d28d9">&#9655; Export Conversation</span>

Export any conversation as a formatted Markdown note (&#11015;). The file is saved to the configured export folder with a timestamped filename, preserving the distinction between User and Assistant messages.

---

### <span style="color:#6d28d9">&#9655; System Prompt Presets</span>

Create reusable system prompts (e.g. "Constitutional Law Professor", "Code Auditor", "Spanish Tutor") in settings. Switch between them from the preset dropdown in the chat header — no need to retype.

---

### <span style="color:#6d28d9">&#9655; Per-Note Frontmatter Prompts</span>

Override the global system prompt for specific notes by adding a `horme-prompt` key to the YAML frontmatter. This allows for note-specific personas that activate automatically when the note is in context.

```yaml
---
horme-prompt: "You are an expert in constitutional law. Always cite legal precedent."
---
```

---

## <span style="color:#7c3aed">&#9741; Providers</span>

Horme supports multiple AI providers. Local providers are recommended for privacy.

| Provider       | Type            | Notes                                               |
| -------------- | --------------- | --------------------------------------------------- |
| **Ollama**     | &#127968; Local | Default. Full feature access including Vault Brain. |
| **LM Studio**  | &#127968; Local | Full feature access including Vault Brain.          |
| **Claude**     | &#9729; Cloud   | Vault Brain requires explicit opt-in.               |
| **Gemini**     | &#9729; Cloud   | Vault Brain requires explicit opt-in.               |
| **OpenAI**     | &#9729; Cloud   | Vault Brain requires explicit opt-in.               |
| **Groq**       | &#9729; Cloud   | Vault Brain requires explicit opt-in.               |
| **OpenRouter** | &#9729; Cloud   | Vault Brain requires explicit opt-in.               |

---

## <span style="color:#7c3aed">&#9881; Settings</span>

| Setting                   | Default                  | Description                                                                                |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| **Ollama Base URL**       | `http://127.0.0.1:11434` | Endpoint for the Ollama API.                                                               |
| **Embedding Model**       | `nomic-embed-text`       | Model used for indexing (e.g. `nomic-embed-text`, `mxbai-embed-large`).                    |
| **Vault Brain**           | `Off`                    | Toggle for the semantic RAG engine and background indexer.                                 |
| **Allow Cloud RAG**       | `Off`                    | Explicitly allow vault content to be sent to cloud providers.                              |
| **Cloud API Keys**        | —                        | Stored in Obsidian Secret Storage (not in `data.json`).                                    |
| **Grammar Manual Folder** | `Gramática`              | Folder containing your grammar reference notes.                                            |
| **Grammar Language**      | `Español`                | Language your grammar manuals cover. Proofreading only consults manuals for this language. |
| **Summary Field**         | `summary`                | Frontmatter key where generated summaries are stored.                                      |
| **Summary Language**      | `Español`                | Language summaries are written in.                                                         |
| **Max Tag Candidates**    | `250`                    | Number of existing tags considered for semantic suggestions.                               |
| **Debug logging**         | `Off`                    | Enables extra developer-console logs (may include file paths).                             |
| **Export Folder**         | `HORME`                  | Vault-relative path for saved notes and exports.                                           |

---

## <span style="color:#7c3aed">&#9744; Release Files</span>

To install Horme, you need exactly three files:

| File            | Purpose                       |
| --------------- | ----------------------------- |
| `main.js`       | Bundled plugin logic.         |
| `styles.css`    | Chat panel and modal styling. |
| `manifest.json` | Plugin metadata for Obsidian. |

---

## <span style="color:#7c3aed">&#9998; Author</span>

**DuckTapeKiller**

---

## <span style="color:#7c3aed">&#9878; License</span>

MIT
