import { Skill, SkillParameter } from "./types";
import HormePlugin from "../../main";
import { Notice } from "obsidian";
import { errorToMessage, getStringProp } from "../utils/TypeGuards";

export class GrammarScholarSkill implements Skill {
  id = "grammar_scholar";
  name = "Grammar Scholar";
  description = "Consults high-authority grammar and orthography manuals for precision checks on false friends, syntax, and orthotypography.";
  
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  parameters: SkillParameter[] = [
    {
      name: "terms",
      type: "string",
      description: "Specific words or grammatical constructions to verify (e.g., 'eventualmente', 'subjunctive').",
      required: true
    },
    {
      name: "context_sentence",
      type: "string",
      description: "The complete sentence where the term is used, enabling contextual rule matching.",
      required: false
    }
  ];

  instructions = `To use this skill, output exactly: <call:grammar_scholar>{"terms": "word", "context_sentence": "full sentence"}</call>.
  Mandatory for checking non-obvious errors like false cognates, prepositional regimes, or orthotypography based on local manuals. 
  Do NOT use this for basic questions; use it for linguistic precision and following the user's local manuals.`;

  async execute(params: unknown): Promise<string> {
    try {
      const terms = getStringProp(params, "terms");
      const contextSentence = getStringProp(params, "context_sentence");
      if (!terms) return `Invalid parameters for ${this.name}: expected {"terms": string, "context_sentence"?: string}.`;

      // Combine term and sentence for a rich semantic query
      const query = contextSentence ? `${terms}: ${contextSentence}` : terms;
      const results = await this.plugin.grammarIndexer.search(query);
      
      if (results.length === 0) {
        return `No specific rules found in local manuals for "${terms}". Proceed with general linguistic knowledge.`;
      }

      new Notice("● Grammar Scholar: Consulted local manuals.");
      const joinedResults = "Findings from your Grammar Manuals:\n\n" + results.join("\n\n---\n\n");
      const characterLimit = 2500; 
      
      if (joinedResults.length > characterLimit) {
        return joinedResults.substring(0, characterLimit) + "\n\n...[TRUNCATED for efficiency]";
      }

      return joinedResults;
    } catch (e: unknown) {

      console.error("Horme Grammar Scholar Skill Error:", e);
      throw new Error(errorToMessage(e));
    }
  }
}
