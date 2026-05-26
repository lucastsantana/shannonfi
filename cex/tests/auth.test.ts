import { describe, it, expect } from 'vitest';
import { generateJwt } from '../src/coinbase/auth';
import * as jwt from 'jsonwebtoken';
import { createPrivateKey, generateKeyPairSync } from 'crypto';

// Generate a fresh EC P-256 keypair for testing
const { privateKey: nodePrivKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const testPrivateKey = nodePrivKey.export({ type: 'sec1', format: 'pem' }).toString();
const testApiKeyName = 'organizations/test-org/apiKeys/test-key';

const testAuthConfig = {
  apiKeyName: testApiKeyName,
  privateKey: testPrivateKey,
};

describe('generateJwt', () => {
  it('produces a valid JWT', () => {
    const token = generateJwt(testAuthConfig, 'GET', '/api/v3/brokerage/accounts');
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('includes required payload claims', () => {
    const token = generateJwt(testAuthConfig, 'GET', '/api/v3/brokerage/accounts');
    const publicKey = createPrivateKey(testPrivateKey).asymmetricKeyDetails;
    // Decode without verifying to inspect claims
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded).not.toBeNull();

    const payload = decoded!.payload as Record<string, unknown>;
    expect(payload['sub']).toBe(testApiKeyName);
    expect(payload['iss']).toBe('cdp');
    expect(payload['uri']).toBe('GET api.coinbase.com/api/v3/brokerage/accounts');
    expect(typeof payload['nbf']).toBe('number');
    expect(typeof payload['exp']).toBe('number');
    expect((payload['exp'] as number) - (payload['nbf'] as number)).toBe(120);
  });

  it('includes required header fields', () => {
    const token = generateJwt(testAuthConfig, 'POST', '/api/v3/brokerage/orders');
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded).not.toBeNull();

    const header = decoded!.header as Record<string, unknown>;
    expect(header['alg']).toBe('ES256');
    expect(header['kid']).toBe(testApiKeyName);
    expect(typeof header['nonce']).toBe('string');
    expect((header['nonce'] as string).length).toBeGreaterThan(0);
  });

  it('uppercases the HTTP method in uri claim', () => {
    const token = generateJwt(testAuthConfig, 'post', '/api/v3/brokerage/orders');
    const decoded = jwt.decode(token, { complete: true });
    const payload = decoded!.payload as Record<string, unknown>;
    expect(payload['uri']).toBe('POST api.coinbase.com/api/v3/brokerage/orders');
  });

  it('generates a different nonce on each call', () => {
    const t1 = generateJwt(testAuthConfig, 'GET', '/api/v3/brokerage/accounts');
    const t2 = generateJwt(testAuthConfig, 'GET', '/api/v3/brokerage/accounts');
    const d1 = jwt.decode(t1, { complete: true })!.header as Record<string, unknown>;
    const d2 = jwt.decode(t2, { complete: true })!.header as Record<string, unknown>;
    expect(d1['nonce']).not.toBe(d2['nonce']);
  });
});
