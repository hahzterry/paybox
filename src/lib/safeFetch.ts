/**
 * lib/safeFetch.ts
 *
 * HTTP fetch helper that NEVER blindly calls .json() on a response.
 *
 * Inspects (in order):
 *   1. Network errors → UPSTREAM_TIMEOUT
 *   2. HTTP status (429, 5xx, redirects) → UPSTREAM_RATE_LIMITED / UPSTREAM_HTTP_ERROR
 *   3. Content-Type header → must include "application/json"
 *   4. Response body preview → detect HTML, Cloudflare WAF pages, error pages
 *   5. JSON parse → UPSTREAM_INVALID_RESPONSE if it fails
 *
 * Returns a discriminated union:
 *   - { ok: true, data: any, status, contentType }
 *   - { ok: false, error: ToolError }
 */

import { ErrorCode, type ToolError } from "./errors.js";

export interface SafeFetchSuccess {
  ok: true;
  data: any;
  status: number;
  contentType: string;
}

export interface SafeFetchFailure {
  ok: false;
  error: ToolError;
}

export type SafeFetchResult = SafeFetchSuccess | SafeFetchFailure;

export interface SafeFetchOptions {
  /** Upstream provider name for diagnostics (e.g. "polygonscan") */
  provider?: string;
  /** Headers to send */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 15000) */
  timeoutMs?: number;
  /** Max body preview length (default: 200 chars) */
  previewLength?: number;
  /** Expected response type — defaults to "json" */
  expect?: "json" | "text";
}

/**
 * Fetch a URL and safely parse the response.
 *
 * NEVER throws — always returns a SafeFetchResult.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const provider = opts.provider ?? "unknown";
  const timeoutMs = opts.timeoutMs ?? 15000;
  const previewLength = opts.previewLength ?? 200;
  const expect = opts.expect ?? "json";

  // --- 1. Network fetch with timeout -----------------------------------
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return {
        ok: false,
        error: {
          code: ErrorCode.UPSTREAM_TIMEOUT,
          message: `${provider}: request timed out after ${timeoutMs}ms`,
          retryable: true,
          upstreamProvider: provider,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_TIMEOUT,
        message: `${provider}: network error — ${err?.message ?? "unknown"}`,
        retryable: true,
        upstreamProvider: provider,
      },
    };
  }

  const status = res.status;
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

  // --- 2. Detect redirects (we set redirect: "follow" so this is unusual) -
  if (status >= 300 && status < 400) {
    const location = res.headers.get("location") ?? "(no location header)";
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_HTTP_ERROR,
        message: `${provider}: unexpected redirect to ${location}`,
        retryable: false,
        upstreamStatus: status,
        upstreamProvider: provider,
        upstreamContentType: contentType,
      },
    };
  }

  // --- 3. Rate limit ----------------------------------------------------
  if (status === 429) {
    const preview = await readPreview(res, previewLength);
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_RATE_LIMITED,
        message: `${provider}: rate limited (HTTP 429). Wait and retry.`,
        retryable: true,
        upstreamStatus: status,
        upstreamProvider: provider,
        upstreamContentType: contentType,
        upstreamPreview: preview,
      },
    };
  }

  // --- 4. Other HTTP errors --------------------------------------------
  if (status >= 400) {
    const preview = await readPreview(res, previewLength);
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_HTTP_ERROR,
        message: `${provider}: HTTP ${status}`,
        retryable: status >= 500,
        upstreamStatus: status,
        upstreamProvider: provider,
        upstreamContentType: contentType,
        upstreamPreview: preview,
      },
    };
  }

  // --- 5. Content-Type validation --------------------------------------
  // Many upstreams (Cloudflare WAF, error pages, etc.) return HTML when they
  // fail. Detect this BEFORE attempting JSON parse.
  const isHtml =
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml");

  if (expect === "json" && isHtml) {
    const preview = await readPreview(res, previewLength);
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_HTML_RESPONSE,
        message:
          `${provider}: returned HTML (content-type: ${contentType || "unknown"}) ` +
          `instead of JSON. Likely a Cloudflare/WAF page, error page, or upstream outage.`,
        retryable: true,
        upstreamStatus: status,
        upstreamProvider: provider,
        upstreamContentType: contentType,
        upstreamPreview: preview,
      },
    };
  }

  // --- 6. Detect Cloudflare challenge even with JSON content-type -------
  // Some Cloudflare pages return JSON-looking but actually contain challenge.
  const text = await res.text();

  // Detect common WAF / challenge patterns in the body
  const cloudflareIndicators = [
    "<!DOCTYPE html",
    "<html",
    "cf-browser-verification",
    "cf-challenge",
    "Just a moment",
    "Attention Required",
    "cloudflare",
    "__cf_bm",
    "Checking your browser",
    "Enable JavaScript and cookies to continue",
  ];

  const bodyLower = text.slice(0, 2000).toLowerCase();
  const matchedIndicator = cloudflareIndicators.find((ind) =>
    bodyLower.includes(ind.toLowerCase())
  );

  if (matchedIndicator) {
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_BLOCKED,
        message:
          `${provider}: response contains WAF/challenge indicator "${matchedIndicator}". ` +
          `Upstream is blocking the request.`,
        retryable: true,
        upstreamStatus: status,
        upstreamProvider: provider,
        upstreamContentType: contentType,
        upstreamPreview: text.slice(0, previewLength),
      },
    };
  }

  // --- 7. Parse JSON ----------------------------------------------------
  if (expect === "json") {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (err: any) {
      return {
        ok: false,
        error: {
          code: ErrorCode.UPSTREAM_INVALID_RESPONSE,
          message: `${provider}: JSON parse failed — ${err?.message ?? "unknown"}`,
          retryable: false,
          upstreamStatus: status,
          upstreamProvider: provider,
          upstreamContentType: contentType,
          upstreamPreview: text.slice(0, previewLength),
        },
      };
    }
    return {
      ok: true,
      data: parsed,
      status,
      contentType,
    };
  }

  // expect === "text"
  return {
    ok: true,
    data: text,
    status,
    contentType,
  };
}

async function readPreview(
  res: Response,
  length: number
): Promise<string> {
  try {
    // Clone so we don't consume the body if the caller wants to read it later
    const text = await res.clone().text();
    return text.slice(0, length);
  } catch {
    return "(could not read body)";
  }
}
