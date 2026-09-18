/**
 * Ambient module declarations for vendored SQLite WASM glue files.
 * The glue is third-party (see ./vendor/PROVENANCE.md) and ships no types;
 * db.ts narrows the shapes it actually uses behind Sqlite3Module.
 */
declare module '*.mjs' {
  const initSqlite3: (options?: Record<string, unknown>) => Promise<unknown>;
  export default initSqlite3;
}
