import { PROMPT_ROLES, SOURCE_TYPES } from '@job-portal/shared';

const badRequest = {
  description: 'Invalid or missing parameters',
  content: { 'application/json': { example: { error: 'Invalid query' } } },
};
const unauthorized = {
  description: 'Missing or invalid bearer token',
  content: { 'application/json': { example: { error: 'Unauthorized' } } },
};

/** Hand-authored OpenAPI 3 spec for the currently-implemented endpoints.
 * Grows alongside the API surface in later sprints. */
export const openapiSpec = {
  openapi: '3.0.3',
  info: { title: 'Job Portal API', version: '0.1.0' },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Prompt: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          source: { type: 'string', enum: SOURCE_TYPES },
          role: { type: 'string', enum: PROMPT_ROLES },
          template: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'Liveness + dependency health (no auth)',
        responses: {
          '200': {
            description: 'All dependencies reachable',
            content: {
              'application/json': {
                example: { status: 'ok', db: 'ok', redis: 'ok' },
              },
            },
          },
          '503': {
            description: 'One or more dependencies down',
            content: {
              'application/json': {
                example: { status: 'fail', db: 'fail', redis: 'ok' },
              },
            },
          },
        },
      },
    },
    '/api/ping': {
      get: {
        summary: 'Auth smoke test',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Authenticated',
            content: { 'application/json': { example: { pong: true } } },
          },
          '401': unauthorized,
        },
      },
    },
    '/api/prompts': {
      get: {
        summary: 'Get the prompt for a source + role (admin)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'source',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: SOURCE_TYPES },
          },
          {
            name: 'role',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: PROMPT_ROLES },
          },
        ],
        responses: {
          '200': {
            description: 'The prompt for this source + role',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Prompt' } },
            },
          },
          '400': badRequest,
          '401': unauthorized,
          '404': { description: 'No prompt for this source + role' },
        },
      },
      post: {
        summary: 'Create or overwrite the prompt for a source + role (admin)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['source', 'role', 'template'],
                properties: {
                  source: { type: 'string', enum: SOURCE_TYPES },
                  role: { type: 'string', enum: PROMPT_ROLES },
                  template: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The upserted prompt',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Prompt' } },
            },
          },
          '400': badRequest,
          '401': unauthorized,
        },
      },
    },
  },
} as const;
