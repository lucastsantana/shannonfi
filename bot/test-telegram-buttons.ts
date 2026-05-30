import { TelegramService } from './src/core/notifier/telegram';

async function test() {
  try {
    const telegram = new TelegramService({ chatId: '1684226180' });
    const buttons = [
      [
        { text: '1️⃣ BTC-BRL', callbackData: 'select:1:BTC-BRL' },
        { text: '2️⃣ ETH-BRL', callbackData: 'select:1:ETH-BRL' },
      ],
      [
        { text: '3️⃣ SOL-BRL', callbackData: 'select:1:SOL-BRL' },
      ],
    ];
    const messageId = await telegram.sendMessageWithButtons(
      '🔍 <b>Asset Scanner</b>\n\nSelect an asset to analyze:',
      buttons,
    );
    console.log('✅ Telegram message with buttons sent successfully, messageId:', messageId);
  } catch (err) {
    console.error('❌ Telegram error:', (err as Error).message);
    console.error('Stack:', (err as Error).stack);
    process.exit(1);
  }
}

test();
