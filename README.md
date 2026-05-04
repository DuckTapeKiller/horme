# <span style="color:#7c3aed">&#9653; Horme</span>

*In Greek mythology, Horme (/ˈhɔːrmiː/; Ancient Greek: Ὁρμή) is the Greek spirit personifying energetic activity, impulse or effort (to do a thing), eagerness, setting oneself in motion, and starting an action, and particularly onrush in battle.*

![Illustration](images/illustration_1.png)

**A minimalist, privacy-first AI assistant for Obsidian, powered by local LLMs via Ollama.**

No data leaves your machine. No API keys. No cloud. Just your models, your notes, your rules.

---

## <span style="color:#7c3aed">&#9776; Table of Contents</span>

- [Installation](#-installation)
- [Requirements](#-requirements)
- [Features](#-features)
  - [Chat Panel](#-chat-panel)
  - [Right-Click Context Menu](#-right-click-context-menu)
  - [Inline Diff Confirmation](#-inline-diff-confirmation)
  - [Keyboard Shortcuts](#-keyboard-shortcuts)
  - [Stop Generation](#-stop-generation)
  - [Copy, Regenerate, Save](#-copy-regenerate-save)
  - [Token Awareness](#-token-awareness)
  - [Connection Status Indicator](#-connection-status-indicator)
  - [Note Context](#-note-context)
  - [Document Upload](#-document-upload)
  - [Chat History](#-chat-history)
  - [Export Conversation](#-export-conversation)
  - [System Prompt Presets](#-system-prompt-presets)
  - [Per-Note Frontmatter Prompts](#-per-note-frontmatter-prompts)
  - [Configurable Export Path](#-configurable-export-path)
  - [Smart Tagging](#-smart-tagging)
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
| **At least one model** | Pull a model with `ollama pull <model>` (e.g. `llama3`, `mistral`, `gemma2`). |
| **Obsidian** | v1.0.0 or later. |

---

## <span style="color:#7c3aed">&#9733; Features</span>

### <span style="color:#6d28d9">&#9655; Chat Panel</span>

Open the chat panel from the ribbon icon (&#9653;) or the command palette (`Horme: Open chat panel`). The panel lives in the left sidebar and provides a full streaming conversation interface with your local model.

- Model selector dropdown with live connection indicator.
- Streaming responses rendered as Markdown (code blocks, lists, bold, etc.).
- Text in both user and assistant messages is fully selectable.

---

### <span style="color:#6d28d9">&#9655; Right-Click Context Menu</span>

Select text in any note, right-click, and choose **Horme** to access:

| Action | Description |
|---|---|
| **Proofread** | Fixes grammar, spelling, and punctuation. |
| **Rewrite** | Improves clarity and readability. |
| **Expand** | Adds detail while preserving meaning. |
| **Summarize** | Condenses text to key points. |
| **Beautify Format** | Fixes heading hierarchy, normalizes lists and spacing. |
| **Fact check** | Verifies claims as accurate, inaccurate, or unverifiable. |
| **Change tone** | Submenu: Formal &#8729; Casual &#8729; Concise &#8729; Friendly. |
| **Translate** | Prompts for a target language and translates. |

---

### <span style="color:#6d28d9">&#9655; Inline Diff Confirmation</span>

When a right-click action completes, Horme shows a side-by-side **Original vs. Replacement** modal before touching your text. You review the diff and explicitly click **Accept** or **Cancel**. The replacement is always undoable with `Ctrl+Z`.

---

### <span style="color:#6d28d9">&#9655; Keyboard Shortcuts</span>

Every context menu action is also registered as an Obsidian command:

- `Horme: Proofread`
- `Horme: Rewrite`
- `Horme: Expand`
- `Horme: Summarize`
- `Horme: Beautify Format`
- `Horme: Fact check`

Bind any of these to a hotkey via **Settings &#10132; Hotkeys**. Each command operates on the current editor selection.

---

### <span style="color:#6d28d9">&#9655; Stop Generation</span>

During streaming, the send button transforms into a red &#9632; **stop** button. Clicking it cancels the active stream immediately via `reader.cancel()`, so you are never stuck waiting for a slow or runaway model.

---

### <span style="color:#6d28d9">&#9655; Copy, Regenerate, Save</span>

Below every assistant response, three action buttons appear:

| Button | Action |
|---|---|
| **Copy** | Copies the response text to your clipboard. |
| **Regenerate** | Removes the last response and re-sends the same prompt for a fresh answer. |
| **Save as note** | Saves the response as a `.md` file in the configured export folder. |

---

### <span style="color:#6d28d9">&#9655; Token Awareness</span>

Before sending a message, Horme estimates the total token count of the conversation (system prompt + note context + uploaded documents + chat history). If the estimate exceeds **~6,000 tokens**, a warning notice is displayed:

> &#9888; ~8200 tokens -- may exceed model context window

This helps prevent silent truncation on models with small context limits.

---

### <span style="color:#6d28d9">&#9655; Connection Status Indicator</span>

A small coloured dot appears next to the model selector:

- &#9679; **Green** -- Ollama is reachable.
- &#9679; **Red** -- Ollama is unreachable.

The status refreshes on load and whenever you click the refresh button.

---

### <span style="color:#6d28d9">&#9655; Note Context</span>

Check **"Use current note as context"** to inject the active note's full content into the system prompt. A label below the toggle shows the name of the note being used (e.g. `My Article`), and it updates live when you switch tabs.

The plugin tracks the *last focused markdown editor*, so clicking into the chat panel does not break the reference.

---

### <span style="color:#6d28d9">&#9655; Document Upload</span>

Click the &#128206; paperclip button to upload a file:

- **PDF** -- Text is extracted client-side via `pdfjs-dist`. No external service is contacted.
- **TXT / MD** -- Read directly.

The document content is injected as context for subsequent messages until the chat is cleared.

---

### <span style="color:#6d28d9">&#9655; Chat History</span>

Click the &#128337; clock button in the header to open the **Chat History** panel.

- Conversations are auto-saved after each assistant response and when you clear the chat.
- Each entry shows the first message (truncated) and a timestamp.
- Click any entry to reload that conversation with full Markdown rendering.
- **Delete history** wipes all stored conversations.

Up to 50 conversations are retained in local storage.

---

### <span style="color:#6d28d9">&#9655; Export Conversation</span>

Click the &#11015; download button in the header to export the full conversation as a Markdown note. The export uses the format:

```
**You**:
your message

---

**Horme**:
assistant response
```

The file is saved to the configured export folder with a timestamped filename.

---

### <span style="color:#6d28d9">&#9655; System Prompt Presets</span>

Create named system prompt presets in **Settings &#10132; System Prompt Presets**. When at least one preset exists, a dropdown appears in the chat header allowing you to switch personas on the fly (e.g. "Coding Assistant", "Writing Coach", "Translator").

Selecting "Default prompt" reverts to the global system prompt.

---

### <span style="color:#6d28d9">&#9655; Per-Note Frontmatter Prompts</span>

Override the global system prompt for a specific note by adding a `horme-prompt` key to its YAML frontmatter:

```yaml
---
horme-prompt: "You are a Spanish tutor. Always respond in Spanish."
---
```

When this note is the active context, its frontmatter prompt takes priority over the global system prompt and any selected preset. This works for both chat and right-click actions.

---

### <span style="color:#6d28d9">&#9655; Configurable Export Path</span>

By default, saved notes and exported conversations go to a `HORME` folder at the vault root. Change this in **Settings &#10132; Export folder**. The folder is created automatically if it does not exist.

---

### <span style="color:#6d28d9">&#9655; Smart Tagging</span>

Automatically generate relevant tags for your notes based on your existing vault tags. Use the command `Horme: Suggest frontmatter tags` to:

- Analyze the current note's content.
- Compare it against your vault's live tag index (or a specific "allowed tags" note).
- Get a ranked list of suggested tags.
- Apply them directly to the note's YAML frontmatter.

This ensures your tagging stays consistent and avoids creating "hallucinated" tags that don't exist in your system.

---

## <span style="color:#7c3aed">&#9881; Settings</span>

| Setting | Default | Description |
|---|---|---|
| **Ollama base URL** | `http://127.0.0.1:11434` | Endpoint for the Ollama API. |
| **Default model** | *(first available)* | Model used for all actions and chat. |
| **Custom system prompt** | *(empty)* | Global prompt prepended to every interaction. |
| **Temperature** | `0.6` | Controls response randomness (0 = deterministic, 1 = creative). |
| **Export folder** | `HORME` | Vault-relative path for saved notes and exports. |
| **Prompt presets** | *(none)* | Named system prompt profiles, selectable from the chat panel. |
| **Optional tag list note** | *(none)* | Use a specific note as the allowed-tag list instead of the vault index. |
| **Max tag candidates** | `250` | How many existing tags to send to the model for consideration. |
| **Max suggested tags** | `12` | Upper bound for tags suggested for a single note. |

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
