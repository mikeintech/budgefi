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
  version: Generated<number>;
  created_at: Timestamp;
  archived_at: Timestamp | null;
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
}
export interface CommitmentsTable {
  id: Generated<string>;
  household_id: string;
  name: string;
  amount_minor: string;
  currency: string;
  due_date: DateOnly | null;
  recurrence: string | null;
  provenance: string;
  version: Generated<number>;
  active: Generated<boolean>;
  settled_at: Timestamp | null;
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
  active: boolean;
  settled_at: Timestamp | null;
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
  exception_activity: Generated<boolean>;
  weekly_digest: Generated<boolean>;
  lock_screen_detail: Generated<boolean>;
  reminder_hour: Generated<number>;
  timezone: Generated<string>;
  updated_at: Timestamp;
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

export interface Database {
  users: UsersTable;
  households: HouseholdsTable;
  household_memberships: MembershipsTable;
  accounts: AccountsTable;
  balance_observations: BalancesTable;
  financial_transactions: TransactionsTable;
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
  notification_endpoints: NotificationEndpointsTable;
  notification_events: NotificationEventsTable;
  notification_deliveries: NotificationDeliveriesTable;
  account_deletion_requests: AccountDeletionRequestsTable;
  financial_pattern_analyses: FinancialPatternAnalysesTable;
}

export type AccountRow = Selectable<AccountsTable>;
export type NewAccount = Insertable<AccountsTable>;
export type CommitmentRow = Selectable<CommitmentsTable>;
export type CommitmentUpdate = Updateable<CommitmentsTable>;
