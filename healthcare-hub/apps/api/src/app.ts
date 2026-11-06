import 'reflect-metadata';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HubError } from './common/problem.filter.js';
import { AppModule, type AppDeps } from './app.module.js';

/** Builds the configured Nest/Fastify app (shared by main.ts and tests). */
export async function createApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    loggerInstance: deps.logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
    maxParamLength: 512, // signed blob tokens travel in the path
  });
  // Only the signed evidence-upload route may carry a large body; everything else stays at 1 MB.
  adapter.getInstance().addHook('onRoute', (route) => {
    if (route.url.includes('/evidence/blob/')) route.bodyLimit = 52_428_800;
  });
  // Raw bytes for uploads (any content type); JSON routes keep Fastify's JSON parser.
  adapter.getInstance().removeContentTypeParser('text/plain'); // built-in parser yields strings; uploads need raw bytes
  adapter
    .getInstance()
    .addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => done(null, payload));
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(deps), adapter, {
    logger: false,
  });
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await fastify.register(cors, {
    origin: [deps.config.WEB_ORIGIN],
    credentials: true,
    // The library's default leaves out PUT, which the browser needs for direct evidence uploads.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Org-Id',
      'X-Location-Id',
      'Idempotency-Key',
      'If-Match',
    ],
  });
  await fastify.register(rateLimit, {
    max: deps.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // Thrown as a HubError so the problem filter answers 429 RATE_LIMITED: a plain object here
    // was not recognised and went out as a 500 internal error.
    errorResponseBuilder: (_req, ctx) =>
      new HubError('RATE_LIMITED', 429, `Too many requests. Try again in ${ctx.after}.`),
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  return app;
}
