import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

export class DocxService {
  async generateBuffer(markdown: string): Promise<Buffer> {
    const doc = new Document({
      sections: [{
        properties: {},
        children: this.markdownToDocxParagraphs(markdown),
      }],
    });

    return await Packer.toBuffer(doc);
  }

  private markdownToDocxParagraphs(markdown: string): Paragraph[] {
    const lines = markdown.split("\n");
    const paragraphs: Paragraph[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        paragraphs.push(new Paragraph({
          text: headerMatch[2],
          heading: HeadingLevel[`HEADING_${level}` as keyof typeof HeadingLevel],
          spacing: { before: 200, after: 100 }
        }));
        continue;
      }
      
      const listMatch = line.match(/^[-*]\s+(.*)$/);
      if (listMatch) {
        paragraphs.push(new Paragraph({
          children: this.parseInlineStyles(listMatch[1]),
          bullet: { level: 0 },
        }));
        continue;
      }

      paragraphs.push(new Paragraph({
        children: this.parseInlineStyles(line),
        spacing: { after: 120 }
      }));
    }
    return paragraphs;
  }

  private parseInlineStyles(text: string): TextRun[] {
    const runs: TextRun[] = [];
    let current = "";
    let i = 0;
    while (i < text.length) {
      if (text.startsWith("**", i)) {
        if (current) runs.push(new TextRun({ text: current }));
        current = "";
        const end = text.indexOf("**", i + 2);
        if (end !== -1) {
          runs.push(new TextRun({ text: text.slice(i + 2, end), bold: true }));
          i = end + 2;
        } else {
          current = "**";
          i += 2;
        }
      } else if (text.startsWith("*", i)) {
        if (current) runs.push(new TextRun({ text: current }));
        current = "";
        let end = i + 1;
        while (end < text.length) {
          if (text[end] === "*" && !text.startsWith("**", end)) break;
          if (text.startsWith("**", end)) { end += 2; continue; }
          end++;
        }
        if (end < text.length) {
          runs.push(new TextRun({ text: text.slice(i + 1, end), italics: true }));
          i = end + 1;
        } else { current = "*"; i += 1; }
      } else {
        current += text[i];
        i++;
      }
    }
    if (current) runs.push(new TextRun({ text: current }));
    return runs;
  }
}
