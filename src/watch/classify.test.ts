import { describe, expect, test } from 'bun:test';
import { defaultClassify, defaultClassifier } from './classify.js';
import { GROUP_NAMES } from './types.js';
import type { EdinetDbEvent } from '../tools/finance/events.js';

function ev(overrides: Partial<EdinetDbEvent> = {}): EdinetDbEvent {
  return {
    event_id: 'e1',
    event_date: '2026-09-20',
    event_type: 'unknown_type',
    event_category: 'misc',
    severity: 'low',
    edinet_code: 'E00001',
    sec_code: '1234',
    filer_name: 'X',
    title: 't',
    detected_at: '2026-09-20T00:00:00.000000Z',
    event_timestamp: null,
    fiscal_year: null,
    quarter: null,
    source: null,
    source_id: null,
    corrects_event_id: null,
    summary: null,
    metadata: null,
    ...overrides,
  };
}

describe('defaultClassify', () => {
  test('control markers (delisting, tender offer, merger) map to group 3', () => {
    expect(defaultClassify(ev({ event_type: 'delisting_notice' })).group).toBe(3);
    expect(defaultClassify(ev({ event_type: 'tender_offer_announcement' })).group).toBe(3);
    expect(defaultClassify(ev({ event_type: 'business_combination' })).group).toBe(3);
    expect(defaultClassify(ev({ event_type: 'going_concern_doubt' })).group).toBe(3);
  });

  test('decision markers (forecast revision, dividend, buyback) map to group 2', () => {
    expect(defaultClassify(ev({ event_type: 'earnings_forecast_revision' })).group).toBe(2);
    expect(defaultClassify(ev({ event_type: 'dividend_forecast_revision' })).group).toBe(2);
    expect(defaultClassify(ev({ event_type: 'buyback_announcement' })).group).toBe(2);
    expect(defaultClassify(ev({ event_type: 'extraordinary_loss_recognized' })).group).toBe(2);
  });

  test('org markers (officer change) map to group 1', () => {
    expect(defaultClassify(ev({ event_type: 'officer_change' })).group).toBe(1);
    expect(defaultClassify(ev({ event_type: 'representative_change' })).group).toBe(1);
  });

  test('unknown event types default to group 0 (safe side, never over-promoted)', () => {
    expect(defaultClassify(ev({ event_type: 'totally_unknown_thing_never_seen' })).group).toBe(0);
    expect(defaultClassify(ev({ event_type: '' })).group).toBe(0);
  });

  test('low-priority markers (completion, correction, filing) always win to group 0, even alongside a decision-shaped word', () => {
    // "buyback" alone would be a decision marker (group 2), but "completion" must dominate:
    // a completion/progress report is not the decision itself.
    expect(defaultClassify(ev({ event_type: 'buyback_completion_report' })).group).toBe(0);
    expect(defaultClassify(ev({ event_type: 'earnings_summary' })).group).toBe(0);
    expect(defaultClassify(ev({ event_type: 'correction_of_annual_report' })).group).toBe(0);
  });

  test('classification includes source: "default"', () => {
    expect(defaultClassify(ev()).source).toBe('default');
  });

  test('matching also considers event_category', () => {
    expect(defaultClassify(ev({ event_type: 'unspecified', event_category: 'merger_related' })).group).toBe(3);
  });

  test('defaultClassifier.classify delegates to defaultClassify', () => {
    const result = defaultClassifier.classify(ev({ event_type: 'officer_change' }));
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as { group: unknown }).group).toBe(1);
  });

  test('GROUP_NAMES has exactly 4 entries and matches design v0 §5 verbatim', () => {
    expect(GROUP_NAMES).toEqual([
      '経過・完了の報告',
      '組織・人事・軽微な取引',
      '業績予想・配当・自己株式・特別損益などの決定',
      '支配・上場・存続に関わる事項',
    ]);
  });
});
