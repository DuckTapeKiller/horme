import { Skill, SkillParameter } from "./types";
import HormePlugin from "../../main";

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

  async execute(params: { context: string }): Promise<string> {
    try {
      // Privacy guard: refuse if vault search is locked
      const canAccess = this.plugin.isLocalProviderActive() || this.plugin.settings.allowCloudRAG;
      if (!this.plugin.settings.vaultBrainEnabled || !canAccess) {
        return "Vault search is not available with the current provider configuration.";
      }

      const results = await this.plugin.vaultIndexer.search(params.context, 5);
      if (results.length === 0) {
        return "No strongly related notes found in the vault.";
      }

      return "Found the following related content in your vault:\n\n" + results.join("\n\n---\n\n");
    } catch (e) {
      console.error("Horme Vault Link Skill Error:", e);
      return `Error searching vault: ${e.message}`;
    }
  }
}
