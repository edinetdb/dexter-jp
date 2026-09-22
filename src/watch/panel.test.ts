import { describe, expect, test } from 'bun:test';
import { assertOutputClean, lintOutput, quote } from '../guard/output-linter.js';
import { buildWatchPanel, renderWatchPanel, CLASSIFICATION_NOTE } from './panel.js';
import { GROUP_NAMES } from './types.js';
import type { EdinetDbEvent } from '../tools/finance/events.js';
import type { EventClassifier, Watchlist } from './types.js';

function ev(overrides: Partial<EdinetDbEvent> = {}): EdinetDbEvent {
  return {
    event_id: 'e-' + Math.random().toString(36).slice(2),
    event_date: '2026-09-20',
    event_type: 'officer_change',
    event_category: 'governance',
    severity: 'critical',
    edinet_code: 'E02144',
    sec_code: '7203',
    filer_name: 'トヨタ自動車',
    title: '役員の異動に関するお知らせ',
    detected_at: '2026-09-20T01:23:45.000000Z',
    event_timestamp: null,
    fiscal_year: 2026,
    quarter: null,
    source: 'edinet',
    source_id: null,
    corrects_event_id: null,
    summary: null,
    metadata: null,
    ...overrides,
  };
}

const toyotaWatchlist: Watchlist = {
  entries: [{ label: 'トヨタ自動車', secCode: '7203', edinetCode: 'E02144' }],
};

const unlistedWatchlist: Watchlist = {
  entries: [{ label: '非上場社', edinetCode: 'E99999' }],
};

describe('buildWatchPanel', () => {
  test('basic display: shows event type and published time (detected_at)', async () => {
    const panel = await buildWatchPanel(
      [ev({ event_type: 'officer_change', detected_at: '2026-09-20T01:23:45.000000Z' })],
      toyotaWatchlist,
      { incomplete: false, windowSince: '2026-09-15' },
    );
    const line = panel.groups[1].lines[0];
    expect(line.eventType).toBe('officer_change');
    expect(line.publishedAt).toBe('2026-09-20T01:23:45.000000Z');
  });

  test('groups: always exactly 4 sections, names match design v0 §5 verbatim', async () => {
    const panel = await buildWatchPanel([], toyotaWatchlist, { incomplete: false, windowSince: 's' });
    expect(panel.groups.map((g) => g.name)).toEqual([...GROUP_NAMES]);
    expect(panel.groups.map((g) => g.index)).toEqual([0, 1, 2, 3]);
  });

  test('★ group 0 ("経過・完了の報告") is never dropped when all=false — only collapsed to a count, other groups stay fully expanded', async () => {
    const events = [
      ev({ event_type: 'earnings_summary' }), // group 0
      ev({ event_type: 'officer_change' }), // group 1
      ev({ event_type: 'buyback_announcement' }), // group 2
      ev({ event_type: 'tender_offer_announcement' }), // group 3
    ];
    const panel = await buildWatchPanel(events, toyotaWatchlist, {
      incomplete: false,
      windowSince: 's',
      all: false,
    });

    expect(panel.groups).toHaveLength(4);
    expect(panel.groups[0].count).toBe(1);
    expect(panel.groups[0].lines).toEqual([]); // collapsed, not dropped
    expect(panel.groups[0].collapsed).toBe(true);
    expect(panel.groups[1].count).toBe(1);
    expect(panel.groups[1].lines).toHaveLength(1);
    expect(panel.groups[1].collapsed).toBe(false);
    expect(panel.groups[2].lines).toHaveLength(1);
    expect(panel.groups[3].lines).toHaveLength(1);
  });

  test('/watch all expands group 0 to full detail too', async () => {
    const events = [ev({ event_type: 'earnings_summary' }), ev({ event_type: 'earnings_summary' })];
    const panel = await buildWatchPanel(events, toyotaWatchlist, { incomplete: false, windowSince: 's', all: true });
    expect(panel.groups[0].count).toBe(2);
    expect(panel.groups[0].lines).toHaveLength(2);
    expect(panel.groups[0].collapsed).toBe(false);
  });

  test('★ upstream severity never appears anywhere in the built panel (design: never pass severity through to record/display/log)', async () => {
    const events = [ev({ severity: 'critical' }), ev({ severity: 'high' })];
    const panel = await buildWatchPanel(events, toyotaWatchlist, { incomplete: false, windowSince: 's' });
    const json = JSON.stringify(panel).toLowerCase();
    expect(json.includes('severity')).toBe(false);
    expect(json.includes('critical')).toBe(false);
    // 'high' alone is too common a substring to be a safe negative-assertion target
    // (could appear in unrelated words); severity is checked structurally instead:
    const anyLineHasSeverityKey = panel.groups.some((g) => g.lines.some((l) => 'severity' in l));
    expect(anyLineHasSeverityKey).toBe(false);
  });

  test('uncertain classifier output ("要確認") is bucketed separately, not counted in any of the 4 groups', async () => {
    const uncertainClassifier: EventClassifier = {
      classify: () => ({ group: 'uncertain', source: 'jev' }),
    };
    const panel = await buildWatchPanel([ev()], toyotaWatchlist, {
      incomplete: false,
      windowSince: 's',
      classifier: uncertainClassifier,
    });
    expect(panel.uncertain).toHaveLength(1);
    expect(panel.groups.every((g) => g.count === 0)).toBe(true);
  });

  test('events that match no watchlist entry are dropped from the panel entirely', async () => {
    const panel = await buildWatchPanel([ev({ sec_code: '9999', edinet_code: 'E00000' })], toyotaWatchlist, {
      incomplete: false,
      windowSince: 's',
    });
    expect(panel.groups.every((g) => g.count === 0)).toBe(true);
    expect(panel.byTicker).toEqual([]);
  });

  test('byTicker: entry with secCode+edinetCode gets 2 deep links; edinet-only entry gets 1', async () => {
    const panelToyota = await buildWatchPanel([ev()], toyotaWatchlist, { incomplete: false, windowSince: 's' });
    expect(panelToyota.byTicker).toHaveLength(1);
    expect(panelToyota.byTicker[0].deepLinks).toHaveLength(2);

    const panelUnlisted = await buildWatchPanel(
      [ev({ sec_code: null, edinet_code: 'E99999' })],
      unlistedWatchlist,
      { incomplete: false, windowSince: 's' },
    );
    expect(panelUnlisted.byTicker).toHaveLength(1);
    expect(panelUnlisted.byTicker[0].deepLinks).toHaveLength(1);
    expect(panelUnlisted.byTicker[0].deepLinks[0].url).toContain('edinetdb.jp');
  });

  test('incomplete flag and watchlistIssues pass straight through to the panel', async () => {
    const panel = await buildWatchPanel([], toyotaWatchlist, {
      incomplete: true,
      windowSince: 's',
      watchlistIssues: ['issue 1'],
    });
    expect(panel.incomplete).toBe(true);
    expect(panel.watchlistIssues).toEqual(['issue 1']);
  });

  test('classificationNote states the classification is title/type-only ("タイトルだけで分けている旨")', async () => {
    const panel = await buildWatchPanel([], toyotaWatchlist, { incomplete: false, windowSince: 's' });
    expect(panel.classificationNote).toBe(CLASSIFICATION_NOTE);
    expect(panel.classificationNote).toContain('タイトル');
    // The note itself must be clean (it's part of our own generated output).
    expect(lintOutput(panel.classificationNote).clean).toBe(true);
  });

  test('★ title text is wrapped in quote() so a valuation-list word in the upstream title does not trip the linter', async () => {
    const events = [ev({ title: '自己株式の取得により割安な水準を是正します' })];
    const panel = await buildWatchPanel(events, toyotaWatchlist, { incomplete: false, windowSince: 's' });
    // Must not throw: the title carries a banned word ('割安') but is quoted, so the
    // structural linter walk() skips it (guard/output-linter.ts: isQuoted() short-circuit).
    expect(() => assertOutputClean(panel, 'watch.panel')).not.toThrow();
    const line = panel.groups[1].lines[0];
    expect(line.title).toEqual(quote('自己株式の取得により割安な水準を是正します', { source: 'edinetdb-events' }));
  });

  test('★ (paired, discrimination proof) the same banned word DOES trip the linter when NOT wrapped in quote() — proves the quote-skip in the previous test is discriminating, not a blanket pass', () => {
    const unwrappedPanel = {
      summary: '自己株式の取得により割安な水準を是正します', // plain string, not quote()
    };
    const result = lintOutput(unwrappedPanel);
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.term === '割安')).toBe(true);
  });
});

describe('renderWatchPanel', () => {
  test('basic text includes event type, published time, group names, and the classification note', async () => {
    const events = [ev({ event_type: 'officer_change', detected_at: '2026-09-20T01:23:45.000000Z' })];
    const panel = await buildWatchPanel(events, toyotaWatchlist, { incomplete: false, windowSince: '2026-09-15' });
    const text = renderWatchPanel(panel);

    expect(text).toContain('officer_change');
    expect(text).toContain('2026-09-20T01:23:45.000000Z');
    expect(text).toContain('組織・人事・軽微な取引');
    expect(text).toContain(CLASSIFICATION_NOTE);
  });

  test('incomplete window renders a "未取得あり" note', async () => {
    const panel = await buildWatchPanel([], toyotaWatchlist, { incomplete: true, windowSince: 's' });
    expect(renderWatchPanel(panel)).toContain('未取得あり');
  });

  test('collapsed group 0 renders a pointer to /watch all, not the full list', async () => {
    const panel = await buildWatchPanel([ev({ event_type: 'earnings_summary' })], toyotaWatchlist, {
      incomplete: false,
      windowSince: 's',
      all: false,
    });
    const text = renderWatchPanel(panel);
    expect(text).toContain('/watch all');
  });

  test('deep links for a matched ticker are rendered', async () => {
    const panel = await buildWatchPanel([ev()], toyotaWatchlist, { incomplete: false, windowSince: 's' });
    const text = renderWatchPanel(panel);
    expect(text).toContain('https://jp.tradingview.com/symbols/TSE-7203/');
    expect(text).toContain('https://edinetdb.jp/companies/E02144?utm_source=dexter-cli');
  });

  test('rendered text shows the upstream title verbatim, including words banned in our own generated strings (quotes are for the display to the user, not for suppressing legitimate source text)', async () => {
    const events = [ev({ title: '自己株式の取得により割安な水準を是正します' })];
    const panel = await buildWatchPanel(events, toyotaWatchlist, { incomplete: false, windowSince: 's' });
    expect(renderWatchPanel(panel)).toContain('割安');
  });
});
