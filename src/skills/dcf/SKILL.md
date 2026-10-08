---
name: dcf-valuation
description: Build and validate a cash-flow-based DCF valuation for a Japanese listed company when the user explicitly requests DCF, discounted cash flow, or a cash-flow-based intrinsic-value estimate.
status: stable
requires:
  tools:
    - calculate_dcf
---

# DCF valuation

## Use when

Use this Skill only for an explicit DCF, discounted-cash-flow analysis, or cash-flow-based intrinsic-value request.

Do not activate it merely for a general valuation question, a price target, whether a stock is cheap or undervalued, analyst consensus, or PER/PBR/EV-EBITDA comparisons.

Examples:
- Use: “Run a DCF on Toyota.” “Estimate intrinsic value using discounted cash flow.”
- Do not use: “Is Toyota undervalued?” “What is the analyst price target?” “Compare Toyota’s valuation multiples with Honda.”

## Required inputs

Obtain explicit period-labeled enterprise free-cash-flow forecasts, WACC, perpetual growth, net debt, diluted shares outstanding, and one monetary unit. Record the source and fiscal period for reported inputs and label forecast assumptions as assumptions.

A verified current market price is optional. If unavailable, state `current market price: unavailable`; never substitute `PER × EPS` or another derived proxy. Without a verified price, report intrinsic value without upside/downside.

## Evidence rules

- Never invent financial statements, market data, guidance, consensus, identifiers, or dates.
- Distinguish reported values, company guidance, analyst consensus, and your assumptions.
- Attach dates or fiscal periods to material financial inputs.
- Verify company identity and securities/EDINET codes from tool evidence; verify listing status when relevant.
- Keep yen, million-yen, billion-yen, and per-share units explicit and consistent.
- Do not mix fiscal and calendar periods, or enterprise and equity values, without an explicit bridge.
- Do not call analyst consensus company guidance unless the source does.

## Calculation

Use `calculate_dcf` for the base valuation and sensitivity matrix. Do not manually reproduce its discounting, terminal value, enterprise-to-equity bridge, or per-share arithmetic.

## References

- Read [references/methodology.md](references/methodology.md) only when establishing or validating formulas, cash-flow basis, or valuation assumptions.
- Read [references/japan-market-inputs.md](references/japan-market-inputs.md) only when selecting current Japan-specific market inputs.

Do not read both references by default.

## Output

Report sourced inputs and assumptions, discounted forecast FCF, terminal value, enterprise value, the net-debt bridge, equity value, intrinsic value per share, and the 3 × 3 sensitivity matrix. Identify invalid sensitivity cells and material limitations. Add current-price comparison only when the price is verified and dated.

## Completion criteria

The company and periods are identified, every material input is sourced or labeled as an assumption, units reconcile, `calculate_dcf` succeeds, and the result clearly separates enterprise value, equity value, and per-share value.
