import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { problemType, type ErrorCode, type Problem } from '@hub/contracts';

/** Thrown for business/auth failures that carry a stable code. */
export class HubError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    status: number,
    public readonly detail?: string,
    /** Structured check results (allocation / shift gate). Codes and reasons only. */
    public readonly checks?: Record<string, unknown>[],
  ) {
    super(code, status);
  }
}

const TITLES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Not permitted',
  NOT_FOUND: 'Not found',
  VALIDATION_FAILED: 'Request validation failed',
  ORG_REQUIRED: 'Organisation required',
  MFA_REQUIRED: 'Multi-factor authentication required',
  USER_INACTIVE: 'Account is not active',
  DEVICE_REVOKED: 'This device has been signed out',
  ALLOCATION_BLOCKED: 'Allocation blocked',
  SHIFT_GATE_BLOCKED: 'Shift start blocked',
  EVIDENCE_NOT_VERIFIED: 'Evidence not verified',
  STALE_VERSION: 'Stale version',
  OVERRIDE_NOT_PERMITTED: 'Override not permitted',
  FOUR_EYES_REQUIRED: 'A second person must approve this',
  CONFLICT: 'Conflicts with existing data',
  TEMPLATE_NOT_PUBLISHED: 'Requirement template is not published',
  UPLOAD_REJECTED: 'Upload rejected',
  TRANSITION_NOT_ALLOWED: 'Transition not allowed',
  SELF_APPROVAL: 'You cannot approve or change your own record',
  RATE_LIMITED: 'Too many requests',
  INTERNAL: 'Internal error',
};

export const notFound = () => new HubError('NOT_FOUND', 404);

/**
 * RFC 9457 problem+json. Never echoes request payloads, headers or exception internals
 * (no PII in error responses; CLAUDE.md #7).
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();
    const problem = this.toProblem(exception, req);
    if (problem.status >= 500) {
      this.log.error(
        { err: exception instanceof Error ? exception.name : 'unknown', reqId: req.id },
        'unhandled error',
      );
    }
    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }

  private toProblem(e: unknown, req: FastifyRequest): Problem {
    const instance = `${req.method} ${req.url.split('?')[0]}`;
    if (e instanceof HubError) {
      return {
        type: problemType(e.code),
        title: TITLES[e.code],
        status: e.getStatus(),
        code: e.code,
        detail: e.detail,
        instance,
        ...(e.checks ? { checks: e.checks } : {}),
      };
    }
    if (e instanceof ZodError) {
      return {
        type: problemType('VALIDATION_FAILED'),
        title: TITLES.VALIDATION_FAILED,
        status: 400,
        code: 'VALIDATION_FAILED',
        instance,
        errors: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const code: ErrorCode =
        status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 429
                ? 'RATE_LIMITED'
                : status >= 500
                  ? 'INTERNAL'
                  : 'VALIDATION_FAILED';
      return { type: problemType(code), title: TITLES[code], status, code, instance };
    }
    return {
      type: problemType('INTERNAL'),
      title: TITLES.INTERNAL,
      status: 500,
      code: 'INTERNAL',
      instance,
    };
  }
}
