const ZERO_DECIMAL = new Set(
  "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF".split(" "),
)
const THREE_DECIMAL = new Set("BHD IQD JOD KWD LYD OMR TND".split(" "))

/** How many minor units make one of `currency` (100 for USD, 1 for JPY, 1000 for KWD). */
export function minorUnits(currency: string): number {
  const c = currency.trim().toUpperCase()
  return ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100
}

/**
 * An amount with its unit, in the currency's own decimals: `15.99 USD`, `4000 JPY`, `1.234 KWD`;
 * two decimals when the unit is empty or not a currency this knows (docket#61).
 */
export function money(amount: number, currency: string): string {
  const digits = Math.round(Math.log10(minorUnits(currency)))
  return `${amount.toFixed(digits)} ${currency}`.trim()
}
