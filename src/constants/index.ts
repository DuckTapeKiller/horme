import { HormeSettings } from "../types";

export const DEFAULT_SYSTEM_PROMPT = `Your name is Horme. In Greek mythology, Horme (/ˈhɔːrmiː/; Ancient Greek: Ὁρμή) is the spirit personifying energetic activity, impulse, or effort (to do a thing). You embody this spirit by being a proactive and efficient assistant.

You are a specialised Obsidian assistant. Your goal is to help the user manage their personal knowledge base, refine notes, and streamline workflows.

Rules:
* **Language:** Always reply in the same language the user speaks to you.
* **Tone:** Be concise, factual, and clear. Avoid sycophantic or over-enthusiastic language.
* **Constraints:** Provide minimal output by default. Only expand on a topic if the user explicitly requests it.
* **Expertise:** You are an expert in Markdown, YAML frontmatter, [[internal linking]], and Obsidian-specific plugins or methodologies.`;

export const DEFAULT_SETTINGS: HormeSettings = {
  aiProvider: "ollama",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  defaultModel: "llama3",
  lmStudioUrl: "http://localhost:1234",
  lmStudioModel: "",
  claudeApiKey: "",
  claudeModel: "claude-3-5-haiku-latest",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  groqApiKey: "",
  groqModel: "llama-3.1-70b-versatile",
  openRouterApiKey: "",
  openRouterModel: "mistralai/mistral-7b-instruct:free",
  systemPrompt: "",
  temperature: 0.6,
  exportFolder: "HORME",
  promptPresets: [],
  tagsFilePath: "",
  maxTagCandidates: 250,
  maxSuggestedTags: 12,
  useMobileOverride: false,
  mobileProvider: "gemini",
  mobileModel: "gemini-2.5-flash",
  vaultBrainEnabled: false,
  ragEmbeddingModel: "nomic-embed-text",
  indexStatus: "Ready",
  contextCloudWarningShown: false,
  grammarFolderPath: "Gramática",
  grammarLanguage: "Español",
  summaryField: "summary",
  summaryLanguage: "Español",
  allowCloudRAG: false,
};

export const PROVIDER_MODELS: Record<string, string[]> = {
  gemini: ["gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.5-pro"],
  claude: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-opus-latest", "claude-haiku-4-5-20251001"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"],
  groq: ["llama-3.1-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
  openrouter: ["mistralai/mistral-7b-instruct:free", "google/gemma-7b-it:free", "openchat/openchat-7b:free"]
};

export const ACTIONS: Array<{ id: string; title: string; prompt: string }> = [
  {
    id: "proofread",
    title: "Proofread",
    prompt: "Proofread the following text. Fix grammar, spelling, and punctuation errors. Return only the corrected text with no explanation.",
  },
  {
    id: "expand",
    title: "Expand",
    prompt: "Expand the following text with more detail while maintaining the original meaning and tone. Return only the expanded text.",
  },
  {
    id: "summarize",
    title: "Summarize",
    prompt: "Summarize the following text concisely, preserving key points. Return only the summary.",
  },
  {
    id: "beautify",
    title: "Beautify Format",
    prompt: "You are a markdown formatting assistant. The user will send you a block of markdown text. Your job is to fix and beautify its structure: correct heading hierarchy, clean up bullet points and lists, normalize spacing, and ensure consistent use of bold and italics. Never alter the actual words or meaning. Return only the corrected markdown with no explanation or preamble.",
  },
  {
    id: "fact-check",
    title: "Fact check",
    prompt: "Fact-check the following text. For each claim, state whether it is accurate, inaccurate, or unverifiable, and briefly explain why. Return only the fact-check analysis.",
  },
];

export const VIEW_TYPE = "horme-chat";
