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
  execute(params: any): Promise<string>;
}

export interface SkillCall {
  skillId: string;
  parameters: any;
}

export interface SkillResult {
  skillId: string;
  result: string;
}
