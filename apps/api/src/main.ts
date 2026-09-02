import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { ErrorFilter } from "./http/error.filter.js";
import { assertAuthConfiguration } from "./auth/auth.guard.js";

assertAuthConfiguration();
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4422);
const host = process.env.API_HOST ?? "0.0.0.0";
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({
    bodyLimit: 256 * 1024,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.plaid-verification",
        "body.publicToken",
        "body.access_token",
        "body.public_token",
      ],
    },
  }),
  { rawBody: true },
);
app.setGlobalPrefix("v1");
app.enableCors({
  origin: process.env.WEB_ORIGIN?.split(",") ?? [
    "http://localhost:4411",
    "http://127.0.0.1:4411",
  ],
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Accept",
    "Authorization",
    "Content-Type",
    "X-Household-Id",
    "X-Request-Id",
    "X-Dev-Auth-Subject",
  ],
});
app.useGlobalFilters(new ErrorFilter());
app.enableShutdownHooks();
await app.listen(port, host);
