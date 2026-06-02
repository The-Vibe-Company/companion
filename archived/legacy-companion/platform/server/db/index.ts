import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

/**
 * Lazy singleton for the Drizzle ORM client using postgres.js driver.
 *
 * Requires `DATABASE_URL` env var (standard Postgres connection string).
 * The singleton avoids creating multiple connections and mirrors the lazy
 * initialisation pattern used in `stripe.ts`.
 *
 * The underlying postgres.js `sql` client is retained so it can be drained
 * on process shutdown via `closeDb()`.
 */
let _db: PostgresJsDatabase<typeof schema> | null = null;
let _sql: Sql | null = null;

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _sql = postgres(url);
    _db = drizzle(_sql, { schema });
  }
  return _db;
}

/** Drain the connection pool for graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _db = null;
  }
}
