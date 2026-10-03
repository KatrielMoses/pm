// The image's frozen-lockfile install needs every workspace manifest copied before `pnpm install`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const missing = [];
for (const base of ['apps', 'packages']) {
  for (const name of readdirSync(base)) {
    const manifest = `${base}/${name}/package.json`;
    if (existsSync(manifest) && !dockerfile.includes(`COPY ${manifest} ${base}/${name}/`))
      missing.push(manifest);
  }
}
if (missing.length) {
  console.error(
    `Dockerfile does not copy workspace manifests before install:\n  - ${missing.join('\n  - ')}`,
  );
  process.exit(1);
}
console.log('Dockerfile manifest check passed');
