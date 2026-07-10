import { ERROR_STAGES, JOB_STATUSES, PROMPT_ROLES, SOURCE_TYPES } from '@job-portal/shared';

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
      Job: {
        type: 'object',
        description: 'A job in the pull-API wire contract (snake_case, PRD §12).',
        properties: {
          id: { type: 'integer' },
          source: { type: 'string' },
          external_id: { type: 'string' },
          title: { type: 'string' },
          company: { type: 'string', nullable: true },
          location: { type: 'string', nullable: true },
          posted_at: { type: 'string', format: 'date-time', nullable: true },
          apply_url: { type: 'string' },
          enriched_at: { type: 'string', format: 'date-time', nullable: true },
          enrichment_json: { type: 'object', nullable: true },
        },
      },
      ErrorRow: {
        type: 'object',
        description: 'A row from the errors audit table (snake_case, PRD §13).',
        properties: {
          id: { type: 'integer' },
          source: { type: 'string', nullable: true },
          job_id: { type: 'integer', nullable: true },
          stage: { type: 'string', enum: ERROR_STAGES },
          attempts: { type: 'integer' },
          error_message: { type: 'string' },
          error_stack: { type: 'string', nullable: true },
          payload: { type: 'object', nullable: true },
          webhook_delivered: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Source: {
        type: 'object',
        description: 'A configured source from sources.yaml (in-memory, PRD §12).',
        properties: {
          name: { type: 'string' },
          source_type: { type: 'string', enum: SOURCE_TYPES },
          url: { type: 'string' },
          cron: { type: 'string' },
          enabled: { type: 'boolean' },
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
    '/api/jobs': {
      get: {
        summary: 'List jobs within a fixed time window (pull API, PRD §12)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: JOB_STATUSES, default: 'matched' },
          },
          { name: 'source', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'from',
            in: 'query',
            required: false,
            description: 'ISO timestamp, inclusive (enriched_at >= from). Defaults to epoch.',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            description: 'ISO timestamp, exclusive (enriched_at < to). Defaults to now().',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, default: 0 },
          },
        ],
        responses: {
          '200': {
            description: 'A page of jobs plus the page size (count, not window total)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jobs: { type: 'array', items: { $ref: '#/components/schemas/Job' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': badRequest,
          '401': unauthorized,
        },
      },
    },
    '/api/jobs/{id}': {
      get: {
        summary: 'Get a single job with full detail (raw payload + enrichment)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'The job, including raw adapter payload and status',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/Job' },
                    {
                      type: 'object',
                      properties: {
                        raw: { type: 'object' },
                        status: { type: 'string', enum: JOB_STATUSES },
                      },
                    },
                  ],
                },
              },
            },
          },
          '400': badRequest,
          '401': unauthorized,
          '404': { description: 'No job with this id' },
        },
      },
    },
    '/api/admin/reenrich': {
      post: {
        summary: 'Enqueue re-enrichment for matching jobs (admin, PRD §12)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description:
                  'All fields optional. job_ids (if given) is used directly; ' +
                  'otherwise jobs are selected by source/status/created_at window. ' +
                  'prompt_role is accepted but ignored (both passes always re-run).',
                properties: {
                  source: { type: 'string' },
                  status: { type: 'string', enum: JOB_STATUSES },
                  prompt_role: { type: 'string', enum: PROMPT_ROLES },
                  from: { type: 'string', format: 'date-time' },
                  to: { type: 'string', format: 'date-time' },
                  job_ids: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Number of enrichment jobs enqueued',
            content: { 'application/json': { example: { queued: 12 } } },
          },
          '400': badRequest,
          '401': unauthorized,
        },
      },
    },
    '/api/sources': {
      get: {
        summary: 'List configured sources (in-memory, not DB) (admin, PRD §12)',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'The configured sources',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Source' } },
              },
            },
          },
          '401': unauthorized,
        },
      },
    },
    '/api/errors': {
      get: {
        summary: 'Window pagination over the errors audit table (admin, PRD §12)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'stage',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ERROR_STAGES },
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            description: 'ISO timestamp, inclusive (created_at >= from). Defaults to epoch.',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            description: 'ISO timestamp, exclusive (created_at < to). Defaults to now().',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0, default: 0 },
          },
        ],
        responses: {
          '200': {
            description: 'A page of error rows plus the page size',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    errors: { type: 'array', items: { $ref: '#/components/schemas/ErrorRow' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': badRequest,
          '401': unauthorized,
        },
      },
    },
  },
} as const;
