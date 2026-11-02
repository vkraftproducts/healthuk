import { defineConfig } from 'prisma/config';

// The Prisma schema is used for the typed client only. Schema changes are made with
// forward-only SQL migrations in sql/migrations (RLS, triggers and constraints need raw SQL).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://hub_app@localhost:5432/hub' },
});
