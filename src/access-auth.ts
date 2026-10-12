/**
 * Cloudflare Access authentication.
 *
 * The server is published only through a Cloudflare Tunnel whose hostname
 * is a self-hosted Access application with Managed OAuth enabled. Access
 * runs the whole OAuth 2.1 flow (discovery, dynamic client registration,
 * PKCE, login against the Access policy) and forwards each authorized
 * request with a signed JWT in the Cf-Access-Jwt-Assertion header.
 *
 * Cloudflare requires the origin to validate that JWT, so a request that
 * reaches the origin without passing Access (another tunnel route, a
 * process on the host) is still rejected. We check the signature against
 * the team's public keys, the issuer, the application audience (AUD tag),
 * that `exp` is present and not passed, and that the identity is on the
 * allow-list.
 *
 * Key availability: the team's keys are cached for 12 h, and if fetching
 * them fails (DNS/egress blip) the last good set is used for up to 24 h,
 * so a short outage doesn't turn every valid request into a 401. A key
 * fetch failure with no usable cached keys answers 503, not 401, so the
 * client doesn't mistake it for a revoked token.
 */

import type { NextFunction, Request, Response } from "express";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

export interface AccessAuthOptions {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience: string;
  /** Lower-cased e-mail addresses allowed to use the connector. */
  allowedEmails: string[];
  /** Override the key set entirely (tests). */
  keys?: JWTVerifyGetKey;
  /** Override where keys are fetched from (tests). Default: the team's /cdn-cgi/access/certs. */
  jwksUrl?: string;
  /** How long fetched keys are trusted before a refetch (default 12 h). */
  cacheMaxAgeMs?: number;
  /** How long the last good keys may stand in when refetching fails (default 24 h). */
  staleIfErrorMs?: number;
  onReject?: (reason: string, req: Request) => void;
}

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

const HOUR = 60 * 60 * 1000;

export type AccessAuthMiddleware = ((req: Request, res: Response, next: NextFunction) => Promise<void>) & {
  /** Fetch the team keys now (best effort), so the first request doesn't wait. */
  prefetch: () => Promise<void>;
};

/** Errors that mean "could not get the keys", as opposed to "bad token". */
export function isKeyFetchError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch() network failure
  const e = err as { code?: string; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "ERR_JWKS_TIMEOUT" || e.code === "ERR_JWKS_INVALID") return true;
  return e.code === "ERR_JOSE_GENERIC" && /JSON Web Key Set/.test(e.message ?? "");
}

export function accessAuth(opts: AccessAuthOptions): AccessAuthMiddleware {
  const issuer = `https://${opts.teamDomain}`;
  const allowed = new Set(opts.allowedEmails.map((e) => e.trim().toLowerCase()));
  const staleMax = opts.staleIfErrorMs ?? 24 * HOUR;

  let keys: JWTVerifyGetKey;
  let prefetch: () => Promise<void> = async () => {};
  if (opts.keys) {
    keys = opts.keys;
  } else {
    const remote = createRemoteJWKSet(new URL(opts.jwksUrl ?? `${issuer}/cdn-cgi/access/certs`), {
      cacheMaxAge: opts.cacheMaxAgeMs ?? 12 * HOUR,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
    let lastGood: { set: JWTVerifyGetKey; at: number } | null = null;
    const remember = (): void => {
      const jwks = remote.jwks();
      if (jwks) lastGood = { set: createLocalJWKSet(jwks), at: Date.now() };
    };
    keys = async (header, token) => {
      try {
        const key = await remote(header, token);
        remember();
        return key;
      } catch (err) {
        if (isKeyFetchError(err) && lastGood && Date.now() - lastGood.at < staleMax) {
          return lastGood.set(header, token);
        }
        throw err;
      }
    };
    prefetch = async () => {
      try {
        await remote.reload();
        remember();
      } catch {
        // retried on the first request
      }
    };
  }

  const middleware = async function accessAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const reject = (reason: string): void => {
      opts.onReject?.(reason, req);
      res.status(401).json({ error: "unauthorized" });
    };

    const token = req.header(ACCESS_JWT_HEADER);
    if (!token) return reject("missing access jwt");

    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: opts.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
        clockTolerance: 30,
      }));
    } catch (err) {
      if (isKeyFetchError(err)) {
        opts.onReject?.(`access keys unavailable: ${(err as { code?: string }).code ?? (err as Error).name}`, req);
        res.status(503).set("Retry-After", "30").json({ error: "auth_unavailable" });
        return;
      }
      const e = err as { code?: string; claim?: string; name?: string };
      return reject(`invalid access jwt: ${e.code ?? e.name}${e.claim ? ` (${e.claim})` : ""}`);
    }

    // Service tokens carry no email; only named people may use this.
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email || !allowed.has(email)) return reject("identity not allowed");

    next();
  } as AccessAuthMiddleware;
  middleware.prefetch = prefetch;
  return middleware;
}
