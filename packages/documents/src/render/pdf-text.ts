// Test helper: the selectable text of a PDF, page by page, read the way an applicant tracking system would.
//
// pdfjs-dist's own type declarations pull the DOM lib into the whole repo's typecheck (and change what fetch accepts),
// so the module is loaded by a variable specifier and typed here with only what the helper uses.
interface PdfJs {
  getDocument(src: { data: Uint8Array; useSystemFonts: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }>;
    }>;
    destroy(): Promise<void>;
  };
}

const PDFJS = 'pdfjs-dist/legacy/build/pdf.mjs';

export async function extractPages(pdf: Buffer): Promise<string[]> {
  const pdfjs = (await import(PDFJS)) as PdfJs;
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str ?? '').join(' '));
  }
  await task.destroy();
  return pages;
}
