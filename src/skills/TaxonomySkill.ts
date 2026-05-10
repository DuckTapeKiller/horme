import { Skill, SkillParameter } from "./types";
import HormePlugin from "../../main";

export class TaxonomySkill implements Skill {
  id = "taxonomy";
  name = "Taxonomy Scholar";
  description = "Retrieves the full list of existing tags in the vault to ensure consistent and accurate tagging.";
  
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  parameters: SkillParameter[] = [];

  instructions = `To use this skill, output exactly: <call:taxonomy>{}</call>. Use this before suggesting tags to ensure you are using the user's existing taxonomy.`;

  async execute(): Promise<string> {
    try {
      const tags = await this.plugin.loadAllowedTags();
      if (tags.length === 0) {
        return "The vault currently has no tags.";
      }

      return "Existing tags in the vault:\n" + tags.map(t => `#${t}`).join(", ");
    } catch (e) {
      console.error("Horme Taxonomy Skill Error:", e);
      throw e;
    }
  }
}
