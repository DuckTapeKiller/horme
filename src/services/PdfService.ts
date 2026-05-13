import { App, TFile } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import { asNumberArray, isRecord } from "../utils/TypeGuards";

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy?: () => void | Promise<void>;
}

interface PdfJsDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
  cleanup?: () => void;
  destroy?: () => void | Promise<void>;
}

interface PdfJsPage {
  getTextContent: () => Promise<{ items: unknown[] }>;
  getViewport: (params: { scale: number }) => { width: number; height: number };
  cleanup?: () => void;
}

interface PdfJsTextItem {
  str: string;
  transform: number[];
  fontName?: string;
}

export class PdfService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async extractText(file: TFile | File, onProgress?: (p: number, s: string) => void): Promise<string> {
    const arrayBuffer = file instanceof TFile 
      ? await this.app.vault.readBinary(file)
      : await (file as File).arrayBuffer();

    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer }) as unknown as PdfJsLoadingTask;
    let pdf: PdfJsDocument | null = null;
    try {
      pdf = await loadingTask.promise;
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
          if (typeof page.cleanup === "function") page.cleanup();
        }
      }

      return pages.join("\n\n");
    } finally {
      try {
        if (pdf && typeof pdf.cleanup === "function") pdf.cleanup();
      } catch {
        // no-op
      }
      try {
        if (pdf && typeof pdf.destroy === "function") await pdf.destroy();
      } catch {
        // no-op
      }
      try {
        if (typeof loadingTask.destroy === "function") await loadingTask.destroy();
      } catch {
        // no-op
      }
    }
  }

  private isTextItem(item: unknown): item is PdfJsTextItem {
    if (!isRecord(item)) return false;
    if (typeof item.str !== "string") return false;
    const t = (item as Record<string, unknown>).transform;
    const transform = asNumberArray(t);
    if (!transform || transform.length < 6) return false;
    return true;
  }

  private async extractStructuredText(page: PdfJsPage): Promise<string> {
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const items = content.items
      .filter((item): item is PdfJsTextItem => this.isTextItem(item) && item.str.trim().length > 0)
      .sort((a, b) => {
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
