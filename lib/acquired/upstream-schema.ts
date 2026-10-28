// Drizzle schema for this space.
//
// `sessions` — one row per blind-walk test session. The full answer state
// (baseline ratings, per-step ratings/skips, continue/stop choices, retest +
// aux ratings, computed verdict, bound route_id + route snapshot) is stored
// as a JSON string in `data`; the client owns the shape, the server treats
// it as opaque and only peeks at `verdict` / `routeId` / `routeTitle` for
// the history list.
//
// `routes` — the generic route library (schema "acquired-route/2"). One row
// per route: the full route JSON verbatim in `data`, keyed by `route_id`.
// Seeded on first use from server/src/seedRoutes.ts; users can import and
// delete routes at runtime through the route actions.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id"),
  data: text("data").notNull(),
  finished: integer("finished", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const routes = sqliteTable("routes", {
  routeId: text("route_id").primaryKey(),
  ownerId: text("owner_id"),
  title: text("title").notNull(),
  destination: text("destination").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

