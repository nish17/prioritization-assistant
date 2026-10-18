import { execSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import { migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { adminUrl, PG_CONTAINER, PG_PORT, TEMPLATE_DB } from "./pg.js";

const sh = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function canQuery(): Promise<boolean> {
  const c = new pg.Client({ connectionString: adminUrl(), connectionTimeoutMillis: 1000 });
  try {
    await c.connect();
    await c.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

export default async function setup(): Promise<void> {
  if (!process.env.TEST_PG_URL_BASE) {
    if (!sh(`docker ps -q -f name=^${PG_CONTAINER}$`)) {
      sh(`docker rm -f ${PG_CONTAINER} 2>/dev/null || true`);
      sh(
        `docker run -d --name ${PG_CONTAINER} -e POSTGRES_PASSWORD=postgres -p ${PG_PORT}:5432 postgres:16 ` +
          `-c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200`,
      );
    }
    // initdb restarts the server once, so require two successful queries a moment apart.
    const deadline = Date.now() + 60_000;
    for (;;) {
      if ((await canQuery()) && (await sleep(700), await canQuery())) break;
      if (Date.now() > deadline) throw new Error("test Postgres did not become ready");
      await sleep(500);
    }
  }

  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  process.env.MIGRATIONS_DIR = resolve(process.cwd(), "src/db/migrations");
  const pool = createPool(adminUrl(TEMPLATE_DB));
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
