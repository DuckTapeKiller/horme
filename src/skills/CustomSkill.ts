import type { App, RequestUrlParam } from "obsidian";
import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import { Skill, SkillParameter } from "./types";
import { CustomSkillDefinition } from "../types";
import { getStringProp, isRecord } from "../utils/TypeGuards";

export class CustomSkill implements Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  parameters: SkillParameter[];
  primaryParam = "input";
  private url: string;
  private method: "GET" | "POST";
  private headers: Record<string, string>;
  private body: string;
  private responsePath: string;
  private app: App;

  constructor(app: App, def: CustomSkillDefinition) {
    this.app = app;
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
    this.parameters = [
      {
        name: "input",
        type: "string",
        required: true,
        description: "The text to process with this skill.",
      },
    ];
  }

  private resolveSecrets(input: string, missing: Set<string>): string {
    return input.replace(/\{\{secret:([^}]+)\}\}/g, (_match, rawId) => {
      const id = String(rawId || "").trim();
      if (!id) return "";
      try {
        const value = this.app.secretStorage.getSecret(id);
        if (value === null) {
          missing.add(id);
          return "";
        }
        return value;
      } catch {
        missing.add(id);
        return "";
      }
    });
  }

  async execute(params: unknown): Promise<string> {
    const query = getStringProp(params, "input");
    if (!query) return `Invalid parameters for ${this.name}: expected {"input": string}.`;

    // Secrets are resolved in the templates before the query goes in, so text
    // in the query (which a model writes, perhaps on a web page's prompting)
    // can never name a secret and have it sent. Function replacers keep "$&"
    // and similar in the query literal.
    const missingSecrets = new Set<string>();
    const urlTemplate = this.resolveSecrets(this.url, missingSecrets);
    const finalUrl = urlTemplate.replace(/\{\{query\}\}/g, () => encodeURIComponent(query));

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.headers || {})) {
      headers[k] = this.resolveSecrets(String(v ?? ""), missingSecrets);
    }
    const reqOptions: RequestUrlParam = {
      url: finalUrl,
      method: this.method,
      headers,
      throw: false,
    };

    if (this.method === "POST" && this.body) {
      const contentTypeKey = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
      const contentType = contentTypeKey ? headers[contentTypeKey].toLowerCase() : "";
      const bodyTemplate = this.resolveSecrets(this.body, missingSecrets);

      if (!contentType || contentType.includes("json")) {
        // Escape the query as a JSON string body (without its outer quotes).
        const escapedQuery = JSON.stringify(query).slice(1, -1);
        reqOptions.body = bodyTemplate.replace(/\{\{query\}\}/g, () => escapedQuery);
        if (!contentTypeKey) headers["Content-Type"] = "application/json";
      } else if (contentType.includes("x-www-form-urlencoded")) {
        // Encoded, so "&" or "=" in the query cannot add form fields.
        reqOptions.body = bodyTemplate.replace(/\{\{query\}\}/g, () => encodeURIComponent(query));
      } else {
        reqOptions.body = bodyTemplate.replace(/\{\{query\}\}/g, () => query);
      }
    }

    if (missingSecrets.size > 0) {
      const list = [...missingSecrets].sort().join(", ");
      return `Custom skill "${this.name}" is missing secret(s): ${list}. Create them in Obsidian Secret Storage (or select/create them in Horme's provider API Key fields) and try again.`;
    }

    const res = await requestUrlWithTimeout(reqOptions);

    if (res.status < 200 || res.status >= 400) {
      return `HTTP Error ${res.status} from ${this.name}. Response: ${(res.text || "").slice(0, 500)}`;
    }

    // Extract data via dot-path (e.g. "results[0].text")
    // res.json throws on a body that is not JSON (plain text, HTML).
    let data: unknown;
    try {
      data = res.json as unknown;
    } catch {
      data = res.text;
    }
    if (data === undefined || data === null) data = res.text;

    // isRecord is true for lists too, so a top-level list can be addressed ("[0].text").
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
   * Supports array indexing: "results[0].title" → obj.results[0].title, and
   * "[0].title" for a response that is a list.
   */
  private extractPath(obj: unknown, path: string): unknown {
    // Segments like "results", "results[0]", "[0]" (a top-level list) or "0".
    const segments = path.split(".").filter((s) => s !== "");
    let current: unknown = obj;

    for (const segment of segments) {
      const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
      if (!m) return undefined;
      const [, key, indexes] = m;
      if (key) {
        if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
        else current = isRecord(current) && !Array.isArray(current) ? current[key] : undefined;
      }
      for (const idx of indexes.match(/\d+/g) ?? []) {
        current = Array.isArray(current) ? current[Number(idx)] : undefined;
      }
      if (current === undefined || current === null) return undefined;
    }

    return current;
  }
}
