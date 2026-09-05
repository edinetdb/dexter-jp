import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { api } from './api.js';

// ---------------------------------------------------------------------------
// Cursor pagination: api.get must follow next_page_url until absent and
// return one merged document, so every tool and the cache always see the
// complete result set.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let requestedUrls: string[] = [];
let responses: Record<string, unknown>[] = [];

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  requestedUrls = [];
  responses = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrls.push(String(url));
    const body = responses.shift();
    if (!body) {
      throw new Error('test received more requests than stubbed responses');
    }
    return jsonResponse(body);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('api.get pagination', () => {
  test('follows next_page_url to the end and concatenates record arrays', async () => {
    responses = [
      { prices: [{ time: '2024-01-01' }, { time: '2024-01-02' }], next_page_url: 'https://api.financialdatasets.ai/prices/?cursor=page2' },
      { prices: [{ time: '2024-01-03' }], next_page_url: 'https://api.financialdatasets.ai/prices/?cursor=page3' },
      { prices: [{ time: '2024-01-04' }] },
    ];

    const { data } = await api.get('/prices/', { ticker: 'AAPL' });

    expect((data.prices as unknown[]).length).toBe(4);
    // Pages 2+ request the returned URL verbatim — never re-derived from params.
    expect(requestedUrls[1]).toBe('https://api.financialdatasets.ai/prices/?cursor=page2');
    expect(requestedUrls[2]).toBe('https://api.financialdatasets.ai/prices/?cursor=page3');
  });

  test('strips next_page_url from the merged document', async () => {
    responses = [
      { prices: [{ time: '2024-01-01' }], next_page_url: 'https://api.financialdatasets.ai/prices/?cursor=page2' },
      { prices: [{ time: '2024-01-02' }] },
    ];

    const { data } = await api.get('/prices/', { ticker: 'AAPL' });

    expect('next_page_url' in data).toBe(false);
  });

  test('merges the nested /financials/ envelope arrays in lockstep', async () => {
    responses = [
      {
        financials: {
          income_statements: [{ report_period: '2024-03-31' }],
          balance_sheets: [{ report_period: '2024-03-31' }],
          cash_flow_statements: [{ report_period: '2024-03-31' }],
        },
        next_page_url: 'https://api.financialdatasets.ai/financials/?cursor=page2',
      },
      {
        financials: {
          income_statements: [{ report_period: '2023-12-31' }],
          balance_sheets: [{ report_period: '2023-12-31' }],
          cash_flow_statements: [{ report_period: '2023-12-31' }],
        },
      },
    ];

    const { data } = await api.get('/financials/', { ticker: 'AAPL', limit: 20 });

    const financials = data.financials as Record<string, unknown[]>;
    expect(financials.income_statements.length).toBe(2);
    expect(financials.balance_sheets.length).toBe(2);
    expect(financials.cash_flow_statements.length).toBe(2);
  });

  test('a single-page response makes exactly one request', async () => {
    responses = [{ snapshot: { price: 123.45 } }];

    const { data } = await api.get('/prices/snapshot/', { ticker: 'AAPL' });

    expect(requestedUrls.length).toBe(1);
    expect((data.snapshot as Record<string, unknown>).price).toBe(123.45);
  });
});
