import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import {
  accountInclusionRequestSchema,
  commitmentRequestSchema,
  exceptionDecisionRequestSchema,
  manualBalanceRequestSchema,
  manualTransactionRequestSchema,
  planCalibrationRequestSchema,
  planUpdateRequestSchema,
  uuidSchema,
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
