import type { z } from 'zod';

/** Parses with a zod schema; throws ZodError (rendered as 400 problem+json by ProblemFilter). */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}
