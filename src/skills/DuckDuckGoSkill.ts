import { requestUrl } from "obsidian";
import { Skill, SkillParameter } from "./types";

export class DuckDuckGoSkill implements Skill {
  id = "ddg_search";
  name = "DuckDuckGo Instant Answer";
  description = "Searches DuckDuckGo for instant answers, quick facts, and topic summaries. Useful for recent events, technical specs, and claims not covered by Wikipedia.";
  
  parameters: SkillParameter[] = [
    {
      name: "query",
      type: "string",
      description: "The search query or claim to look up.",
      required: true
    }
  ];

  instructions = `To use this skill, output exactly: <call:ddg_search>{"query": "your search query"}</call>. Use this as a complement to Wikipedia when you need to verify recent events, technical specifications, or niche topics that Wikipedia may not cover. This skill is also useful as a second opinion to cross-reference Wikipedia findings.`;

  async execute(params: { query: string }): Promise<string> {
    try {
      const { query } = params;
      
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await requestUrl({ url });
      const data = res.json;

      let output = `## DuckDuckGo: "${query}"\n\n`;
      let hasContent = false;

      // Abstract (main answer)
      if (data.Abstract && data.Abstract.trim().length > 0) {
        output += `**Answer:** ${data.Abstract}\n`;
        if (data.AbstractSource) output += `**Source:** ${data.AbstractSource}`;
        if (data.AbstractURL) output += ` — ${data.AbstractURL}`;
        output += "\n\n";
        hasContent = true;
      }

      // Answer box (for direct factual answers like "How tall is...")
      if (data.Answer && data.Answer.trim().length > 0) {
        output += `**Direct Answer:** ${data.Answer}\n`;
        if (data.AnswerType) output += `(Type: ${data.AnswerType})\n`;
        output += "\n";
        hasContent = true;
      }

      // Definition
      if (data.Definition && data.Definition.trim().length > 0) {
        output += `**Definition:** ${data.Definition}\n`;
        if (data.DefinitionSource) output += `Source: ${data.DefinitionSource}\n`;
        output += "\n";
        hasContent = true;
      }

      // Related topics (up to 3)
      if (data.RelatedTopics && data.RelatedTopics.length > 0) {
        const topics = data.RelatedTopics
          .filter((t: any) => t.Text && t.Text.trim().length > 0)
          .slice(0, 3);
        
        if (topics.length > 0) {
          output += "**Related:**\n";
          for (const topic of topics) {
            output += `- ${topic.Text}\n`;
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
    } catch (e) {
      throw e;
    }
  }
}
