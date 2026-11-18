import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';

test('old databases are upgraded without losing orders; Academy students become regular users', () => {
  const file = path.join(os.tmpdir(), `migrate-${process.pid}.db`);
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role TEXT, created_at TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, slug TEXT, created_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, slug TEXT, name TEXT, tagline TEXT, description TEXT, category TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT NOT NULL, agent_id TEXT NOT NULL, price_id TEXT NOT NULL,
      plan_name TEXT NOT NULL, interval TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT, created_at TEXT NOT NULL DEFAULT 'x', paid_at TEXT);
    INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1','s@example.com','Student','x','STUDENT','x');
    INSERT INTO orders (id, user_id, org_id, agent_id, price_id, plan_name, interval, amount, currency, status) VALUES ('o1','u1','g1','a1','p1','Старт','MONTH',2900,'USD','PAID');`);
  old.close();
  const db = openDb(file);
  const row = db.prepare('SELECT * FROM orders').get();
  assert.deepEqual([row.id, row.product_type, row.agent_id, row.amount, row.status], ['o1', 'AGENT', 'a1', 2900, 'PAID']);
  assert.equal(db.prepare("SELECT role FROM users WHERE id = 'u1'").get().role, 'USER');
  db.close();
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
});
