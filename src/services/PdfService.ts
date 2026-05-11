import { App, TFile } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

export class PdfService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async extractText(file: TFile | File, onProgress?: (p: number, s: string) => void): Promise<string> {
    const arrayBuffer = file instanceof TFile 
      ? await this.app.vault.readBinary(file)
      : await (file as File).arrayBuffer();
      
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    try {
      const numPages = pdf.numPages;
      const pages: string[] = [];

      for (let i = 1; i <= numPages; i++) {
        if (onProgress) onProgress(i / numPages, `Extracting page ${i} of ${numPages}...`);
        const page = await pdf.getPage(i);
        try {
          const structuredText = await this.extractStructuredText(page);
          
          if (this.detectBadOcr(structuredText)) {
            pages.push(`--- PAGE ${i} (Warning: Low quality or garbled text) ---\n${structuredText}`);
          } else {
            pages.push(`--- PAGE ${i} ---\n${structuredText}`);
          }
        } finally {
          try { page.cleanup?.(); } catch { /* best-effort */ }
        }
      }

      return pages.join("\n\n");
    } finally {
      // Best-effort cleanup to avoid leaving PDF.js workers alive after extraction.
      try { await loadingTask.destroy(); } catch { /* best-effort */ }
    }
  }

  private async extractStructuredText(page: any): Promise<string> {
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const items = content.items
      .filter((item: any) => "str" in item && item.str.trim().length > 0)
      .sort((a: any, b: any) => {
        const yA = a.transform[5];
        const yB = b.transform[5];
        if (Math.abs(yA - yB) < 5) return a.transform[4] - b.transform[4];
        return yB - yA;
      });

    const lines: string[] = [];
    for (const item of items) {
      const transform = item.transform;
      // Normalize coordinates to 0-1000 scale (Marker-style) for AI efficiency
      const x = Math.round((transform[4] / pageWidth) * 1000);
      const y = Math.round(((pageHeight - transform[5]) / pageHeight) * 1000);
      const fontSize = Math.round(transform[0]);
      
      const fontName = item.fontName?.toLowerCase() || "";
      const isBold = fontName.includes("bold") || fontName.includes("700") || fontName.includes("800");
      const isItalic = fontName.includes("italic") || fontName.includes("oblique");
      
      let style = "";
      if (isBold) style += ", bold";
      if (isItalic) style += ", italic";

      lines.push(`[x: ${x}, y: ${y}, size: ${fontSize}${style}] ${item.str}`);
    }

    return lines.join("\n");
  }

  private detectBadOcr(text: string): boolean {
    if (!text.trim()) return false;
    const alphanumeric = text.replace(/[^a-zA-Z0-9]/g, "").length;
    const total = text.replace(/\s/g, "").length;
    if (total === 0) return false;
    return (alphanumeric / total) < 0.3;
  }
}
