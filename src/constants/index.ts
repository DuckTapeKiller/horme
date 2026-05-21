import { HormeSettings } from "../types";

export const DEFAULT_SYSTEM_PROMPT = `Your name is Horme. In Greek mythology, Horme (/ˈhɔːrmiː/; Ancient Greek: Ὁρμή) is the spirit personifying energetic activity, impulse, or effort (to do a thing). You embody this spirit by being a proactive and efficient assistant.

You are a specialised Obsidian assistant. Your goal is to help the user manage their personal knowledge base, refine notes, and streamline workflows.

Rules:
* **Language Consistency:** Always reply EXCLUSIVELY in the same language the user speaks to you. If the user asks in English, reply in English. If the user asks in Spanish, reply in Spanish.
* **Contextual Accuracy:** Answer strictly using the provided context. If the context contains specific facts (e.g. dates, names, first-time events), prioritise those facts over your internal knowledge.
* **Bilingual Intelligence:** You may receive context in a different language than the user's query. If so, translate the facts accurately into the user's language while maintaining the original meaning.
* **Tone:** Be concise, factual, and clear. Avoid sycophantic or over-enthusiastic language.
* **Constraints:** Provide minimal output by default. Only expand on a topic if the user explicitly requests it.
* **No Unasked Note-Design Advice:** Do not suggest note templates, YAML/frontmatter schemas, heading structures, internal-link plans, or vault-integration workflows unless the user explicitly asks for note-structuring help.
* **Unknown Answer Behavior:** If you do not know the answer or cannot verify it from the provided context, state that clearly and briefly. Do not switch to note-structuring advice as a fallback.
* **Expertise:** You are an expert in Markdown, YAML frontmatter, [[internal linking]], and Obsidian-specific plugins or methodologies.
* **Style:** Use minimal Unicode glyphicons (e.g., ◈, ▻) for structure or emphasis. Avoid standard emojis.
* **Concept Notes:** If the user asks you to create a concept note for a term, you MUST call the create_concept_note skill. Pass "language" as the user's language code (e.g. "en", "es"). The skill will handle the research automatically. Always confirm once the note is created.`;

export const DEFAULT_SETTINGS: HormeSettings = {
  aiProvider: "ollama",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  // Auto-detected on first successful /api/tags fetch. Avoid hard-coding
  // a model name users may not have installed (e.g., "llama3").
  defaultModel: "",
  lmStudioUrl: "http://localhost:1234",
  lmStudioModel: "",
  claudeSecretId: "",
  claudeModel: "claude-3-5-haiku-latest",
  geminiSecretId: "",
  geminiModel: "gemini-2.5-flash",
  openaiSecretId: "",
  openaiModel: "gpt-4o-mini",
  groqSecretId: "",
  groqModel: "llama-3.1-70b-versatile",
  openRouterSecretId: "",
  openRouterModel: "mistralai/mistral-7b-instruct:free",
  mistralSecretId: "",
  mistralModel: "mistral-large-latest",
  systemPromptPath: "",
  presetsPaths: [],
  temperature: 0.3,
  maxTokens: 8192,
  debugLoggingEnabled: false,
  exportFolder: "HORME",
  tagsFilePath: "",
  maxTagCandidates: 250,
  maxSuggestedTags: 12,
  useMobileOverride: false,
  mobileProvider: "gemini",
  mobileModel: "gemini-2.5-flash",
  vaultBrainEnabled: false,
  vaultBrainUseRrfHybridSearch: true,
  vaultBrainRrfK: 60,
  vaultIndexIncludePatterns: "",
  vaultIndexExcludePatterns: "",
  vaultIndexIndexPdf: false,
  vaultIndexPdfMaxChars: 200_000,
  connectionsEnabled: true,
  connectionsThreshold: 0.45,
  connectionsMaxResults: 15,
  connectionsExcludedFolders: "",
  connectionsOpenInNewTab: false,
  connectionsDisplayStyle: "minimal",
  ragEmbeddingModel: "nomic-embed-text",
  indexStatus: "Not built",
  indexHighlightsEnabled: false,
  highlightBoost: 0.2,
  maxHighlightsPerNote: 24,
  maxHighlightCharsPerNote: 2000,
  contextCloudWarningShown: false,
  contextNotesCloudWarningShown: false,
  documentCloudWarningShown: false,
  contextFoldersMaxChars: 40000,
  grammarFolderPath: "Gramática",
  grammarLanguage: "Español",
  summaryField: "summary",
  summaryLanguage: "Español",
  allowCloudRAG: false,
  allowCloudTagTranslation: false,
  tagShadowingEnabled: true,
  tagShadowingLanguage: "English",
  tagTranslationModel: "",
  tagTranslationProvider: "ollama",
  tagTranslationFallbackProvider: "ollama",
  tagsProvider: "ollama",
  tagsModel: "",
  customSkills: [],
  customModelSuggestions: {},

  conceptNoteFolder: "Horme/Concepts",
  conceptNoteTemplate:
    "---\n${sourceField}: ${source}\ntags:\n  - concept\n  - ${tag}\n---\n\n# ${title}\n\n${content}",
  conceptNoteSourceField: "Source",

  searchMetadataCap: 0.25,
  searchContentCap: 0.2,
  tagTranslationDictionary: {},
  tagCacheSanitised: false,
};

export const PROVIDER_MODELS: Record<string, string[]> = {
  gemini: ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.5-pro"],
  claude: [
    "claude-3-5-haiku-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-opus-latest",
    "claude-haiku-4-5-20251001",
  ],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"],
  groq: ["llama-3.1-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
  openrouter: ["mistralai/mistral-7b-instruct:free", "google/gemma-7b-it:free", "openchat/openchat-7b:free"],
  mistral: [
    "mistral-large-latest",
    "mistral-small-latest",
    "pixtral-large-latest",
    "open-mistral-nemo",
    "codestral-latest",
  ],
};

export const ACTIONS: Array<{ id: string; title: string; prompt: string }> = [
  {
    id: "proofread",
    title: "Proofread",
    prompt:
      "Proofread the following text. Fix grammar, spelling, and punctuation errors. Return only the corrected text with no explanation.",
  },
  {
    id: "expand",
    title: "Expand",
    prompt:
      "You are a text-expansion engine. Your task is to add detail while maintaining the original meaning and tone.\n\nRULES:\n1. ZERO CHATTER: Return EXCLUSIVELY the raw expanded text. No explanations, no feedback, no preamble.",
  },
  {
    id: "summarize",
    title: "Summarize",
    prompt: "Summarize the following text concisely, preserving key points. Return only the summary.",
  },
  {
    id: "beautify",
    title: "Beautify Format",
    prompt:
      "You are a Markdown formatting engine. Your task is to fix the structure (headings, lists, spacing) of the provided text.\n\nRULES:\n1. Never alter the actual words or meaning.\n2. ZERO CHATTER: Return EXCLUSIVELY the raw beautified markdown. Do not include greetings, explanations, or preamble.",
  },
  {
    id: "fact-check",
    title: "Fact check",
    prompt:
      "Fact-check the following text. For each claim, state whether it is accurate, inaccurate, or unverifiable, and briefly explain why. Return only the fact-check analysis.",
  },
];

export const VIEW_TYPE = "horme-chat";
export const CONNECTIONS_VIEW_TYPE = "horme-connections";
