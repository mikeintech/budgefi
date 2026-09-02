import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../api/src/database/database.module.js";
import { PlaidConfig } from "../../api/src/plaid/plaid.config.js";
import { PlaidGateway } from "../../api/src/plaid/plaid.gateway.js";
import { PlaidService } from "../../api/src/plaid/plaid.service.js";
import { PlaidTokenCrypto } from "../../api/src/plaid/token-crypto.js";

@Module({
  imports: [DatabaseModule],
  providers: [PlaidConfig, PlaidGateway, PlaidTokenCrypto, PlaidService],
})
export class PlaidWorkerModule {}
