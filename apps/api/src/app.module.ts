import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth/auth.guard.js";
import { ClerkAccountPolicyService } from "./auth/clerk-account-policy.service.js";
import { ClerkWebhookController } from "./auth/clerk-webhook.controller.js";
import { ClerkWebhookService } from "./auth/clerk-webhook.service.js";
import { NativeAuthController } from "./auth/native-auth.controller.js";
import { NativeAuthService } from "./auth/native-auth.service.js";
import { CoreController } from "./core/core.controller.js";
import { CoreService } from "./core/core.service.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { PlaidConfig } from "./plaid/plaid.config.js";
import { PlaidController } from "./plaid/plaid.controller.js";
import { PlaidGateway } from "./plaid/plaid.gateway.js";
import { PlaidService } from "./plaid/plaid.service.js";
import { PlaidTokenCrypto } from "./plaid/token-crypto.js";
import { OperationsController } from "./operations/operations.controller.js";
import { OperationsService } from "./operations/operations.service.js";
import { NotificationTokenCrypto } from "./operations/notification-token-crypto.js";
import { InsightsController } from "./insights/insights.controller.js";
import { InsightsGateway } from "./insights/insights.gateway.js";
import { InsightsService } from "./insights/insights.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, CoreController, PlaidController, OperationsController, NativeAuthController, ClerkWebhookController, InsightsController],
  providers: [CoreService, PlaidConfig, PlaidGateway, PlaidTokenCrypto, PlaidService, OperationsService, NotificationTokenCrypto, NativeAuthService, ClerkAccountPolicyService, ClerkWebhookService, InsightsGateway, InsightsService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
