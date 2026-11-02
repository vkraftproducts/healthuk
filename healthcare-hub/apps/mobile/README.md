# Healthcare Hub crew app

Expo (SDK 58) app for crews: My shift and gates, vehicle check, cleaning, assigned jobs, defects,
fuel receipts, policies, profile. Spec: `docs/MOBILE_APP.md`; decisions: `docs/DECISIONS.md` (M7).

```
pnpm dev                                   # API, mock OIDC, database
pnpm db:seed && pnpm --filter @hub/api demo:crew   # today's shift + one offered job for dev|crew
pnpm dev:mobile                            # Expo dev server (development build required: SQLCipher)
pnpm --filter @hub/mobile test             # Jest + Testing Library
maestro test apps/mobile/.maestro          # E2E on a device/emulator with a development build
eas build --profile pilot                  # internal pilot build (needs EAS project + store accounts)
```

Layout: `src/core` holds the logic with no native imports (outbox, sync, session and wipe, cache,
gate rules), so it is unit-tested; `src/native` adapts Expo modules; `src/screens` are the screens.
Everything is synthetic: the default control number is from the Ofcom drama range.
