import { TFile, WorkspaceLeaf } from "obsidian";

export type AiProvider = "ollama" | "lmstudio" | "claude" | "gemini" | "openai" | "groq" | "openrouter";

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
  systemPrompt: string;
  temperature: number;
  exportFolder: string;
  promptPresets: Array<{ name: string; prompt: string }>;
  tagsFilePath: string;
  maxTagCandidates: number;
  maxSuggestedTags: number;
  // Platform Overrides
  useMobileOverride: boolean;
  mobileProvider: AiProvider;
  mobileModel: string;
  contextCloudWarningShown: boolean;
  // Vault Brain (Local RAG)
  vaultBrainEnabled: boolean;
  ragEmbeddingModel: string;
  indexStatus: string;
  grammarFolderPath: string;
  grammarLanguage: string;
  summaryField: string;
  summaryLanguage: string;
  allowCloudRAG: boolean;
}

export interface SavedConversation {
  id: string;
  title: string;
  timestamp: number;
  messages: Array<{ role: string; content: string; images?: string[] }>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[]
}
