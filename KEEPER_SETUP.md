# Keeper Setup Guide

The vault keeper can be deployed as:
1. **Scheduled GitHub Action** (periodic checks every 5 minutes)
2. **Self-hosted runner** (continuous long-running process)
3. **VPS/Cloud server** (most reliable for production)
4. **Docker container** (portable, easy to manage)

---

## Option 1: Scheduled GitHub Action (Simplest)

### Setup

1. **Generate keeper keypair** (or reuse existing):
```bash
solana-keygen new -o keeper.json
cat keeper.json  # Copy as secret
```

2. **Store secrets in GitHub** (Settings → Secrets and variables → Actions):
   - `SOLANA_RPC_URL` → RPC endpoint (e.g., `https://api.mainnet-beta.solana.com`)
   - `VAULT_AUTHORITY` → Vault PDA (from initialize instruction)
   - `KEEPER_SECRET_KEY` → Keeper keypair JSON array (e.g., `[1, 2, 3, ...]`)

3. **Workflow runs automatically:**
   - Every hour (cron: `0 * * * *`)
   - Checks if rebalance interval elapsed (432,000 slots ≈ 48 hours)
   - If yes, triggers rebalance
   - Retries on failure

### Pros
- Zero infrastructure cost
- Automatic GitHub Actions CI/CD
- No server to manage
- Hourly frequency is perfect for ~2-day rebalance intervals

### Cons
- 1-hour granularity (not real-time)
- If keeper fails, waits up to 1 hour for retry
- GitHub Actions rate limits (but hourly is well within free tier)

---

## Option 2: Self-Hosted Runner (Better)

### Setup

1. **Provision a Linux VM** (e.g., t3.micro on AWS):
   - 1 vCPU, 1 GB RAM minimum
   - Ubuntu 22.04 LTS
   - Static IP or domain name

2. **Install GitHub runner**:
```bash
# On your VM
mkdir ~/github-runner
cd ~/github-runner

# Download runner from GitHub (Settings → Actions → Runners)
curl -o actions-runner-linux-x64-2.x.x.tar.gz \
  https://github.com/actions/runner/releases/download/...

tar xzf actions-runner-linux-x64-2.x.x.tar.gz

# Configure
./config.sh --url https://github.com/your-org/shannonfi \
  --token <TOKEN_FROM_GITHUB>

# Install and start as systemd service
./svc.sh install
sudo systemctl start actions.runner...
```

3. **Tag runner** in GitHub Settings → Runners:
   - Label: `self-hosted` (already applied)
   - Add custom label: `solana-keeper` (for specificity)

4. **Update workflow** (`.github/workflows/keeper-long-running.yml`):
```yaml
runs-on: [self-hosted, solana-keeper]  # Your custom label
```

5. **Store secrets** same as Option 1.

### Pros
- Precise control over execution
- No GitHub Actions quota limits
- Can run 24/7 without throttling

### Cons
- Need to maintain VM (patching, monitoring)
- Cost: ~$10–30/month for a micro instance

---

## Option 3: VPS / Cloud Deployment (Production)

### Recommended: DigitalOcean App Platform or AWS Lambda

#### DigitalOcean App Platform

1. **Create `app.yaml`**:
```yaml
name: shannonfi-keeper
services:
  - name: keeper
    github:
      repo: your-org/shannonfi
      branch: main
    build_command: "cd app && npm install && npx tsc"
    run_command: "node dist/keeper.js"
    http_port: 3000
    envs:
      - key: RPC_URL
        scope: RUN_TIME
        value: ${SOLANA_RPC_URL}
      - key: VAULT_AUTHORITY
        scope: RUN_TIME
        value: ${VAULT_AUTHORITY}
      - key: KEEPER_SECRET_KEY
        scope: RUN_TIME
        value: ${KEEPER_SECRET_KEY}
    health_check:
      http_path: /health
```

2. **Deploy**:
```bash
doctl apps create --spec app.yaml
```

3. **Set environment variables** in DigitalOcean dashboard.

#### AWS Lambda (Serverless)

Keeper as Lambda function called by CloudWatch Events every minute:

```typescript
// app/src/lambda.ts
import { Handler } from 'aws-lambda';

export const handler: Handler = async (event) => {
  const keeper = new VaultKeeper({
    programId: new PublicKey(process.env.PROGRAM_ID!),
    vaultAuthority: new PublicKey(process.env.VAULT_AUTHORITY!),
    keeperKeypair: Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(process.env.KEEPER_SECRET_KEY!))
    ),
    rpcUrl: process.env.RPC_URL!,
  });

  await keeper.checkAndRebalance();
  return { statusCode: 200, body: 'OK' };
};
```

Deploy:
```bash
sam package --template-file template.yaml --s3-bucket my-bucket --output-template-file packaged.yaml
sam deploy --template-file packaged.yaml --capabilities CAPABILITY_IAM
```

### Pros
- Minimal ops burden
- Scales automatically
- Pay only for what you use

### Cons
- Vendor lock-in
- Cold start delays (Lambda ~2–5s)
- Less precise timing

---

## Option 4: Docker Container (Portable)

### Build

1. **Create `Dockerfile`**:
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --prefer-offline

COPY app app
WORKDIR /app/app
RUN npm install --prefer-offline
RUN npx tsc

ENTRYPOINT ["node", "dist/keeper.js"]
```

2. **Build and push**:
```bash
docker build -t your-registry/shannonfi-keeper:latest .
docker push your-registry/shannonfi-keeper:latest
```

### Run Locally

```bash
docker run \
  -e RPC_URL="https://api.mainnet-beta.solana.com" \
  -e VAULT_AUTHORITY="<your-vault-pda>" \
  -e KEEPER_SECRET_KEY='[...]' \
  your-registry/shannonfi-keeper:latest
```

### Deploy to Kubernetes / Container Service

```bash
# DigitalOcean App Platform (shown above)
# AWS ECS
ecs-cli compose --file docker-compose.yml up
# Docker Swarm
docker stack deploy -c docker-compose.yml shannonfi
```

---

## Monitoring & Alerting

### GitHub Action Notifications

Add to keeper workflow:

```yaml
- name: Slack notification on failure
  if: failure()
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {
        "text": "🚨 Keeper check failed",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*Vault Keeper Failed*\nRun: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
            }
          }
        ]
      }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

### Prometheus Metrics

Add to keeper:

```typescript
// app/src/metrics.ts
import promClient from 'prom-client';

export const rebalanceCounter = new promClient.Counter({
  name: 'vault_rebalances_total',
  help: 'Total number of successful rebalances',
});

export const rebalanceErrors = new promClient.Counter({
  name: 'vault_rebalance_errors_total',
  help: 'Total number of failed rebalance attempts',
});

export const keeperFeeAccrued = new promClient.Gauge({
  name: 'keeper_fee_sol_total',
  help: 'Total SOL accumulated as keeper fees',
});
```

### Health Check Endpoint

```typescript
// app/src/keeper.ts (update constructor)
import express from 'express';

const app = express();
let lastCheckTime = 0;
let lastError: string | null = null;

app.get('/health', (req, res) => {
  const age = Date.now() - lastCheckTime;
  if (age > 10 * 60 * 1000) {
    // No check in 10 minutes
    return res.status(503).json({ status: 'stale', age_ms: age, error: lastError });
  }
  res.json({ status: 'ok', age_ms: age });
});

app.listen(3000, () => console.log('Health check on :3000'));
```

---

## Recommended Setup by Environment

### Development / Testing
**→ Option 4 (Docker locally)** or **Option 1 (GitHub Action, hourly)**  
Easy to iterate, no cost. Hourly checks are perfect for 2-day rebalance intervals.

### Staging / Devnet
**→ Option 1 (GitHub Action)** or **Option 2 (Self-hosted runner)**  
GitHub Action (hourly) is simplest for devnet. Self-hosted runner if you want faster checks.

### Production / Mainnet
**→ Option 1 (GitHub Action, hourly)** with optional fallback  
GitHub Action is **cost-free** and highly reliable. Runs hourly, which is perfect for ~2-day rebalance windows.
Only add Option 2/3 if you need faster redundancy or want to monitor more frequently.

---

## Cost Breakdown

| Option | Monthly Cost | Reliability | Check Interval |
|--------|------------|-------------|---------|
| GitHub Action | $0 (free tier) | ⭐⭐ (managed) | 1 hour | 
| Self-hosted runner | $10–30 (VM) | ⭐⭐⭐ (you manage) | ~30 sec |
| DigitalOcean App | $5–20 (app tier) | ⭐⭐⭐ (managed) | ~30 sec |
| AWS Lambda | $1–10 (pay-per-call) | ⭐⭐⭐ (managed) | 1 hour |
| Docker on VPS | $5–20 (VM) | ⭐⭐⭐ (you manage) | ~30 sec |

---

## Security Checklist

- [ ] Keeper secret key stored in GitHub Secrets (never in code/logs)
- [ ] RPC URL uses HTTPS
- [ ] Vault authority is a separate PDA from keeper wallet
- [ ] Keeper fee is capped at 0.5% max
- [ ] Rebalance threshold is > 1% to avoid micro-rebalances
- [ ] Slippage is capped at 1% max
- [ ] Health checks configured (prevents runaway keeper)
- [ ] Logs are rotated / archived
- [ ] Monitoring + alerting set up (Slack, PagerDuty, etc.)

---

## Troubleshooting

**Keeper doesn't trigger rebalance:**
- Check if `last_rebalance_slot + 432_000 <= current_slot`
- Verify Pyth feed is not stale
- Check if vault drift > rebalance_threshold_bps

**Action times out:**
- Increase timeout in workflow
- Check RPC endpoint is responsive
- Reduce batch size or add retries

**High slippage on swaps:**
- Increase `slippage_bps` (up to 100 = 1%)
- Check Jupiter routing
- Consider larger minimum swap size

---

**Next:** Choose your deployment option and implement Option 2 (set_keeper update) or Option 3 (VPS) for production.
