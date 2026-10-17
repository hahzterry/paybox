/**
 * lib/store.ts
 *
 * Local JSON-file persistence for the wallet watchlist.
 *
 * One file per PayBox user (keyed by the wallet address PayBox grants us).
 * In production this would be a real database; for the hackathon a flat
 * file is fine and keeps the plugin dependency-free.
 *
 * PERSISTENCE CONTRACT:
 *   write → commit → verify → return success
 *
 * If verification fails, we return ok:false — NEVER silently claim success
 * for a write that didn't persist.
 *
 * Atomic write strategy: write to a temp file, then rename. This prevents
 * partial writes on crash. After write, we re-read the file and verify the
 * entry is present.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface TrackedWallet {
  /** Polymarket / Polygon wallet address (lowercase) */
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

export interface AddWalletResult {
  ok: boolean;
  wallet?: TrackedWallet;
  /** Set when ok=false; explains why persistence failed */
  error?: string;
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

/**
 * Atomic write: write to temp file, then rename. Prevents partial writes
 * on crash. Verifies the write succeeded.
 *
 * Returns true if the write was verified, false otherwise.
 */
async function writeStoreVerified(
  data: Record<string, StoreShape>
): Promise<boolean> {
  const filePath = storePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // Write to a temp file first
  const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");

    // Atomic rename (on same filesystem, this is atomic on POSIX systems)
    await fs.rename(tmpPath, filePath);

    // VERIFY: re-read the file and confirm it parses correctly
    const verifyRaw = await fs.readFile(filePath, "utf-8");
    const verifyData = JSON.parse(verifyRaw) as Record<string, StoreShape>;
    // Sanity check: data round-tripped
    if (
      JSON.stringify(verifyData) !== JSON.stringify(data) &&
      // Allow re-ordering of keys by comparing serialized forms
      JSON.stringify(verifyData) !== JSON.stringify(data)
    ) {
      return false;
    }
    return true;
  } catch (err: any) {
    // Clean up temp file if rename failed
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    return false;
  }
}

function getOrCreate(
  data: Record<string, StoreShape>,
  userId: string
): StoreShape {
  if (!data[userId]) {
    data[userId] = { userId, wallets: [] };
  }
  return data[userId];
}

/**
 * Add a wallet to the watchlist. WRITE → COMMIT → VERIFY pattern.
 *
 * Returns { ok: true, wallet } only after durable persistence is confirmed.
 * Returns { ok: false, error } if persistence fails.
 */
export async function addWallet(
  userId: string,
  address: string,
  label: string
): Promise<AddWalletResult> {
  const data = await readStore();
  const store = getOrCreate(data, userId);
  const normalized = address.toLowerCase();
  const existing = store.wallets.find((w) => w.address === normalized);

  let entry: TrackedWallet;
  if (existing) {
    existing.label = label || existing.label;
    existing.enabled = true;
    entry = existing;
  } else {
    entry = {
      address: normalized,
      label,
      addedAt: new Date().toISOString(),
      enabled: true,
    };
    store.wallets.push(entry);
  }

  // Write + verify
  const verified = await writeStoreVerified(data);
  if (!verified) {
    return {
      ok: false,
      error: "Watchlist write could not be verified. The entry was not persisted.",
    };
  }

  // Double-verify: re-read and confirm the entry is actually there
  const recheck = await readStore();
  const recheckEntry = recheck[userId]?.wallets.find(
    (w) => w.address === normalized
  );
  if (!recheckEntry) {
    return {
      ok: false,
      error:
        "Watchlist write succeeded but entry not found on re-read. Filesystem may be ephemeral or read-only.",
    };
  }

  return { ok: true, wallet: recheckEntry };
}

export async function removeWallet(
  userId: string,
  address: string
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const data = await readStore();
  const store = data[userId];
  if (!store) return { ok: true, removed: false };
  const normalized = address.toLowerCase();
  const before = store.wallets.length;
  store.wallets = store.wallets.filter((w) => w.address !== normalized);
  if (store.wallets.length === before) {
    return { ok: true, removed: false };
  }

  const verified = await writeStoreVerified(data);
  if (!verified) {
    return {
      ok: false,
      removed: false,
      error: "Watchlist write could not be verified. The entry was not removed.",
    };
  }
  return { ok: true, removed: true };
}

export async function listWallets(userId: string): Promise<TrackedWallet[]> {
  const data = await readStore();
  return data[userId]?.wallets ?? [];
}
