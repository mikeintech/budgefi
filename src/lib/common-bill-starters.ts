export const commonBillStarters = [
  { key: "housing", name: "Housing", detail: "Rent or mortgage" },
  { key: "utilities", name: "Utilities", detail: "Electric, gas, or water" },
  { key: "phone_internet", name: "Phone & internet", detail: "Connectivity" },
  { key: "insurance", name: "Insurance", detail: "Recurring premiums" },
  { key: "subscriptions", name: "Subscriptions", detail: "Memberships and services" },
  { key: "debt_payment", name: "Minimum debt payment", detail: "Required monthly payment" },
] as const;

export type CommonBillStarterKey = (typeof commonBillStarters)[number]["key"];

const starterNames = new Map<CommonBillStarterKey, string>(
  commonBillStarters.map((item) => [item.key, item.name]),
);

/** A starter marker is only valid while the locally-created row is untouched.
 * Once completed or renamed, it is an ordinary commitment. */
export function untouchedStarterKey(
  item: {
    name: string;
    amount: number;
    dueDate: string;
    starterItemKey?: CommonBillStarterKey;
  },
  persisted: boolean,
): CommonBillStarterKey | undefined {
  if (!item.starterItemKey || persisted) return undefined;
  return item.amount === 0 &&
    !item.dueDate &&
    item.name.trim() === starterNames.get(item.starterItemKey)
    ? item.starterItemKey
    : undefined;
}
