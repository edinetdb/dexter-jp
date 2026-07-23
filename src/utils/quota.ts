/**
 * EDINET DB API の日次呼び出し上限を管理する。
 *
 * Freeプランは100回/日までのため、既定値は100。
 * 上限に達した呼び出しはブロックし、logger.error + console.error でアラートを出す。
 * カウントは日付が変わるとリセットされる。
 *
 * 状態は .dexter/edinet-quota.json に永続化する（.dexter/* は既にgitignore対象）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from './logger.js';
import { dexterPath } from './paths.js';

interface QuotaState {
  date: string; // YYYY-MM-DD (ローカル日付)
  count: number;
}

const QUOTA_FILE = dexterPath('edinet-quota.json');

export function getDailyLimit(): number {
  const fromEnv = Number(process.env.EDINETDB_DAILY_LIMIT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100;
}

export function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function readQuotaState(): QuotaState {
  if (!existsSync(QUOTA_FILE)) {
    return { date: todayKey(), count: 0 };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(QUOTA_FILE, 'utf-8'));
    const obj = parsed as Record<string, unknown>;
    if (typeof obj?.date === 'string' && typeof obj?.count === 'number') {
      return { date: obj.date, count: obj.count };
    }
  } catch {
    // 壊れたファイルは無視して0件から再開する
  }
  return { date: todayKey(), count: 0 };
}

function writeQuotaState(state: QuotaState): void {
  try {
    const dir = dirname(QUOTA_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(QUOTA_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[EDINET DB quota] 状態保存に失敗しました: ${message}`);
  }
}

/**
 * EDINET DB への実際のネットワーク呼び出し直前に呼ぶ。
 * 本日分の上限に達している場合は Error を投げてリクエストをブロックする。
 */
export function assertEdinetQuota(label: string): void {
  const limit = getDailyLimit();
  const today = todayKey();
  let state = readQuotaState();

  if (state.date !== today) {
    state = { date: today, count: 0 };
  }

  if (state.count >= limit) {
    const message =
      `[EDINET DB] 本日のAPI呼び出し上限(${limit}回/日)に達したためブロックしました: ${label}\n` +
      `プランのアップグレード、または EDINETDB_DAILY_LIMIT の変更をご検討ください。`;
    logger.error(message);
    console.error(message);
    throw new Error(message);
  }

  state.count += 1;
  writeQuotaState(state);
}
