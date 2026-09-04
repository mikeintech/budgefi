import type { ManualTransactionRequest } from "@budgefi/contracts";
export type TransactionCategory = ManualTransactionRequest["category"];
export const transactionCategories: readonly (readonly [
  TransactionCategory,
  string,
])[] = [
  ["income", "Income"],
  ["housing", "Housing"],
  ["utilities", "Bills & utilities"],
  ["groceries", "Groceries"],
  ["dining", "Dining"],
  ["transportation", "Transportation"],
  ["shopping", "Shopping"],
  ["health", "Health"],
  ["insurance", "Insurance"],
  ["debt", "Debt"],
  ["subscriptions", "Subscriptions"],
  ["fees", "Fees"],
  ["entertainment", "Entertainment"],
  ["education", "Education"],
  ["giving", "Giving"],
  ["taxes", "Taxes"],
  ["savings_investments", "Savings & investments"],
  ["transfer", "Transfer"],
  ["cash_atm", "Cash & ATM"],
  ["other", "Other"],
  ["uncategorized", "Needs category"],
];
export const transactionCategoryLabels = new Map<string, string>(
  transactionCategories,
);
