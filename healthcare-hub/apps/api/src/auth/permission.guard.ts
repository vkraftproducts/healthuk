import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Logger } from 'pino';
import { LOGGER } from '../logger.provider.js';
import { AUTH_ONLY_KEY, ORG_MEMBER_KEY, PERMISSION_KEY, PUBLIC_KEY } from '../common/decorators.js';
import { getHub, type HubRequest } from '../common/context.js';
import { HubError } from '../common/problem.filter.js';

/**
 * Deny by default: a route must be @Public(), @AuthenticatedOnly() or declare
 * @RequirePermission(...). Undeclared routes are refused (and reported by a unit test).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(AUTH_ONLY_KEY, targets)) return true;

    const orgMember = this.reflector.getAllAndOverride<boolean>(ORG_MEMBER_KEY, targets);
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSION_KEY,
      targets,
    );
    if (!orgMember && (!required || required.length === 0)) {
      this.log.error(
        { route: ctx.getHandler().name },
        'route has no permission declaration; denying',
      );
      throw new HubError('FORBIDDEN', 403);
    }
    const hub = getHub(ctx.switchToHttp().getRequest<HubRequest>());
    if (!hub.orgId) throw new HubError('ORG_REQUIRED', 400, 'Send the X-Org-Id header');
    if (hub.mfaRequired && !hub.mfaSatisfied) throw new HubError('MFA_REQUIRED', 403);
    if (required && !required.every((k) => hub.permissions.has(k)))
      throw new HubError('FORBIDDEN', 403);
    return true;
  }
}
