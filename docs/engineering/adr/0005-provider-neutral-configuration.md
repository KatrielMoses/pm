# ADR-0005: Provider-neutral configuration and deployment boundary

Status: accepted (1A). Context: brief §3, §9; RELEASE_TOPOLOGY §3, §6; DQ-28; OD-43.

**Decision.** Twelve-factor environment variables validated by `zod` at startup, with explicit
modes (`local`, `test`, `preview`, `staging`, `production`); `.env` only in `local`. Secrets are
wrapped in `Secret`. A `SecretProvider` interface marks the boundary for the future secret
store/KMS; `secretref:` values are rejected until a vendor is approved. Namespace isolation has two
layers: database names must belong to `pm_<env>`, and each database records its environment in
`ops.environment_binding` at first migration; processes and the migrator refuse a mismatch.
Observability exports OTLP only; error reporting is an interface. CI: GitHub Actions workflow plus
the provider-portable `scripts/verify.sh`. No cloud resources, region, or vendor SDKs are chosen.

**Consequences.** Any container platform can run the image with the documented variable and
network contract (docs/engineering/environments.md).
