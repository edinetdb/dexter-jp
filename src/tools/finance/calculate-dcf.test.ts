import { describe, expect, test } from 'bun:test';
import {
  calculateDcf,
  calculateDcfAnalysis,
  type CalculateDcfInput,
  type DcfInput,
} from './calculate-dcf.js';

const BASE_INPUT: DcfInput = {
  forecastFreeCashFlows: [
    { period: 'FY2027', value: 100 },
    { period: 'FY2028', value: 110 },
  ],
  wacc: 0.10,
  terminalGrowthRate: 0.02,
  netDebt: 50,
  dilutedSharesOutstanding: 10_000_000,
  unit: 'JPY_million',
};

describe('calculateDcf', () => {
  test('calculates a manually verifiable positive DCF', () => {
    const result = calculateDcf(BASE_INPUT);

    expect(result.discountedForecastFreeCashFlows[0]!.presentValue).toBeCloseTo(90.9090909, 7);
    expect(result.discountedForecastFreeCashFlows[1]!.presentValue).toBeCloseTo(90.9090909, 7);
    expect(result.terminalValue).toBeCloseTo(1402.5, 7);
    expect(result.discountedTerminalValue).toBeCloseTo(1159.0909091, 7);
    expect(result.enterpriseValue).toBeCloseTo(1340.9090909, 7);
    expect(result.equityValue).toBeCloseTo(1290.9090909, 7);
    expect(result.intrinsicValuePerShare).toBeCloseTo(129.0909091, 7);
    expect(result.assumptions.percentageConvention).toBe('decimal_fraction');
    expect(result.assumptions.discountingConvention).toBe('end_of_period');
  });

  test('treats negative net debt as net cash and increases equity value', () => {
    const debtCase = calculateDcf(BASE_INPUT);
    const netCashCase = calculateDcf({ ...BASE_INPUT, netDebt: -50 });

    expect(netCashCase.assumptions.netDebtConvention).toBe('debt_minus_cash');
    expect(netCashCase.equityValue - debtCase.equityValue).toBeCloseTo(100, 10);
    expect(netCashCase.intrinsicValuePerShare - debtCase.intrinsicValuePerShare).toBeCloseTo(10, 10);
  });

  test('allows a negative individual forecast FCF', () => {
    const result = calculateDcf({
      ...BASE_INPUT,
      forecastFreeCashFlows: [
        { period: 'FY2027', value: -20 },
        { period: 'FY2028', value: 100 },
      ],
    });

    expect(result.discountedForecastFreeCashFlows[0]!.presentValue).toBeLessThan(0);
    expect(Number.isFinite(result.intrinsicValuePerShare)).toBe(true);
  });

  test('rejects WACC equal to or below terminal growth', () => {
    expect(() => calculateDcf({ ...BASE_INPUT, wacc: 0.02, terminalGrowthRate: 0.02 })).toThrow();
    expect(() => calculateDcf({ ...BASE_INPUT, wacc: 0.01, terminalGrowthRate: 0.02 })).toThrow();
  });

  test('rejects zero and negative diluted shares', () => {
    expect(() => calculateDcf({ ...BASE_INPUT, dilutedSharesOutstanding: 0 })).toThrow();
    expect(() => calculateDcf({ ...BASE_INPUT, dilutedSharesOutstanding: -1 })).toThrow();
  });

  test('rejects non-finite numeric inputs', () => {
    expect(() => calculateDcf({ ...BASE_INPUT, wacc: Number.NaN })).toThrow();
    expect(() => calculateDcf({ ...BASE_INPUT, netDebt: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => calculateDcf({
      ...BASE_INPUT,
      forecastFreeCashFlows: [{ period: 'FY2027', value: Number.NEGATIVE_INFINITY }],
    })).toThrow();
  });

  test('rejects missing period labels and empty forecasts', () => {
    expect(() => calculateDcf({
      ...BASE_INPUT,
      forecastFreeCashFlows: [{ period: ' ', value: 100 }],
    })).toThrow();
    expect(() => calculateDcf({ ...BASE_INPUT, forecastFreeCashFlows: [] })).toThrow();
  });
});

describe('calculateDcfAnalysis', () => {
  test('returns a deterministic 3 × 3 sensitivity grid with the base result at the center', () => {
    const input: CalculateDcfInput = { ...BASE_INPUT, waccDelta: 0.01, growthDelta: 0.005 };
    const result = calculateDcfAnalysis(input);

    expect(result.sensitivity.rows).toHaveLength(3);
    for (const row of result.sensitivity.rows) {
      expect(row.cells).toHaveLength(3);
    }

    const center = result.sensitivity.rows[1]!.cells[1]!;
    expect(center.valid).toBe(true);
    if (center.valid) {
      expect(center.intrinsicValuePerShare).toBeCloseTo(result.base.intrinsicValuePerShare, 10);
    }
  });

  test('represents invalid WACC/growth sensitivity cells explicitly', () => {
    const result = calculateDcfAnalysis({
      ...BASE_INPUT,
      wacc: 0.03,
      terminalGrowthRate: 0.02,
      waccDelta: 0.01,
      growthDelta: 0.01,
    });

    const invalidCells = result.sensitivity.rows.flatMap((row) => row.cells)
      .filter((cell) => !cell.valid);
    expect(invalidCells.length).toBeGreaterThan(0);
    for (const cell of invalidCells) {
      if (!cell.valid) {
        expect(cell.error).toContain('WACC must be greater than the terminal growth rate');
      }
    }
  });
});
