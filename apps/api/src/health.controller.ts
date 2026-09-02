import { Controller, Get, Inject } from "@nestjs/common";
import { TenantDatabase } from "./database/tenant-database.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  async health() {
    await this.database.healthCheck();
    return { status: "ok", service: "budgefi-api" };
  }
}
