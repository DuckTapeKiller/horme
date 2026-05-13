import { Skill, SkillParameter } from "./types";
import HormePlugin from "../../main";
import { errorToMessage, getStringProp } from "../utils/TypeGuards";

export class VaultLinkSkill implements Skill {
  id = "vault_links";
  name = "Vault Linker";
  description = "Finds semantically related notes within the user's Obsidian vault based on content similarity.";
  
  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  parameters: SkillParameter[] = [
    {
      name: "context",
      type: "string",
      description: "The core theme or content snippet to find related notes for.",
      required: true
    }
  ];

  instructions = `To use this skill, output exactly: <call:vault_links>{"context": "themes or text to link"}</call>. Use this to discover connections between current thoughts and existing knowledge in the vault.`;

  async execute(params: unknown): Promise<string> {
    try {
      const context = getStringProp(params, "context");
      if (!context) return `Invalid parameters for ${this.name}: expected {"context": string}.`;

      // Privacy guard: refuse if vault search is locked
      const canAccess = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
      if (!this.plugin.settings.vaultBrainEnabled || !canAccess) {
        return "Vault search is not available with the current provider configuration.";
      }

      const results = await this.plugin.vaultIndexer.search(context, 5);
      if (results.length === 0) {
        return "No strongly related notes found in the vault.";
      }

      return "Found the following related content in your vault:\n\n" + results.join("\n\n---\n\n");
    } catch (e: unknown) {

      console.error("Horme Vault Link Skill Error:", e);
      throw new Error(errorToMessage(e));
    }
  }
}
