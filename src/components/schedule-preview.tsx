import {
  advanceAnchoredDate,
  anchorFromDate,
  type AnchoredCadence,
} from "../../packages/domain/src/index.js";

export function SchedulePreview({
  firstDate,
  cadence,
}: {
  firstDate: string;
  cadence: string;
}) {
  if (!firstDate) return null;
  const label = cadenceLabel(cadence);
  if (!label) return null;
  if (cadence === "one_time")
    return <PreviewText>Due {formatDate(firstDate)} · one time</PreviewText>;
  if (cadence === "planning_period")
    return <PreviewText>Planned before the next payday</PreviewText>;
  if (cadence === "irregular")
    return (
      <PreviewText>
        Next date is a reminder only · no repeat assumed
      </PreviewText>
    );
  if (cadence === "semi_monthly")
    return (
      <PreviewText>
        Next {formatDate(firstDate)} · then twice a month
      </PreviewText>
    );
  const anchor = anchorFromDate(firstDate);
  const following = advanceAnchoredDate(
    firstDate,
    cadence as AnchoredCadence,
    anchor,
  );
  return (
    <PreviewText>
      Next {formatDate(firstDate)} · then {label} · following{" "}
      {formatDate(following)}
      {anchor.endOfMonth && ["monthly", "quarterly", "annual"].includes(cadence)
        ? " (month end)"
        : ""}
    </PreviewText>
  );
}

function PreviewText({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-5 text-muted">{children}</p>;
}

function cadenceLabel(value: string) {
  return {
    weekly: "weekly",
    biweekly: "every two weeks",
    semi_monthly: "twice a month",
    monthly: "monthly",
    quarterly: "every three months",
    annual: "yearly",
    one_time: "one time",
    planning_period: "before next payday",
    irregular: "irregularly",
  }[value as keyof typeof labels];
}

const labels = {
  weekly: true,
  biweekly: true,
  semi_monthly: true,
  monthly: true,
  quarterly: true,
  annual: true,
  one_time: true,
  planning_period: true,
  irregular: true,
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year:
      value.slice(0, 4) === String(new Date().getFullYear())
        ? undefined
        : "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
