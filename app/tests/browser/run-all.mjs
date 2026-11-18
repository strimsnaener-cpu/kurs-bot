// Runs every browser test in order. First time: npm i -D playwright && npx playwright install chromium
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
const files = fs.readdirSync(dir).filter(f => /^\d\d-.*\.mjs$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [`${dir}${f}`], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} browser test file(s) had problems` : '\nAll browser tests ran');
process.exit(failed ? 1 : 0);
