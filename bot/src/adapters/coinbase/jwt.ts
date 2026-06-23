/**
 * Coinbase CDP API key JWT signing.
 *
 * NOTE ON VERIFICATION: this is the least-tested part of this adapter. It was
 * written against Coinbase's published auth documentation (CDP API keys, JWT per
 * request, ES256 for ECDSA keys / EdDSA for Ed25519 keys, ~120s expiry, claims
 * including sub/iss/uri, header kid+nonce) but has not been exercised against a
 * real Coinbase account or sandbox in this environment — there were no credentials
 * available to do so. Test this against a real (even read-only, e.g. list-accounts)
 * call before trusting it for live trading.
 */

import { SignJWT } from 'jose';
import * as crypto from 'crypto';
import { COINBASE_JWT_EXPIRY_SECONDS } from '../../constants';

function detectAlgorithm(keyObject: crypto.KeyObject): 'ES256' | 'EdDSA' {
  const type = keyObject.asymmetricKeyType;
  if (type === 'ed25519') return 'EdDSA';
  if (type === 'ec') return 'ES256';
  throw new Error(
    `Unsupported Coinbase private key type: ${type}. Expected an EC (ES256) or Ed25519 (EdDSA) key.`,
  );
}

// Minimal PKCS8 DER envelope for Ed25519 (OID 1.3.101.112), everything but the
// 32-byte seed that follows is fixed-width and identical for every Ed25519 key.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Coinbase's CDP "Secret API Key" download for Ed25519 keys is base64-encoded raw
 * key material, not PEM — Node's crypto module only loads DER/PEM, so a raw 32-byte
 * (or 64-byte seed+pubkey) Ed25519 key needs to be wrapped in a minimal PKCS8 DER
 * envelope first. EC keys are still handed over to Coinbase as a PEM block, so that
 * path is unchanged.
 */
function parsePrivateKey(privateKeyMaterial: string): crypto.KeyObject {
  const trimmed = privateKeyMaterial.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return crypto.createPrivateKey(trimmed);
  }

  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 32 && raw.length !== 64) {
    throw new Error(
      `Unrecognized Coinbase private key format: expected a PEM block or a base64-encoded ` +
        `Ed25519 key (32 or 64 raw bytes), got ${raw.length} decoded bytes.`,
    );
  }
  const seed = raw.subarray(0, 32);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * Generates a fresh, short-lived JWT for one specific request. Coinbase's CDP auth
 * binds each token to the exact method+host+path being called (via the `uri`
 * claim), so a JWT cannot be cached or reused across requests the way Mercado
 * Bitcoin's OAuth2 access token or a Binance HMAC signature's timestamp window can.
 */
export async function generateCoinbaseJwt(
  keyName: string,
  privateKeyPem: string,
  method: 'GET' | 'POST',
  requestPath: string,
  host = 'api.coinbase.com',
): Promise<string> {
  const keyObject = parsePrivateKey(privateKeyPem);
  const algorithm = detectAlgorithm(keyObject);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: keyName,
    iss: 'cdp',
    nbf: now,
    exp: now + COINBASE_JWT_EXPIRY_SECONDS,
    uri: `${method} ${host}${requestPath}`,
  })
    .setProtectedHeader({
      alg: algorithm,
      kid: keyName,
      nonce: crypto.randomBytes(16).toString('hex'),
      typ: 'JWT',
    })
    .sign(keyObject as unknown as Parameters<SignJWT['sign']>[0]);
}
