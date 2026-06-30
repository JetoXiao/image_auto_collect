import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "../db/schema.sql");
const sql = await fs.readFile(schemaPath, "utf8");
const pool = createPool();

try {
  await pool.query(sql);
  console.log("Database schema is ready.");
} finally {
  await pool.end();
}
