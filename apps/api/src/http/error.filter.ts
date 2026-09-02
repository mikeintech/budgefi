import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const source = exception instanceof HttpException ? exception.getResponse() : null;
    const detail = typeof source === "object" && source !== null ? source as Record<string, unknown> : {};
    const message = typeof detail.message === "string" ? detail.message : exception instanceof Error && status < 500 ? exception.message : "Unexpected server error";
    const code = typeof detail.code === "string" ? detail.code : status === 400 ? "bad_request" : status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : status === 429 ? "rate_limited" : status === 503 ? "service_unavailable" : status >= 500 ? "internal_error" : "request_failed";
    const requestId = Array.isArray(request.headers["x-request-id"]) ? request.headers["x-request-id"]?.[0] : request.headers["x-request-id"];
    if (status >= 500) {
      const errorName = exception instanceof Error ? exception.name : "UnknownError";
      const errorMessage = exception instanceof Error ? exception.message : "Non-error exception";
      process.stderr.write(`${JSON.stringify({ level: "error", errorName, errorMessage, requestId: requestId ?? null })}\n`);
    }
    void response.status(status).send({ error: { code, message, requestId: requestId ?? null }, ...(detail.issues ? { issues: detail.issues } : {}) });
  }
}
