/**
 * Telegram webhook — 24/7 on Vercel (replaces Railway polling).
 */
import { createBot } from '../src/bot/handlers.js';
import { ensureArcHealth } from '../src/chain/health.js';
import type { Update } from 'grammy/types';

type Req = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type Res = {
  status: (n: number) => Res;
  json: (o: unknown) => void;
  end: () => void;
  setHeader: (k: string, v: string) => void;
};

let botPromise: Promise<ReturnType<typeof createBot>> | null = null;

async function bot(): Promise<ReturnType<typeof createBot>> {
  if (!botPromise) {
    botPromise = (async () => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
      const b = createBot(token);
      await b.init();
      console.log(`[webhook] @${b.botInfo.username} ready`);
      return b;
    })();
  }
  return botPromise;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({ ok: true, service: 'arctrade-bot' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  try {
    const b = await bot();
    await ensureArcHealth();
    await b.handleUpdate(req.body as Update);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook]', e instanceof Error ? e.message : e);
    res.status(200).json({ ok: false });
  }
}
