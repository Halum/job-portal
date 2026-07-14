import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type Logger } from '@job-portal/shared';
import type { AppConfigFile } from '@job-portal/config';

const insertError = vi.fn();
const markWebhookDelivered = vi.fn();

vi.mock('@job-portal/db', () => ({ insertError, markWebhookDelivered }));

const { createErrorNotifier } = await import('../src/notify.js');

const silentLogger: Logger = createLogger({ level: 'silent' });

const config = {
  app: {
    n8n: { error_webhook_url: 'http://hook.local/webhook' },
    retries: { webhook_error: { attempts: 3, backoff_ms: 1 } },
  } as AppConfigFile,
};

const input = {
  event: 'enrichment.failed' as const,
  source: null,
  jobId: 42,
  stage: 'enrichment' as const,
  attempts: 3,
  error: 'boom',
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createErrorNotifier', () => {
  it('empty webhook url: writes the row, never POSTs', async () => {
    insertError.mockResolvedValueOnce(7);
    const pullOnly = {
      app: { ...config.app, n8n: { error_webhook_url: '' } } as AppConfigFile,
    };
    const notify = createErrorNotifier({ db: {} as never, config: pullOnly, logger: silentLogger });

    await notify(input);

    expect(insertError).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markWebhookDelivered).not.toHaveBeenCalled();
  });

  it('2xx: writes the row, POSTs once, marks delivered true', async () => {
    insertError.mockResolvedValueOnce(7);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const notify = createErrorNotifier({ db: {} as never, config, logger: silentLogger });

    await notify(input);

    expect(insertError).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://hook.local/webhook');
    expect(JSON.parse(opts.body)).toMatchObject({
      event: 'enrichment.failed',
      source: null,
      job_id: 42,
      stage: 'enrichment',
      attempts: 3,
      error: 'boom',
    });
    expect(markWebhookDelivered).toHaveBeenCalledWith({}, 7, true);
  });

  it('non-2xx: retries up to attempts, leaves webhook_delivered false', async () => {
    insertError.mockResolvedValueOnce(9);
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const notify = createErrorNotifier({ db: {} as never, config, logger: silentLogger });

    await notify(input);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(markWebhookDelivered).not.toHaveBeenCalled();
  });

  it('db insert throws: still POSTs the webhook and does not crash', async () => {
    insertError.mockRejectedValueOnce(new Error('db down'));
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const notify = createErrorNotifier({ db: {} as never, config, logger: silentLogger });

    await expect(notify(input)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    // No row id captured → cannot mark delivered.
    expect(markWebhookDelivered).not.toHaveBeenCalled();
  });

  it('fetch rejects (network): retries then gives up without throwing', async () => {
    insertError.mockResolvedValueOnce(11);
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const notify = createErrorNotifier({ db: {} as never, config, logger: silentLogger });

    await expect(notify(input)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(markWebhookDelivered).not.toHaveBeenCalled();
  });
});
