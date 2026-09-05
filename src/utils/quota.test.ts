import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { assertEdinetQuota, getDailyLimit, todayKey } from './quota.js';

const QUOTA_FILE = '.dexter/edinet-quota.json';

function writeState(date: string, count: number): void {
  mkdirSync('.dexter', { recursive: true });
  writeFileSync(QUOTA_FILE, JSON.stringify({ date, count }));
}

function readState(): { date: string; count: number } {
  return JSON.parse(readFileSync(QUOTA_FILE, 'utf-8'));
}

describe('assertEdinetQuota', () => {
  beforeEach(() => {
    if (existsSync(QUOTA_FILE)) {
      rmSync(QUOTA_FILE);
    }
    delete process.env.EDINETDB_DAILY_LIMIT;
  });

  afterEach(() => {
    if (existsSync(QUOTA_FILE)) {
      rmSync(QUOTA_FILE);
    }
    delete process.env.EDINETDB_DAILY_LIMIT;
  });

  test('increments the count on each call', () => {
    assertEdinetQuota('/test/');
    assertEdinetQuota('/test/');
    expect(readState().count).toBe(2);
  });

  test('resets the count when the stored date is not today', () => {
    writeState('2000-01-01', 99);
    assertEdinetQuota('/test/');
    expect(readState().count).toBe(1);
  });

  test('blocks once the daily limit is reached', () => {
    writeState(todayKey(), getDailyLimit());
    expect(() => assertEdinetQuota('/test/')).toThrow();
    // ブロックされた呼び出しはカウントに加算しない
    expect(readState().count).toBe(getDailyLimit());
  });

  test('EDINETDB_DAILY_LIMIT overrides the default 100', () => {
    process.env.EDINETDB_DAILY_LIMIT = '3';
    expect(getDailyLimit()).toBe(3);
    writeState(todayKey(), 3);
    expect(() => assertEdinetQuota('/test/')).toThrow();
  });
});
