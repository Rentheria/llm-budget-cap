/** Thrown for invalid configuration, a Redis timeout, or an unexpected reply. */
export class BudgetCapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BudgetCapError';
  }
}
