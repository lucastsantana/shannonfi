import { TelegramService } from './src/core/notifier/telegram';

async function sendAnalysis() {
  try {
    const telegram = new TelegramService({ chatId: '1684226180' });
    
    const message = `🔍 <b>Asset Scanner Results</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Analysis Date:</b> 2026-05-30
<b>Window:</b> 30 days
<b>Symbols Scanned:</b> 15

<b>Top 5 Candidates (by MAD × return):</b>

1. <b>HYPE-BRL</b> ◄ Current
   MAD: 3.9% | Return: +67.6% | Score: 0.06

2. <b>LINK-BRL</b>
   MAD: 1.7% | Return: +3.7% | Score: 0.02

3. <b>AVAX-BRL</b>
   MAD: 1.6% | Return: +1.2% | Score: 0.02

4. <b>PEPE-BRL</b>
   MAD: 1.7% | Return: -9.4% | Score: 0.02

5. <b>DOGE-BRL</b>
   MAD: 1.6% | Return: -3.0% | Score: 0.02

<b>Recommendation:</b>
HYPE-BRL remains the strongest candidate with 67.6% 30-day return and good volatility (3.9% MAD).`;

    await telegram.sendMessage(message);
    console.log('✅ Analysis sent to Telegram!');
  } catch (err) {
    const error = err as any;
    console.error('❌ Error:', error?.message || error?.toString());
    console.error('Code:', error?.code);
    process.exit(1);
  }
}

sendAnalysis();
