// Type declaration for html2pdf.js which ships without bundled types.
declare module 'html2pdf.js' {
  export interface Html2PdfOptions {
    margin?: number | number[];
    filename?: string;
    jsPDF?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface Html2PdfInstance {
    from(element: HTMLElement): Html2PdfInstance;
    set(options: Html2PdfOptions): Html2PdfInstance;
    output(type: "blob"): Promise<Blob>;
    output(type: string): Promise<unknown>;
  }

  interface Html2PdfFactory {
    (): Html2PdfInstance;
  }

  const html2pdf: Html2PdfFactory;
  export default html2pdf;
}
