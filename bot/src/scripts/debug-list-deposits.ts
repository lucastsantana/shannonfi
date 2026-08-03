/**
 * One-off diagnostic: dumps the raw Mercado Bitcoin fiat-deposit and withdrawal
 * list responses for an instance, unfiltered. Used to confirm the real `status`
 * field values MB's API returns, since capital-flow-sync.ts's `'CREDITED'` filter
 * was never validated against a real deposit (see docs/capital-flow-recording-guide.md
 * investigation, 2026-08-02: a real deposit went undetected for 2+ days).
 *
 * Read-only — makes no trades, writes nothing to the database.
 *
 * Usage: npm run debug-deposits -- --config configs/hype-mb.yaml
 */
import { loadConfig } from '../config';
import { MercadoBitcoinAdapter } from '../adapters/mercadobitcoin/adapter';
import { MbClient } from '../adapters/mercadobitcoin/client';
import { getMercadoBitcoinCredentials } from '../core/keyring';

function parseArgs(): string {
  const idx = process.argv.indexOf('--config');
  if (idx === -1 || !process.argv[idx + 1]) {
    throw new Error('Usage: npm run debug-deposits -- --config <path>');
  }
  return process.argv[idx + 1]!;
}

async function main() {
  const configPath = parseArgs();
  const config = loadConfig(configPath);
  if (config.exchange !== 'mercadobitcoin') {
    throw new Error(`This diagnostic is Mercado Bitcoin-only; config exchange is ${config.exchange}`);
  }

  // Raw /accounts dump — bypasses the adapter's accounts[0]-only accountId
  // resolution, to check whether there's more than one account on this API key
  // and whether the deposit landed in a different one than what the bot uses.
  let clientId = process.env.MB_CLIENT_ID;
  let clientSecret = process.env.MB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const creds = getMercadoBitcoinCredentials();
    clientId = creds.clientId;
    clientSecret = creds.clientSecret;
  }
  const client = new MbClient(clientId, clientSecret, config.mercadobitcoin.apiBaseUrl);

  console.log('=== Accounts (raw) ===');
  const accounts = await client.get<any[]>('/accounts');
  console.log(JSON.stringify(accounts, null, 2));

  for (const acct of accounts) {
    console.log(`\n=== Balances for account ${acct.id} (${acct.currency}, ${acct.type}) ===`);
    const balances = await client.get<any[]>(`/accounts/${acct.id}/balances`);
    console.log(JSON.stringify(balances, null, 2));
  }

  const adapter = new MercadoBitcoinAdapter(config.mercadobitcoin, true, config.maxSlippageBps, config.symbol);

  console.log('\n=== Fiat Deposits (raw, via adapter accountId) ===');
  const deposits = await adapter.listFiatDeposits(50);
  console.log(JSON.stringify(deposits, null, 2));

  console.log('\n=== Withdrawals (raw, via adapter accountId) ===');
  const withdrawals = await adapter.listWithdrawals(50);
  console.log(JSON.stringify(withdrawals, null, 2));

  // Also try deposits/withdrawals against EVERY account found, not just the
  // adapter's cached accounts[0] — in case the deposit landed in a different
  // account than the one the bot trades from.
  for (const acct of accounts) {
    console.log(`\n=== Fiat Deposits (raw, account ${acct.id}) ===`);
    try {
      const d = await client.get<any[]>(`/accounts/${acct.id}/wallet/fiat/BRL/deposits`, { limit: 50 });
      console.log(JSON.stringify(d, null, 2));
    } catch (err: any) {
      console.log('Error:', err.message);
    }
  }

  // Per the real OpenAPI spec, `page` and `from`/`to` (unix seconds, filters on
  // created_at) are also accepted but currently never sent by our code. Try
  // them explicitly in case there's an undocumented pagination/date default.
  const accountId = accounts[0].id;
  console.log('\n=== Fiat Deposits (explicit page=1) ===');
  try {
    const d = await client.get<any[]>(`/accounts/${accountId}/wallet/fiat/BRL/deposits`, { limit: 50, page: 1 });
    console.log(JSON.stringify(d, null, 2));
  } catch (err: any) {
    console.log('Error:', err.message);
  }

  console.log('\n=== Fiat Deposits (explicit from/to spanning 2026-05-01 to now) ===');
  try {
    const from = Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000);
    const to = Math.floor(Date.now() / 1000);
    const d = await client.get<any[]>(`/accounts/${accountId}/wallet/fiat/BRL/deposits`, { from, to });
    console.log(JSON.stringify(d, null, 2));
  } catch (err: any) {
    console.log('Error:', err.message);
  }
}

main().catch((err) => {
  console.error('Diagnostic failed:', err.message);
  process.exit(1);
});
