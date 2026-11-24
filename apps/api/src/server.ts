import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Accounts, User } from '@job-portal/accounts';
import { registerTools, type ToolDeps } from './tools';

function buildMcpServer(user: User, deps: ToolDeps): McpServer {
  const mcp = new McpServer({ name: 'job-automation', version: '0.1.0' });
  registerTools(mcp, user, deps);
  return mcp;
}

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function reply(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers).end();
}

/**
 * Stateless Streamable HTTP MCP endpoint at /mcp, bearer-authenticated.
 * ponytail: a fresh MCP server and transport per request, no sessions; add sessions only if a tool needs server push.
 */
export interface ApiDeps extends ToolDeps {
  accounts: Accounts;
}

export function createApiServer({ accounts, ...tools }: ApiDeps): Server {
  const { logger } = tools;
  return createServer((req, res) => {
    void (async () => {
      if (req.url !== '/mcp') {
        reply(res, 404);
        return;
      }
      const user = await accounts.authenticate(req.headers.authorization);
      if (!user) {
        reply(res, 401, { 'WWW-Authenticate': 'Bearer' });
        return;
      }
      if (req.method !== 'POST') {
        reply(res, 405, { Allow: 'POST' });
        return;
      }

      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        reply(res, err instanceof BodyTooLargeError ? 413 : 400, { Connection: 'close' });
        return;
      }
      const mcp = buildMcpServer(user, tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      logger.error({ err }, 'request failed');
      if (!res.headersSent) reply(res, 500);
    });
  });
}
