import { requestUrl } from "obsidian";
import { Skill, SkillParameter } from "./types";
import { asArray, errorToMessage, getRecordProp, getStringProp } from "../utils/TypeGuards";

export class DuckDuckGoSkill implements Skill {
  id = "ddg_search";
  name = "DuckDuckGo Instant Answer";
  description = "Searches DuckDuckGo for instant answers, quick facts, and topic summaries. Useful for recent events, technical specs, and claims not covered by Wikipedia.";
  terminal = true;
  
  parameters: SkillParameter[] = [
    {
      name: "query",
      type: "string",
      description: "The search query or claim to look up.",
      required: true
    }
  ];

  instructions = `To use this skill, output exactly: <call:ddg_search>{"query": "your search query"}</call>. Use this as a complement to Wikipedia when you need to verify recent events, technical specifications, or niche topics that Wikipedia may not cover. This skill is also useful as a second opinion to cross-reference Wikipedia findings.`;

  async execute(params: unknown): Promise<string> {
    try {
      const query = getStringProp(params, "query");
      if (!query) return `Invalid parameters for ${this.name}: expected {"query": string}.`;
      
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await requestUrl({ url });
      const data: unknown = res.json;

      let output = `## DuckDuckGo: "${query}"\n\n`;
      let hasContent = false;

      // Abstract (main answer)
      const abstract = getStringProp(data, "Abstract");
      if (abstract && abstract.trim().length > 0) {
        output += `**Answer:** ${abstract}\n`;
        const abstractSource = getStringProp(data, "AbstractSource");
        if (abstractSource) output += `**Source:** ${abstractSource}`;
        const abstractUrl = getStringProp(data, "AbstractURL");
        if (abstractUrl) output += `\n<!-- ${abstractUrl} -->`;
        output += "\n\n";
        hasContent = true;
      }

      // Answer box (for direct factual answers like "How tall is...")
      const answer = getStringProp(data, "Answer");
      if (answer && answer.trim().length > 0) {
        output += `**Direct Answer:** ${answer}\n`;
        const answerType = getStringProp(data, "AnswerType");
        if (answerType) output += `(Type: ${answerType})\n`;
        output += "\n";
        hasContent = true;
      }

      // Definition
      const definition = getStringProp(data, "Definition");
      if (definition && definition.trim().length > 0) {
        output += `**Definition:** ${definition}\n`;
        const definitionSource = getStringProp(data, "DefinitionSource");
        if (definitionSource) output += `Source: ${definitionSource}\n`;
        output += "\n";
        hasContent = true;
      }

      // Related topics (up to 3)
      const relatedTopics = asArray(getRecordProp(data, "RelatedTopics")) ?? [];
      if (relatedTopics.length > 0) {
        const topics = relatedTopics
          .filter((t) => {
            const text = getStringProp(t, "Text");
            return Boolean(text && text.trim().length > 0);
          })
          .slice(0, 3);
        
        if (topics.length > 0) {
          output += "**Related:**\n";
          for (const topic of topics) {
            const text = getStringProp(topic, "Text");
            if (text) output += `- ${text}\n`;
          }
          output += "\n";
          hasContent = true;
        }
      }

      if (!hasContent) {
        return `DuckDuckGo returned no instant answer for "${query}". Try a more specific query or use the wikipedia skill instead.`;
      }

      // Cap output
      if (output.length > 2500) {
        output = output.substring(0, 2450) + "\n\n...[TRUNCATED]";
      }

      return output;
    } catch (e: unknown) {

      console.error("Horme DuckDuckGo Skill Error:", e);
      throw new Error(errorToMessage(e));
    }
  }
}
