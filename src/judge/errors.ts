/** バックエンド呼び出しが失敗した時に投げるエラー。再試行してよいかで型を分ける。 */

/** 429・タイムアウト・ネットワーク断など、もう一度叩けば直りうる失敗。 */
export class RetryableJudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableJudgeError';
  }
}

/** 認証エラー・録画不在など、再試行しても直らない失敗。 */
export class NonRetryableJudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJudgeError';
  }
}

/** replay バックエンドで録画が見つからなかった時。実 API へは絶対に落ちない。 */
export class ReplayMissError extends NonRetryableJudgeError {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayMissError';
  }
}

/**
 * 入力ガードの追加票が取れなかった。
 *
 * `/check` はこれを捕まえて**走らせない**（go-decision G-A1 改定 2026-09-22）。
 * 名前を付ける理由 = 「判定層が使えない」と「実装のバグ」を呼び出し側で区別するため。
 * 素の Error だと `catch` で握り潰した時に、ガードが薄いまま走る状態と見分けがつかない。
 */
export class JudgeUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JudgeUnavailableError';
  }
}
