import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import {
  accountDeletionRequestSchema,
  notificationEndpointDisableRequestSchema,
  notificationEndpointRequestSchema,
  notificationPreferencesUpdateSchema,
  notificationTestRequestSchema,
  uuidSchema,
} from "../../../../packages/contracts/src/index.js";
import type { AuthenticatedRequest } from "../auth/request-auth.js";
import { parseBody } from "../http/zod.js";
import { OperationsService } from "./operations.service.js";

@Controller()
export class OperationsController {
  constructor(
    @Inject(OperationsService) private readonly operations: OperationsService
  ) {}

  @Get("notifications/preferences") preferences(
    @Req() request: AuthenticatedRequest
  ) {
    return this.operations.getPreferences(request.identity);
  }
  @Put("notifications/preferences") updatePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ) {
    return this.operations.updatePreferences(
      request.identity,
      parseBody(notificationPreferencesUpdateSchema, body)
    );
  }
  @Post("notifications/endpoints") registerEndpoint(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ) {
    return this.operations.registerEndpoint(
      request.identity,
      parseBody(notificationEndpointRequestSchema, body)
    );
  }
  @Delete("notifications/endpoints/:endpointId") disableEndpoint(
    @Req() request: AuthenticatedRequest,
    @Param("endpointId") endpointId: string,
    @Body() body: unknown
  ) {
    return this.operations.disableEndpoint(
      request.identity,
      uuidSchema.parse(endpointId),
      parseBody(notificationEndpointDisableRequestSchema, body)
    );
  }
  @Post("notifications/test") testNotification(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ) {
    return this.operations.queueTest(
      request.identity,
      parseBody(notificationTestRequestSchema, body)
    );
  }
  @Get("account/export") exportAccount(@Req() request: AuthenticatedRequest) {
    return this.operations.exportAccount(request.identity);
  }
  @Post("account/deletion") requestDeletion(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown
  ) {
    return this.operations.requestDeletion(
      request.identity,
      parseBody(accountDeletionRequestSchema, body)
    );
  }
  @Get("account/deletion") deletionStatus(
    @Req() request: AuthenticatedRequest
  ) {
    return this.operations.deletionStatus(request.identity);
  }
}
