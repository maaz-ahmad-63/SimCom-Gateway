import Database, { Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface DatabaseConnectionOptions {
  dbPath: string;
  walMode?: boolean;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

export function createDatabaseConnection(options: DatabaseConnectionOptions): DatabaseType {
  const resolvedPath = path.resolve(options.dbPath);
  const dir = path.dirname(resolvedPath);

  // Ensure database directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath, {
    verbose: options.verbose,
  });

  // Performance and safety pragmas
  if (options.walMode !== false) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  return db;
}
