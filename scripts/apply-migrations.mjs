// Applies supabase/migrations/*.sql in filename order against DATABASE_URL.
// Dev/test convenience only — real environments apply the SAME directory via
// the Supabase CLI (`supabase db push` / `supabase migration up`), keeping
// migration-first as the single path for schema changes.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'supabase',
  'migrations',
);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rowCount } = await client.query('select 1 from schema_migrations where version = $1', [
      file,
    ]);
    if (rowCount > 0) continue;

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied  ${file}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`FAILED   ${file}`);
      throw err;
    }
  }
  console.log('migrations up to date');
} finally {
  await client.end();
}
