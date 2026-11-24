import { and, eq } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import { fileBytes, files, type FileKind } from './schema';

export { FILE_KINDS, MASTER_KINDS, type FileKind, type MasterKind } from './schema';

/** The upload limit, per file. The route enforces it before it reads the whole body. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class DocumentsError extends Error {
  constructor(
    readonly code: 'not_found' | 'unsupported_type' | 'invalid_argument',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentsError';
  }
}

export interface FileInfo {
  id: string;
  kind: FileKind;
  filename: string;
  mediaType: string;
  size: number;
  createdAt: Date;
}

export interface NewFile {
  kind: FileKind;
  filename: string;
  bytes: Buffer;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const startsWith = (b: Buffer, magic: number[]): boolean => magic.every((m, i) => b[i] === m);

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The media type of an upload, decided from its content alone; null when the kind does not allow it. */
export function detectMediaType(kind: FileKind, filename: string, bytes: Buffer): string | null {
  if (kind === 'photo') {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    return null;
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  // A DOCX is a zip with a word/document.xml entry; zip entry names are stored uncompressed.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return bytes.includes('word/document.xml', 0, 'latin1') ? DOCX : null;
  }
  if (isUtf8Text(bytes)) return /\.(md|markdown)$/i.test(filename) ? 'text/markdown' : 'text/plain';
  return null;
}

const infoColumns = {
  id: files.id,
  kind: files.kind,
  filename: files.filename,
  mediaType: files.mediaType,
  size: files.size,
  createdAt: files.createdAt,
};

export interface Documents {
  /** Checks the content type and stores the file; a new upload of a kind never removes an older one. */
  storeFile: (userId: string, file: NewFile) => Promise<FileInfo>;
  /** The file and its bytes, or null when the id is unknown or belongs to another user. */
  getFile: (userId: string, id: string) => Promise<{ info: FileInfo; bytes: Buffer } | null>;
}

export function createDocuments(db: Db): Documents {
  return {
    async storeFile(userId, file) {
      if (file.bytes.length === 0)
        throw new DocumentsError('invalid_argument', 'the file is empty');
      if (file.bytes.length > MAX_FILE_BYTES) {
        throw new DocumentsError('invalid_argument', 'the file is over the size limit');
      }
      const mediaType = detectMediaType(file.kind, file.filename, file.bytes);
      if (mediaType === null) {
        throw new DocumentsError(
          'unsupported_type',
          file.kind === 'photo'
            ? 'a photo must be a PNG or JPEG'
            : 'a Master file must be a PDF, DOCX, Markdown or UTF-8 text file',
        );
      }
      return db.transaction(async (tx) => {
        const [info] = await tx
          .insert(files)
          .values({
            userId,
            kind: file.kind,
            filename: file.filename,
            mediaType,
            size: file.bytes.length,
          })
          .returning(infoColumns);
        if (!info) throw new Error('file insert returned no row');
        await tx.insert(fileBytes).values({ fileId: info.id, bytes: file.bytes });
        return info;
      });
    },

    async getFile(userId, id) {
      const [info] = await db
        .select(infoColumns)
        .from(files)
        .where(and(eq(files.id, id), eq(files.userId, userId)));
      if (!info) return null;
      const [row] = await db
        .select({ bytes: fileBytes.bytes })
        .from(fileBytes)
        .where(eq(fileBytes.fileId, id));
      return row ? { info, bytes: row.bytes } : null;
    },
  };
}
