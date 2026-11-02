import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONTROLLERS } from '../src/app.module.js';
import {
  AUTH_ONLY_KEY,
  ORG_MEMBER_KEY,
  PERMISSION_KEY,
  PUBLIC_KEY,
} from '../src/common/decorators.js';

export interface Route {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Express-style path with {param} placeholders, as in OpenAPI, relative to /api/v1 (or absolute for unversioned). */
  openApiPath: string;
  url: string;
  isPublic: boolean;
  needsPermission: boolean;
  orgMember: boolean;
  permissions: string[];
}

const METHODS: Record<number, Route['method']> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
};
export const SAMPLE_UUID = '01900000-0000-7000-8000-0000000000ff';

export function discoverRoutes(): Route[] {
  const reflector = new Reflector();
  const out: Route[] = [];
  for (const C of CONTROLLERS) {
    const base = String(Reflect.getMetadata('path', C) ?? '').replace(/^\/|\/$/g, '');
    for (const name of Object.getOwnPropertyNames(C.prototype)) {
      const fn = (C.prototype as unknown as Record<string, unknown>)[name];
      if (typeof fn !== 'function') continue;
      const sub = Reflect.getMetadata('path', fn) as string | undefined;
      const m = Reflect.getMetadata('method', fn) as number | undefined;
      if (sub === undefined || m === undefined) continue;
      const path = [base, sub.replace(/^\/|\/$/g, '')].filter(Boolean).join('/');
      const isPublic = Boolean(reflector.get(PUBLIC_KEY, fn));
      const permissions = (reflector.get(PERMISSION_KEY, fn) as string[] | undefined) ?? [];
      const unversioned = isPublic && (path === 'healthz' || path === 'readyz');
      out.push({
        name: `${C.name}.${name}`,
        method: METHODS[m] ?? 'GET',
        openApiPath: (unversioned ? '/' : '/api/v1/') + path.replace(/:([A-Za-z]+)/g, '{$1}'),
        url: (unversioned ? '/' : '/api/v1/') + path.replace(/:[A-Za-z]+/g, SAMPLE_UUID),
        isPublic,
        needsPermission: !reflector.get(AUTH_ONLY_KEY, fn) && permissions.length > 0,
        orgMember: Boolean(reflector.get(ORG_MEMBER_KEY, fn)),
        permissions,
      });
    }
  }
  return out;
}
