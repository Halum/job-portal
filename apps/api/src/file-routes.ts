import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { User } from '@job-portal/accounts';
import { DocumentsError, FILE_KINDS, MAX_FILE_BYTES, type Documents } from '@job-portal/documents';

const uploadQuery = z.object({
  kind: z.enum(FILE_KINDS),
  filename: z.string().min(1).max(255),
});

const FILE_ID = /^\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** True for the paths this module serves: the upload route and the download route. */
export function isFilePath(pathname: string): boolean {
  return pathname === '/files' || FILE_ID.test(pathname);
}

/**
 * Reads the body; null as soon as it passes the limit. Past that the rest is drained and dropped (so the client
 * can read the answer), and a client that keeps sending beyond twice the limit is cut off.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      resolve(null);
      if (size > 2 * MAX_FILE_BYTES) req.destroy();
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: Buffer | string,
): void {
  res.writeHead(status, headers).end(body);
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(body));
};

/** Upload (POST /files?kind=&filename=, raw body) and download (GET /files/<id>) for an authenticated user. */
export async function handleFileRoute(
  req: IncomingMessage,
  res: ServerResponse,
  user: User,
  url: URL,
  documents: Documents,
): Promise<void> {
  if (url.pathname === '/files') {
    if (req.method !== 'POST') {
      send(res, 405, { Allow: 'POST' });
      return;
    }
    const query = uploadQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) {
      json(res, 400, { error: 'kind and filename are required' });
      return;
    }
    // A declared size over the limit is refused unread: limit 0 stores nothing and only drains.
    const declaredTooLarge = Number(req.headers['content-length']) > MAX_FILE_BYTES;
    const bytes = await readBody(req, declaredTooLarge ? 0 : MAX_FILE_BYTES);
    if (bytes === null) {
      send(res, 413, {});
      return;
    }
    try {
      const info = await documents.storeFile(user.id, { ...query.data, bytes });
      json(res, 201, { ...info, createdAt: info.createdAt.toISOString() });
      return;
    } catch (err) {
      if (!(err instanceof DocumentsError)) throw err;
      json(res, err.code === 'unsupported_type' ? 415 : 400, { error: err.message });
      return;
    }
  }

  if (req.method !== 'GET') {
    send(res, 405, { Allow: 'GET' });
    return;
  }
  const id = FILE_ID.exec(url.pathname)?.[1];
  const file = id ? await documents.getFile(user.id, id) : null;
  if (!file) {
    send(res, 404, {});
    return;
  }
  send(
    res,
    200,
    {
      'Content-Type': file.info.mediaType,
      'Content-Length': String(file.bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.info.filename)}`,
    },
    file.bytes,
  );
}
