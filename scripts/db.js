import fs from "node:fs";
import pg from "pg";

const { Pool } = pg;

const defaultPasswordFile = "D:\\Program Files\\PostgreSQL\\credentials\\postgres_password.txt";

export function readPgPassword() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  if (process.env.PG_PASSWORD) return process.env.PG_PASSWORD;
  const passwordFile = process.env.PG_PASSWORD_FILE || defaultPasswordFile;
  if (fs.existsSync(passwordFile)) {
    return fs.readFileSync(passwordFile, "utf8").trim();
  }
  return undefined;
}

export function createPool() {
  return new Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "image_auto_collect",
    user: process.env.PGUSER || "postgres",
    password: readPgPassword(),
    max: 10
  });
}
