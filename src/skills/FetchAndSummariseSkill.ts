import { Notice } from "obsidian";
import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import { Skill, SkillParameter } from "./types";
import HormePlugin from "../../main";
import { errorToMessage, getStringProp } from "../utils/TypeGuards";

export class FetchAndSummariseSkill implements Skill {
  id = "fetch_and_summarise";
  name = "Fetch and Summarise";
  description =
    "Fetches the core content of an online news article or web URL and extracts the text layout for reading and synthesis.";
  terminal = true; // Mark as terminal to force direct chat rendering
  primaryParam = "url";

  private plugin: HormePlugin;

  constructor(plugin: HormePlugin) {
    this.plugin = plugin;
  }

  parameters: SkillParameter[] = [
    {
      name: "url",
      type: "string",
      description: "The full HTTP or HTTPS URL of the online article to scrape.",
      required: true,
    },
  ];

  instructions = `To use this skill, output exactly: <call:fetch_and_summarise>{"url": "https://example.com/article"}</call>. Use this whenever the user shares a link to a newspaper article, blog post, or webpage and explicitly requests that you read, summarize, evaluate, or answer questions about its content.`;

  async execute(params: unknown): Promise<string> {
    try {
      const url = getStringProp(params, "url");
      if (!url) return 'Invalid parameters: expected {"url": "string"}.';

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return "Error: Invalid URL protocol specified. Target must begin with http:// or https://.";
      }

      // Fetch the webpage natively using Obsidian HTTP proxy layer
      const res = await requestUrlWithTimeout({ url });
      if (res.status !== 200) {
        return `Error: Unable to fetch webpage. Remote host returned HTTP Status Code ${res.status}.`;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(res.text, "text/html");

      // Strip intrusive noise elements to shrink VRAM usage profile
      const noiseSelectors =
        "script, style, noscript, iframe, nav, footer, header, aside, head, .advertisement, .comments, ytd-engagement-panel-section-list-renderer";
      doc.querySelectorAll(noiseSelectors).forEach((el) => el.remove());

      // Target relevant content wrapper nodes to extract clean textual content
      let rootContainer: Element | Document = doc;
      const structuralBody =
        doc.querySelector("article") ||
        doc.querySelector("main") ||
        doc.querySelector("#content") ||
        doc.querySelector(".article-body") ||
        doc.querySelector(".story-body");
      if (structuralBody) {
        rootContainer = structuralBody;
      }

      const elements = rootContainer.querySelectorAll("h1, h2, h3, p");
      const textLines: string[] = [];

      elements.forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length > 15) {
          if (el.tagName.startsWith("H")) {
            textLines.push(`\n### ${text}\n`);
          } else {
            textLines.push(text);
          }
        }
      });

      const fullContent = textLines.join("\n\n").trim();
      if (!fullContent) {
        return "Error: Webpage downloaded successfully, but no readable article text body or paragraphs could be extracted from the structural HTML template.";
      }

      // Context Window Protection: Truncate document data to safe boundary
      const maxChars = 8000;
      const cleanContent = fullContent.length > maxChars ? fullContent.substring(0, maxChars) : fullContent;

      // Trigger an explicit, terminal summary pass using the plugin's active text gateway
      const summaryPrompt = `Review the following extracted webpage content from ${url} and generate a concise, high-density summary. 
Structure your response cleanly using Markdown with bullet points or text glyphs for key takeaways, maintaining an objective tone. 

CRITICAL VISUAL RULE: Do not use any emojis (e.g. no icons, no emotional graphics) anywhere in the text response. Use clean typography or standard text-based symbols if structure is needed. Do not include any introductory chatter or meta-commentary.

Content:
${cleanContent}`;

      new Notice("● Fetch & Summarise: Reading article...");

      // Privacy guard: scraped webpage content must not leave the device
      // unless the user has explicitly acknowledged cloud document sharing.
      if (!this.plugin.isLocalProviderActive() && !this.plugin.settings.documentCloudWarningShown) {
        return `## ◈ Article Fetched\n**Source:** ${url}\n\n⚠ **Privacy Guard:** The article was fetched successfully, but summarisation requires sending its content to your active cloud provider. Please enable the "Use current note as context" toggle in the chat view first to acknowledge cloud sharing, or switch to a local provider (Ollama / LM Studio).`;
      }

      // Call your plugin's primary chat generation channel
      const aiSummary = await this.plugin.aiGateway.generate(
        summaryPrompt,
        "You are a precise research assistant specializing in text synthesis. You never use emojis.",
      );

      return `## ◈ Article Summary\n**Source:** ${url}\n\n${aiSummary.trim()}`;
    } catch (e: unknown) {
      console.error("Horme Fetch and Summarise Skill Error:", e);
      return `Error executing web scrape request: ${errorToMessage(e)}`;
    }
  }
}
