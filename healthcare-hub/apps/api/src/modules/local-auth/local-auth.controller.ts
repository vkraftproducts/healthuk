import { Body, Controller, Header, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ChangePasswordRequest,
  ForcedPasswordChangeRequest,
  LoginRequest,
  MfaResetRequest,
  MfaSetupRequest,
  MfaVerifyRequest,
  type LoginResponse,
  type MfaResetResponse,
  type MfaSetupResponse,
  type PasswordResetResponse,
  type TokenResponse,
} from '@hub/contracts';
import { AuthenticatedOnly, Public, RequirePermission } from '../../common/decorators.js';
import { Hub, type HubRequestContext } from '../../common/context.js';
import { body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { CONFIG, type AppConfig } from '../../config.js';
import {
  clearedRefreshCookie,
  cookieSecure,
  readRefreshCookie,
  refreshCookie,
} from '../../auth/refresh-cookie.js';
import { LocalAuthService, type WithRefresh } from './local-auth.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Local username + password sign-in (AUTH_MODE=local only; 404 in other modes; ADR 0006).
 * The sign-in steps are @Public: they are how a token is obtained. Replies are never cached.
 * A completed sign-in also sets the HttpOnly refresh cookie; /auth/refresh rotates it and
 * /auth/logout clears it.
 */
@Controller('auth')
export class LocalAuthController {
  constructor(
    @Inject(LocalAuthService) private readonly auth: LocalAuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() raw: unknown,
  ): Promise<LoginResponse> {
    return this.withCookie(reply, await this.auth.login(body(LoginRequest, raw), req.ip));
  }

  @Public()
  @Post('mfa/setup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  mfaSetup(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<MfaSetupResponse> {
    return this.auth.mfaSetup(body(MfaSetupRequest, raw).challengeId, req.ip);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async mfaVerify(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() raw: unknown,
  ): Promise<LoginResponse> {
    return this.withCookie(reply, await this.auth.mfaVerify(body(MfaVerifyRequest, raw), req.ip));
  }

  @Public()
  @Post('forced-password-change')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async forcedPasswordChange(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() raw: unknown,
  ): Promise<TokenResponse> {
    const input = body(ForcedPasswordChangeRequest, raw);
    return this.withCookie(reply, await this.auth.forcedPasswordChange(input, req.ip));
  }

  /** Public: the access token may have expired. The refresh cookie is the credential. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TokenResponse> {
    this.sameOrigin(req);
    try {
      return this.withCookie(
        reply,
        await this.auth.refresh(readRefreshCookie(req.headers.cookie), req.ip),
      );
    } catch (e) {
      reply.header('set-cookie', clearedRefreshCookie(cookieSecure(this.config)));
      throw e;
    }
  }

  @AuthenticatedOnly()
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Hub() hub: HubRequestContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() raw: unknown,
  ): Promise<{ changed: true }> {
    const result = await this.auth.changePassword(hub, body(ChangePasswordRequest, raw), req.ip);
    return this.withCookie(reply, result);
  }

  /** Public so that signing out works after the access token has expired. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ signedOut: true }> {
    this.sameOrigin(req);
    const header = req.headers.authorization;
    const bearer = typeof header === 'string' ? (/^Bearer (\S+)$/.exec(header)?.[1] ?? null) : null;
    const out = await this.auth.logout(readRefreshCookie(req.headers.cookie), bearer, req.ip);
    reply.header('set-cookie', clearedRefreshCookie(cookieSecure(this.config)));
    return out;
  }

  private withCookie<T>(reply: FastifyReply, result: WithRefresh<T>): T {
    if (result.refresh) {
      const { value, maxAgeSeconds } = result.refresh;
      reply.header('set-cookie', refreshCookie(value, maxAgeSeconds, cookieSecure(this.config)));
    }
    return result.body;
  }

  /** Defence in depth beside SameSite=Strict: a browser request must come from the web app. */
  private sameOrigin(req: FastifyRequest): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && origin !== this.config.WEB_ORIGIN)
      throw new HubError('FORBIDDEN', 403);
  }
}

/** Administrator actions on a member's local credentials (audited in the service transaction). */
@Controller('admin')
export class LocalAuthAdminController {
  constructor(@Inject(LocalAuthService) private readonly auth: LocalAuthService) {}

  @RequirePermission('admin.users.manage')
  @Post('users/:id/reset-password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resetPassword(
    @Hub() hub: HubRequestContext,
    @Param('id') rawId: string,
  ): Promise<PasswordResetResponse> {
    if (!UUID.test(rawId)) throw notFound();
    return this.auth.resetPassword(hub, rawId.toLowerCase());
  }

  @RequirePermission('admin.users.manage')
  @Post('users/:id/mfa-reset')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  mfaReset(
    @Hub() hub: HubRequestContext,
    @Param('id') rawId: string,
    @Body() raw: unknown,
  ): Promise<MfaResetResponse> {
    if (!UUID.test(rawId)) throw notFound();
    return this.auth.mfaReset(hub, rawId.toLowerCase(), body(MfaResetRequest, raw));
  }
}
