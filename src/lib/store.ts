/**
 * lib/store.ts
 *
 * Local JSON-file persistence for the wallet watchlist.
 *
 * One file per PayBox user (keyed by the wallet address PayBox grants us).
 * In production this would be a real database; for the hackathon a flat
 * file is fine and keeps the plugin dependency-free.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface TrackedWallet {
  /** Polymarket / Polygon wallet address (checksummed or lowercase) */
  address: string;
  /** User-facing label, e.g. "Whale #1" */
  label: string;
  /** ISO timestamp when added */
  addedAt: string;
  /** Whether to include this wallet in activity digests */
  enabled: boolean;
}

interface StoreShape {
  /** PayBox user id (the credential subject) */
  userId: string;
  wallets: TrackedWallet[];
}

const DEFAULT_PATH = path.resolve(process.cwd(), ".data", "watchlist.json");

function storePath(): string {
  return process.env.WATCHLIST_PATH ?? DEFAULT_PATH;
}

async function readStore(): Promise<Record<string, StoreShape>> {
  try {
    const raw = await fs.readFile(storePath(), "utf-8");
    return JSON.parse(raw) as Record<string, StoreShape>;
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(data: Record<string, StoreShape>): Promise<void> {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(data, null, 2), "utf-8");
}

function getOrCreate(data: Record<string, StoreShape>, userId: string): StoreShape {
  if (!data[userId]) {
    data[userId] = { userId, wallets: [] };
  }
  return data[userId];
}

export async function addWallet(
  userId: string,
  address: string,
  label: string
): Promise<TrackedWallet> {
  const data = await readStore();
  const store = getOrCreate(data, userId);
  const normalized = address.toLowerCase();
  const existing = store.wallets.find((w) => w.address === normalized);
  if (existing) {
    existing.label = label || existing.label;
    existing.enabled = true;
    await writeStore(data);
    return existing;
  }
  const entry: TrackedWallet = {
    address: normalized,
    label,
    addedAt: new Date().toISOString(),
    enabled: true,
  };
  store.wallets.push(entry);
  await writeStore(data);
  return entry;
}

export async function removeWallet(
  userId: string,
  address: string
): Promise<boolean> {
  const data = await readStore();
  const store = data[userId];
  if (!store) return false;
  const normalized = address.toLowerCase();
  const before = store.wallets.length;
  store.wallets = store.wallets.filter((w) => w.address !== normalized);
  await writeStore(data);
  return store.wallets.length < before;
}

export async function listWallets(userId: string): Promise<TrackedWallet[]> {
  const data = await readStore();
  return data[userId]?.wallets ?? [];
}
