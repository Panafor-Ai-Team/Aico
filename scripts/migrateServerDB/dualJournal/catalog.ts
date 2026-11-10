import type { MigrationExecutor } from './runner';

/** Normalized catalog of the public schema, for fresh-vs-upgraded comparison. */
export const schemaSnapshot = async (executor: MigrationExecutor): Promise<Set<string>> => {
  const lines = new Set<string>();
  const columns = await executor.query<Record<string, string>>(`
    SELECT table_name, column_name, udt_name, is_nullable, coalesce(column_default, '') AS d
    FROM information_schema.columns WHERE table_schema = 'public'`);
  for (const c of columns) {
    lines.add(
      `col ${c.table_name}.${c.column_name} ${c.udt_name} null=${c.is_nullable} default=${c.d}`,
    );
  }
  const indexes = await executor.query<Record<string, string>>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
  );
  // Collapse whitespace: index options can embed JSON (BM25 `text_fields`) whose layout
  // differs between equivalent migration file versions.
  for (const i of indexes) lines.add(`idx ${i.indexname} ${i.indexdef.replaceAll(/\s+/g, ' ')}`);
  const constraints = await executor.query<Record<string, string>>(`
    SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace`);
  for (const c of constraints) lines.add(`con ${c.rel}.${c.conname} ${c.def}`);
  const triggers = await executor.query<Record<string, string>>(`
    SELECT event_object_table, trigger_name, event_manipulation, action_timing, action_statement
    FROM information_schema.triggers WHERE trigger_schema = 'public'`);
  for (const t of triggers) {
    lines.add(
      `trg ${t.event_object_table}.${t.trigger_name} ${t.action_timing} ${t.event_manipulation} ${t.action_statement}`,
    );
  }
  const functions = await executor.query<Record<string, string>>(`
    SELECT p.proname, md5(p.prosrc) AS src FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace`);
  for (const f of functions) lines.add(`fn ${f.proname} ${f.src}`);
  const enums = await executor.query<Record<string, string>>(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`);
  for (const e of enums) lines.add(`enum ${e.typname} ${e.labels}`);
  return lines;
};

export const diffSnapshots = (a: Set<string>, b: Set<string>) => ({
  onlyInFresh: [...a].filter((line) => !b.has(line)).sort(),
  onlyInUpgraded: [...b].filter((line) => !a.has(line)).sort(),
});
