import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, type Pool } from "../../src/db/pool.js";

// Local Docker postgres:16 (multi-connection, so the advisory-lock tests are real).
export const PG_CONTAINER = "prioritizer-test-pg";
export const PG_PORT = 55432;
export const TEMPLATE_DB = "prioritizer_template";
export const adminUrl = (db = "postgres") =>
  process.env.TEST_PG_URL_BASE ? `${process.env.TEST_PG_URL_BASE}/${db}` : `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${db}`;

export interface TestDb {
  pool: Pool;
  url: string;
  drop(): Promise<void>;
}

/** A fresh database cloned from the migrated template. */
export async function freshDb(): Promise<TestDb> {
  const name = `t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const url = adminUrl(name);
  const pool = createPool(url);
  return {
    pool,
    url,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
