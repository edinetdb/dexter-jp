---
name: dcf-valuation
description: Performs discounted cash flow (DCF) valuation analysis to estimate intrinsic value per share for Japanese listed companies. Triggers when user asks for fair value, intrinsic value, DCF, valuation, "what is X worth", price target, undervalued/overvalued analysis, or wants to compare current price to fundamental value.
---

# DCF Valuation Skill (Japanese Market)

## Workflow Checklist

Copy and track progress:
```
DCF Analysis Progress:
- [ ] Step 1: Gather financial data
- [ ] Step 2: Calculate FCF growth rate
- [ ] Step 3: Estimate discount rate (WACC)
- [ ] Step 4: Project future cash flows (Years 1-5 + Terminal)
- [ ] Step 5: Calculate present value and fair value per share
- [ ] Step 6: Run sensitivity analysis
- [ ] Step 7: Validate results
- [ ] Step 8: Present results with caveats
```

## Step 1: Gather Financial Data

Call the `get_financials` tool with these queries:

### 1.1 Cash Flow History
**Query:** `"[TICKER] annual financial statements for the last 5 years"`

**Extract:** `cfOperating` (operating cash flow), `cfInvesting`, `capex`, calculate FCF = cfOperating - capex (absolute value)

### 1.2 Financial Metrics / Key Ratios
**Query:** `"[TICKER] key ratios and financial metrics"`

**Extract:** `ROIC`, `financialLeverage`, `deRatio`, `operatingMargin`, `netMargin`, `dividendYield`

### 1.3 Balance Sheet
**Query:** `"[TICKER] latest financial statements"`

**Extract:** `totalAssets`, `netAssets`, `interestBearingDebt` (or calculate from shortTermLoans + longTermLoans + bondsPayable), `cash`, `sharesIssued`

### 1.4 Company Info
**Query:** `"[TICKER] company info"`

**Extract:** `industry`, `accountingStandard`, `healthScore`, `PER`, `BPS`, `EPS`

### 1.5 Current Price
EDINET DB does not provide stock price data. Use the latest `PER × EPS` as a price estimate, or note that the user should provide the current stock price for accurate analysis.

## Step 2: Calculate FCF Growth Rate

Calculate 3-5 year FCF CAGR from cash flow history.

**Cross-validate with:** revenue growth trend, EPS growth, operating income growth

**Growth rate selection:**
- Stable FCF history → Use CAGR with 10-20% haircut
- Volatile FCF → Weight recent trends more heavily
- **Cap at 15%** (sustained higher growth is rare)

## Step 3: Estimate Discount Rate (WACC)

**Default assumptions for Japanese market:**
- Risk-free rate: 1.0-1.5% (JGB 10-year yield)
- Equity risk premium: 5-7%
- Cost of debt: 1-3% pre-tax (Japan's low interest rate environment)
- Tax rate: ~30% (effective corporate tax)

Calculate WACC using `deRatio` for capital structure weights.

**Typical WACC ranges for Japanese companies:**
- Large-cap blue chips: 5-7%
- Mid-cap growth: 7-9%
- Small-cap / high-risk: 9-12%

**Reasonableness check:** WACC should be below ROIC for value-creating companies.

## Step 4: Project Future Cash Flows

**Years 1-5:** Apply growth rate with 5% annual decay (multiply growth rate by 0.95, 0.90, 0.85, 0.80 for years 2-5).

**Terminal value:** Use Gordon Growth Model with 1.0-1.5% terminal growth (Japan's lower nominal GDP growth).

## Step 5: Calculate Present Value

Discount all FCFs → sum for Enterprise Value → subtract Net Debt → divide by `sharesIssued` for fair value per share.

Note: All amounts are in millions of JPY unless stated otherwise. Fair value per share will be in JPY.

## Step 6: Sensitivity Analysis

Create 3×3 matrix: WACC (base ±1%) vs terminal growth (0.5%, 1.0%, 1.5%).

## Step 7: Validate Results

Before presenting, verify these sanity checks:

1. **PER cross-check**: Implied PER (fair value / EPS) should be reasonable for the industry
   - Japanese market average: ~15x. Growth: 20-30x. Value: 8-12x.

2. **PBR cross-check**: Fair value / BPS should be reasonable
   - TSE has been pushing companies to achieve PBR > 1.0x

3. **Terminal value ratio**: Terminal value should be 50-80% of total EV for mature companies

If validation fails, reconsider assumptions before presenting results.

## Step 8: Output Format

Present a structured summary including:
1. **Valuation Summary**: Current price (if known) vs. fair value, upside/downside percentage
2. **Key Inputs Table**: All assumptions with their sources
3. **Projected FCF Table**: 5-year projections with present values (in millions of JPY)
4. **Sensitivity Matrix**: 3×3 grid varying WACC (±1%) and terminal growth (0.5%, 1.0%, 1.5%)
5. **Caveats**: Standard DCF limitations plus Japan-specific considerations (yen currency risk, governance reform impact, cross-shareholding)
