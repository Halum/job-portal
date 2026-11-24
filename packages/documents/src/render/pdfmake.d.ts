// pdfmake ships no types. The community @types/pdfmake references the DOM lib, which would change the types of
// fetch and friends for the whole repo, so this declares only the part of the API the renderer uses.
declare module 'pdfmake' {
  export type Content = string | { [key: string]: unknown } | Content[];
  export interface TDocumentDefinitions {
    info?: { title?: string; author?: string };
    content: Content;
    styles?: { [name: string]: { [key: string]: unknown } };
    defaultStyle?: { [key: string]: unknown };
    pageSize?: string;
    pageMargins?: [number, number, number, number];
    footer?: (currentPage: number, pageCount: number) => Content | null;
  }
  const pdfmake: {
    addFonts(fonts: {
      [family: string]: { normal: string; bold: string; italics: string; bolditalics: string };
    }): void;
    setLocalAccessPolicy(policy: (path: string) => boolean): void;
    setUrlAccessPolicy(policy: (url: string) => boolean): void;
    createPdf(definition: TDocumentDefinitions): { getBuffer(): Promise<Uint8Array> };
  };
  export default pdfmake;
}
