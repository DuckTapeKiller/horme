import { App, Modal, MarkdownRenderer, Editor, Notice } from "obsidian";
import type HormePlugin from "../../main";

interface ClaimBlock {
  claim: string;
  verdict: string;
  source: string;
  note: string;
}

export class FactCheckResultModal extends Modal {
  private resultMarkdown: string;
  private plugin: HormePlugin;
  private editor: Editor;
  private selectionEnd: { line: number; ch: number };
  private footnoteOffset: number = 0; // Tracks characters added by previous footnotes

  constructor(
    app: App,
    plugin: HormePlugin,
    resultMarkdown: string,
    editor: Editor,
    selectionEnd: { line: number; ch: number },
  ) {
    super(app);
    this.plugin = plugin;
    this.resultMarkdown = resultMarkdown;
    this.editor = editor;
    this.selectionEnd = selectionEnd;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("horme-fact-check-modal");

    const headerEl = contentEl.createEl("h2", { text: "Fact Check Results" });
    headerEl.addClass("horme-fact-check-header");

    const containerEl = contentEl.createDiv("horme-fact-check-container");

    const claims = this.parseClaims(this.resultMarkdown);

    if (claims.length === 0) {
      // fallback if parsing fails or there are no claims formatted correctly
      MarkdownRenderer.render(this.app, this.resultMarkdown, containerEl, "", this.plugin as any);
    } else {
      for (const claim of claims) {
        this.renderClaimBlock(containerEl, claim);
      }
    }

    const btnRow = contentEl.createDiv("horme-fact-check-buttons");
    const closeBtn = btnRow.createEl("button", { text: "Close", cls: "mod-cta" });
    closeBtn.addEventListener("click", () => this.close());
  }

  private parseClaims(text: string): ClaimBlock[] {
    // The prompt forces the output to start each claim with "**Claim:**"
    const blocks = text.split(/\*\*Claim:\*\*/i);
    const parsed: ClaimBlock[] = [];

    // Start at 1 because index 0 is anything before the first "**Claim:**"
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i].trim();

      const verdictMatch = block.match(/\*\*Verdict:\*\*(.*?)(?=\*\*Source:\*\*|$)/is);
      const sourceMatch = block.match(/\*\*Source:\*\*(.*?)(?=\*\*Note:\*\*|$)/is);
      const noteMatch = block.match(/\*\*Note:\*\*(.*)/is);

      let claimText = "";
      const nextSectionIdx = block.search(/\*\*Verdict:\*\*/i);
      if (nextSectionIdx !== -1) {
        claimText = block.substring(0, nextSectionIdx).trim();
      } else {
        claimText = block; // Fallback if verdict is missing
      }

      const verdictText = verdictMatch ? verdictMatch[1].trim() : "";
      const sourceText = sourceMatch ? sourceMatch[1].trim() : "";
      const noteText = noteMatch ? noteMatch[1].trim() : "";

      parsed.push({
        claim: claimText,
        verdict: verdictText,
        source: sourceText,
        note: noteText,
      });
    }
    return parsed;
  }

  private renderClaimBlock(containerEl: HTMLElement, claim: ClaimBlock) {
    const blockEl = containerEl.createDiv("horme-claim-block");

    const fields = [
      { title: "Claim", content: claim.claim },
      { title: "Verdict", content: claim.verdict },
      { title: "Source", content: claim.source },
      { title: "Note", content: claim.note },
    ];

    for (const field of fields) {
      if (!field.content) continue;
      const fieldRow = blockEl.createDiv("horme-claim-field");

      const titleSpan = fieldRow.createSpan("horme-claim-title");
      titleSpan.createEl("strong", { text: `${field.title}:` });
      titleSpan.appendText(" ");

      if (field.title === "Verdict") {
        const dotSpan = fieldRow.createSpan("horme-verdict-dot");
        const lowerContent = field.content.toLowerCase();
        if (lowerContent.includes("inaccurate")) {
          dotSpan.addClass("horme-verdict-red");
        } else if (lowerContent.includes("accurate")) {
          dotSpan.addClass("horme-verdict-green");
        } else if (lowerContent.includes("unverifiable")) {
          dotSpan.addClass("horme-verdict-yellow");
        }
      }

      const contentSpan = fieldRow.createSpan("horme-claim-content");
      // Use MarkdownRenderer so links and simple formatting are preserved natively
      MarkdownRenderer.render(this.app, field.content, contentSpan, "", this.plugin as any);
    }

    const actionRow = blockEl.createDiv("horme-claim-actions");

    const copyBtn = actionRow.createEl("button", { text: "Copy" });
    copyBtn.addEventListener("click", () => {
      const textToCopy = `**Claim:** ${claim.claim}\n**Verdict:** ${claim.verdict}\n**Source:** ${claim.source}\n**Note:** ${claim.note}`;
      navigator.clipboard.writeText(textToCopy);
      copyBtn.setText("Copied!");
    });

    const insertBtn = actionRow.createEl("button", { text: "Insert as Footnote" });
    insertBtn.addEventListener("click", () => {
      try {
        const currentText = this.editor.getValue();
        let index = 1;
        while (currentText.includes(`[^${index}]`)) {
          index++;
        }

        // Clean up footnote content: remove newlines
        const footnoteContent =
          `**Fact Check - ${claim.verdict}**: ${claim.note} (Source: ${claim.source})`.replace(/\n/g, " ");

        // 100% Accurate placement at the end of the original selection.
        // We add `this.footnoteOffset` so if you click multiple footnotes, they stack properly left-to-right.
        const insertPos = {
          line: this.selectionEnd.line,
          ch: this.selectionEnd.ch + this.footnoteOffset,
        };

        const marker = `[^${index}]`;
        this.editor.replaceRange(marker, insertPos);
        this.footnoteOffset += marker.length;

        const lastLine = this.editor.lastLine();
        const lastLineLength = this.editor.getLine(lastLine).length;
        this.editor.replaceRange(`\n\n[^${index}]: ${footnoteContent}`, {
          line: lastLine,
          ch: lastLineLength,
        });

        insertBtn.setText("Inserted ✓");
      } catch (err) {
        new Notice("Failed to insert footnote. Check console for details.");
        console.error(err);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
