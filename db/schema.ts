export { routes, sessions } from "../lib/acquired/upstream-schema";
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const acquiredRuns = sqliteTable('acquired_runs', {
 id:text('id').primaryKey(), action:text('action').notNull(), status:text('status').notNull(),
 routeId:text('route_id'), metrics:text('metrics').notNull(), createdAt:integer('created_at').notNull(),
});
export const acquiredBuildLock = sqliteTable('acquired_build_lock', {
 id:text('id').primaryKey(), requestId:text('request_id').notNull(), expiresAt:integer('expires_at').notNull(),
});

// Atomic rolling counters for the public beta. Keys carry an expiry bucket.
export const acquiredUsage = sqliteTable('acquired_usage', {
 id:text('id').primaryKey(), used:integer('used').notNull(), expiresAt:integer('expires_at').notNull(),
});
