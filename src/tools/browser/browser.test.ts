/**
 * Chromium 不在の検知（T7a）。
 *
 * `DEXTER_SKIP_BROWSER=1` で `bun install` した利用者が browser ツールを初めて
 * 使う時、playwright の生の "Executable doesn't exist" を返すのではなく、
 * 直し方（`DEXTER_SKIP_BROWSER` を外して再インストール、または
 * `playwright install chromium`）を案内する（design v0 §3「脱落の手当て」）。
 *
 * `playwright` パッケージを丸ごとモックし、実際の Chromium 起動はしない。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { browserTool } from './browser.js';

const PLAYWRIGHT_MISSING_EXECUTABLE_MESSAGE = [
  "browserType.launch: Executable doesn't exist at /fake/ms-playwright/chromium-9999/chrome-mac/Chromium.app",
  '╔═════════════════════════════════════════════════════════════════════════╗',
  '║ Looks like Playwright Test or Playwright was just installed or updated. ║',
  '╚═════════════════════════════════════════════════════════════════════════╝',
].join('\n');

describe('browser tool — Chromium 不在の検知', () => {
  beforeEach(() => {
    mock.module('playwright', () => ({
      chromium: {
        launch: async () => {
          throw new Error(PLAYWRIGHT_MISSING_EXECUTABLE_MESSAGE);
        },
      },
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test('navigate は「DEXTER_SKIP_BROWSER を外す / playwright install」を案内するエラーを返す', async () => {
    const result = await browserTool.invoke({ action: 'navigate', url: 'https://example.com' });
    const text = typeof result === 'string' ? result : JSON.stringify(result);

    expect(text).not.toContain("Executable doesn't exist");
    expect(text).toContain('DEXTER_SKIP_BROWSER');
    expect(text).toContain('playwright install chromium');
  });

  test('snapshot でも同じ案内が出る（ensureBrowser を通る全アクション共通）', async () => {
    const result = await browserTool.invoke({ action: 'snapshot' });
    const text = typeof result === 'string' ? result : JSON.stringify(result);

    expect(text).toContain('DEXTER_SKIP_BROWSER');
  });
});
