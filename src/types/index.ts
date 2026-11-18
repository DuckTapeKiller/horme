import type { ImageSourceSetting } from "../utils/imageSources";

export type AiProvider =
  | "llamacpp"
  | "ollama"
  | "lmstudio"
  | "claude"
  | "gemini"
  | "openai"
  | "groq"
  | "openrouter"
  | "mistral"
  | "custom"
  | "apple";

export interface CustomSkillDefinition {
  id: string; // generated slug: "custom_" + sanitized name
  name: string; // display name shown in dropdown
  description: string; // one-line description shown in dropdown
  url: string; // URL template — use {{query}} as placeholder
  method: "GET" | "POST";
  headers: Record<string, string>; // optional request headers
  body: string; // POST body template — use {{query}} as placeholder
  responsePath: string; // dot-path to extract from JSON response (e.g. "results[0].text")
}

/** Settings keys whose values are strings. */
export type StringKey = {
  [K in keyof HormeSettings]: HormeSettings[K] extends string ? K : never;
}[keyof HormeSettings];

/** Settings keys whose values are true or false. */
export type BooleanKey = {
  [K in keyof HormeSettings]: HormeSettings[K] extends boolean ? K : never;
}[keyof HormeSettings];

export interface HormeSettings {
  aiProvider: AiProvider;
  ollamaBaseUrl: string;
  /** Keychain name of the key for a server in front of Ollama ("" when it needs none). */
  ollamaSecretId: string;
  /**
   * Tokens Ollama gives the model per request (num_ctx), capped at what the
   * model can take; 0 leaves it to Ollama (4,096 on many computers, which
   * cuts Horme's requests).
   */
  ollamaContextLength: number;
  defaultModel: string;
  lmStudioUrl: string;
  /** Keychain name of LM Studio's API token ("" when it needs none). */
  lmStudioSecretId: string;
  lmStudioModel: string;
  /** Embedding model id for LM Studio RAG (chat models cannot embed). */
  lmStudioEmbeddingModel: string;
  /** llama-server base URL (works with router mode and single-model servers). */
  llamaCppUrl: string;
  /** Keychain name of the key llama-server was started with (--api-key); "" when it needs none. */
  llamaCppSecretId: string;
  llamaCppModel: string;
  /** Separate llama-server for embeddings (llama.cpp needs --embedding; typically chat port + 1). */
  llamaCppEmbeddingUrl: string;
  /** Keychain name of the embedding server's key; "" uses the chat server's key. */
  llamaCppEmbeddingSecretId: string;
  /** Embedding model id for llama.cpp RAG (chat models cannot embed). */
  llamaCppEmbeddingModel: string;
  /**
   * The server that makes embeddings for Vault Brain, the tag index, the
   * grammar index and Deep Research, whatever answers the chat. Only servers
   * the user runs: indexing sends the full text of every note.
   */
  embeddingSource: "llamacpp" | "lmstudio" | "ollama" | "custom";
  /** Offer skills as native OpenAI-schema tools on LM Studio/Ollama (XML stays the fallback). */
  nativeToolCalling: boolean;
  /** Agent mode: plan-first prompting and a larger tool budget for multi-step tasks. */
  agentMode: boolean;
  /** Maximum tool calls per request in agent mode. */
  agentMaxRounds: number;
  /** Local models think again on the round after a skill result (slower). */
  thinkAfterSkills: boolean;
  // Cloud provider secrets (SecretStorage IDs, not raw keys)
  claudeSecretId: string;
  claudeModel: string;
  geminiSecretId: string;
  geminiModel: string;
  openaiSecretId: string;
  openaiModel: string;
  groqSecretId: string;
  groqModel: string;
  openRouterSecretId: string;
  openRouterModel: string;
  mistralSecretId: string;
  mistralModel: string;
  /** OpenAI-compatible server: its base address as its docs give it, usually ending in /v1. */
  customUrl: string;
  /** Keychain name of the OpenAI-compatible server's key ("" when it needs none). */
  customSecretId: string;
  customModel: string;
  /** Embedding model on the OpenAI-compatible server; "" detects one whose name says "embed". */
  customEmbeddingModel: string;
  /** The user says the OpenAI-compatible server is theirs: notes may go to it as to a local provider. */
  customIsLocal: boolean;
  /**
   * The address the user confirmed as theirs with "This server is mine". The
   * mark holds only while the server's address is still this one: a new
   * address is a new server, which counts as cloud until confirmed again.
   */
  customTrustedUrl: string;
  /** Apple Intelligence: "system" (on this Mac) or "pcc" (Apple's Private Cloud Compute). */
  appleModel: string;
  systemPromptPath: string;
  presetsPaths: string[];
  temperature: number;
  maxTokens: number;
  debugLoggingEnabled: boolean;
  exportFolder: string;
  tagsFilePath: string;
  maxTagCandidates: number;
  maxSuggestedTags: number;
  // Platform Overrides
  useMobileOverride: boolean;
  mobileProvider: AiProvider;
  mobileModel: string;
  /**
   * When the mobile provider or model was last changed on a computer (milliseconds
   * since 1970, 0 if never). A model picked on a phone before that gives way to it.
   */
  mobileChangedAt: number;
  contextCloudWarningShown: boolean;
  contextNotesCloudWarningShown: boolean;
  /** Consent to send folder context ("+ Add folders") to a cloud provider. */
  contextFoldersCloudWarningShown: boolean;
  documentCloudWarningShown: boolean;
  /**
   * Hard cap (in characters) for folder-based context injection from "+ Add folders".
   * This protects against accidentally sending huge prompts when a folder contains many notes.
   */
  contextFoldersMaxChars: number;
  // Vault Brain (Local RAG)
  vaultBrainEnabled: boolean;
  /**
   * Use Reciprocal Rank Fusion (RRF) to combine dense (embedding) and sparse (keyword) retrieval ranks.
   * Inspired by YOLO's hybrid search implementation.
   */
  vaultBrainUseRrfHybridSearch: boolean;
  /** RRF smoothing constant. Typical default is 60. */
  vaultBrainRrfK: number;
  /**
   * Optional comma-separated glob patterns for which Markdown files are indexed by Vault Brain.
   * When empty, all Markdown files are eligible (subject to the exclude patterns below).
   *
   * Examples:
   * - `Music/**`
   */
  vaultIndexIncludePatterns: string;
  /**
   * Optional comma-separated glob patterns to exclude Markdown files from Vault Brain indexing.
   *
   * Examples:
   * - `Templates/**`
   * - `Archive/**`
   */
  vaultIndexExcludePatterns: string;
  /**
   * If enabled, Vault Brain can index PDFs by pulling extracted text from the optional
   * community plugin "Text Extractor" (plugin id: "text-extractor").
   */
  vaultIndexIndexPdf: boolean;
  /** Hard cap for extracted PDF text (characters) per file during indexing. */
  vaultIndexPdfMaxChars: number;
  connectionsEnabled: boolean;
  connectionsThreshold: number;
  connectionsMaxResults: number;
  connectionsExcludedFolders: string;
  connectionsOpenInNewTab: boolean;
  connectionsDisplayStyle: "minimal" | "detailed";
  ragEmbeddingModel: string;
  indexStatus: string;
  indexHighlightsEnabled: boolean;
  highlightBoost: number;
  maxHighlightsPerNote: number;
  maxHighlightCharsPerNote: number;
  grammarFolderPath: string;
  grammarLanguage: string;
  summaryField: string;
  summaryLanguage: string;
  allowCloudRAG: boolean;
  allowCloudTagTranslation: boolean;
  tagShadowingEnabled: boolean;
  tagShadowingLanguage: string;
  tagTranslationModel: string;
  tagTranslationProvider: AiProvider;
  tagTranslationFallbackProvider: "ollama" | "lmstudio" | "llamacpp";
  tagsProvider: AiProvider;
  tagsModel: string;
  /**
   * Persistent, user-added model suggestions keyed by a stable list id.
   * This powers the "type or select" model inputs in Settings, so any
   * manually-entered model name is remembered and offered next time.
   */
  customModelSuggestions: Record<string, string[]>;
  customSkills: CustomSkillDefinition[];

  // Images (Find image skill and pictures in answers)
  /** Picture sources in the order they are tried, each switched on or off. */
  imageSources: ImageSourceSetting[];
  /** The most pictures one request can show. */
  imageMaxCount: number;
  /** "wikipedia": Wikipedia lookups show the article's picture; "always": the model is also asked to illustrate answers. */
  imagesInAnswers: "off" | "wikipedia" | "always";
  /** Folder for pictures saved from the chat; empty means Obsidian's attachment location. */
  imageSaveFolder: string;
  /** "Show me a photo of …" is answered by Find image directly, without the model. */
  imageQuickRequests: boolean;
  /** Keychain names (SecretStorage ids) of the image sources' keys, never the keys themselves. */
  imageOpenverseIdSecret: string;
  imageOpenverseSecretSecret: string;
  imagePexelsSecret: string;
  imageUnsplashSecret: string;
  imageBraveSecret: string;

  // Concept Notes (Autonomous research + note creation)
  conceptNoteFolder: string;
  conceptNoteTemplate: string;
  conceptNoteSourceField: string;

  searchMetadataCap: number;
  searchContentCap: number;
  tagTranslationDictionary: Record<string, string>;
  tagCacheSanitised: boolean;
}

export interface SavedConversation {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool_result";
  content: string;
  images?: string[];
  audio?: string | null;
  /** Model's reasoning/thinking trace, shown in a collapsed bubble. */
  reasoning?: string;
  /** Exact RAG passages injected into the prompt for this turn, shown in a collapsed bubble. */
  context?: string;
  /** Vault note paths surfaced as "Sources" pills for this turn. */
  sources?: string[];
  /** The reply was only pictures: the cards above it carry title and credit, so no text is drawn. */
  picturesOnly?: boolean;
}
