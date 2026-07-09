/** Hand-authored OpenAPI 3 spec for the currently-implemented endpoints.
 * Grows alongside the API surface in later sprints. */
export const openapiSpec = {
  openapi: '3.0.3',
  info: { title: 'Job Portal API', version: '0.1.0' },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
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
          '401': {
            description: 'Missing or invalid bearer token',
            content: { 'application/json': { example: { error: 'Unauthorized' } } },
          },
        },
      },
    },
  },
} as const;
