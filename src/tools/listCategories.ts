/**
 * tools/listCategories.ts
 *
 * Returns the 13 turnkey Polymarket categories Kreopoly supports as toggleable
 * filters. Used by the agent when helping the user configure a copy task or
 * filter their positions.
 *
 * This is a free, read-only tool with no arguments.
 */

import { z } from "zod";
import { POLYMARKET_CATEGORIES } from "../lib/categories.js";

export const listCategoriesSchema = z.object({}).optional();

export const listCategoriesTool = {
  name: "kreopoly_list_categories",
  description:
    "List the 13 turnkey Polymarket categories Kreopoly supports as toggleable " +
    "filters (Politics, Crypto, Sports, Pop Culture, Business, Economics, " +
    "Geopolitics, Science, Tech, AI, Climate, Entertainment, Legal). " +
    "Use these slugs in kreopoly_copy_trade (filters.categories) and " +
    "kreopoly_get_positions (category).",
  inputSchema: listCategoriesSchema ?? z.object({}),
  handler: async () => {
    return {
      ok: true,
      count: POLYMARKET_CATEGORIES.length,
      categories: POLYMARKET_CATEGORIES,
      hint:
        "Pass any of these slugs to kreopoly_copy_trade {filters: {categories: [...]}} " +
        "or kreopoly_get_positions {category: '...'} to filter.",
    };
  },
};
