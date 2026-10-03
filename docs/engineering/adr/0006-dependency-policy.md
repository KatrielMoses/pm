# ADR-0006: Dependency policy

Status: accepted (1A).

- **Exact versions** (`saveExact`) and a committed lockfile; CI uses `--frozen-lockfile`.
- **Supply chain:** pnpm's minimum-release-age policy stays on (no exemptions; e.g. eslint is
  pinned to 10.11.0 because 10.12.0 was hours old). Install scripts run only for allow-listed
  packages (`allowBuilds`: embedded-postgres binaries); `cpu-features`, `ssh2`, `protobufjs` builds denied.
- **Scanning:** `pnpm audit` + OSV-Scanner (lockfile) and gitleaks (secrets), pinned and
  checksum-verified in CI (`scripts/install-scanners.sh`).
- **Licenses:** shipped code (image closure + browser runtime) must use MIT, ISC, Apache-2.0,
  BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, Python-2.0, CC0-1.0, Unlicense, MIT-0, or CC-BY-4.0.
  Build-only tools (e.g. lightningcss, MPL-2.0, inside Vite) are inventoried but not shipped.
- **Admission:** a new dependency must be maintained (release in the last 12 months), not
  duplicate an existing one, and not introduce infrastructure prohibited by Phase 0 (Redis, Kafka,
  Elasticsearch, vector databases, ORMs managing schema, cloud-vendor frameworks).
- **Updates:** monthly batch PR (all minors/patches, full `pnpm verify`); security advisories
  within the week; majors one at a time with an ADR note when behavior changes. Regenerate
  `docs/engineering/dependency-inventory.md` with `pnpm deps:licenses`.
- **Test-only exceptions:** `embedded-postgres` is published with a `-beta` suffix by its
  maintainer; it is a dev-only fallback that runs real PostgreSQL binaries when Docker is absent.
