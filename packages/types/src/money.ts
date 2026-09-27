/** An amount with its unit, two decimals: `15.99 USD`; the unit may be empty. */
export function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`.trim()
}
