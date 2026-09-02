import { nextMonthlyDate } from "./dates.js";

type DatedCustomCommitment = {
  amount: number;
  dueDate: string;
};

type CommitmentDateFields<TCustom extends DatedCustomCommitment> = {
  rentDueDate: string;
  electricDueDate: string;
  streamBoxDueDate: string;
  insuranceDueDate: string;
  customCommitments: TCustom[];
};

export function withSuggestedCommitmentDates<
  TCustom extends DatedCustomCommitment,
  TPlan extends CommitmentDateFields<TCustom>,
>(value: TPlan, horizonStart: string, horizonEnd: string): TPlan {
  return {
    ...value,
    rentDueDate: value.rentDueDate || nextMonthlyDate(horizonStart, 1),
    electricDueDate:
      value.electricDueDate || nextMonthlyDate(horizonStart, 10),
    streamBoxDueDate:
      value.streamBoxDueDate || nextMonthlyDate(horizonStart, 15),
    insuranceDueDate:
      value.insuranceDueDate || nextMonthlyDate(horizonStart, 20),
    customCommitments: value.customCommitments.map((item) =>
      item.amount > 0 && !item.dueDate ? { ...item, dueDate: horizonEnd } : item,
    ),
  };
}
