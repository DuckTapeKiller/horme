export type AiProvider = "ollama" | "lmstudio" | "claude" | "gemini" | "openai" | "groq" | "openrouter";

export interface CustomSkillDefinition {
  id: string;           // generated slug: "custom_" + sanitized name
  name: string;         // display name shown in dropdown
  description: string;  // one-line description shown in dropdown
  url: string;          // URL template — use {{query}} as placeholder
  method: "GET" | "POST";
  headers: Record<string, string>;  // optional request headers
  body: string;         // POST body template — use {{query}} as placeholder
  responsePath: string; // dot-path to extract from JSON response (e.g. "results[0].text")
}

export interface HormeSettings {
  aiProvider: AiProvider;
  ollamaBaseUrl: string;
  defaultModel: string;
  lmStudioUrl: string;
  lmStudioModel: string;
  claudeApiKey: string;
  claudeModel: string;
  geminiApiKey: string;
  geminiModel: string;
  openaiApiKey: string;
  openaiModel: string;
  groqApiKey: string;
  groqModel: string;
  openRouterApiKey: string;
  openRouterModel: string;
  systemPromptPath: string;
  presetsPaths: string[];
  temperature: number;
  maxTokens: number;
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
  // Vault Brain (Local RAG)
  vaultBrainEnabled: boolean;
  connectionsEnabled: boolean;
  connectionsThreshold: number;
  connectionsMaxResults: number;
  connectionsExcludedFolders: string;
  connectionsOpenInNewTab: boolean;
  connectionsDisplayStyle: "minimal" | "detailed";
  ragEmbeddingModel: string;
  indexStatus: string;
  grammarFolderPath: string;
  grammarLanguage: string;
  summaryField: string;
  summaryLanguage: string;
  allowCloudRAG: boolean;
  tagShadowingEnabled: boolean;
  tagShadowingLanguage: string;
  tagTranslationModel: string;
  tagTranslationProvider: "ollama" | "lmstudio";
  tagsProvider: AiProvider;
  tagsModel: string;
  customSkills: CustomSkillDefinition[];

  // Concept Notes (Autonomous research + note creation)
  conceptNoteFolder: string;
  conceptNoteTemplate: string;
  conceptNoteSourceField: string;
}

export interface SavedConversation {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
  audio?: string | null;
}
