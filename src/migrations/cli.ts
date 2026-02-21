#!/usr/bin/env node

/**
 * CLI tool for running database migrations
 * 
 * Usage:
 *   npx tsx src/migrations/cli.ts
 *   npx tsx src/migrations/cli.ts --schema my_schema
 *   npx tsx src/migrations/cli.ts --check
 * 
 * Environment variables:
 *   DATABASE_URL - Postgres connection string
 */

import { Pool } from 'pg';
import { runMigrations, getCurrentVersion, MigrationRaceError } from './runner';

interface CLIOptions {
  schema: string;
  check: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    schema: 'workflows',
    check: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--schema' && i + 1 < args.length) {
      options.schema = args[i + 1];
      i++;
    } else if (arg === '--check' || arg === '-c') {
      options.check = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: tsx src/migrations/cli.ts [options]

Options:
  --schema <name>    Schema name (default: workflows)
  --check, -c        Check current version without running migrations
  --help, -h         Show this help message

Environment:
  DATABASE_URL       Postgres connection string (required)

Examples:
  tsx src/migrations/cli.ts
  tsx src/migrations/cli.ts --schema my_workflows
  tsx src/migrations/cli.ts --check
      `);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const client = await pool.connect();

  try {
    if (options.check) {
      // Just check the current version
      const version = await getCurrentVersion(client, options.schema);
      
      if (version === null) {
        console.log(`Schema "${options.schema}" has no migrations applied`);
      } else {
        console.log(`Current migration version: ${version}`);
      }
    } else {
      // Run migrations
      console.log(`Running migrations on schema "${options.schema}"...`);
      
      const result = await runMigrations(client, {
        schemaName: options.schema,
      });
      
      console.log(`✓ Migrations complete (${result.durationMs}ms)`);
      
      if (result.applied.length > 0) {
        console.log(`  Applied: ${result.applied.join(', ')}`);
      } else {
        console.log(`  All migrations already applied`);
      }
      
      if (result.alreadyApplied.length > 0) {
        console.log(`  Total migrations: ${result.alreadyApplied.length}`);
      }
    }
  } catch (err) {
    if (err instanceof MigrationRaceError) {
      console.log('⚠ Migration already in progress by another process');
      console.log('  This is expected during concurrent startup');
    } else {
      console.error('✗ Migration failed:', err);
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
