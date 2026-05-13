import { requestUrl } from "obsidian";
import type { RequestUrlParam } from "obsidian";
import { Skill, SkillParameter } from "./types";
import { CustomSkillDefinition } from "../types";
import { getStringProp, isRecord } from "../utils/TypeGuards";

export class CustomSkill implements Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  parameters: SkillParameter[];
  private url: string;
  private method: "GET" | "POST";
  private headers: Record<string, string>;
  private body: string;
  private responsePath: string;

  constructor(def: CustomSkillDefinition) {
    this.id = def.id;
    this.name = def.name;
    this.description = def.description;
    this.url = def.url;
    this.method = def.method || "GET";
    this.headers = def.headers || {};
    this.body = def.body || "";
    this.responsePath = def.responsePath || "";
    // Custom skills are triggered via the Skills dropdown (forced-execution),
    // not by the model's own XML call syntax. The instructions field is
    // intentionally empty to avoid confusing the model into trying to invoke
    // a skill that the model itself cannot call.
    this.instructions = "";
    // Single generic parameter — receives the user's raw typed input.
    this.parameters = [{
      name: "input",
      type: "string",
      required: true,
      description: "The text to process with this skill."
    }];
  }

  async execute(params: unknown): Promise<string> {
    const query = getStringProp(params, "input");
    if (!query) return `Invalid parameters for ${this.name}: expected {"input": string}.`;

    // Substitute {{query}} in URL (URL-encoded) and body (raw)
    const finalUrl = this.url.replace(/\{\{query\}\}/g, encodeURIComponent(query));

    const headers: Record<string, string> = { ...this.headers };
    const reqOptions: RequestUrlParam = {
      url: finalUrl,
      method: this.method,
      headers,
      throw: false,
    };

    if (this.method === "POST" && this.body) {
      const isJson = (!headers["Content-Type"] || headers["Content-Type"].includes("json"));
      
      if (isJson) {
        // Safely escape the query before injecting it to prevent breaking the JSON structure.
        // JSON.stringify("test") returns '"test"'. We slice off the outer quotes to get the escaped inner string.
        const escapedQuery = JSON.stringify(query).slice(1, -1);
        reqOptions.body = this.body.replace(/\{\{query\}\}/g, escapedQuery);
        
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      } else {
        reqOptions.body = this.body.replace(/\{\{query\}\}/g, query);
      }
    }

    const res = await requestUrl(reqOptions);

    if (res.status < 200 || res.status >= 400) {
      return `HTTP Error ${res.status} from ${this.name}. Response: ${(res.text || "").slice(0, 500)}`;
    }

    // Extract data via dot-path (e.g. "results[0].text")
    let data: unknown = (res.json as unknown) ?? res.text;

    if (this.responsePath && isRecord(data)) {
      data = this.extractPath(data, this.responsePath);
    }

    // Format output
    if (data === undefined || data === null) {
      return `No data found at path "${this.responsePath}" in the response from ${this.name}.`;
    }

    const output =
      typeof data === "string" || typeof data === "number" || typeof data === "boolean"
        ? String(data)
        : JSON.stringify(data, null, 2);

    // Cap at 3000 chars to avoid context overflow
    if (output.length > 3000) {
      return output.slice(0, 2950) + "\n\n...[TRUNCATED]";
    }

    return output;
  }

  /**
   * Extracts a value from a nested object using a dot-path string.
   * Supports array indexing: "results[0].title" → obj.results[0].title
   */
  private extractPath(obj: unknown, path: string): unknown {
    const segments = path.split(".");
    let current: unknown = obj;

    for (const segment of segments) {
      if (current === undefined || current === null) return undefined;

      // Handle array indexing like "results[0]"
      const arrMatch = segment.match(/^(\w+)\[(\d+)\]$/);
      if (arrMatch) {
        const key = arrMatch[1];
        const idx = Number.parseInt(arrMatch[2], 10);
        const next = isRecord(current) ? current[key] : undefined;
        if (Array.isArray(next)) {
          current = next[idx];
        } else {
          return undefined;
        }
      } else {
        current = isRecord(current) ? current[segment] : undefined;
      }
    }

    return current;
  }
}
