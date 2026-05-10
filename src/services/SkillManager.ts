import HormePlugin from "../../main";
import { HormeSettings } from "../types";
import { Skill, SkillCall } from "../skills/types";
import { WikipediaSkill } from "../skills/WikipediaSkill";
import { VaultLinkSkill } from "../skills/VaultLinkSkill";
import { TaxonomySkill } from "../skills/TaxonomySkill";
import { GrammarScholarSkill } from "../skills/GrammarScholarSkill";
import { WiktionarySkill } from "../skills/WiktionarySkill";
import { DuckDuckGoSkill } from "../skills/DuckDuckGoSkill";
import { DateCalculatorSkill } from "../skills/DateCalculatorSkill";
import { CustomSkill } from "../skills/CustomSkill";

export class SkillManager {
  private plugin: HormePlugin;
  private skills: Map<string, Skill> = new Map();

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
    this.registerBuiltInSkills();
    this.loadCustomSkills();
  }

  private registerBuiltInSkills() {
    this.registerSkill(new WikipediaSkill());
    this.registerSkill(new WiktionarySkill());
    this.registerSkill(new DuckDuckGoSkill());
    this.registerSkill(new DateCalculatorSkill());
    this.registerSkill(new VaultLinkSkill(this.plugin));
    this.registerSkill(new TaxonomySkill(this.plugin));
    this.registerSkill(new GrammarScholarSkill(this.plugin));
  }

  registerSkill(skill: Skill) {
    this.skills.set(skill.id, skill);
  }

  getSkillInstructions(suppressVaultSkill = false): string {
    // Privacy guard: never advertise vault_links if vault search is locked
    const vaultLocked = !this.plugin.settings.vaultBrainEnabled
      || (!this.plugin.isLocalProviderActive() && !this.plugin.settings.allowCloudRAG);

    let instructions = "## AGENT SKILLS\n";
    instructions += "You have access to specialized skills. To invoke a skill, you MUST output a specific tag in your response. " +
                    "Do not explain the skill call, just output the tag. You can think first, then call the skill.\n\n";

    for (const skill of this.skills.values()) {
      // Suppress vault_links when RAG context has already been injected OR vault is privacy-locked
      if ((suppressVaultSkill || vaultLocked) && skill.id === "vault_links") continue;
      instructions += `### Skill: ${skill.name} (id: ${skill.id})\n`;
      instructions += `Description: ${skill.description}\n`;
      instructions += `Instructions: ${skill.instructions}\n\n`;
    }

    return instructions;
  }

  parseSkillCalls(text: string): SkillCall[] {
    const calls: SkillCall[] = [];
    const regex = /<call:([^>]+)>([\s\S]*?)<\/call>/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const skillId = match[1];
      const paramsText = match[2];
      try {
        const parameters = JSON.parse(paramsText);
        calls.push({ skillId, parameters });
      } catch (e) {
        const msg = `Failed to parse parameters for skill ${skillId}. Invalid JSON.`;
        this.plugin.diagnosticService.report("Skill Parser", msg, "warning");
        console.error(msg, paramsText, e);
      }
    }

    return calls;
  }

  async executeSkill(call: SkillCall): Promise<string> {
    const skill = this.skills.get(call.skillId);
    if (!skill) {
      const msg = `Skill "${call.skillId}" not found.`;
      this.plugin.diagnosticService.report("Skill Manager", msg, "warning");
      return `Error: ${msg}`;
    }

    try {
      console.log(`Horme: Executing skill "${skill.name}" with params:`, call.parameters);
      return await skill.execute(call.parameters);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      // Log to Intelligence Dashboard with the skill name explicitly in the message
      this.plugin.diagnosticService.report(
        "Skill Engine",
        `Skill: ${skill.name} / Execution failed: ${errorMessage}`,
        "error"
      );
      console.error(`Horme Skill Error [${skill.name}]:`, e);
      return `Error: ${skill.name} failed. ${errorMessage}`;
    }
  }

  /** Returns all registered skills as an ordered array. */
  getSkills(): Skill[] {
    return [...this.skills.values()];
  }

  /** Returns a single skill by its id, or undefined if not found. */
  getSkillById(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /** (Re)loads custom skills from settings. Safe to call multiple times. */
  loadCustomSkills() {
    try {
      // Remove any previously registered custom skills
      for (const id of this.skills.keys()) {
        if (id.startsWith("custom_")) this.skills.delete(id);
      }
      // Register each custom skill from settings
      for (const def of this.plugin.settings.customSkills) {
        if (!def.id || !def.name) {
          this.plugin.diagnosticService.report("Skill Loader", `Invalid custom skill definition: ${def.name || "Unknown"}`, "warning");
          continue;
        }
        this.skills.set(def.id, new CustomSkill(def));
      }
      // Refresh the dropdown in any open chat views
      this.plugin.app.workspace.iterateAllLeaves(leaf => {
        const view = leaf.view as any;
        if (typeof view.buildSkillsMenu === "function") {
          view.buildSkillsMenu();
        }
      });
    } catch (e) {
      this.plugin.handleError(e, "Custom Skills Loader");
    }
  }
}
