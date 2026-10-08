import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const finiteNumber = z.number().refine(Number.isFinite, 'Must be a finite number');
const positiveFiniteNumber = finiteNumber.refine((value) => value > 0, 'Must be greater than zero');

const forecastFreeCashFlowSchema = z.object({
  period: z.string().trim().min(1, 'Period label is required'),
  value: finiteNumber.describe('Forecast free cash flow in the selected monetary unit. Negative values are allowed.'),
});

const dcfCoreShape = {
  forecastFreeCashFlows: z.array(forecastFreeCashFlowSchema).min(1, 'At least one forecast period is required'),
  wacc: positiveFiniteNumber.describe('Weighted average cost of capital as a decimal fraction; 0.08 means 8%.'),
  terminalGrowthRate: finiteNumber
    .refine((value) => value > -1, 'Terminal growth rate must be greater than -100%')
    .describe('Perpetual growth rate as a decimal fraction; 0.02 means 2%.'),
  netDebt: finiteNumber.describe('Debt minus cash in the selected monetary unit. Negative values represent net cash.'),
  dilutedSharesOutstanding: positiveFiniteNumber.describe('Diluted shares outstanding as an actual share count.'),
  unit: z.enum(['JPY', 'JPY_million', 'JPY_billion']).describe(
    'Monetary unit shared by every forecast FCF and netDebt. Per-share output is normalized to JPY.',
  ),
};

function validateRateRelationship(
  input: { wacc: number; terminalGrowthRate: number },
  ctx: z.RefinementCtx,
): void {
  if (input.wacc <= input.terminalGrowthRate) {
    ctx.addIssue({
      code: 'custom',
      path: ['wacc'],
      message: 'WACC must be greater than the terminal growth rate',
    });
  }
}

const DcfCoreInputSchema = z.object(dcfCoreShape).superRefine(validateRateRelationship);

export const CalculateDcfInputSchema = z.object({
  ...dcfCoreShape,
  waccDelta: positiveFiniteNumber
    .default(0.01)
    .describe('Sensitivity step as a decimal fraction; default 0.01 means 1 percentage point.'),
  growthDelta: positiveFiniteNumber
    .default(0.005)
    .describe('Sensitivity step as a decimal fraction; default 0.005 means 0.5 percentage point.'),
}).superRefine(validateRateRelationship);

export type DcfInput = z.input<typeof DcfCoreInputSchema>;
export type CalculateDcfInput = z.input<typeof CalculateDcfInputSchema>;

export interface DiscountedForecastFreeCashFlow {
  period: string;
  value: number;
  discountPeriod: number;
  discountFactor: number;
  presentValue: number;
}

export interface DcfCalculationResult {
  assumptions: {
    forecastFreeCashFlows: Array<{ period: string; value: number }>;
    wacc: number;
    terminalGrowthRate: number;
    netDebt: number;
    dilutedSharesOutstanding: number;
    unit: 'JPY' | 'JPY_million' | 'JPY_billion';
    percentageConvention: 'decimal_fraction';
    netDebtConvention: 'debt_minus_cash';
    discountingConvention: 'end_of_period';
  };
  discountedForecastFreeCashFlows: DiscountedForecastFreeCashFlow[];
  terminalValue: number;
  discountedTerminalValue: number;
  enterpriseValue: number;
  equityValue: number;
  intrinsicValuePerShare: number;
  intrinsicValuePerShareUnit: 'JPY';
}

export type DcfSensitivityCell = {
  wacc: number;
  terminalGrowthRate: number;
} & (
  | { valid: true; intrinsicValuePerShare: number }
  | { valid: false; error: string }
);

export interface DcfAnalysisResult {
  base: DcfCalculationResult;
  sensitivity: {
    waccDelta: number;
    growthDelta: number;
    waccValues: number[];
    terminalGrowthRateValues: number[];
    rows: Array<{
      terminalGrowthRate: number;
      cells: DcfSensitivityCell[];
    }>;
  };
}

const UNIT_TO_JPY: Record<DcfCalculationResult['assumptions']['unit'], number> = {
  JPY: 1,
  JPY_million: 1_000_000,
  JPY_billion: 1_000_000_000,
};

function normalizeRate(value: number): number {
  return Number(value.toFixed(12));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Calculate one end-of-period Gordon-growth DCF from explicit inputs. */
export function calculateDcf(input: DcfInput): DcfCalculationResult {
  const parsed = DcfCoreInputSchema.parse(input);

  const discountedForecastFreeCashFlows = parsed.forecastFreeCashFlows.map((forecast, index) => {
    const discountPeriod = index + 1;
    const discountFactor = 1 / Math.pow(1 + parsed.wacc, discountPeriod);
    return {
      ...forecast,
      discountPeriod,
      discountFactor,
      presentValue: forecast.value * discountFactor,
    };
  });

  const finalForecast = parsed.forecastFreeCashFlows[parsed.forecastFreeCashFlows.length - 1]!;
  const terminalValue = finalForecast.value * (1 + parsed.terminalGrowthRate)
    / (parsed.wacc - parsed.terminalGrowthRate);
  const terminalDiscountPeriod = parsed.forecastFreeCashFlows.length;
  const discountedTerminalValue = terminalValue / Math.pow(1 + parsed.wacc, terminalDiscountPeriod);
  const enterpriseValue = discountedForecastFreeCashFlows
    .reduce((sum, forecast) => sum + forecast.presentValue, 0) + discountedTerminalValue;
  const equityValue = enterpriseValue - parsed.netDebt;
  const intrinsicValuePerShare = equityValue * UNIT_TO_JPY[parsed.unit]
    / parsed.dilutedSharesOutstanding;

  return {
    assumptions: {
      forecastFreeCashFlows: parsed.forecastFreeCashFlows,
      wacc: parsed.wacc,
      terminalGrowthRate: parsed.terminalGrowthRate,
      netDebt: parsed.netDebt,
      dilutedSharesOutstanding: parsed.dilutedSharesOutstanding,
      unit: parsed.unit,
      percentageConvention: 'decimal_fraction',
      netDebtConvention: 'debt_minus_cash',
      discountingConvention: 'end_of_period',
    },
    discountedForecastFreeCashFlows,
    terminalValue,
    discountedTerminalValue,
    enterpriseValue,
    equityValue,
    intrinsicValuePerShare,
    intrinsicValuePerShareUnit: 'JPY',
  };
}

/** Calculate the base DCF and a deterministic 3 × 3 WACC/growth sensitivity grid. */
export function calculateDcfAnalysis(input: CalculateDcfInput): DcfAnalysisResult {
  const parsed = CalculateDcfInputSchema.parse(input);
  const base = calculateDcf(parsed);
  const waccValues = [
    normalizeRate(parsed.wacc - parsed.waccDelta),
    parsed.wacc,
    normalizeRate(parsed.wacc + parsed.waccDelta),
  ];
  const terminalGrowthRateValues = [
    normalizeRate(parsed.terminalGrowthRate - parsed.growthDelta),
    parsed.terminalGrowthRate,
    normalizeRate(parsed.terminalGrowthRate + parsed.growthDelta),
  ];

  const rows = terminalGrowthRateValues.map((terminalGrowthRate) => ({
    terminalGrowthRate,
    cells: waccValues.map((wacc): DcfSensitivityCell => {
      try {
        const result = calculateDcf({ ...parsed, wacc, terminalGrowthRate });
        return { wacc, terminalGrowthRate, valid: true, intrinsicValuePerShare: result.intrinsicValuePerShare };
      } catch (error) {
        return { wacc, terminalGrowthRate, valid: false, error: errorMessage(error) };
      }
    }),
  }));

  return {
    base,
    sensitivity: {
      waccDelta: parsed.waccDelta,
      growthDelta: parsed.growthDelta,
      waccValues,
      terminalGrowthRateValues,
      rows,
    },
  };
}

export const CALCULATE_DCF_DESCRIPTION =
  'Calculate and validate a DCF valuation from explicit assumptions, including forecast discounting, Gordon-growth terminal value, equity bridge, per-share value, and a 3 × 3 sensitivity matrix.';

export const calculateDcfTool = new DynamicStructuredTool({
  name: 'calculate_dcf',
  description: CALCULATE_DCF_DESCRIPTION,
  schema: CalculateDcfInputSchema,
  func: async (input) => formatToolResult(calculateDcfAnalysis(input)),
});
