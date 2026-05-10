import { Skill, SkillParameter } from "./types";
import HormePlugin from "../../main";

export class SpanishScholarSkill implements Skill {
  id = "spanish_scholar";
  name = "Spanish Grammar Scholar";
  description = "Consults high-authority Spanish grammar and orthography manuals for precision checks on false friends, syntax, and orthotypography.";
  
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  parameters: SkillParameter[] = [
    {
      name: "terms",
      type: "string",
      description: "Specific words or grammatical constructions to verify (e.g., 'eventualmente', 'leísmo').",
      required: true
    },
    {
      name: "context_sentence",
      type: "string",
      description: "The complete sentence where the term is used, enabling contextual rule matching.",
      required: false
    }
  ];

  instructions = `To use this skill, output exactly: <call:spanish_scholar>{"terms": "word", "context_sentence": "full sentence"}</call>.
  Mandatory for checking non-obvious errors like false cognates, prepositional regimes, or orthotypography in Spanish. 
  Do NOT use this for basic Spanish questions; use it for linguistic precision and following the user's local manuals.`;

  async execute(params: { terms: string; context_sentence?: string }): Promise<string> {
    try {
      // Combine term and sentence for a rich semantic query
      const query = params.context_sentence ? `${params.terms}: ${params.context_sentence}` : params.terms;
      const results = await this.plugin.grammarIndexer.search(query);
      
      if (results.length === 0) {
        return `No specific rules found in local manuals for "${params.terms}". Proceed with general linguistic knowledge.`;
      }

      new Notice("● Spanish Scholar: Consulted local manuals.");
      const joinedResults = "Findings from your Grammar Manuals:\n\n" + results.join("\n\n---\n\n");
      const characterLimit = 2500; 
      
      if (joinedResults.length > characterLimit) {
        return joinedResults.substring(0, characterLimit) + "\n\n...[TRUNCATED for efficiency]";
      }

      return joinedResults;
    } catch (e) {
      console.error("Horme Spanish Scholar Skill Error:", e);
      throw e;
    }
  }
}
