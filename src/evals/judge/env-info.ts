/**
 * 実行環境の記録（合格基準「出力に n・日付・実行環境（モデル名、バックエンド名、
 * ホスト OS / bun のバージョン）」の実行環境部分）。
 * モデル名・バックエンド名は各バックエンドの結果側（bench.ts の BenchBackendResult）に載る。
 */
import os from 'node:os';

export interface RuntimeEnvInfo {
  host: string;
  platform: string;
  /** bun のバージョン。bun 以外のランタイムで実行された場合は undefined。 */
  bunVersion?: string;
  nodeVersion: string;
}

export interface CollectRuntimeEnvSources {
  hostname?: () => string;
  platform?: string;
  versions?: { bun?: string; node: string };
}

/** 実際の `os` / `process` から実行環境を集める。テストは `sources` を注入して呼ぶ。 */
export function collectRuntimeEnv(sources: CollectRuntimeEnvSources = {}): RuntimeEnvInfo {
  const hostname = sources.hostname ?? (() => os.hostname());
  const platform = sources.platform ?? process.platform;
  const versions = sources.versions ?? process.versions;

  return {
    host: hostname(),
    platform,
    bunVersion: versions.bun,
    nodeVersion: versions.node,
  };
}
