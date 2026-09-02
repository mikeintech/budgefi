import { Body, Controller, Inject, Post, Req } from "@nestjs/common";
import { onboardingAnalysisRequestSchema } from "../../../../packages/contracts/src/index.js";
import type { AuthenticatedRequest } from "../auth/request-auth.js";
import { parseBody } from "../http/zod.js";
import { InsightsService } from "./insights.service.js";

@Controller("insights")
export class InsightsController {
  constructor(
    @Inject(InsightsService) private readonly insights: InsightsService,
  ) {}

  @Post("onboarding")
  analyzeOnboarding(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.insights.analyzeOnboarding(
      request.identity,
      parseBody(onboardingAnalysisRequestSchema, body),
    );
  }
}
