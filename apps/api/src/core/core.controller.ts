import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  accountInclusionRequestSchema,
  accountPlanningRoleRequestSchema,
  commitmentRequestSchema,
  debtCreateRequestSchema,
  debtUpdateRequestSchema,
  incomeScheduleCreateRequestSchema,
  incomeScheduleUpdateRequestSchema,
  exceptionDecisionRequestSchema,
  manualBalanceRequestSchema,
  manualModeRequestSchema,
  manualTransactionRequestSchema,
  manualTransactionUpdateSchema,
  manualTransactionVoidSchema,
  occurrenceSkipRequestSchema,
  planCalibrationRequestSchema,
  planUpdateRequestSchema,
  savingsGoalBalanceUpdateRequestSchema,
  savingsGoalCreateRequestSchema,
  savingsGoalUpdateRequestSchema,
  starterApplicationUndoRequestSchema,
  uuidSchema,
  transactionFeedQuerySchema,
  transactionCategoryUpdateSchema,
  transactionOccurrenceLinkRequestSchema,
  transactionOccurrenceUnlinkRequestSchema,
  merchantCategoryRuleDeleteSchema,
  merchantCategoryRuleUpdateSchema,
  payCycleQuerySchema,
} from "../../../../packages/contracts/src/index.js";
import type { AuthenticatedRequest } from "../auth/request-auth.js";
import { parseBody } from "../http/zod.js";
import { CoreService } from "./core.service.js";
import { getFeatureFlags } from "../config/feature-flags.js";

@Controller()
export class CoreController {
  constructor(@Inject(CoreService) private readonly core: CoreService) {}

  @Get("bootstrap")
  bootstrap(@Req() request: AuthenticatedRequest) {
    return this.core.getBootstrap(request.identity);
  }

  @Get("features")
  features() {
    return getFeatureFlags();
  }

  @Get("pay-cycles")
  payCycles(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.core.listPayCycles(
      request.identity,
      payCycleQuerySchema.parse(query),
    );
  }

  @Get("pay-cycles/:cycleId")
  payCycle(
    @Req() request: AuthenticatedRequest,
    @Param("cycleId") cycleId: string,
  ) {
    return this.core.getPayCycle(request.identity, uuidSchema.parse(cycleId));
  }

  @Post("income-schedules")
  createIncomeSchedule(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.core.addIncomeSchedule(
      request.identity,
      parseBody(incomeScheduleCreateRequestSchema, body),
    );
  }

  @Put("income-schedules/:scheduleId")
  updateIncomeSchedule(
    @Req() request: AuthenticatedRequest,
    @Param("scheduleId") scheduleId: string,
    @Body() body: unknown,
  ) {
    return this.core.updateIncomeSchedule(
      request.identity,
      uuidSchema.parse(scheduleId),
      parseBody(incomeScheduleUpdateRequestSchema, body),
    );
  }

  @Get("transactions")
  transactions(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.core.listTransactions(
      request.identity,
      transactionFeedQuerySchema.parse(query),
    );
  }

  @Put("transactions/:transactionId/category")
  categorizeTransaction(
    @Req() request: AuthenticatedRequest,
    @Param("transactionId") transactionId: string,
    @Body() body: unknown,
  ) {
    return this.core.updateTransactionCategory(
      request.identity,
      uuidSchema.parse(transactionId),
      parseBody(transactionCategoryUpdateSchema, body),
    );
  }

  @Post("transactions/:transactionId/link-occurrence")
  linkTransactionToOccurrence(
    @Req() request: AuthenticatedRequest,
    @Param("transactionId") transactionId: string,
    @Body() body: unknown,
  ) {
    return this.core.linkTransactionToOccurrence(
      request.identity,
      uuidSchema.parse(transactionId),
      parseBody(transactionOccurrenceLinkRequestSchema, body),
    );
  }

  @Post("transactions/:transactionId/unlink-occurrence")
  unlinkTransactionFromOccurrence(
    @Req() request: AuthenticatedRequest,
    @Param("transactionId") transactionId: string,
    @Body() body: unknown,
  ) {
    return this.core.unlinkTransactionFromOccurrence(
      request.identity,
      uuidSchema.parse(transactionId),
      parseBody(transactionOccurrenceUnlinkRequestSchema, body),
    );
  }

  @Put("transactions/:transactionId/manual")
  updateManualTransaction(
    @Req() request: AuthenticatedRequest,
    @Param("transactionId") transactionId: string,
    @Body() body: unknown,
  ) {
    return this.core.updateManualTransaction(
      request.identity,
      uuidSchema.parse(transactionId),
      parseBody(manualTransactionUpdateSchema, body),
    );
  }

  @Get("transaction-category-rules")
  transactionCategoryRules(@Req() request: AuthenticatedRequest) {
    return this.core.listMerchantCategoryRules(request.identity);
  }

  @Put("transaction-category-rules/:ruleId")
  updateTransactionCategoryRule(
    @Req() request: AuthenticatedRequest,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
  ) {
    return this.core.updateMerchantCategoryRule(
      request.identity,
      uuidSchema.parse(ruleId),
      parseBody(merchantCategoryRuleUpdateSchema, body),
    );
  }

  @Delete("transaction-category-rules/:ruleId")
  deleteTransactionCategoryRule(
    @Req() request: AuthenticatedRequest,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
  ) {
    return this.core.deleteMerchantCategoryRule(
      request.identity,
      uuidSchema.parse(ruleId),
      parseBody(merchantCategoryRuleDeleteSchema, body),
    );
  }

  @Post("transactions/:transactionId/void")
  voidManualTransaction(
    @Req() request: AuthenticatedRequest,
    @Param("transactionId") transactionId: string,
    @Body() body: unknown,
  ) {
    return this.core.voidManualTransaction(
      request.identity,
      uuidSchema.parse(transactionId),
      parseBody(manualTransactionVoidSchema, body),
    );
  }

  @Post("onboarding/complete")
  completeOnboarding(@Req() request: AuthenticatedRequest) {
    return this.core.completeOnboarding(request.identity);
  }

  @Post("manual/balances")
  saveManualBalance(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.core.saveManualBalance(
      request.identity,
      parseBody(manualBalanceRequestSchema, body),
    );
  }

  @Post("manual/activate")
  activateManualMode(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.core.activateManualMode(
      request.identity,
      parseBody(manualModeRequestSchema, body),
    );
  }

  @Post("manual/transactions")
  addManualTransaction(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.core.addManualTransaction(
      request.identity,
      parseBody(manualTransactionRequestSchema, body),
    );
  }

  @Post("commitments")
  addCommitment(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.core.addCommitment(
      request.identity,
      parseBody(commitmentRequestSchema, body),
    );
  }

  @Post("savings-goals")
  addSavingsGoal(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.core.addSavingsGoal(
      request.identity,
      parseBody(savingsGoalCreateRequestSchema, body),
    );
  }

  @Post("debts")
  addDebt(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.core.addDebt(
      request.identity,
      parseBody(debtCreateRequestSchema, body),
    );
  }

  @Put("debts/:debtId")
  updateDebt(
    @Req() request: AuthenticatedRequest,
    @Param("debtId") debtId: string,
    @Body() body: unknown,
  ) {
    return this.core.updateDebt(
      request.identity,
      uuidSchema.parse(debtId),
      parseBody(debtUpdateRequestSchema, body),
    );
  }

  @Put("savings-goals/:goalId")
  updateSavingsGoal(
    @Req() request: AuthenticatedRequest,
    @Param("goalId") goalId: string,
    @Body() body: unknown,
  ) {
    return this.core.updateSavingsGoal(
      request.identity,
      uuidSchema.parse(goalId),
      parseBody(savingsGoalUpdateRequestSchema, body),
    );
  }

  @Post("savings-goals/:goalId/balance")
  updateSavingsGoalBalance(
    @Req() request: AuthenticatedRequest,
    @Param("goalId") goalId: string,
    @Body() body: unknown,
  ) {
    return this.core.updateSavingsGoalBalance(
      request.identity,
      uuidSchema.parse(goalId),
      parseBody(savingsGoalBalanceUpdateRequestSchema, body),
    );
  }

  @Post("occurrences/:occurrenceId/skip")
  skipOccurrence(
    @Req() request: AuthenticatedRequest,
    @Param("occurrenceId") occurrenceId: string,
    @Body() body: unknown,
  ) {
    return this.core.skipPlanOccurrence(
      request.identity,
      uuidSchema.parse(occurrenceId),
      parseBody(occurrenceSkipRequestSchema, body),
    );
  }

  @Put("plan")
  updatePlan(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.core.updatePlan(
      request.identity,
      parseBody(planUpdateRequestSchema, body),
    );
  }

  @Put("plan/calibration")
  calibratePlan(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.core.calibratePlan(
      request.identity,
      parseBody(planCalibrationRequestSchema, body),
    );
  }

  @Delete("plan/starter-applications/:applicationId")
  undoStarterApplication(
    @Req() request: AuthenticatedRequest,
    @Param("applicationId") applicationId: string,
    @Body() body: unknown,
  ) {
    return this.core.undoStarterApplication(
      request.identity,
      uuidSchema.parse(applicationId),
      parseBody(starterApplicationUndoRequestSchema, body),
    );
  }

  @Put("accounts/:accountId/inclusion")
  setAccountInclusion(
    @Req() request: AuthenticatedRequest,
    @Param("accountId") accountId: string,
    @Body() body: unknown,
  ) {
    return this.core.setAccountInclusion(
      request.identity,
      uuidSchema.parse(accountId),
      parseBody(accountInclusionRequestSchema, body),
    );
  }

  @Put("accounts/:accountId/planning-role")
  setAccountPlanningRole(
    @Req() request: AuthenticatedRequest,
    @Param("accountId") accountId: string,
    @Body() body: unknown,
  ) {
    return this.core.setAccountPlanningRole(
      request.identity,
      uuidSchema.parse(accountId),
      parseBody(accountPlanningRoleRequestSchema, body),
    );
  }

  @Post("cases/:caseId/decision")
  decideException(
    @Req() request: AuthenticatedRequest,
    @Param("caseId") caseId: string,
    @Body() body: unknown,
  ) {
    return this.core.decideException(
      request.identity,
      uuidSchema.parse(caseId),
      parseBody(exceptionDecisionRequestSchema, body),
    );
  }
}
