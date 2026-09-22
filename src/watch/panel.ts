/**
 * `/watch` のパネル組み立てと表示テキスト。design §4.2「基本の表示は開示の種別+公表時刻。
 * Judge は開示の性質で 4 群に分ける…群は見出しにだけ使い、どの群も捨てない（経過の報告は
 * 件数 + `/watch all`）。『要確認』は最上段…タイトルだけで分けている旨を表示」。
 *
 * ★ upstream の `severity` はこのファイルのどの関数にも入力として渡していない
 * （`WatchEventLine` は `severity` を持たない型）。取り違えて足すと型エラーで気付ける上、
 * `panel.test.ts` の走査テストでも固定する。
 *
 * ★ `title` は必ず `quote()` で包む（guard/output-linter.ts）。有報と違い開示タイトルは
 * 短い一文字列なので、包み忘れても気付きにくい = ここを両便で唯一 title を触る場所にする。
 */
import { quote, type QuotedText } from '../guard/output-linter.js';
import type { EdinetDbEvent } from '../tools/finance/events.js';
import { defaultClassifier } from './classify.js';
import { deepLinksFor, type DeepLink } from '../links/deeplink.js';
import { matchWatchlist, watchlistEntryLabel } from './watchlist.js';
import { GROUP_NAMES, type EventClassifier, type Group, type GroupIndex, type Watchlist, type WatchlistEntry } from './types.js';

export const CLASSIFICATION_NOTE =
  '分類は開示の種別とタイトルだけに基づく機械的な仕分けです。当社が内容の軽重を判断したものではありません。';

/** 1 件の開示の表示行。design「基本の表示は開示の種別 + 公表時刻」。`severity` を持たない。 */
export interface WatchEventLine {
  eventId: string;
  eventType: string;
  /** ISO8601（`detected_at`）。design「公表時刻」に対応する当社が持つ唯一の時刻。 */
  publishedAt: string;
  title: QuotedText;
  filerName: string;
  group: Group;
  classificationSource: string;
}

export interface WatchGroupSection {
  index: GroupIndex;
  name: string;
  count: number;
  /** `index !== 0 || all` のときだけ埋まる。それ以外（既定の group0）は `[]` で件数だけ見せる。 */
  lines: WatchEventLine[];
  collapsed: boolean;
}

export interface WatchTickerSection {
  label: string;
  events: WatchEventLine[];
  deepLinks: DeepLink[];
}

export interface WatchPanel {
  generatedAt: string;
  windowSince: string;
  windowUntil?: string;
  /** 「未取得あり」。design §4.2「届かなければ『未取得あり』」。 */
  incomplete: boolean;
  classificationNote: string;
  /** 「要確認」（Score の最大確率 < 0.5）。既定分類器では常に空。 */
  uncertain: WatchEventLine[];
  /** 常に 4 要素（index 0..3）。どの群も配列から欠けない。 */
  groups: WatchGroupSection[];
  byTicker: WatchTickerSection[];
  /** ウォッチリスト読み込み時の注記（未登録・不正エントリ 等）。 */
  watchlistIssues: string[];
}

export interface BuildWatchPanelOptions {
  /** `/watch all`。既定 false = group0 は件数だけ。 */
  all?: boolean;
  incomplete: boolean;
  windowSince: string;
  windowUntil?: string;
  watchlistIssues?: string[];
  classifier?: EventClassifier;
  /** テスト注入用の時計。 */
  now?: () => string;
}

function toEventLine(event: EdinetDbEvent, classification: { group: Group; source: string }): WatchEventLine {
  return {
    eventId: event.event_id,
    eventType: event.event_type,
    publishedAt: event.detected_at,
    // ★ title は必ず quote() で包む（包まないと有報/開示タイトル中の語で linter が発火する。
    //   逆に包めば芯の証拠を捨てずに linter を通せる。panel.test.ts の対テストで固定）。
    title: quote(event.title, { source: 'edinetdb-events' }),
    filerName: event.filer_name,
    group: classification.group,
    classificationSource: classification.source,
    // event.severity は意図的にここに入れない（design §4.2「upstream の severity を
    // 記録 JSON・表示・ログに通さない」）。
  };
}

function emptyGroups(): WatchGroupSection[] {
  return [0, 1, 2, 3].map((index) => ({
    index: index as GroupIndex,
    name: GROUP_NAMES[index],
    count: 0,
    lines: [],
    collapsed: false,
  }));
}

/**
 * 一致した開示から `WatchPanel` を組み立てる。`events` はウォッチリストと未突合のまま渡してよい
 * （このファイルが `matchWatchlist` で突合する）。ウォッチリストに一致しない開示は
 * パネルに現れない（`/watch` はウォッチリスト限定の機能のため）。
 */
export async function buildWatchPanel(
  events: readonly EdinetDbEvent[],
  watchlist: Watchlist,
  opts: BuildWatchPanelOptions,
): Promise<WatchPanel> {
  const classifier = opts.classifier ?? defaultClassifier;
  const now = opts.now ?? (() => new Date().toISOString());
  const all = opts.all ?? false;

  const groups = emptyGroups();
  const uncertain: WatchEventLine[] = [];
  const byTickerMap = new Map<string, { entry: WatchlistEntry; events: WatchEventLine[] }>();

  for (const event of events) {
    const matches = matchWatchlist(event, watchlist);
    if (matches.length === 0) {
      continue;
    }

    const classification = await classifier.classify(event);
    const line = toEventLine(event, classification);

    if (classification.group === 'uncertain') {
      uncertain.push(line);
    } else {
      const section = groups[classification.group];
      section.count += 1;
      if (section.index !== 0 || all) {
        section.lines.push(line);
      }
    }

    for (const entry of matches) {
      const label = watchlistEntryLabel(entry);
      const bucket = byTickerMap.get(label) ?? { entry, events: [] };
      bucket.events.push(line);
      byTickerMap.set(label, bucket);
    }
  }

  for (const section of groups) {
    section.collapsed = section.index === 0 && !all;
  }

  const byTicker: WatchTickerSection[] = [...byTickerMap.entries()].map(([label, bucket]) => ({
    label,
    events: bucket.events,
    deepLinks: deepLinksFor(bucket.entry),
  }));

  return {
    generatedAt: now(),
    windowSince: opts.windowSince,
    windowUntil: opts.windowUntil,
    incomplete: opts.incomplete,
    classificationNote: CLASSIFICATION_NOTE,
    uncertain,
    groups,
    byTicker,
    watchlistIssues: opts.watchlistIssues ?? [],
  };
}

function formatLine(line: WatchEventLine): string {
  return `  - [${line.publishedAt}] ${line.eventType} — ${line.filerName}: ${line.title.text}`;
}

/**
 * 人間向けの表示テキストを組み立てる（`panel` は既に `assertOutputClean` を通した前提。
 * ここでは `quote().text` を素直に展開する — 検査はパネル構築側で済んでいるので
 * ここで二重にやらない。呼び出し側は `assertOutputClean(panel, 'watch.panel')` を
 * `buildWatchPanel` の結果に対して先に実行してからこの関数を呼ぶこと）。
 */
export function renderWatchPanel(panel: WatchPanel): string {
  const lines: string[] = [];
  lines.push(`検索範囲: ${panel.windowSince} 〜 ${panel.windowUntil ?? '(今日まで)'}`);
  if (panel.incomplete) {
    lines.push('※ 未取得あり（ページ上限に達したため、この窓の一部は次回に持ち越します）');
  }
  for (const issue of panel.watchlistIssues) {
    lines.push(`※ ${issue}`);
  }
  lines.push('');

  if (panel.uncertain.length > 0) {
    lines.push('## 要確認');
    for (const line of panel.uncertain) lines.push(formatLine(line));
    lines.push('');
  }

  // 表示順: 支配・上場・存続 → 業績予想等の決定 → 組織・人事 → 経過・完了の報告（既定は件数のみ）
  for (const index of [3, 2, 1, 0] as const) {
    const section = panel.groups[index];
    lines.push(`## ${section.name}（${section.count}件）`);
    if (section.collapsed) {
      lines.push(`  （詳細は非表示。全件見るには /watch all）`);
    } else {
      for (const line of section.lines) lines.push(formatLine(line));
    }
    lines.push('');
  }

  if (panel.byTicker.length > 0) {
    lines.push('## 銘柄別リンク');
    for (const ticker of panel.byTicker) {
      lines.push(`### ${ticker.label}`);
      for (const link of ticker.deepLinks) lines.push(`  ${link.label}: ${link.url}`);
    }
    lines.push('');
  }

  lines.push(panel.classificationNote);

  return lines.join('\n');
}
