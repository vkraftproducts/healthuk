# ADR 0005: Expo React Native crew app

Status: Accepted. Alternatives: PWA (weaker iOS background sync, storage eviction, push
limits), native Swift/Kotlin (2 codebases). Decision: Expo with EAS Build; encrypted SQLite
outbox. Consequences: one TS codebase sharing packages/rules and contracts.
