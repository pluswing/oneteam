import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AppConfig = {
  server: {
    host: string;
    port: number;
  };
  database: {
    url: string;
  };
};

export function loadConfig(): AppConfig {
  return {
    server: {
      host: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT ?? "3580")
    },
    database: {
      url: process.env.ONETEAM_DATABASE_URL ?? "file:./data/oneteam.db"
    }
  };
}

export function ensureDatabaseDirectory(databaseUrl: string): void {
  if (!databaseUrl.startsWith("file:")) {
    return;
  }

  const filePath = databaseUrl.replace(/^file:/, "");
  if (filePath === ":memory:" || filePath === "") {
    return;
  }

  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}
