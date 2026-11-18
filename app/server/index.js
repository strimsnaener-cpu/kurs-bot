import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seedCatalog } from './seed.js';
import { seedAcademy } from './academy-seed.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const dbFile = process.env.DATABASE_FILE || path.join(root, 'data', 'app.db');

if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is missing. Copy .env.example to .env and follow the comment in it.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = openDb(dbFile);
if (seedCatalog(db)) console.log('Seeded the marketplace with 5 starter agents.');
if (seedAcademy(db)) console.log('Seeded the Academy with the six-month program outline.');
const app = createApp({
  db,
  encryptionKey: process.env.ENCRYPTION_KEY,
  publicDir: path.join(root, 'public'),
  baseUrl: process.env.BASE_URL || `http://localhost:${port}`,
  isProd,
  env: process.env,
});
app.engine.start();

http.createServer(app).listen(port, () => {
  console.log(`Running on http://localhost:${port}`);
  if (!isProd) console.log(`Dev emails (verification, reset links): http://localhost:${port}/api/dev/outbox`);
  console.log(`Agent replies: ${app.engine.llmMode}. Telegram: ${app.engine.useWebhooks ? 'webhooks via ' + process.env.PUBLIC_URL : 'long polling (no public URL needed)'}`);
});
