import HormePlugin from "../../main";
import { NativeTool, Skill, SkillCall } from "../skills/types";
import { WikipediaSkill } from "../skills/WikipediaSkill";
import { VaultLinkSkill } from "../skills/VaultLinkSkill";
import { GrammarScholarSkill } from "../skills/GrammarScholarSkill";
import { WiktionarySkill } from "../skills/WiktionarySkill";
import { DuckDuckGoSkill } from "../skills/DuckDuckGoSkill";
import { DateCalculatorSkill } from "../skills/DateCalculatorSkill";
import { CustomSkill } from "../skills/CustomSkill";
import { CreateConceptNoteSkill } from "../skills/CreateConceptNoteSkill";
import { FetchAndSummariseSkill } from "../skills/FetchAndSummariseSkill";
import { DeepResearchSkill } from "../skills/DeepResearchSkill";

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
    this.registerSkill(new CreateConceptNoteSkill(this.plugin.app, this.plugin));
    this.registerSkill(new VaultLinkSkill(this.plugin));
    this.registerSkill(new GrammarScholarSkill(this.plugin));
    this.registerSkill(new FetchAndSummariseSkill(this.plugin));
    this.registerSkill(new DeepResearchSkill());
  }

  registerSkill(skill: Skill) {
    this.skills.set(skill.id, skill);
  }

  /** Privacy guard: never advertise vault_links if vault search is locked. */
  private isVaultSkillLocked(): boolean {
    return (
      !this.plugin.settings.vaultBrainEnabled ||
      (!this.plugin.isLocalProviderActive() && !this.plugin.settings.allowCloudRAG)
    );
  }

  private isSkillOffered(skill: Skill, suppressVaultSkill: boolean, targetSkillId?: string): boolean {
    // If a specific skill is targeted, skip all others
    if (targetSkillId && skill.id !== targetSkillId) return false;
    // Suppress vault_links when RAG context has already been injected OR vault is privacy-locked
    if ((suppressVaultSkill || this.isVaultSkillLocked()) && skill.id === "vault_links") return false;
    return true;
  }

  /**
   * Plan-first agent workflow appended when agent mode is on. The
   * "reply text stays empty until the final answer" rule keeps plans and
   * step notes out of the chat bubble.
   */
  private getAgentWorkflowBlock(): string {
    const rounds = Math.min(50, Math.max(1, this.plugin.settings.agentMaxRounds));
    return (
      `## AGENT WORKFLOW (up to ${rounds} skill calls for this request)\n` +
      "For any task that needs multiple steps (research, comparing sources, gathering material, creating notes):\n" +
      "1. FIRST think through a short numbered plan of the steps you intend to take. Keep it to one line per step.\n" +
      "2. Execute the plan one skill call at a time. After each result, decide whether the plan still holds; revise it if a step failed or a result changed the picture.\n" +
      "3. Never repeat a call that already failed with the same arguments — change the approach instead.\n" +
      "4. When the plan is complete (or further calls stop adding information), write the final answer synthesizing everything you found.\n" +
      "CRITICAL — WHERE TO WRITE WHAT: the plan and your notes between steps belong in your reasoning/thinking, NEVER in the reply text. While you still intend to call more skills, output NOTHING as reply text — no plan, no progress notes, no partial answers. The ONLY prose you ever write as reply text is the single final answer, after your last skill call.\n\n"
    );
  }

  getSkillInstructions(
    suppressVaultSkill = false,
    targetSkillId?: string,
    options: { native?: boolean } = {},
  ): string {
    // Native mode: the skill list (names, descriptions, JSON schemas) travels
    // in the request's `tools` array — the prompt only carries policy.
    if (options.native === true) {
      let nativeInstructions = "## AGENT SKILLS\n";
      nativeInstructions +=
        "You have access to specialized skills exposed through your native function-calling mechanism. " +
        "Call them ONLY through function calling — NEVER write tool-call syntax (XML, JSON, or code blocks) in your reply text. " +
        "Only the provided functions exist and are enabled; never invent one. " +
        "Call one skill at a time; after receiving a result you may call another if needed. " +
        "For multi-part questions, plan ALL the lookups you need and execute them one by one — do not stop after the first result.\n\n";
      if (this.plugin.settings.agentMode) nativeInstructions += this.getAgentWorkflowBlock();
      return nativeInstructions;
    }

    let instructions = "## AGENT SKILLS\n";
    instructions +=
      "You have access to specialized skills. To invoke a skill, you MUST output a specific tag in your response. " +
      "Do not explain the skill call, just output the tag. You can think first, then call the skill.\n\n";

    for (const skill of this.skills.values()) {
      if (!this.isSkillOffered(skill, suppressVaultSkill, targetSkillId)) continue;
      instructions += `### Skill: ${skill.name} (id: ${skill.id})\n`;
      instructions += `Description: ${skill.description}\n`;
      instructions += `Instructions: ${skill.instructions}\n`;
      if (skill.parameters.length > 0) {
        instructions += `Parameters (JSON):\n`;
        for (const param of skill.parameters) {
          instructions += `- ${param.name} (${param.type}): ${param.description}${param.required ? " (REQUIRED)" : ""}\n`;
        }
      }
      instructions += `\n`;
    }

    if (this.plugin.settings.agentMode) instructions += this.getAgentWorkflowBlock();

    return instructions;
  }

  /**
   * The offered skills as OpenAI-schema tools for native function calling
   * (LM Studio, Ollama). Same visibility rules as getSkillInstructions. The
   * XML call syntax embedded in each skill's prose instructions is stripped —
   * native callers must never see it.
   */
  getNativeTools(suppressVaultSkill = false, targetSkillId?: string): NativeTool[] {
    const tools: NativeTool[] = [];
    for (const skill of this.skills.values()) {
      if (!this.isSkillOffered(skill, suppressVaultSkill, targetSkillId)) continue;
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      for (const param of skill.parameters) {
        const prop: Record<string, unknown> = { type: param.type, description: param.description };
        if (param.type === "array" && param.items) prop.items = { type: param.items.type };
        properties[param.name] = prop;
        if (param.required) required.push(param.name);
      }
      const usageGuidance = skill.instructions
        .replace(/To use this skill, output exactly:\s*/gi, "")
        .replace(/<call:[a-zA-Z0-9_]+>[\s\S]*?<\/call>\.?\s*/g, "");
      tools.push({
        type: "function",
        function: {
          name: skill.id,
          description: `${skill.description} ${usageGuidance}`.trim(),
          parameters: { type: "object", properties, required },
        },
      });
    }
    return tools;
  }

  parseSkillCalls(text: string): SkillCall[] {
    // Step 9.3: Add a maximum single-response length check (e.g., 200KB)
    if (text.length > 200 * 1024) {
      this.plugin.diagnosticService.report(
        "Skill Parser",
        `Refusing to parse skill calls. Text length (${text.length} bytes) exceeds 200KB limit.`,
        "warning",
      );
      return [];
    }

    const calls: SkillCall[] = [];
    // 1. Finds each <call:id> opening tag using a non-backtracking regex for the tag name only.
    const tagRegex = /<call:([a-zA-Z0-9_]+)>/g;
    let match;

    const isEscaped = (str: string, index: number): boolean => {
      let count = 0;
      for (let i = index - 1; i >= 0; i--) {
        if (str[i] === "\\") count++;
        else break;
      }
      return count % 2 !== 0;
    };

    while ((match = tagRegex.exec(text)) !== null) {
      const skillId = match[1];
      const startIdx = match.index + match[0].length;

      // Find the opening '{' that begins the JSON parameter object.
      let jsonStart = -1;
      for (let i = startIdx; i < text.length; i++) {
        const char = text[i];
        if (char === "{") {
          jsonStart = i;
          break;
        }
        if (char === "<") {
          break;
        }
      }

      if (jsonStart === -1) {
        continue;
      }

      // Use the brace-counting parser to extract the balanced JSON object.
      let braceCount = 0;
      let inString = false;
      let jsonEnd = -1;

      for (let i = jsonStart; i < text.length; i++) {
        const char = text[i];
        if (char === '"' && !isEscaped(text, i)) {
          inString = !inString;
        }
        if (!inString) {
          if (char === "{") {
            braceCount++;
          } else if (char === "}") {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i;
              break;
            }
          }
        }
      }

      if (jsonEnd === -1) {
        const msg = `Failed to find balanced JSON parameters for skill ${skillId}. Unclosed brace.`;
        this.plugin.diagnosticService.report("Skill Parser", msg, "warning");
        continue;
      }

      const paramsText = text.slice(jsonStart, jsonEnd + 1);

      // Finds the </call> tag immediately after the closing '}'.
      const afterJson = text.slice(jsonEnd + 1);
      const closeTagMatch = /^\s*<\/call>/.exec(afterJson);
      if (!closeTagMatch) {
        const msg = `Failed to parse skill ${skillId}: missing or misplaced </call> closing tag.`;
        this.plugin.diagnosticService.report("Skill Parser", msg, "warning");
        continue;
      }

      // Update regex index to skip past the closing tag
      const closeTagLength = closeTagMatch[0].length;
      tagRegex.lastIndex = jsonEnd + 1 + closeTagLength;

      try {
        const parameters: unknown = JSON.parse(paramsText);
        calls.push({ skillId, parameters });
      } catch (e: unknown) {
        const msg = `Failed to parse parameters for skill ${skillId}. Invalid JSON.`;
        this.plugin.diagnosticService.report("Skill Parser", msg, "warning");
        const preview = paramsText.length > 500 ? `${paramsText.slice(0, 500)}…` : paramsText;
        this.plugin.debugLog(`${msg} Params preview:`, preview);
        console.error(msg, e);
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
      this.plugin.debugLog(`Horme: Executing skill "${skill.name}"`);
      return await skill.execute(call.parameters);
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      // Log to Intelligence Dashboard with the skill name explicitly in the message
      this.plugin.diagnosticService.report(
        "Skill Engine",
        `Skill: ${skill.name} / Execution failed: ${errorMessage}`,
        "error",
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
          this.plugin.diagnosticService.report(
            "Skill Loader",
            `Invalid custom skill definition: ${def.name || "Unknown"}`,
            "warning",
          );
          continue;
        }
        this.skills.set(def.id, new CustomSkill(this.plugin.app, def));
      }
      // Refresh the dropdown in any open chat views
      this.plugin.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as unknown as { buildSkillsMenu?: () => void };
        if (typeof view.buildSkillsMenu === "function") {
          view.buildSkillsMenu();
        }
      });
    } catch (e: unknown) {
      this.plugin.handleError(e, "Custom Skills Loader");
    }
  }
}
