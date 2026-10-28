import { z } from 'zod';
import type { getDb } from '@/db';
export { z };
export type Ctx = { db: <T>() => ReturnType<typeof getDb>; invalidateQueries: () => void; ownerId?: string; isOwner?: boolean };
export function defineAction<R extends z.ZodTypeAny, S extends z.ZodTypeAny>(config: {
  request: R; response: S; handler: (ctx: Ctx, args: z.infer<R>) => Promise<z.infer<S>>;
}) { return config; }
export type ActionsModule = Record<string, unknown>;
