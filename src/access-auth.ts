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
 * somehow reaches the origin without passing Access (another tunnel route,
 * a local process on the box) is still rejected. We check the signature
 * against the team's public keys, the issuer, the application audience
 * (AUD tag), expiry, and that the identity is on the allow-list.
 */

import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessAuthOptions {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience: string;
  /** Lower-cased e-mail addresses allowed to use the connector. */
  allowedEmails: string[];
  /** Override the key set (tests). Defaults to the team's /certs endpoint. */
  keys?: JWTVerifyGetKey;
  onReject?: (reason: string, req: Request) => void;
}

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export function accessAuth(opts: AccessAuthOptions) {
  const issuer = `https://${opts.teamDomain}`;
  const keys =
    opts.keys ??
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  const allowed = new Set(opts.allowedEmails.map((e) => e.trim().toLowerCase()));

  return async function accessAuthMiddleware(
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
        clockTolerance: 30,
      }));
    } catch (err) {
      return reject(`invalid access jwt: ${(err as Error).name}`);
    }

    // Service tokens carry no email; only named people may use this.
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email || !allowed.has(email)) return reject("identity not allowed");

    next();
  };
}
