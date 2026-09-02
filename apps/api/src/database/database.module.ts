import { Global, Module } from "@nestjs/common";
import { createDatabase } from "../../../../packages/database/src/index.js";
import { TenantDatabase } from "./tenant-database.js";
import { DATABASE } from "./database.token.js";

@Global()
@Module({
  providers: [
    { provide: DATABASE, useFactory: () => createDatabase() },
    TenantDatabase,
  ],
  exports: [DATABASE, TenantDatabase],
})
export class DatabaseModule {}
