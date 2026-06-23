import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { generateCoinbaseJwt } from '../../../src/adapters/coinbase/jwt';

// Decodes a JWT's header/payload without verifying the signature — we just need
// to assert the claims/header shape this adapter constructs, not re-test `jose`
// itself. No real Coinbase credentials are needed for this: it only exercises our
// own signing code against locally-generated test keypairs.
function decodeJwt(token: string): { header: any; payload: any } {
  const [headerB64, payloadB64] = token.split('.');
  const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf-8'));
  const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf-8'));
  return { header, payload };
}

describe('generateCoinbaseJwt', () => {
  it('signs with ES256 and the correct claims for an EC (P-256) key', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'sec1', format: 'pem' }).toString();

    const token = await generateCoinbaseJwt(
      'organizations/org-id/apiKeys/key-id',
      pem,
      'GET',
      '/api/v3/brokerage/accounts',
      'api.coinbase.com',
    );

    const { header, payload } = decodeJwt(token);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('organizations/org-id/apiKeys/key-id');
    expect(typeof header.nonce).toBe('string');
    expect(header.nonce.length).toBeGreaterThan(0);

    expect(payload.sub).toBe('organizations/org-id/apiKeys/key-id');
    expect(payload.iss).toBe('cdp');
    expect(payload.uri).toBe('GET api.coinbase.com/api/v3/brokerage/accounts');
    expect(payload.exp - payload.nbf).toBe(120);
  });

  it('signs with EdDSA for an Ed25519 key', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const token = await generateCoinbaseJwt('key-name', pem, 'POST', '/api/v3/brokerage/orders');
    const { header, payload } = decodeJwt(token);

    expect(header.alg).toBe('EdDSA');
    expect(payload.uri).toBe('POST api.coinbase.com/api/v3/brokerage/orders');
  });

  it('generates a fresh nonce on every call (tokens are never reused)', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const tokenA = await generateCoinbaseJwt('key-name', pem, 'GET', '/path');
    const tokenB = await generateCoinbaseJwt('key-name', pem, 'GET', '/path');

    expect(tokenA).not.toBe(tokenB);
    expect(decodeJwt(tokenA).header.nonce).not.toBe(decodeJwt(tokenB).header.nonce);
  });

  it('signs with EdDSA for a raw base64-encoded Ed25519 key (Coinbase CDP download format)', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    // Coinbase's "Secret API Key" download gives the raw 32-byte seed, base64-encoded,
    // not PEM. Extract it from the PKCS8 DER by stripping the fixed 16-byte prefix.
    const der = privateKey.export({ type: 'pkcs8', format: 'der' });
    const seed = der.subarray(der.length - 32);
    const rawBase64 = seed.toString('base64');

    const token = await generateCoinbaseJwt('key-name', rawBase64, 'GET', '/api/v3/brokerage/accounts');
    const { header, payload } = decodeJwt(token);

    expect(header.alg).toBe('EdDSA');
    expect(payload.uri).toBe('GET api.coinbase.com/api/v3/brokerage/accounts');
  });

  it('rejects malformed base64 key material that is neither PEM nor 32/64 raw bytes', async () => {
    await expect(
      generateCoinbaseJwt('key-name', Buffer.from('too-short').toString('base64'), 'GET', '/path'),
    ).rejects.toThrow(/Unrecognized Coinbase private key format/);
  });

  it('rejects an unsupported key type', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    await expect(
      generateCoinbaseJwt('key-name', pem, 'GET', '/path'),
    ).rejects.toThrow(/Unsupported Coinbase private key type/);
  });
});
