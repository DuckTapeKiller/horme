export type AiProvider =
  | "llamacpp"
  | "ollama"
  | "lmstudio"
  | "claude"
  | "gemini"
  | "openai"
  | "groq"
  | "openrouter"
  | "mistral";

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

export interface HormeSettings {
  aiProvider: AiProvider;
  ollamaBaseUrl: string;
  defaultModel: string;
  lmStudioUrl: string;
  lmStudioModel: string;
  /** Embedding model id for LM Studio RAG (chat models cannot embed). */
  lmStudioEmbeddingModel: string;
  /** llama-server base URL (works with router mode and single-model servers). */
  llamaCppUrl: string;
  llamaCppModel: string;
  /** Separate llama-server for embeddings (llama.cpp needs --embedding; typically chat port + 1). */
  llamaCppEmbeddingUrl: string;
  /** Embedding model id for llama.cpp RAG (chat models cannot embed). */
  llamaCppEmbeddingModel: string;
  /** Offer skills as native OpenAI-schema tools on LM Studio/Ollama (XML stays the fallback). */
  nativeToolCalling: boolean;
  /** Agent mode: plan-first prompting and a larger tool budget for multi-step tasks. */
  agentMode: boolean;
  /** Maximum tool calls per request in agent mode. */
  agentMaxRounds: number;
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
  contextCloudWarningShown: boolean;
  contextNotesCloudWarningShown: boolean;
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
}
