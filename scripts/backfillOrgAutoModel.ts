import { customAlphabet } from 'nanoid';
import pg from 'pg';

const { Pool } = pg;

/** Mirrors packages/database/src/utils/idGenerator.ts (`modelAccessRules` -> `mar`). */
const nanoId = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 12);
const AUTO_MODEL_ID = 'openrouter/auto';

const DEFAULT_BATCH_SIZE = 100;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const batchSizeArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const batchSize = batchSizeArg
  ? Number.parseInt(batchSizeArg.slice('--batch-size='.length), 10)
  : DEFAULT_BATCH_SIZE;

if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
  throw new Error('--batch-size must be an integer between 1 and 1000');
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString });

/**
 * Grants the Auto routing model to every team that already grants at least
 * one model — i.e. teams that have been configured, not teams an admin
 * deliberately locked at zero (empty allow-list is a fail-closed "no models"
 * state per OrganizationModel.getAllowedModelsForMember, and must stay that
 * way). Auto only became part of the default set after this script was
 * written; existing teams seeded before that never got it and can't pick it
 * up retroactively on their own.
 */
const run = async () => {
  let cursor = '';
  let processedTeams = 0;
  let grantedTeams = 0;

  while (true) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const teamResult = await client.query<{ id: string; org_id: string }>(
        `
          SELECT t.id, t.org_id
          FROM organization_teams AS t
          WHERE t.id > $1
            AND EXISTS (
              SELECT 1 FROM model_access_rules AS mar
              WHERE mar.team_id = t.id AND mar.scope = 'team'
            )
            AND NOT EXISTS (
              SELECT 1 FROM model_access_rules AS mar
              WHERE mar.team_id = t.id AND mar.scope = 'team' AND mar.model_id = $2
            )
          ORDER BY t.id
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        `,
        [cursor, AUTO_MODEL_ID, batchSize],
      );
      const teams = teamResult.rows;

      if (teams.length === 0) {
        await client.query('COMMIT');
        break;
      }

      if (apply) {
        for (const team of teams) {
          await client.query(
            `
              INSERT INTO model_access_rules (id, org_id, scope, team_id, model_id)
              VALUES ($1, $2, 'team', $3, $4)
            `,
            [`mar_${nanoId()}`, team.org_id, team.id, AUTO_MODEL_ID],
          );
        }
      }

      await client.query('COMMIT');

      processedTeams += teams.length;
      grantedTeams += apply ? teams.length : 0;
      cursor = teams.at(-1)!.id;

      console.log(JSON.stringify({ apply, cursor, grantedTeams, processedTeams }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(JSON.stringify({ apply, complete: true, grantedTeams, processedTeams }));
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
