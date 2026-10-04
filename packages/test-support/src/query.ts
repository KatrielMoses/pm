import pg from 'pg';

/**
 * One query on a fresh connection to `url` (browser journeys seed test-only fixtures and inspect
 * state through it). The URL is never logged; errors carry the PostgreSQL message only.
 */
export async function queryUrl(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}
