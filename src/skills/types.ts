export interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  parameters: SkillParameter[];
  instructions: string;
  terminal?: boolean;
  primaryParam?: string;
  execute(params: unknown): Promise<string>;
}

export interface SkillCall {
  skillId: string;
  parameters: unknown;
}

/**
 * A skill expressed as an OpenAI-schema tool, for providers with native
 * function calling (LM Studio, Ollama). Tool-calling-trained models are far
 * more reliable with this than with prompt-taught XML syntax.
 */
export interface NativeTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}
