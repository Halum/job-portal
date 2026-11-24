import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { userSchema, type Accounts, type User } from '@job-portal/accounts';
import type { Logger } from '@job-portal/shared';

function buildMcpServer(user: User): McpServer {
  const mcp = new McpServer({ name: 'job-automation', version: '0.1.0' });
  mcp.registerTool(
    'whoami',
    {
      description: 'Return the id, email and timezone of the authenticated user.',
      outputSchema: userSchema.shape,
    },
    () => {
      return { content: [{ type: 'text', text: JSON.stringify(user) }], structuredContent: user };
    },
  );
  return mcp;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function reply(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers).end();
}

/**
 * Stateless Streamable HTTP MCP endpoint at /mcp, bearer-authenticated.
 * ponytail: a fresh MCP server and transport per request, no sessions; add sessions only if a tool needs server push.
 */
export function createApiServer(accounts: Accounts, logger: Logger): Server {
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
      } catch {
        reply(res, 400);
        return;
      }
      const mcp = buildMcpServer(user);
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
