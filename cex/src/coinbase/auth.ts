import { sign } from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { JWT_TTL_SECONDS } from '../constants';

export interface AuthConfig {
  apiKeyName: string;   // "organizations/<org-id>/apiKeys/<key-id>"
  privateKey: string;   // PEM-encoded EC private key (ES256)
}

/**
 * Generates a Coinbase CDP JWT for a specific request.
 *
 * The `uri` claim must match "METHOD api.coinbase.com/path" exactly — no https://, no query string.
 * Coinbase validates this to prevent token replay against different endpoints.
 * A fresh JWT must be generated for every request; tokens are single-use by design.
 */
export function generateJwt(
  config: AuthConfig,
  method: string,
  requestPath: string,
): string {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    sub: config.apiKeyName,
    iss: 'cdp',
    nbf: now,
    exp: now + JWT_TTL_SECONDS,
    uri: `${method.toUpperCase()} api.coinbase.com${requestPath}`,
  };

  // nonce goes in the JOSE header (non-standard, Coinbase-required)
  return sign(payload, config.privateKey, {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: config.apiKeyName,
      nonce: nanoid(16),
    } as Parameters<typeof sign>[2] extends { header?: infer H } ? H : never,
  });
}
