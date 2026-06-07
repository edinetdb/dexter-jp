import { describe, expect, test } from 'bun:test';
import {
  compactFinanceResult,
  getDeterministicCompanySnapshotRoute,
} from './get-financials.js';

describe('compactFinanceResult', () => {
  test('keeps company snapshots compact and adds packet diagnostics', () => {
    const result = compactFinanceResult('get_company_info', {
      name: 'Toyota Motor Corporation',
      sec_code: '7203',
      industry: '輸送用機器',
      giant_payload: [{ unused: true }],
      latest_financials: {
        fiscal_year: 2025,
        revenue: 48000000000000,
        operating_income: 4000000000000,
        per: 7.3,
        unused_field: 'drop me',
      },
    }) as Record<string, unknown>;
    const keyMetrics = result.key_metrics as Record<string, Record<string, unknown>>;

    expect(result.name).toBe('Toyota Motor Corporation');
    expect(result.sec_code).toBe('7203');
    expect(result.giant_payload).toBeUndefined();
    expect(result.latest_financials).toEqual({
      fiscal_year: 2025,
      revenue: 48000000000000,
      operating_income: 4000000000000,
      per: 7.3,
    });
    expect(keyMetrics.per).toEqual({
      label: 'PER (Price-to-Earnings Ratio) / 株価収益率',
      value: 7.3,
      unit: 'x',
      status: 'available',
      sourceField: 'latest_financials.per',
    });
    expect(keyMetrics.pbr).toEqual({
      label: 'PBR (Price-to-Book Ratio) / 株価純資産倍率',
      value: null,
      unit: 'x',
      status: 'unavailable',
      sourceField: 'latest_financials.pbr',
      note: 'PBR is not available in this company snapshot source. Do not infer PBR from PER.',
    });
    expect(keyMetrics.pbr.value).not.toBe(7.3);
    expect(result._packet).toEqual({
      packetType: 'company_snapshot',
      sourceTool: 'get_company_info',
      compacted: true,
      selectedFieldCount: 5,
    });
  });

  test('falls back to original data when compact extraction is unusable', () => {
    const original = {
      unexpected_payload: {
        still_needed: true,
      },
    };

    const result = compactFinanceResult('get_company_info', original) as Record<string, unknown>;

    expect(result.unexpected_payload).toEqual(original.unexpected_payload);
    expect(result).not.toEqual({});
    expect(result._packet).toEqual({
      packetType: 'company_snapshot',
      sourceTool: 'get_company_info',
      compacted: false,
      selectedFieldCount: 0,
      fallbackReason: 'compact_packet_unusable',
    });
  });
});

describe('getDeterministicCompanySnapshotRoute', () => {
  test('routes simple company overview and latest financials queries directly to get_company_info', () => {
    const route = getDeterministicCompanySnapshotRoute('トヨタの会社概要と直近の主要財務を簡単に確認して');

    expect(route).toEqual({
      tool: 'get_company_info',
      args: { ticker: '7203' },
    });
  });

  test('passes through unambiguous securities codes for snapshot queries', () => {
    const route = getDeterministicCompanySnapshotRoute('7203の会社概要と直近の主要財務を簡単に確認して');

    expect(route).toEqual({
      tool: 'get_company_info',
      args: { ticker: '7203' },
    });
  });

  test('passes through unambiguous EDINET codes for snapshot queries', () => {
    const route = getDeterministicCompanySnapshotRoute('E02144の会社概要と直近の主要財務を簡単に確認して');

    expect(route).toEqual({
      tool: 'get_company_info',
      args: { ticker: 'E02144' },
    });
  });

  test('does not treat years as securities codes before whitelisted aliases', () => {
    const route = getDeterministicCompanySnapshotRoute('トヨタの2025年の会社概要と直近の主要財務を確認して');

    expect(route).toEqual({
      tool: 'get_company_info',
      args: { ticker: '7203' },
    });
  });

  test('falls back to the LLM router for non-whitelisted bare company names', () => {
    expect(getDeterministicCompanySnapshotRoute('ソニーの会社概要と直近の主要財務を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('三菱の会社概要と直近の主要財務を確認して')).toBeNull();
  });

  test('falls back for mixed identifiers or numeric amounts', () => {
    expect(getDeterministicCompanySnapshotRoute('7203とホンダの会社概要と直近財務を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('E02144と7267の会社概要と直近財務を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('E02144とホンダの会社概要と直近財務を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('売上高1000億円の会社概要と直近財務を確認して')).toBeNull();
  });

  test('falls back for multi-intent snapshot plus analysis or detailed ratio asks', () => {
    expect(getDeterministicCompanySnapshotRoute('トヨタの会社概要と直近財務と財務健全性スコアを確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('トヨタの会社概要と直近財務、財務分析もして')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('トヨタの会社概要と直近財務、ROICとROEを詳しく')).toBeNull();
  });

  test('does not route comparisons, filings, earnings, screening, or trend queries', () => {
    expect(getDeterministicCompanySnapshotRoute('トヨタとホンダの会社概要と直近財務を比較して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('トヨタとホンダの会社概要と直近財務を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('7203と7267の会社概要と直近財務を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('トヨタの有価証券報告書から会社概要と直近財務を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('トヨタの会社概要と直近の決算短信を確認して')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('会社概要と直近財務が良い企業をスクリーニングして')).toBeNull();
    expect(getDeterministicCompanySnapshotRoute('トヨタの会社概要と過去5年の財務推移を確認して')).toBeNull();
  });
});
