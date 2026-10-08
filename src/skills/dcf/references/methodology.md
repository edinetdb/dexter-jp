# DCF methodology

Read this reference only when a DCF formula, cash-flow basis, or assumption needs to be established or checked.

## Cash-flow and value basis

Use enterprise free cash flow (FCFF) with WACC when calculating enterprise value. Keep the cash-flow definition consistent across historical evidence and forecasts; do not mix equity cash flow with an enterprise-value bridge.

Forecast periods must be explicit and sequential. The calculator uses end-of-period discounting: the first forecast is discounted one period, the second two periods, and so on.

## Discount rate

WACC combines the market-value weights of equity and debt with the cost of equity and after-tax cost of debt. Select each component from dated evidence or clearly labeled assumptions. Do not infer a current WACC from an undated sector range.

Rates passed to `calculate_dcf` are decimal fractions: `0.08` means 8%.

## Terminal value and equity bridge

The calculator applies Gordon growth at the end of the final explicit period:

`terminal value = final FCF × (1 + g) / (WACC - g)`

WACC must exceed perpetual growth. Enterprise value is the present value of explicit FCF plus discounted terminal value. Equity value is:

`equity value = enterprise value - net debt`

Net debt means debt minus cash, so net cash is a negative number. Divide equity value by diluted shares outstanding only after reconciling monetary units.

## Validation and interpretation

Review whether forecast FCF, WACC, perpetual growth, net debt, and diluted shares describe the same company and relevant valuation date. Treat sensitivity analysis as an assumption range, not a probability distribution. Investigate results dominated by terminal value or driven by unsupported assumptions.

A market-price comparison requires a verified, dated price. Do not derive a substitute price from PER × EPS or another valuation multiple.
