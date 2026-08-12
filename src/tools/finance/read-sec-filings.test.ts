import { describe, test, expect, mock, afterEach, afterAll } from 'bun:test';

// sec-edgar-client.js / model/llm.js をモックしてから read-sec-filings.js を
// importする(bun:testのmock.moduleはimport解決前に登録する必要がある)。
const resolveTickerToCikMock = mock(async (ticker: string) => {
  if (ticker.toUpperCase() === 'JPM') {
    return { cik: '0000019617', title: 'JPMORGAN CHASE & CO' };
  }
  return null;
});

const getRecentFilingsMock = mock(async () => [
  {
    form: '10-K',
    filingDate: '2026-02-13',
    accessionNumber: '0001628280-26-008131',
    primaryDocument: 'jpm-20251231.htm',
    documentUrl: 'https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm',
  },
]);

const callLlmMock = mock(async (prompt: string, _options?: { model: string }) => ({
  response: { content: `SUMMARIZED(${prompt.length} chars input)` },
}));

mock.module('./sec-edgar-client.js', () => ({
  resolveTickerToCik: resolveTickerToCikMock,
  getRecentFilings: getRecentFilingsMock,
}));

mock.module('../../model/llm.js', () => ({
  callLlm: callLlmMock,
}));

const { createReadSecFilings } = await import('./read-sec-filings.js');

// mock.module()はプロセス全体のモジュールレジストリを書き換えるため、
// このファイルのテストが終わってもmock.restore()しないと同時実行される
// 他のテストファイル(例: sec-edgar-client.test.ts)が本物ではなくこの
// モック版のsec-edgar-client.jsを読み込んでしまう(実際に発生を確認した
// クロスファイル汚染)。afterAllで確実に元へ戻す。
afterAll(() => {
  mock.restore();
});

// SEC EDGARの本文HTML取得(グローバルfetch)はテストごとに差し替える。
function mockDocumentFetch(html: string) {
  return mock(async () => new Response(html, { status: 200, statusText: 'OK' }));
}

async function invoke(tool: ReturnType<typeof createReadSecFilings>, input: Record<string, unknown>) {
  const raw = await tool.invoke(input as never);
  return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
}

describe('read_sec_filings tool', () => {
  afterEach(() => {
    resolveTickerToCikMock.mockClear();
    getRecentFilingsMock.mockClear();
    callLlmMock.mockClear();
  });

  test('returns an error for an unresolvable ticker', async () => {
    const tool = createReadSecFilings('test-model');
    const parsed = await invoke(tool, { ticker: 'NOTREAL' });
    expect(parsed.data.error).toContain('Could not find US ticker');
  });

  test('extracts a short section without invoking the summarizer', async () => {
    globalThis.fetch = mockDocumentFetch(
      '<p>Item 1A. Risk Factors</p><p>Short risk content.</p><p>Item 1B.</p>',
    ) as unknown as typeof fetch;

    const tool = createReadSecFilings('test-model');
    const parsed = await invoke(tool, { ticker: 'JPM', form: '10-K', section: 'risk_factors' });

    expect(parsed.data.companyName).toBe('JPMORGAN CHASE & CO');
    expect(parsed.data.form).toBe('10-K');
    expect(parsed.data.sections.risk_factors).toContain('Short risk content.');
    expect(callLlmMock).not.toHaveBeenCalled();
    expect(parsed.sourceUrls).toEqual([
      'https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm',
    ]);
  });

  test('summarizes a section that exceeds the length threshold, using the caller-provided model', async () => {
    const longContent = 'x'.repeat(25_000); // MAX_SECTION_MARKDOWN_LENGTH(20,000)を超える
    globalThis.fetch = mockDocumentFetch(
      `<p>Item 1A. Risk Factors</p><p>${longContent}</p><p>Item 1B.</p>`,
    ) as unknown as typeof fetch;

    const tool = createReadSecFilings('microsoft/phi-4');
    const parsed = await invoke(tool, { ticker: 'JPM', form: '10-K', section: 'risk_factors' });

    expect(callLlmMock).toHaveBeenCalledTimes(1);
    // 2026-08-12に修正したバグの回帰テスト: getFastModel/resolveProviderを
    // 経由せず、呼び出し元のmodel('microsoft/phi-4')がそのままcallLlmへ
    // 渡ることを確認する(以前はproviders.tsのfastModel、例えば
    // 'gpt-5.4-mini'のようなクラウド専用名に化けてローカルLM Studioで
    // 400エラーになっていた)。
    const callArgs = callLlmMock.mock.calls[0];
    const options = callArgs[1] as { model: string };
    expect(options.model).toBe('microsoft/phi-4');
    expect(parsed.data.sections.risk_factors).toContain('SUMMARIZED');
  });

  test('reports missing sections without failing the whole call', async () => {
    globalThis.fetch = mockDocumentFetch('<p>No Item headers in this document at all.</p>') as unknown as typeof fetch;

    const tool = createReadSecFilings('test-model');
    const parsed = await invoke(tool, { ticker: 'JPM', form: '10-K', section: 'risk_factors' });

    expect(parsed.data.error).toContain('Could not extract');
    expect(parsed.data.missing).toEqual(['risk_factors']);
  });

  test('defaults to 10-K when form is omitted', async () => {
    globalThis.fetch = mockDocumentFetch(
      '<p>Item 1. Business</p><p>Biz content.</p><p>Item 1A. Risk Factors</p>',
    ) as unknown as typeof fetch;

    const tool = createReadSecFilings('test-model');
    await invoke(tool, { ticker: 'JPM' });

    expect(getRecentFilingsMock).toHaveBeenCalledWith('0000019617', ['10-K'], 1);
  });
});
