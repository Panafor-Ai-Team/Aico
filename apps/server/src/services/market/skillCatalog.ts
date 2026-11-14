import { type LobeChatDatabase } from '@lobechat/database';
import {
  type MarketSkillCategory,
  type MarketSkillDetail,
  type MarketSkillListItem,
  type MarketSkillListResponse,
} from '@lobehub/market-sdk';
import { sql } from 'drizzle-orm';

/**
 * Reads the self-hosted skill catalog (`skill_catalog`, filled by
 * aico-skills/tools/to_postgres.py) so the market UI works without
 * market.lobehub.com. Comments and ratings have no catalog equivalent and are
 * served locally as empty/zero values; the ZIP download is in skillZip.ts.
 */

export interface SkillCatalogQuery {
  category?: string;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: string;
}

/** Table missing or not seeded yet: the caller should serve from upstream instead. */
export class CatalogUnavailableError extends Error {
  constructor(reason: string) {
    super(`skill_catalog unavailable: ${reason}`);
    this.name = 'CatalogUnavailableError';
  }
}

interface CatalogRow {
  author: { name?: string; url?: string } | null;
  category: string | null;
  content: string;
  description: string | null;
  github: Record<string, any> | null;
  identifier: string;
  installs: number | null;
  manifest: Record<string, any> | null;
  name: string | null;
  repo: string | null;
  resources: Record<string, any> | null;
  stars: number | null;
  total?: number;
  updated_at: string | null;
  version: string | null;
}

const LIST_COLUMNS =
  'identifier, name, description, category, repo, stars, installs, version, updated_at, author, github';
const DETAIL_COLUMNS = `${LIST_COLUMNS}, content, manifest, resources`;

/** Sort fields accepted by the market UI (`SkillSorts`). */
const ORDER_COLUMNS: Record<string, { column: string; dir: 'asc' | 'desc' }> = {
  createdAt: { column: 'updated_at', dir: 'desc' },
  installCount: { column: 'installs', dir: 'desc' },
  name: { column: 'name', dir: 'asc' },
  stars: { column: 'stars', dir: 'desc' },
  updatedAt: { column: 'updated_at', dir: 'desc' },
};

export const toListItem = (row: CatalogRow): MarketSkillListItem => ({
  author: row.author?.name,
  category: row.category ?? undefined,
  commentCount: 0,
  createdAt: row.updated_at ?? '',
  description: row.description ?? '',
  github: row.github ?? undefined,
  identifier: row.identifier,
  installCount: row.installs ?? 0,
  isFeatured: false,
  isOfficial: false,
  isValidated: false,
  name: row.name ?? row.identifier,
  ratingCount: 0,
  updatedAt: row.updated_at ?? '',
  version: row.version ?? '',
});

export const toDetail = (row: CatalogRow): MarketSkillDetail => ({
  author: row.author?.name ? { name: row.author.name, url: row.author.url } : undefined,
  category: row.category ?? undefined,
  content: row.content,
  createdAt: row.updated_at ?? '',
  description: row.description ?? '',
  github: row.github ?? undefined,
  identifier: row.identifier,
  installCount: row.installs ?? 0,
  isFeatured: false,
  isOfficial: false,
  isValidated: false,
  manifest: (row.manifest ?? {}) as MarketSkillDetail['manifest'],
  name: row.name ?? row.identifier,
  overview: { summary: row.description ?? undefined },
  ratingCount: 0,
  repository: row.repo ?? undefined,
  resources: (row.resources ?? {}) as MarketSkillDetail['resources'],
  updatedAt: row.updated_at ?? '',
  version: row.version ?? '',
  versionNumber: 0,
  versions: [],
});

const catalogHasRows = async (db: LobeChatDatabase) =>
  (await db.execute(sql`SELECT 1 FROM skill_catalog LIMIT 1`)).rows.length > 0;

/**
 * BM25 search over name+description; without a query it degrades to a filtered
 * catalog listing. `@@@` is ParadeDB's operator (pg_search ships with aico).
 */
export async function searchSkills(
  db: LobeChatDatabase,
  params: SkillCatalogQuery = {},
): Promise<MarketSkillListResponse> {
  const page = Math.max(params.page ?? 1, 1);
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const q = params.q?.trim();
  const relevance = !!q && (!params.sort || params.sort === 'relevance');

  const fallback = ORDER_COLUMNS[params.sort ?? ''] ?? ORDER_COLUMNS.installCount;
  const dir = params.order ?? fallback.dir;
  const order = relevance
    ? sql.raw('paradedb.score(identifier) DESC')
    : sql.raw(`${fallback.column} ${dir} NULLS LAST`);

  const buildQuery = (search: ReturnType<typeof sql> | undefined) => {
    const filters = [sql`TRUE`];
    if (params.category) filters.push(sql`category = ${params.category}`);
    if (search) filters.push(search);

    return db.execute(sql`
      SELECT ${sql.raw(LIST_COLUMNS)}, count(*) OVER () AS total
      FROM skill_catalog
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY ${order}, identifier ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
  };

  let rows: unknown[];
  try {
    rows = (await buildQuery(q ? sql`(name @@@ ${q} OR description @@@ ${q})` : undefined)).rows;
  } catch (error) {
    // BM25 query syntax rejects user input like an unbalanced quote; plain
    // substring matching keeps a bad query from turning into a 500.
    if (!q) throw error;
    const like = `%${q.replaceAll(/[%_\\]/g, (c) => `\\${c}`)}%`;
    rows = (await buildQuery(sql`(name ILIKE ${like} OR description ILIKE ${like})`)).rows;
  }

  const items = (rows as CatalogRow[]).map(toListItem);
  const totalCount = Number((rows[0] as CatalogRow | undefined)?.total ?? 0);

  // A migrated-but-empty table (fresh deployment) must not render an empty
  // market: treat it as "not seeded" so the caller falls back upstream.
  if (totalCount === 0 && !(await catalogHasRows(db))) {
    throw new CatalogUnavailableError('table is empty');
  }

  return {
    currentPage: page,
    items,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

export async function getSkillFromCatalog(
  db: LobeChatDatabase,
  identifier: string,
): Promise<MarketSkillDetail | undefined> {
  const { rows } = await db.execute(sql`
    SELECT ${sql.raw(DETAIL_COLUMNS)} FROM skill_catalog WHERE identifier = ${identifier} LIMIT 1
  `);
  const row = rows[0] as unknown as CatalogRow | undefined;

  return row ? toDetail(row) : undefined;
}

export async function getSkillCategoriesFromCatalog(
  db: LobeChatDatabase,
): Promise<MarketSkillCategory[]> {
  const { rows } = await db.execute(sql`
    SELECT category, count(*)::int AS count
    FROM skill_catalog
    WHERE category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC, category ASC
  `);

  const categories = (rows as unknown as { category: string; count: number }[]).map((r) => ({
    category: r.category,
    count: Number(r.count),
  }));
  if (categories.length === 0) throw new CatalogUnavailableError('no categories');

  return categories;
}

/** Installs are counted locally so the store never reports upstream numbers. */
export async function incrementSkillInstall(db: LobeChatDatabase, identifier: string) {
  await db.execute(sql`
    UPDATE skill_catalog SET installs = coalesce(installs, 0) + 1 WHERE identifier = ${identifier}
  `);
}
