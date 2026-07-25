import type { StageSettings } from "../config/stages";
import { LOGICAL_NAMES } from "../names";

// Cost guardrail: email alarm so nothing bills silently.
export function createBudget(settings: StageSettings) {
  const budget = new aws.budgets.Budget(LOGICAL_NAMES.budget, {
    budgetType: "COST",
    limitAmount: settings.monthlyBudgetUsd,
    limitUnit: "USD",
    timeUnit: "MONTHLY",
    notifications: [
      {
        comparisonOperator: "GREATER_THAN",
        threshold: 50, // alert at 50% of actual spend
        thresholdType: "PERCENTAGE",
        notificationType: "ACTUAL",
        subscriberEmailAddresses: [settings.alertEmail],
      },
      {
        comparisonOperator: "GREATER_THAN",
        threshold: 100, // alert when forecast to exceed the cap
        thresholdType: "PERCENTAGE",
        notificationType: "FORECASTED",
        subscriberEmailAddresses: [settings.alertEmail],
      },
    ],
  });

  return Object.freeze({ budget });
}
