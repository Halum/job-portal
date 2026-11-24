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

class TooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FILE_BYTES) throw new TooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
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
    // A declared size over the limit is refused unread; the body is drained so the client sees the answer.
    if (Number(req.headers['content-length']) > MAX_FILE_BYTES) {
      send(res, 413, {});
      req.resume();
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBody(req);
    } catch (err) {
      if (err instanceof TooLargeError) {
        send(res, 413, { Connection: 'close' });
        return;
      }
      throw err;
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
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.info.filename)}`,
    },
    file.bytes,
  );
}
