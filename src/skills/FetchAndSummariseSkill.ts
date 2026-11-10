import { Notice } from "obsidian";
import { isPublicHttpUrl } from "../utils/urlSafety";
import { requestUrlWithTimeout } from "../utils/requestWithTimeout";
import { htmlToText } from "../utils/webResearch";
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
      if (!isPublicHttpUrl(url)) {
        return "Error: Only public web pages can be fetched, not local or private network addresses.";
      }

      // Fetch the webpage natively using Obsidian HTTP proxy layer
      const res = await requestUrlWithTimeout({ url });
      if (res.status !== 200) {
        return `Error: Unable to fetch webpage. Remote host returned HTTP Status Code ${res.status}.`;
      }

      // Headings, paragraphs, list items and table rows: lists and tables are
      // often the substance of a page and were dropped before.
      const page = htmlToText(res.text, url);
      const fullContent = page?.text ?? "";
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
      // No skills for the summary itself: the skill list (and agent-mode
      // instructions) would otherwise be appended and the model might call one.
      const aiSummary = await this.plugin.aiGateway.generate(
        summaryPrompt,
        "You are a precise research assistant specializing in text synthesis. You never use emojis.",
        undefined,
        true,
      );

      return `## ◈ Article Summary\n**Source:** ${url}\n\n${aiSummary.trim()}`;
    } catch (e: unknown) {
      console.error("Horme Fetch and Summarise Skill Error:", e);
      return `Error executing web scrape request: ${errorToMessage(e)}`;
    }
  }
}
