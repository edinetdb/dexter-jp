/**
 * 判定層バッチの予算トラッカー。
 * 設計 §4.1: 判定リクエストは再試行込みで 200 回まで / 入力トークン合計 15 万まで / 全体 90 秒で打ち切り。
 * 超えたら途中結果 +「上限到達・未検査 n 段落」を返す。
 */
import type { JudgeUsage } from './types.js';

export interface BudgetLimits {
  maxRequests: number;
  maxInputTokens: number;
  maxWallClockMs: number;
  /** テスト注入用の時計。省略時は Date.now。 */
  now?: () => number;
}

export class BudgetTracker {
  private requestCount = 0;
  private inputTokens = 0;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly limits: BudgetLimits;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
    this.now = limits.now ?? Date.now;
    this.startedAt = this.now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  isExhausted(): boolean {
    return (
      this.requestCount >= this.limits.maxRequests ||
      this.inputTokens >= this.limits.maxInputTokens ||
      this.elapsedMs >= this.limits.maxWallClockMs
    );
  }

  /**
   * 1 回の判定リクエスト試行（再試行も含む）の予算を予約する。
   * 予算が尽きていれば増やさずに false を返す。呼ぶたびに再試行分もカウントする
   * ＝ ここを経由しない再試行を作ると 200 回の上限が効かなくなる。
   */
  tryReserveRequest(): boolean {
    if (this.isExhausted()) return false;
    this.requestCount++;
    return true;
  }

  addInputTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) this.inputTokens += n;
  }

  usage(): JudgeUsage {
    return {
      requestCount: this.requestCount,
      inputTokens: this.inputTokens,
      elapsedMs: this.elapsedMs,
    };
  }
}

export const DEFAULT_CONCURRENCY = 16;
export const DEFAULT_MAX_REQUESTS = 200;
export const DEFAULT_MAX_INPUT_TOKENS = 150_000;
export const DEFAULT_MAX_WALL_CLOCK_MS = 90_000;
export const DEFAULT_MAX_RETRIES = 2;
