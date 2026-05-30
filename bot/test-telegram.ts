import { TelegramService } from './src/core/notifier/telegram';

async function test() {
  try {
    const telegram = new TelegramService({ chatId: '1684226180' });
    await telegram.sendMessage('🔍 <b>Asset Scanner Test</b>\n\nTelegram connectivity check passed!');
    console.log('✅ Telegram message sent successfully');
  } catch (err) {
    console.error('❌ Telegram error:', (err as Error).message);
    process.exit(1);
  }
}

test();
