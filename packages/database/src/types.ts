import type {
  ColumnType,
  Generated,
  Insertable,
  Selectable,
  Updateable,
} from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DateOnly = ColumnType<string, string, string>;
type Json = ColumnType<unknown, unknown | undefined, unknown>;

export interface UsersTable {
  id: Generated<string>;
  auth_subject: string;
  display_name: string;
  email: string | null;
  provisioned_at: Timestamp;
  created_at: Timestamp;
  deleted_at: Timestamp | null;
}
export interface HouseholdsTable {
  id: Generated<string>;
  name: string;
  timezone: string;
  base_currency: string;
  data_revision: Generated<string>;
  lifecycle_state: Generated<string>;
  created_at: Timestamp;
  deleted_at: Timestamp | null;
}
export interface MembershipsTable {
  household_id: string;
  user_id: string;
  role: string;
  onboarding_completed_at: Timestamp | null;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
}
export interface AccountsTable {
  id: Generated<string>;
  household_id: string;
  name: string;
  account_type: string;
  currency: string;
  provenance: string;
  provider_account_id: string | null;
  provider_account_fingerprint: string | null;
  connection_id: string | null;
  include_in_plan: Generated<boolean>;
  planning_role: Generated<string>;
  version: Generated<number>;
  created_at: Timestamp;
  archived_at: Timestamp | null;
}
export interface SavingsGoalsTable {
  id: Generated<string>;
  household_id: string;
  destination_account_id: string | null;
  destination_prior_planning_role: string | null;
  destination_tracking_started_at: Date | null;
  name: string;
  target_amount_minor: string | null;
  target_date: DateOnly | null;
  contribution_amount_minor: string;
  schedule: string;
  next_due_on: DateOnly | null;
  schedule_anchor_day: Generated<number | null>;
  schedule_anchor_eom: Generated<boolean>;
  status: string;
  currency: string;
  provenance: string;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface SavingsGoalRevisionsTable {
  id: Generated<string>;
  household_id: string;
  savings_goal_id: string;
  destination_account_id: string | null;
  destination_prior_planning_role: string | null;
  destination_tracking_started_at: Date | null;
  name: string;
  target_amount_minor: string | null;
  target_date: DateOnly | null;
  contribution_amount_minor: string;
  schedule: string;
  next_due_on: DateOnly | null;
  schedule_anchor_day: Generated<number | null>;
  schedule_anchor_eom: Generated<boolean>;
  status: string;
  currency: string;
  provenance: string;
  version: number;
  actor_user_id: string | null;
  reason: string;
  recorded_at: Timestamp;
}
export interface SavingsGoalMovementsTable {
  id: Generated<string>;
  household_id: string;
  savings_goal_id: string;
  kind: string;
  amount_minor: string;
  currency: string;
  effective_on: DateOnly;
  verification_method: string;
  originating_occurrence_id: string | null;
  originating_occurrence_version: number | null;
  reversed_movement_id: string | null;
  actor_user_id: string | null;
  provenance: string;
  created_at: Timestamp;
}
export interface SavingsMovementEvidenceTable {
  id: Generated<string>;
  household_id: string;
  movement_id: string;
  evidence_role: string;
  transaction_id: string | null;
  balance_observation_id: string | null;
  created_at: Timestamp;
}
export interface DebtsTable {
  id: Generated<string>;
  household_id: string;
  account_id: string;
  linked_commitment_id: string | null;
  payment_commitment_managed: boolean;
  name: string;
  debt_type: string;
  status: string;
  provenance: string;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface DebtRevisionsTable {
  id: Generated<string>;
  household_id: string;
  debt_id: string;
  account_id: string;
  linked_commitment_id: string | null;
  payment_commitment_managed: boolean;
  name: string;
  debt_type: string;
  status: string;
  provenance: string;
  version: number;
  actor_user_id: string | null;
  reason: string;
  recorded_at: Timestamp;
}
export interface DebtBalanceObservationsTable {
  id: Generated<string>;
  household_id: string;
  debt_id: string;
  current_balance_minor: string;
  currency: string;
  provenance: string;
  source_record_id: string;
  observed_at: Timestamp;
  recorded_at: Timestamp;
}
export interface DebtTermObservationsTable {
  id: Generated<string>;
  household_id: string;
  debt_id: string;
  minimum_payment_minor: string | null;
  next_due_on: DateOnly | null;
  statement_balance_minor: string | null;
  statement_on: DateOnly | null;
  last_payment_minor: string | null;
  last_payment_on: DateOnly | null;
  overdue: boolean | null;
  provenance: string;
  source_record_id: string;
  observed_at: Timestamp;
  recorded_at: Timestamp;
}
export interface DebtAprComponentsTable {
  id: Generated<string>;
  household_id: string;
  debt_id: string;
  component_key: string;
  apr_basis_points: number;
  balance_minor: string | null;
  apr_type: string;
  selected_for_projection: boolean;
  provenance: string;
  source_record_id: string;
  observed_at: Timestamp;
  recorded_at: Timestamp;
}
export interface DebtPaymentPoliciesTable {
  household_id: string;
  debt_id: string;
  mode: string;
  fixed_amount_minor: string | null;
  extra_amount_minor: string;
  version: Generated<number>;
  actor_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface DebtPaymentPolicyRevisionsTable {
  id: Generated<string>;
  household_id: string;
  debt_id: string;
  mode: string;
  fixed_amount_minor: string | null;
  extra_amount_minor: string;
  version: number;
  actor_user_id: string | null;
  reason: string;
  recorded_at: Timestamp;
}
export interface DebtPaymentEvidenceTable {
  id: Generated<string>;
  household_id: string;
  debt_id: string;
  occurrence_match_id: string;
  liability_transaction_id: string;
  liability_balance_observation_id: string;
  source_balance_observation_id: string;
  created_at: Timestamp;
}
export interface DebtPaymentEvidenceReversalsTable {
  id: Generated<string>;
  household_id: string;
  evidence_id: string;
  reason: string;
  created_at: Timestamp;
}
export interface IncomeSchedulesTable {
  id: Generated<string>;
  household_id: string;
  destination_account_id: string | null;
  name: string;
  expected_amount_minor: string | null;
  currency: string;
  frequency: string;
  next_expected_date: DateOnly | null;
  confirmed: boolean;
  status: string;
  anchor_day: number | null;
  anchor_eom: boolean;
  second_anchor_day: number | null;
  second_anchor_eom: boolean;
  review_reason: string | null;
  advanced_from_occurrence_id: string | null;
  previous_expected_date: DateOnly | null;
  provenance: string;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface IncomeScheduleRevisionsTable {
  id: Generated<string>;
  household_id: string;
  income_schedule_id: string;
  destination_account_id: string | null;
  name: string;
  expected_amount_minor: string | null;
  frequency: string;
  next_expected_date: DateOnly | null;
  confirmed: boolean;
  status: string;
  anchor_day: number | null;
  anchor_eom: boolean;
  second_anchor_day: number | null;
  second_anchor_eom: boolean;
  review_reason: string | null;
  advanced_from_occurrence_id: string | null;
  previous_expected_date: DateOnly | null;
  provenance: string;
  version: number;
  actor_user_id: string | null;
  reason: string;
  recorded_at: Timestamp;
}
export interface BalancesTable {
  id: Generated<string>;
  household_id: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  provenance: string;
  as_of: Timestamp;
  source_record_id: string | null;
  balance_basis: Generated<string>;
  provider_request_id: string | null;
  recorded_at: Timestamp;
}
export interface TransactionsTable {
  id: Generated<string>;
  household_id: string;
  account_id: string;
  source_kind: string;
  source_record_id: string;
  revision: Generated<number>;
  merchant: string;
  amount_minor: string;
  currency: string;
  direction: Generated<string>;
  occurred_on: DateOnly;
  status: string;
  pending_source_record_id: string | null;
  source_updated_at: Timestamp | null;
  recorded_at: Timestamp;
  raw_hash: string | null;
  transaction_id: string;
  provider_category_primary: string | null;
  provider_category_detailed: string | null;
}
export interface TransactionEntitiesTable {
  id: Generated<string>;
  household_id: string;
  account_id: string;
  version: Generated<number>;
  current_transaction_id: Generated<string | null>;
  current_occurred_on: Generated<Timestamp | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface TransactionSourceAliasesTable {
  household_id: string;
  transaction_id: string;
  account_id: string;
  source_kind: string;
  source_record_id: string;
  created_at: Timestamp;
}
export interface TransactionCategoryAssignmentsTable {
  household_id: string;
  transaction_id: string;
  category: string;
  source: string;
  confidence: string;
  version: Generated<number>;
  actor_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface TransactionCategoryRevisionsTable {
  id: Generated<string>;
  household_id: string;
  transaction_id: string;
  category: string;
  source: string;
  confidence: string;
  version: number;
  actor_user_id: string | null;
  reason: string;
  created_at: Timestamp;
}
export interface MerchantCategoryRulesTable {
  id: Generated<string>;
  household_id: string;
  normalized_merchant: string;
  category: string;
  version: Generated<number>;
  actor_user_id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}
export interface CommitmentsTable {
  id: Generated<string>;
  household_id: string;
  name: string;
  amount_minor: string;
  currency: string;
  due_date: DateOnly | null;
  recurrence: string | null;
  recurrence_anchor_day: Generated<number | null>;
  recurrence_anchor_eom: Generated<boolean>;
  setup_slot: Generated<string | null>;
  provenance: string;
  version: Generated<number>;
  active: Generated<boolean>;
  settled_at: Timestamp | null;
  settled_by_occurrence_id: Generated<string | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface PlansTable {
  id: Generated<string>;
  household_id: string;
  planned_savings_minor: string;
  safety_buffer_minor: string;
  currency: string;
  version: Generated<number>;
  planning_horizon_days: Generated<number>;
  income_amount_minor: Generated<string>;
  income_frequency: Generated<string>;
  next_income_date: DateOnly | null;
  income_confirmed: Generated<boolean>;
  income_source_name: Generated<string>;
  fallback_horizon_days: Generated<number>;
  income_anchor_day: Generated<number | null>;
  income_anchor_eom: Generated<boolean>;
  income_advanced_from_occurrence_id: Generated<string | null>;
  income_previous_expected_date: Generated<string | null>;
  calculation_policy_version: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface PlanRevisionsTable {
  id: Generated<string>;
  household_id: string;
  plan_id: string;
  version: number;
  planned_savings_minor: string;
  safety_buffer_minor: string;
  currency: string;
  planning_horizon_days: number;
  income_amount_minor: string;
  income_frequency: string;
  next_income_date: DateOnly | null;
  income_confirmed: boolean;
  income_source_name: string;
  fallback_horizon_days: number;
  income_anchor_day: Generated<number | null>;
  income_anchor_eom: Generated<boolean>;
  policy_version: string;
  actor_user_id: string | null;
  recorded_at: Timestamp;
}
export interface CommitmentRevisionsTable {
  id: Generated<string>;
  household_id: string;
  commitment_id: string;
  version: number;
  name: string;
  amount_minor: string;
  currency: string;
  due_date: DateOnly | null;
  recurrence: Generated<string | null>;
  active: boolean;
  settled_at: Timestamp | null;
  recurrence_anchor_day: Generated<number | null>;
  recurrence_anchor_eom: Generated<boolean>;
  setup_slot: Generated<string | null>;
  actor_user_id: string | null;
  recorded_at: Timestamp;
}
export interface ActivityTable {
  id: Generated<string>;
  household_id: string;
  actor_user_id: string | null;
  event_type: string;
  title: string;
  detail: string;
  entity_type: string | null;
  entity_id: string | null;
  provenance: string;
  occurred_at: Timestamp;
  metadata: Json;
}
export interface IdempotencyTable {
  household_id: string;
  request_id: string;
  operation: string;
  request_hash: string;
  response_status: number | null;
  response_body: Json | null;
  created_at: Timestamp;
  expires_at: Timestamp;
}
export interface ConnectionsTable {
  id: Generated<string>;
  household_id: string;
  provider: string;
  provider_item_id: string;
  encrypted_access_token: Uint8Array | null;
  status: string;
  sync_cursor: string | null;
  last_successful_sync_at: Timestamp | null;
  environment: string | null;
  institution_id: string | null;
  institution_name: string | null;
  token_key_id: string | null;
  error_code: string | null;
  consent_expires_at: Timestamp | null;
  initial_update_complete: Generated<boolean>;
  historical_update_complete: Generated<boolean>;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface WebhooksTable {
  id: Generated<string>;
  provider: string;
  provider_event_key: string;
  connection_id: string | null;
  household_id: string | null;
  payload_hash: string;
  event_type: string;
  environment: string | null;
  event_code: string | null;
  provider_item_id: string | null;
  verification_key_id: string | null;
  signature_issued_at: Timestamp | null;
  processing_status: Generated<string>;
  error_code: string | null;
  received_at: Timestamp;
  processed_at: Timestamp | null;
}
export interface PlaidLinkSessionsTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  mode: string;
  connection_id: string | null;
  environment: string;
  status: Generated<string>;
  link_token_hash: string | null;
  public_token_hash: string | null;
  encrypted_public_token: Uint8Array | null;
  public_token_key_id: string | null;
  link_session_id: string | null;
  provider_item_id: string | null;
  error_code: string | null;
  expires_at: Timestamp;
  created_at: Timestamp;
  exchange_started_at: Timestamp | null;
  completed_at: Timestamp | null;
}
export interface PlaidSyncJobsTable {
  id: Generated<string>;
  household_id: string;
  connection_id: string;
  webhook_receipt_id: string | null;
  operation: Generated<string>;
  trigger: string;
  state: Generated<string>;
  attempts: Generated<number>;
  available_at: Timestamp;
  locked_at: Timestamp | null;
  completed_at: Timestamp | null;
  last_error_code: string | null;
  created_at: Timestamp;
}
export interface CalculationSnapshotsTable {
  id: Generated<string>;
  household_id: string;
  plan_id: string;
  plan_version: number;
  known_cash_minor: string;
  commitments_minor: string;
  planned_savings_minor: string;
  safety_buffer_minor: string;
  available_minor: string;
  currency: string;
  policy_version: string;
  input_fingerprint: string;
  horizon_start: DateOnly | null;
  horizon_end: DateOnly | null;
  freshness_status: Generated<string>;
  freshness_as_of: Timestamp | null;
  calculated_at: Timestamp;
}
export interface CalculationSnapshotInputsTable {
  household_id: string;
  snapshot_id: string;
  input_kind: string;
  input_id: string;
  input_version: number | null;
  input_hash: string;
  ordinal: number;
}
export interface SyncRunsTable {
  id: Generated<string>;
  household_id: string;
  connection_id: string;
  trigger: string;
  status: string;
  cursor_before: string | null;
  cursor_after: string | null;
  added_count: Generated<number>;
  modified_count: Generated<number>;
  removed_count: Generated<number>;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  error_code: string | null;
  created_at: Timestamp;
}
export interface ExceptionCasesTable {
  id: Generated<string>;
  household_id: string;
  case_type: string;
  status: string;
  expected_amount_minor: string | null;
  observed_amount_minor: string | null;
  currency: string | null;
  title: string;
  version: Generated<number>;
  detection_key: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface CaseEvidenceTable {
  id: Generated<string>;
  household_id: string;
  case_id: string;
  evidence_type: string;
  source_entity_type: string;
  source_entity_id: string;
  summary: string;
  merchant_snapshot: string | null;
  amount_minor_snapshot: string | null;
  currency_snapshot: string | null;
  occurred_on_snapshot: string | null;
  account_id_snapshot: string | null;
  account_name_snapshot: string | null;
  status_snapshot: string | null;
  provenance_snapshot: string | null;
  created_at: Timestamp;
}
export interface NotificationPreferencesTable {
  household_id: string;
  user_id: string;
  email_address: string | null;
  email_verified_at: Timestamp | null;
  email_consent_at: Timestamp | null;
  email_suppressed_at: Timestamp | null;
  email_enabled: Generated<boolean>;
  push_enabled: Generated<boolean>;
  connection_health: Generated<boolean>;
  commitment_reminders: Generated<boolean>;
  income_reminders: Generated<boolean>;
  savings_reminders: Generated<boolean>;
  exception_activity: Generated<boolean>;
  weekly_digest: Generated<boolean>;
  available_cash_alerts: Generated<boolean>;
  available_cash_threshold_minor: Generated<string>;
  lock_screen_detail: Generated<boolean>;
  reminder_hour: Generated<number>;
  reminder_minute: Generated<number>;
  commitment_reminder_days: Generated<number[]>;
  long_term_reminder_days: Generated<number[]>;
  savings_reminder_days: Generated<number[]>;
  quiet_start_minute: Generated<number>;
  quiet_end_minute: Generated<number>;
  version: Generated<number>;
  timezone: Generated<string>;
  updated_at: Timestamp;
}
export interface NotificationPreferenceRevisionsTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  version: number;
  email_enabled: boolean;
  push_enabled: boolean;
  connection_health: boolean;
  commitment_reminders: boolean;
  income_reminders: boolean;
  savings_reminders: boolean;
  exception_activity: boolean;
  weekly_digest: boolean;
  available_cash_alerts: boolean;
  available_cash_threshold_minor: string;
  lock_screen_detail: boolean;
  commitment_reminder_days: number[];
  long_term_reminder_days: number[];
  savings_reminder_days: number[];
  reminder_hour: number;
  reminder_minute: number;
  quiet_start_minute: number;
  quiet_end_minute: number;
  timezone: string;
  recorded_at: Timestamp;
}
export interface NotificationEndpointsTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  platform: string;
  token_hash: string;
  encrypted_token: Uint8Array;
  token_key_id: string;
  device_label: string;
  enabled: Generated<boolean>;
  registered_at: Timestamp;
  last_seen_at: Timestamp;
  disabled_at: Timestamp | null;
}
export interface NotificationEventsTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  event_type: string;
  title: string;
  body: string;
  deep_link_path: Generated<string>;
  dedupe_key: string;
  occurrence_id: Generated<string | null>;
  occurrence_revision: Generated<number | null>;
  preference_revision: number;
  scheduled_for: Timestamp;
  lead_days: Generated<number | null>;
  timezone_snapshot: Generated<string>;
  available_cash_episode_id: Generated<string | null>;
  created_at: Timestamp;
}
export interface AvailableCashAlertEpisodesTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  preference_revision: number;
  threshold_minor: string;
  hysteresis_minor: string;
  opened_snapshot_id: string;
  last_snapshot_id: string;
  opened_available_minor: string;
  last_available_minor: string;
  status: string;
  notify_eligible_at: Timestamp;
  notification_suppression_reason: string | null;
  opened_at: Timestamp;
  recovered_at: Timestamp | null;
  updated_at: Timestamp;
}
export interface AvailableCashAlertStatesTable {
  household_id: string;
  user_id: string;
  current_status: string;
  armed: boolean;
  current_episode_id: string | null;
  last_snapshot_id: string;
  last_evaluated_at: Timestamp;
  last_available_minor: string;
  updated_at: Timestamp;
}
export interface StarterTemplateApplicationsTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  template_key: string;
  template_version: number;
  request_id: string;
  plan_version: number;
  undone_at: Timestamp | null;
  undone_request_id: string | null;
  created_at: Timestamp;
}
export interface StarterTemplateApplicationItemsTable {
  household_id: string;
  application_id: string;
  item_key: string;
  commitment_id: string;
  commitment_version: number;
  name_snapshot: string;
  created_at: Timestamp;
}
export interface NotificationDeliveriesTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  event_id: string;
  endpoint_id: string | null;
  channel: string;
  destination_hash: string | null;
  state: Generated<string>;
  attempts: Generated<number>;
  available_at: Timestamp;
  locked_at: Timestamp | null;
  lease_token: Generated<string | null>;
  lease_generation: Generated<number>;
  sent_at: Timestamp | null;
  last_error_code: string | null;
  created_at: Timestamp;
}
export interface AccountDeletionRequestsTable {
  id: Generated<string>;
  household_id: string;
  user_id: string;
  status: Generated<string>;
  requested_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
  last_error_code: string | null;
}
export interface FinancialPatternAnalysesTable {
  id: Generated<string>;
  household_id: string;
  input_fingerprint: string;
  model: string;
  prompt_version: string;
  source: string;
  state: string;
  transaction_count: number;
  candidate_count: number;
  result: Json;
  created_at: Timestamp;
  expires_at: Timestamp;
}
export interface PlanOccurrencesTable {
  id: Generated<string>;
  household_id: string;
  supersedes_occurrence_id: string | null;
  source_key: string;
  kind: string;
  commitment_id: string | null;
  savings_goal_id: Generated<string | null>;
  income_schedule_id: Generated<string | null>;
  source_revision_kind: Generated<string>;
  source_revision_id: Generated<string>;
  source_revision_version: Generated<number>;
  name: string;
  expected_amount_minor: string | null;
  currency: Generated<string>;
  expected_on: DateOnly;
  state: Generated<string>;
  matched_amount_minor: Generated<string>;
  provenance: string;
  version: Generated<number>;
  verified_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface OccurrenceTransactionMatchesTable {
  id: Generated<string>;
  household_id: string;
  occurrence_id: string;
  transaction_id: string;
  reflected_in_balance_observation_id: string | null;
  amount_applied_minor: string;
  state: string;
  confidence: string;
  reason: string;
  version: Generated<number>;
  actor_user_id: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}
export interface PlanOccurrenceRevisionsTable {
  id: Generated<string>;
  household_id: string;
  occurrence_id: string;
  version: number;
  state: string;
  matched_amount_minor: string;
  verified_at: Timestamp | null;
  reason: string;
  actor_user_id: string | null;
  recorded_at: Timestamp;
}
export interface OccurrenceMatchRevisionsTable {
  id: Generated<string>;
  household_id: string;
  match_id: string;
  version: number;
  state: string;
  amount_applied_minor: string;
  reflected_in_balance_observation_id: string | null;
  reason: string;
  actor_user_id: string | null;
  recorded_at: Timestamp;
}
export interface AccountPlanningRoleRevisionsTable {
  id: Generated<string>;
  household_id: string;
  account_id: string;
  version: number;
  planning_role: string;
  account_name: string;
  account_type: string;
  provenance: string;
  actor_user_id: string | null;
  effective_at: Timestamp;
}
export interface PlanningPeriodsTable {
  id: Generated<string>;
  household_id: string;
  start_on: DateOnly;
  end_on: DateOnly;
  timezone_snapshot: string;
  boundary_basis: string;
  driving_income_schedule_id: string | null;
  driving_expected_occurrence_id: string | null;
  policy_version: string;
  input_fingerprint: string;
  created_at: Timestamp;
}
export interface PlanningPeriodRevisionsTable {
  id: Generated<string>;
  household_id: string;
  planning_period_id: string;
  version: number;
  supersedes_revision_id: string | null;
  state: string;
  reason: string;
  recorded_at: Timestamp;
}
export interface IncomeBoundariesTable {
  id: Generated<string>;
  household_id: string;
  boundary_on: DateOnly;
  timezone_snapshot: string;
  verification_level: string;
  verified_at: Timestamp;
  created_at: Timestamp;
}
export interface IncomeBoundaryRevisionsTable {
  id: Generated<string>;
  household_id: string;
  income_boundary_id: string;
  version: number;
  state: string;
  verification_level: string;
  reason: string;
  recorded_at: Timestamp;
}
export interface IncomeBoundaryEvidenceTable {
  id: Generated<string>;
  household_id: string;
  income_boundary_id: string;
  income_occurrence_id: string;
  income_occurrence_version: number;
  income_schedule_id: string;
  income_schedule_version: number;
  match_id: string;
  match_version: number;
  transaction_id: string;
  transaction_revision: number;
  balance_observation_id: string;
  amount_minor: string;
  created_at: Timestamp;
}
export interface PayCyclesTable {
  id: Generated<string>;
  household_id: string;
  start_boundary_id: string;
  end_boundary_id: string | null;
  start_on: DateOnly;
  end_on: DateOnly | null;
  timezone_snapshot: string;
  supersedes_cycle_id: string | null;
  topology_reason: string;
  created_at: Timestamp;
}
export interface PayCycleReportRevisionsTable {
  id: Generated<string>;
  household_id: string;
  pay_cycle_id: string;
  version: number;
  supersedes_revision_id: string | null;
  event_cutoff_at: Timestamp;
  algorithm_version: string;
  calculated_at: Timestamp;
  status: string;
  assurance: string;
  coverage_reason: string | null;
  earned_minor: string | null;
  spent_minor: string | null;
  pending_minor: string;
  saved_minor: string | null;
  savings_withdrawn_minor: string | null;
  commitments_expected_minor: string | null;
  commitments_paid_minor: string | null;
  commitments_remaining_minor: string | null;
  debt_paid_minor: string | null;
  opening_cash_minor: string | null;
  closing_cash_minor: string | null;
  unexplained_delta_minor: string | null;
  currency: string;
  output: Json;
  input_fingerprint: string;
}
export interface PayCycleReportInputsTable {
  id: Generated<string>;
  household_id: string;
  report_revision_id: string;
  ordinal: number;
  input_kind: string;
  input_id: string;
  input_version: number | null;
  role: string;
  amount_attributed_minor: string | null;
  input_snapshot: Json;
  input_hash: string;
}
export interface PayCycleAccountCoverageTable {
  id: Generated<string>;
  household_id: string;
  report_revision_id: string;
  account_id: string;
  planning_role: string;
  provenance: string;
  opening_observation_id: string | null;
  closing_observation_id: string | null;
  coverage_state: string;
  reason: string;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  households: HouseholdsTable;
  household_memberships: MembershipsTable;
  accounts: AccountsTable;
  savings_goals: SavingsGoalsTable;
  savings_goal_revisions: SavingsGoalRevisionsTable;
  savings_goal_movements: SavingsGoalMovementsTable;
  savings_movement_evidence: SavingsMovementEvidenceTable;
  debts: DebtsTable;
  debt_revisions: DebtRevisionsTable;
  debt_balance_observations: DebtBalanceObservationsTable;
  debt_term_observations: DebtTermObservationsTable;
  debt_apr_components: DebtAprComponentsTable;
  debt_payment_policies: DebtPaymentPoliciesTable;
  debt_payment_policy_revisions: DebtPaymentPolicyRevisionsTable;
  debt_payment_evidence: DebtPaymentEvidenceTable;
  debt_payment_evidence_reversals: DebtPaymentEvidenceReversalsTable;
  income_schedules: IncomeSchedulesTable;
  income_schedule_revisions: IncomeScheduleRevisionsTable;
  balance_observations: BalancesTable;
  financial_transactions: TransactionsTable;
  transaction_entities: TransactionEntitiesTable;
  transaction_source_aliases: TransactionSourceAliasesTable;
  transaction_category_assignments: TransactionCategoryAssignmentsTable;
  transaction_category_revisions: TransactionCategoryRevisionsTable;
  merchant_category_rules: MerchantCategoryRulesTable;
  commitments: CommitmentsTable;
  plans: PlansTable;
  plan_revisions: PlanRevisionsTable;
  commitment_revisions: CommitmentRevisionsTable;
  activity_events: ActivityTable;
  idempotency_records: IdempotencyTable;
  connections: ConnectionsTable;
  webhook_receipts: WebhooksTable;
  plaid_link_sessions: PlaidLinkSessionsTable;
  plaid_sync_jobs: PlaidSyncJobsTable;
  sync_runs: SyncRunsTable;
  calculation_snapshots: CalculationSnapshotsTable;
  calculation_snapshot_inputs: CalculationSnapshotInputsTable;
  exception_cases: ExceptionCasesTable;
  case_evidence: CaseEvidenceTable;
  notification_preferences: NotificationPreferencesTable;
  notification_preference_revisions: NotificationPreferenceRevisionsTable;
  notification_endpoints: NotificationEndpointsTable;
  notification_events: NotificationEventsTable;
  notification_deliveries: NotificationDeliveriesTable;
  available_cash_alert_episodes: AvailableCashAlertEpisodesTable;
  available_cash_alert_states: AvailableCashAlertStatesTable;
  starter_template_applications: StarterTemplateApplicationsTable;
  starter_template_application_items: StarterTemplateApplicationItemsTable;
  account_deletion_requests: AccountDeletionRequestsTable;
  financial_pattern_analyses: FinancialPatternAnalysesTable;
  plan_occurrences: PlanOccurrencesTable;
  plan_occurrence_revisions: PlanOccurrenceRevisionsTable;
  occurrence_transaction_matches: OccurrenceTransactionMatchesTable;
  occurrence_match_revisions: OccurrenceMatchRevisionsTable;
  account_planning_role_revisions: AccountPlanningRoleRevisionsTable;
  planning_periods: PlanningPeriodsTable;
  planning_period_revisions: PlanningPeriodRevisionsTable;
  income_boundaries: IncomeBoundariesTable;
  income_boundary_revisions: IncomeBoundaryRevisionsTable;
  income_boundary_evidence: IncomeBoundaryEvidenceTable;
  pay_cycles: PayCyclesTable;
  pay_cycle_report_revisions: PayCycleReportRevisionsTable;
  pay_cycle_report_inputs: PayCycleReportInputsTable;
  pay_cycle_account_coverage: PayCycleAccountCoverageTable;
}

export type AccountRow = Selectable<AccountsTable>;
export type NewAccount = Insertable<AccountsTable>;
export type CommitmentRow = Selectable<CommitmentsTable>;
export type CommitmentUpdate = Updateable<CommitmentsTable>;
