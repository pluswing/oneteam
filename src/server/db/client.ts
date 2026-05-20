import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { ensureDatabaseDirectory } from "../config";
import * as schema from "./schema";

export type Database = LibSQLDatabase<typeof schema>;

export type DatabaseContext = {
  client: Client;
  db: Database;
};

export function createDatabaseContext(databaseUrl: string): DatabaseContext {
  ensureDatabaseDirectory(databaseUrl);
  const client = createClient({ url: databaseUrl });
  const db = drizzle(client, { schema });
  return { client, db };
}
