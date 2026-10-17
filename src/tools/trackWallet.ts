/**
 * tools/trackWallet.ts
 *
 * Add or remove a wallet from the user's watchlist.
 *
 * The watchlist is per-PayBox-user, stored locally. Used together with
 * kreopoly_get_tracked_activity to mirror Kreopoly's wallet-tracker feature.
 */

import { z } from "zod";
import {
  addWallet,
  removeWallet,
  listWallets,
  type TrackedWallet,
} from "../lib/store.js";

const addAction = z.object({
  action: z.literal("add").describe("Add a wallet to the watchlist."),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Polymarket / Polygon wallet address to track."),
  label: z
    .string()
    .max(64)
    .default("")
    .describe('Friendly name e.g. "Whale #1". Optional.'),
});

const removeAction = z.object({
  action: z.literal("remove"),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Wallet to stop tracking."),
});

const listAction = z.object({
  action: z.literal("list").describe("List currently tracked wallets."),
});

export const trackWalletSchema = z.discriminatedUnion("action", [
  addAction,
  removeAction,
  listAction,
]);

export type TrackWalletArgs = z.infer<typeof trackWalletSchema>;

export const trackWalletTool = {
  name: "kreopoly_track_wallet",
  description:
    "Manage the wallet watchlist (Kreopoly's wallet-tracker feature). " +
    "Actions: add, remove, list. Tracked wallets can be queried with " +
    "kreopoly_get_tracked_activity to mirror smart-money moves. Free read.",
  inputSchema: trackWalletSchema,
  handler: async (args: TrackWalletArgs, ctx: { userId: string }) => {
    const userId = ctx.userId || "anonymous";

    if (args.action === "add") {
      const entry: TrackedWallet = await addWallet(
        userId,
        args.walletAddress,
        args.label
      );
      return {
        ok: true,
        action: "added",
        wallet: entry,
        message: `Now tracking ${entry.address}${entry.label ? ` (${entry.label})` : ""}. ` +
          `Call kreopoly_get_tracked_activity to fetch recent trades.`,
      };
    }

    if (args.action === "remove") {
      const removed = await removeWallet(userId, args.walletAddress);
      return {
        ok: removed,
        action: "removed",
        message: removed
          ? `Stopped tracking ${args.walletAddress}.`
          : `Wallet ${args.walletAddress} was not in the watchlist.`,
      };
    }

    // list
    const wallets = await listWallets(userId);
    return {
      ok: true,
      action: "list",
      count: wallets.length,
      wallets,
      message:
        wallets.length === 0
          ? "Watchlist is empty. Use action='add' to start tracking a wallet."
          : undefined,
    };
  },
};
