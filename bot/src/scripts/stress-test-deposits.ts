/**
 * One-off diagnostic: stress-tests GET /accounts/{accountId}/wallet/fiat/BRL/deposits
 * against every parameter/casing/edge-case combination that could plausibly explain why
 * this endpoint returns [] for hype-mb despite a real, balance-confirmed R$40 PIX deposit
 * on 2026-07-31 (see docs/capital-flow-recording-guide.md investigation).
 *
 * Bypasses MbClient entirely and talks to axios directly so every request/response is
 * fully visible: HTTP status, all response headers (in case of undocumented pagination
 * headers), and the raw response body exactly as received (not just parsed .data).
 *
 * Read-only — every request is a GET. Makes real authenticated calls against the live
 * hype-mb Mercado Bitcoin account. No orders, no writes, no side effects.
 *
 * Usage: npx ts-node src/scripts/stress-test-deposits.ts --config configs/hype-mb.yaml
 */
import axios from 'axios';
import { loadConfig } from '../config';
import { getMercadoBitcoinCredentials } from '../core/keyring';

function parseArgs(): string {
  const idx = process.argv.indexOf('--config');
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error('Usage: npx ts-node src/scripts/stress-test-deposits.ts --config <path>');
  }
  return process.argv[idx + 1]!;
}

interface Attempt {
  label: string;
  method?: 'get';
  path: string;
  params?: Record<string, any>;
}

async function main() {
  const configPath = parseArgs();
  const config = loadConfig(configPath);
  if (config.exchange !== 'mercadobitcoin') {
    throw new Error(`This diagnostic is Mercado Bitcoin-only; config exchange is ${config.exchange}`);
  }

  let clientId = process.env.MB_CLIENT_ID;
  let clientSecret = process.env.MB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const creds = getMercadoBitcoinCredentials();
    clientId = creds.clientId;
    clientSecret = creds.clientSecret;
  }

  const baseURL = config.mercadobitcoin.apiBaseUrl;
  const http = axios.create({ baseURL, timeout: 15_000, validateStatus: () => true });

  console.log('=== OAuth2 token ===');
  const tokenParams = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'global',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenResp = await http.post('/oauth2/token', tokenParams.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  console.log('Token status:', tokenResp.status);
  const accessToken = tokenResp.data.access_token;
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  console.log('\n=== Accounts ===');
  const acctResp = await http.get('/accounts', { headers: authHeaders });
  console.log('Status:', acctResp.status, 'Headers:', JSON.stringify(acctResp.headers));
  console.log('Body:', JSON.stringify(acctResp.data));
  const accountId = acctResp.data[0].id;
  console.log('Using accountId:', accountId);

  const now = Math.floor(Date.now() / 1000);
  const may1 = Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000);
  const depositWindowStart = Math.floor(new Date('2026-07-30T00:00:00Z').getTime() / 1000);
  const depositWindowEnd = Math.floor(new Date('2026-08-01T00:00:00Z').getTime() / 1000);

  const attempts: Attempt[] = [
    { label: 'no params', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits` },
    { label: 'limit=50', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { limit: 50 } },
    { label: 'limit=10 (documented default)', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { limit: 10 } },
    { label: 'limit=1', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { limit: 1 } },
    { label: 'limit=100 (over documented max)', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { limit: 100 } },
    { label: 'limit=0', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { limit: 0 } },
    { label: 'limit=-1', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { limit: -1 } },
    { label: 'page=1', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { page: 1 } },
    { label: 'page=0', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { page: 0 } },
    { label: 'page=2', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { page: 2 } },
    { label: 'page=3', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { page: 3 } },
    { label: 'from=2026-05-01 to=now', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { from: may1, to: now } },
    { label: 'from/to tightly bracketing the deposit window (07-30..08-01)', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { from: depositWindowStart, to: depositWindowEnd } },
    { label: 'from=0 to=now (epoch start)', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { from: 0, to: now } },
    { label: 'to only, no from', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { to: now } },
    { label: 'from only, no to', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { from: may1 } },
    { label: 'lowercase symbol (brl)', path: `/accounts/${accountId}/wallet/fiat/brl/deposits` },
    { label: 'uppercase w/ limit as string "50"', path: `/accounts/${accountId}/wallet/fiat/BRL/deposits`, params: { limit: '50' } },
    { label: 'non-fiat crypto deposits endpoint w/ symbol=BRL (should say fiat not included)', path: `/accounts/${accountId}/wallet/BRL/deposits`, params: { limit: 50 } },
    { label: 'non-fiat crypto deposits w/ status=2 (credited per that schema)', path: `/accounts/${accountId}/wallet/BRL/deposits`, params: { limit: 50, status: 2 } },
  ];

  for (const attempt of attempts) {
    console.log(`\n=== ${attempt.label} ===`);
    console.log('GET', attempt.path, attempt.params ? JSON.stringify(attempt.params) : '(no params)');
    try {
      const resp = await http.get(attempt.path, { params: attempt.params, headers: authHeaders });
      console.log('Status:', resp.status);
      console.log('Relevant headers:', JSON.stringify({
        'content-length': resp.headers['content-length'],
        'x-total-count': resp.headers['x-total-count'],
        'x-page': resp.headers['x-page'],
        'link': resp.headers['link'],
      }));
      console.log('Body:', JSON.stringify(resp.data));
      // Rate limit courtesy delay — balances endpoint is documented at 3 req/sec,
      // assume similar for wallet endpoints.
      await new Promise((r) => setTimeout(r, 350));
    } catch (err: any) {
      console.log('ERROR:', err.message);
    }
  }
}

main().catch((err) => {
  console.error('Stress test failed:', err.message);
  process.exit(1);
});
