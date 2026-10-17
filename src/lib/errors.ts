/**
 * lib/errors.ts
 *
 * Standardized error semantics for all Kreopoly Lens tools.
 *
 * Every tool that can fail returns:
 *   {
 *     ok: false,
 *     error: {
 *       code: ErrorCode,          // machine-readable
 *       message: string,           // human-readable explanation
 *       retryable: boolean,        // can the agent retry?
 *       upstreamStatus?: number,   // HTTP status from upstream (if applicable)
 *       upstreamProvider?: string, // e.g. "polygonscan", "polymarket-data-api"
 *       upstreamContentType?: string,
 *       upstreamPreview?: string,  // first ~200 chars of upstream body
 *     }
 *   }
 *
 * Tools MUST NOT silently convert errors into empty success responses.
 */

export const ErrorCode = {
  // Upstream errors (the API we called failed)
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  UPSTREAM_RATE_LIMITED: "UPSTREAM_RATE_LIMITED",
  UPSTREAM_INVALID_RESPONSE: "UPSTREAM_INVALID_RESPONSE",
  UPSTREAM_HTTP_ERROR: "UPSTREAM_HTTP_ERROR",
  UPSTREAM_HTML_RESPONSE: "UPSTREAM_HTML_RESPONSE",
  UPSTREAM_BLOCKED: "UPSTREAM_BLOCKED",

  // Client errors (the agent sent bad input)
  INVALID_PARAMETERS: "INVALID_PARAMETERS",
  WALLET_NOT_GRANTED: "WALLET_NOT_GRANTED",
  WALLET_NOT_FOUND: "WALLET_NOT_FOUND",
  WALLET_INVALID_FORMAT: "WALLET_INVALID_FORMAT",

  // Persistence errors
  WATCHLIST_PERSISTENCE_FAILED: "WATCHLIST_PERSISTENCE_FAILED",
  COPYTASK_PERSISTENCE_FAILED: "COPYTASK_PERSISTENCE_FAILED",

  // Activity/signal errors
  ACTIVITY_FETCH_FAILED: "ACTIVITY_FETCH_FAILED",
  NO_ACTIVITY: "NO_ACTIVITY",            // genuine zero (upstream confirmed OK)
  NO_MATCHING_TRADES: "NO_MATCHING_TRADES", // upstream OK, but filters rejected all
  NO_ACTIONABLE_SIGNAL: "NO_ACTIONABLE_SIGNAL",

  // Trade errors
  SIGNING_REQUIRED: "SIGNING_REQUIRED",
  SIGNING_FAILED: "SIGNING_FAILED",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  TRANSACTION_REVERTED: "TRANSACTION_REVERTED",
  MARKET_NOT_FOUND: "MARKET_NOT_FOUND",
  MARKET_CLOSED: "MARKET_CLOSED",
  MARKET_NOT_RESOLVED: "MARKET_NOT_RESOLVED",
  NO_SHARES_TO_REDEEM: "NO_SHARES_TO_REDEEM",
  BET_CONSTRUCTION_FAILED: "BET_CONSTRUCTION_FAILED",
  SETTLEMENT_CONSTRUCTION_FAILED: "SETTLEMENT_CONSTRUCTION_FAILED",

  // Internal
  INTERNAL_ERROR: "INTERNAL_ERROR",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The layer where a failure occurred. Useful for diagnostics.
 */
export type ErrorLayer =
  | "client_input"        // bad args from the agent
  | "activity_provider"   // Polygonscan / Polymarket Data API
  | "market_provider"     // Polymarket Gamma API
  | "watchlist_store"     // local watchlist persistence
  | "copytask_store"      // local copy-task persistence
  | "construction"        // building the order/redeem intent
  | "signing"             // PayBox signing layer (forwarded)
  | "execution"           // blockchain / Polymarket execution
  | "internal";           // unhandled / unexpected

export interface ToolError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** Which architectural layer the failure occurred at */
  layer?: ErrorLayer;
  upstreamStatus?: number;
  upstreamProvider?: string;
  upstreamContentType?: string;
  upstreamPreview?: string;
}

export interface ErrorResponse {
  ok: false;
  error: ToolError;
}

export interface SuccessResponse<T = unknown> {
  ok: true;
  [key: string]: unknown;
}

/**
 * Create a structured error response.
 */
export function makeError(
  code: ErrorCode,
  message: string,
  opts: {
    retryable?: boolean;
    layer?: ErrorLayer;
    upstreamStatus?: number;
    upstreamProvider?: string;
    upstreamContentType?: string;
    upstreamPreview?: string;
  } = {}
): ErrorResponse {
  // Auto-attribute the layer based on the error code
  const layer: ErrorLayer = opts.layer ?? defaultLayer(code);
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: opts.retryable ?? defaultRetryable(code),
      layer,
      upstreamStatus: opts.upstreamStatus,
      upstreamProvider: opts.upstreamProvider,
      upstreamContentType: opts.upstreamContentType,
      upstreamPreview: opts.upstreamPreview,
    },
  };
}

/**
 * Auto-attribute the architectural layer for a given error code.
 */
function defaultLayer(code: ErrorCode): ErrorLayer {
  switch (code) {
    case ErrorCode.UPSTREAM_TIMEOUT:
    case ErrorCode.UPSTREAM_RATE_LIMITED:
    case ErrorCode.UPSTREAM_INVALID_RESPONSE:
    case ErrorCode.UPSTREAM_HTML_RESPONSE:
    case ErrorCode.UPSTREAM_HTTP_ERROR:
    case ErrorCode.UPSTREAM_BLOCKED:
    case ErrorCode.ACTIVITY_FETCH_FAILED:
      return "activity_provider";
    case ErrorCode.WATCHLIST_PERSISTENCE_FAILED:
      return "watchlist_store";
    case ErrorCode.COPYTASK_PERSISTENCE_FAILED:
      return "copytask_store";
    case ErrorCode.INVALID_PARAMETERS:
    case ErrorCode.WALLET_INVALID_FORMAT:
      return "client_input";
    case ErrorCode.MARKET_NOT_FOUND:
    case ErrorCode.MARKET_CLOSED:
    case ErrorCode.MARKET_NOT_RESOLVED:
      return "market_provider";
    case ErrorCode.SIGNING_REQUIRED:
    case ErrorCode.SIGNING_FAILED:
      return "signing";
    case ErrorCode.INSUFFICIENT_BALANCE:
    case ErrorCode.TRANSACTION_REVERTED:
      return "execution";
    case ErrorCode.WALLET_NOT_GRANTED:
    case ErrorCode.WALLET_NOT_FOUND:
      return "signing";
    case ErrorCode.TASK_NOT_FOUND:
    case ErrorCode.NO_SHARES_TO_REDEEM:
    case ErrorCode.NO_ACTIVITY:
    case ErrorCode.NO_MATCHING_TRADES:
    case ErrorCode.NO_ACTIONABLE_SIGNAL:
      return "internal";
    case ErrorCode.INTERNAL_ERROR:
    default:
      return "internal";
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  switch (code) {
    case ErrorCode.UPSTREAM_TIMEOUT:
    case ErrorCode.UPSTREAM_RATE_LIMITED:
    case ErrorCode.UPSTREAM_HTTP_ERROR:
    case ErrorCode.UPSTREAM_HTML_RESPONSE:
    case ErrorCode.UPSTREAM_BLOCKED:
    case ErrorCode.ACTIVITY_FETCH_FAILED:
      return true;
    case ErrorCode.UPSTREAM_INVALID_RESPONSE:
    case ErrorCode.INVALID_PARAMETERS:
    case ErrorCode.WALLET_INVALID_FORMAT:
    case ErrorCode.MARKET_NOT_FOUND:
    case ErrorCode.MARKET_CLOSED:
    case ErrorCode.TASK_NOT_FOUND:
    case ErrorCode.NO_SHARES_TO_REDEEM:
      return false;
    default:
      return false;
  }
}

/**
 * Wraps a handler that may throw, converting thrown errors into a structured
 * ErrorResponse. Used by the MCP server's CallToolRequest handler.
 */
export function isErrorResponse(v: unknown): v is ErrorResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as any).ok === false &&
    typeof (v as any).error?.code === "string"
  );
}
