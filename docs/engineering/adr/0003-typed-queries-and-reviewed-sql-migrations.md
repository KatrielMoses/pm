# ADR-0003: Kysely typed queries plus reviewed SQL migrations

Status: accepted (1A). Context: brief §5, 0B §10, 0C §12.

**Decision.** `pg` driver; Kysely for typed queries, so SQL stays visible and RLS behavior is not
hidden. Schemas, constraints, roles, RLS, functions, and indexes are hand-written SQL migrations
run by a small in-repo migrator (`packages/db/src/migrator.ts`) rather than a third-party tool,
because the requirements are specific: migrator-identity enforcement, SHA-256 checksums for up
**and** down files, a hash-chained history, expand/contract gating, environment binding, and an
advisory lock. Kysely's types (`schema.ts`) are kept honest by a schema-drift test against the
migrated catalog. No Prisma or ORM-managed migrations.

**Consequences.** ~300 lines of migrator to own; in exchange the tamper and identity guarantees are
tested directly. Kysely codegen can replace the hand-written types later.
