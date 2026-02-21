import { createHash } from 'crypto';
import { join } from 'path';
import type { PoolClient } from 'pg';
import { readFile, readdir } from "fs/promises";

const BOOSTRAP_SQL = `
-- =============================================================================
-- SCHEMA & MIGRATIONS TABLE
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS {{schema}};

-- Track applied migrations
CREATE TABLE IF NOT EXISTS {{schema}}.migrations (
    ver INTEGER PRIMARY KEY,

    prev_ver INTEGER GENERATED ALWAYS AS (
        CASE 
            WHEN ver = 0 THEN NULL
            ELSE ver - 1
        END
    ) STORED,
    
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_ver CHECK (ver > 0),

    CONSTRAINT fk_prev_migration
    FOREIGN KEY (prev_ver)
    REFERENCES {{schema}}.migrations(ver)
    ON DELETE SET NULL
    ON UPDATE RESTRICT
);`;

// =============================================================================
// TYPES
// =============================================================================

export interface Migration {
  /** Migration version number (e.g., 0, 1, 2) */
  version: number;
  /** SHA256 checksum of the SQL content */
  checksum: string;
  /** Raw SQL content with {{schema}} placeholders */
  sql: string;
  /** Original filename */
  filename: string;
}

export interface MigrationResult {
  /** Migrations that were already applied */
  alreadyApplied: number[];
  /** Migrations that were applied in this run */
  applied: number[];
  /** Total time taken in milliseconds */
  durationMs: number;
}

// =============================================================================
// ERRORS
// =============================================================================

export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly version?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class MigrationRaceError extends MigrationError {
  constructor(version: number) {
    super(
      `Migration ${version} is already being applied by another process. This is expected during concurrent startup.`,
      version
    );
    this.name = 'MigrationRaceError';
  }
}

export class MigrationChecksumMismatchError extends MigrationError {
  constructor(
    version: number,
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(
      `Migration ${version} has been modified. Expected checksum ${expected}, got ${actual}`,
      version
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

// =============================================================================
// MIGRATION DISCOVERY
// =============================================================================

/**
 * Load all migration files from the migrations directory
 * 
 * Migration files must follow the naming convention: `{version}.up.sql`
 * where version is a zero-padded integer (e.g., 00000.up.sql, 00001.up.sql)
 */
async function loadMigrations(): Promise<Migration[]> {
  const migrationsDir = join(__dirname, 'sql');
  
  const files = (await readdir(migrationsDir))
    .filter((f: string) => f.endsWith('.up.sql'))
    .sort(); // Lexical sort ensures correct order

  const migrations: Migration[] = [];
  for (const filename of files) {
    const version = parseInt(filename.split('.')[0], 10);
    if (isNaN(version)) {
      throw new Error(`Invalid migration filename: ${filename}. Expected format: {version}.up.sql`);
    }

    const sql = await readFile(join(migrationsDir, filename), 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    const migration = {
      version,
      checksum,
      sql,
      filename,
    };

    migrations.push(migration);
  }

  return migrations;
}

// =============================================================================
// TEMPLATE UTILITIES
// =============================================================================

/**
 * Replace {{schema}} placeholders with the actual schema name
 */
function templateSQL(sql: string, schemaName: string): string {
  return sql.replace(/\{\{schema\}\}/g, schemaName);
}

// =============================================================================
// MIGRATION RUNNER
// =============================================================================

/**
 * Run all pending migrations on the given database connection
 * 
 * This function is idempotent and safe for concurrent execution:
 * - Multiple processes can call this simultaneously
 * - Each migration is claimed via INSERT (acts as a lock)
 * - If another process claims a migration, this one will rollback and exit
 * - The migrations table foreign key ensures migrations run in order
 * 
 * @param client - A Postgres client connection (not a pool)
 * @param schemaName - The schema name to use (default: 'workflows')
 * @returns Migration result with details about what was applied
 * 
 * @throws {MigrationRaceError} If another process is applying the same migration
 * @throws {MigrationChecksumMismatchError} If an applied migration's checksum changed
 * @throws {MigrationError} For other migration failures
 * 
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { runMigrations } from './migrations/runner';
 * 
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const client = await pool.connect();
 * 
 * try {
 *   const result = await runMigrations(client, 'workflows');
 *   console.log(`Applied ${result.applied.length} migrations`);
 * } finally {
 *   client.release();
 * }
 * ```
 */
export async function runMigrations(
  client: PoolClient,
  opts?: { schemaName?: string }
): Promise<MigrationResult> {
  opts = opts ?? {};
  const { schemaName = process.env.SCHEMA_NAME ?? 'workflows' } = opts;

  const startTime = Date.now();
  const applied: number[] = [];
  const alreadyApplied: number[] = [];

  try {
    // Load all available migrations
    const migrations = await loadMigrations();

    if (migrations.length === 0) {
      return { alreadyApplied, applied, durationMs: Date.now() - startTime };
    }

    // Start transaction
    await client.query('BEGIN');

    // Phase 1: Bootstrap - Create schema and migrations table
    // This is idempotent and safe for concurrent execution
    await client.query(templateSQL(BOOSTRAP_SQL, schemaName));

    // Phase 2: Check which migrations are already applied
    const { rows } = await client.query<{ ver: number; checksum: string }>(
      `SELECT ver, checksum FROM ${schemaName}.migrations ORDER BY ver`
    );

    const appliedMigrations = new Map(rows.map(r => [r.ver, r.checksum]));

    // Phase 3: Validate checksums of already-applied migrations
    for (const migration of migrations) {
      const appliedChecksum = appliedMigrations.get(migration.version);
      
      if (appliedChecksum) {
        if (appliedChecksum !== migration.checksum) {
          throw new MigrationChecksumMismatchError(
            migration.version,
            appliedChecksum,
            migration.checksum
          );
        }
        alreadyApplied.push(migration.version);
      }
    }

    // Phase 4: Apply pending migrations
    for (const migration of migrations) {
      // Skip already-applied migrations
      if (appliedMigrations.has(migration.version)) {
        continue;
      }

      // Try to claim this migration by inserting into migrations table
      // This acts as a lock - only one process will succeed
      try {
        await client.query(
          `INSERT INTO ${schemaName}.migrations (ver, checksum) VALUES ($1, $2)`,
          [migration.version, migration.checksum]
        );
      } catch (err: any) {
        // Primary key violation - another process claimed this migration
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          throw new MigrationRaceError(migration.version);
        }

        // Foreign key violation - previous migration not applied
        if (err.code === '23503') {
          throw new MigrationError(
            `Migration ${migration.version} requires migration ${migration.version - 1} to be applied first`,
            migration.version,
            err
          );
        }

        throw err;
      }

      // We claimed this migration, now run it
      const sql = templateSQL(migration.sql, schemaName);
      await client.query(sql);
      applied.push(migration.version);
    }

    // Commit all changes
    await client.query('COMMIT');

    return {
      alreadyApplied,
      applied,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    // Rollback on any error
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Ignore rollback errors
    }

    // Re-throw migration errors as-is
    if (err instanceof MigrationError) {
      throw err;
    }

    // Wrap other errors
    throw new MigrationError(
      `Migration failed: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err
    );
  }
}

/**
 * Get the current migration version from the database
 * 
 * @param client - A Postgres client connection
 * @param schemaName - The schema name to check (default: 'workflows')
 * @returns The highest applied migration version, or null if no migrations have been applied
 * 
 * @example
 * ```typescript
 * const version = await getCurrentVersion(client);
 * console.log(`Current migration version: ${version}`);
 * ```
 */
export async function getCurrentVersion(
  client: PoolClient,
  schemaName: string = 'workflows'
): Promise<number | null> {
  try {
    const { rows } = await client.query<{ ver: number }>(
      `SELECT ver FROM ${schemaName}.migrations ORDER BY ver DESC LIMIT 1`
    );

    return rows.length > 0 ? rows[0].ver : null;
  } catch (err: any) {
    // If table doesn't exist, no migrations have been applied
    if (err.code === '42P01') {
      return null;
    }
    throw err;
  }
}
