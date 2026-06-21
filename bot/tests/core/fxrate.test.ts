import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { FxRateService } from '../../src/core/tracker/fxrate';

vi.mock('axios', () => {
  const get = vi.fn();
  const instance = {
    get,
    interceptors: {
      request: { use: vi.fn(), eject: vi.fn() },
      response: { use: vi.fn(), eject: vi.fn() },
    },
    defaults: {},
  };
  return {
    default: {
      create: vi.fn(() => instance),
    },
  };
});

describe('FxRateService', () => {
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = (axios.create as any)().get;
    mockGet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the most recent rate from a trailing window of BACEN data', async () => {
    mockGet.mockResolvedValue({
      data: [
        { data: '15/06/2026', valor: '5.10' },
        { data: '16/06/2026', valor: '5.15' },
        { data: '17/06/2026', valor: '5.20' },
      ],
    });

    const svc = new FxRateService();
    const rate = await svc.getUsdBrlRate();
    expect(rate).toBe(5.20);
  });

  it('caches the rate for the rest of the day (one fetch per day)', async () => {
    mockGet.mockResolvedValue({ data: [{ data: '17/06/2026', valor: '5.20' }] });

    const svc = new FxRateService();
    await svc.getUsdBrlRate();
    await svc.getUsdBrlRate();
    await svc.getUsdBrlRate();

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('falls back to the previous cached rate if a later fetch fails', async () => {
    mockGet.mockResolvedValueOnce({ data: [{ data: '17/06/2026', valor: '5.20' }] });
    const svc = new FxRateService();
    const first = await svc.getUsdBrlRate();
    expect(first).toBe(5.20);

    // Force a new fetch by clearing the service's cached date — simulate "next day."
    (svc as unknown as { cachedDate: string | null }).cachedDate = '2000-01-01';
    mockGet.mockRejectedValueOnce(new Error('network down'));

    const second = await svc.getUsdBrlRate();
    expect(second).toBe(5.20); // reused the stale cached value rather than throwing
  });

  it('throws if BACEN is unreachable and there is no cached value yet', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    const svc = new FxRateService();
    await expect(svc.getUsdBrlRate()).rejects.toThrow(/Failed to fetch PTAX rate/);
  });

  it('throws on an empty response with no cached fallback', async () => {
    mockGet.mockResolvedValue({ data: [] });
    const svc = new FxRateService();
    await expect(svc.getUsdBrlRate()).rejects.toThrow(/no PTAX data/);
  });

  it('throws on a non-numeric or non-positive rate', async () => {
    mockGet.mockResolvedValue({ data: [{ data: '17/06/2026', valor: 'not-a-number' }] });
    const svc = new FxRateService();
    await expect(svc.getUsdBrlRate()).rejects.toThrow(/invalid PTAX rate/);
  });
});
