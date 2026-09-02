import type { FastifyRequest } from "fastify";
import type { RequestIdentity } from "../database/tenant-database.js";

export type AuthenticatedRequest = FastifyRequest & { identity: RequestIdentity };
