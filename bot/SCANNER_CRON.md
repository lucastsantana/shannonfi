# Daily Asset Scanner Setup (Mercado Bitcoin)

The Mercado Bitcoin asset scanner can be automatically executed daily at 9 AM BRT using a system cron job.

## Timezone Note

**9 AM BRT (Brasília Time) = 12:00 PM UTC**

If your system is in UTC (e.g., WSL2 on Windows), the cron job will run at 12:00 UTC, which corresponds to 9 AM BRT.

## Setup Instructions

### Step 1: Verify the wrapper script

The wrapper script is at `bot/scan-mb-daily.sh`. It:
- Runs the scanner with 30-day window
- Logs output to `bot/logs/scanner/daily-scan-YYYYMMDD-HHMMSS.log`
- Sends results to Telegram (configured in `configs/hype-mb.yaml`)

Test it manually first:
```bash
cd /home/user/repos/shannonfi/bot
./scan-mb-daily.sh
```

### Step 2: Add to cron

Open your crontab:
```bash
crontab -e
```

Add this line to run daily at 9 AM BRT (12:00 PM UTC):
```cron
0 12 * * * /home/user/repos/shannonfi/bot/scan-mb-daily.sh >> /home/user/repos/shannonfi/bot/logs/scanner/cron.log 2>&1
```

### Step 3: Verify the cron job

List your cron jobs:
```bash
crontab -l
```

Check the output:
```bash
tail -f /home/user/repos/shannonfi/bot/logs/scanner/cron.log
```

## Customization

Edit `scan-daily.sh` to change:
- **WINDOW_DAYS**: Historical analysis period (default: 30 days)
- **CONFIG_FILE**: Which config to use (default: `configs/hype-mb.yaml`)
- **Time**: If you want a different time, modify the cron schedule (see below)

### Cron Schedule Examples

| Time | Cron Expression | Timezone |
|------|-----------------|----------|
| 9 AM BRT (noon UTC) | `0 12 * * *` | UTC system |
| 8 AM BRT (11 AM UTC) | `0 11 * * *` | UTC system |
| 10 AM BRT (1 PM UTC) | `0 13 * * *` | UTC system |
| Custom local time | `0 9 * * *` | Your local TZ |

**To use your local timezone instead of UTC**, prefix the cron line with `TZ=America/Sao_Paulo`:
```cron
TZ=America/Sao_Paulo 0 9 * * * /home/user/repos/shannonfi/bot/scan-mb-daily.sh >> /home/user/repos/shannonfi/bot/logs/scanner/cron.log 2>&1
```

## What Happens Daily

1. **9 AM BRT**: Cron triggers `scan-daily.sh`
2. **Scan runs**: Fetches 30 days of candle data for 15 BRL-paired assets on Mercado Bitcoin
3. **Results scored**: Ranks by `MAD × (1 + rolling_return)` formula
4. **Telegram sent**: Interactive message with ranked candidates + selection buttons
5. **You review**: Click a candidate to rotate (or ignore if current is best)
6. **Logs saved**: Output saved to `logs/scanner/daily-scan-*.log`

## Troubleshooting

### "command not found"
Ensure the full path to `scan-daily.sh` is correct. Use absolute paths in crontab.

### Cron didn't run
Check if cron is running:
```bash
sudo systemctl status cron  # or systemctl status cron.service
```

Check cron logs:
```bash
grep CRON /var/log/syslog  # or journalctl -u cron
```

### "npm: command not found"
Cron jobs don't inherit your shell environment. Specify the full path to npm:
```bash
/usr/bin/npm run scan ...
```

Or update `scan-daily.sh` to source your `.bashrc`:
```bash
source ~/.bashrc
```

### Timezone issues
If cron runs at the wrong time, check your system timezone:
```bash
date
timedatectl  # on systemd systems
```

Then adjust the cron expression or use `TZ=America/Sao_Paulo` prefix.

## Monitoring

Check recent scans:
```bash
ls -lhtr /home/user/repos/shannonfi/bot/logs/scanner/
tail -f /home/user/repos/shannonfi/bot/logs/scanner/cron.log
```

Monitor Telegram for daily notifications at 9 AM BRT.

## Stopping the Scanner

Remove from crontab:
```bash
crontab -e
# Delete the scan line, save and exit
```

Or comment it out:
```cron
# 0 12 * * * /home/user/repos/shannonfi/bot/scan-daily.sh ...
```
