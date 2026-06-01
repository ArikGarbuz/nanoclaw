/**
 * Telegram Channel Adapter for NanoClaw
 * Implements long polling for local development (no webhooks)
 * Echo bot for Layer 2 - no LLM integration yet
 */

import { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { logger } from '../log.js';

/**
 * Telegram Bot API types
 */
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: {
      id: number;
      type: string;
      title?: string;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    text?: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      last_name?: string;
      username?: string;
    };
  };
}

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
}

/**
 * TelegramAdapter implements the NanoClaw ChannelAdapter interface
 * for Telegram messaging platform using long polling
 */
export class TelegramAdapter implements ChannelAdapter {
  name = 'Telegram';
  channelType = 'telegram';
  supportsThreads = false; // Telegram doesn't use threads

  private botToken: string;
  private setup: ChannelSetup | null = null;
  private isRunning = false;
  private lastUpdateId = 0;
  private pollingInterval = 1000; // 1 second between polls
  private pollingLoop: ReturnType<typeof setInterval> | null = null;
  private apiBaseUrl: string;

  constructor(botToken?: string) {
    this.botToken = botToken || process.env.TELEGRAM_BOT_TOKEN || '';
    this.apiBaseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  /**
   * Initialize the adapter
   */
  async setup(setup: ChannelSetup): Promise<void> {
    if (!this.botToken) {
      logger.warn('[Telegram] No bot token configured, adapter unavailable');
      return;
    }

    this.setup = setup;

    try {
      // Verify bot token by fetching bot info
      const meInfo = await this.callTelegramApi<{ id: number; username: string; first_name: string }>(
        'getMe',
        {}
      );

      if (!meInfo) {
        logger.error('[Telegram] Failed to get bot info - invalid token?');
        return;
      }

      logger.info(`[Telegram] Adapter initialized: @${meInfo.username} (ID: ${meInfo.id})`);

      // Start long polling loop
      this.isRunning = true;
      this.startPolling();
    } catch (err) {
      logger.error(`[Telegram] Setup failed: ${err}`);
    }
  }

  /**
   * Cleanup and stop polling
   */
  async teardown(): Promise<void> {
    logger.info('[Telegram] Tearing down adapter');
    this.isRunning = false;

    if (this.pollingLoop) {
      clearInterval(this.pollingLoop);
      this.pollingLoop = null;
    }

    this.setup = null;
  }

  /**
   * Check if adapter is connected and running
   */
  isConnected(): boolean {
    return this.isRunning && this.botToken.length > 0;
  }

  /**
   * Deliver an outbound message to Telegram
   */
  async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    if (!this.isRunning || !this.botToken) {
      logger.error('[Telegram] Cannot deliver - adapter not running');
      return undefined;
    }

    try {
      const chatId = platformId;
      const text = this.formatOutboundMessage(message);

      logger.info(`[Telegram] Sending message to chat ${chatId}`, { text });

      const response = await this.callTelegramApi<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
      });

      if (response) {
        logger.info(`[Telegram] Message sent (ID: ${response.message_id}) to chat ${chatId}`);
        return response.message_id.toString();
      }
    } catch (err) {
      logger.error(`[Telegram] Failed to deliver message: ${err}`);
    }

    return undefined;
  }

  /**
   * Start the long polling loop
   */
  private startPolling(): void {
    logger.info('[Telegram] Starting long polling');

    this.pollingLoop = setInterval(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error(`[Telegram] Poll error: ${err}`);
      }
    }, this.pollingInterval);
  }

  /**
   * Poll Telegram API once for new updates
   */
  private async pollOnce(): Promise<void> {
    try {
      const updates = await this.callTelegramApi<TelegramUpdate[]>('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 5, // Long polling timeout
      });

      if (!updates || updates.length === 0) {
        return;
      }

      for (const update of updates) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

        if (update.message) {
          await this.handleMessage(update.message);
        }
      }
    } catch (err) {
      logger.error(`[Telegram] Poll once failed: ${err}`);
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(msg: TelegramUpdate['message']): Promise<void> {
    if (!msg || !this.setup) {
      return;
    }

    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const text = msg.text || '';
    const timestamp = new Date(msg.date * 1000).toISOString();

    logger.info(`[Telegram] Received message from chat ${chatId} (user ${userId}):`, { text });

    // Echo bot handler - for Layer 2, simply echo back the user's message
    const echoResponse = `Echo: ${text}`;

    logger.info(`[Telegram] Echo response for chat ${chatId}:`, { text: echoResponse });

    // Send echo response immediately
    try {
      await this.callTelegramApi<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: echoResponse,
        parse_mode: 'Markdown',
      });
      logger.info(`[Telegram] Echo sent to chat ${chatId}`);
    } catch (err) {
      logger.error(`[Telegram] Failed to send echo: ${err}`);
    }

    // Also forward to NanoClaw router for future integration
    const inboundMsg: InboundMessage = {
      id: `telegram-${msg.message_id}`,
      kind: 'chat',
      content: {
        text: text,
        userId: userId,
        chatId: chatId,
        chatTitle: msg.chat.title || msg.chat.username || `${msg.chat.first_name} ${msg.chat.last_name || ''}`.trim(),
        chatType: msg.chat.type,
        senderName: `${msg.from.first_name} ${msg.from.last_name || ''}`.trim(),
        senderUsername: msg.from.username,
      },
      timestamp,
      isGroup: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
    };

    this.setup.onInbound(chatId, null, inboundMsg);
  }

  /**
   * Format outbound message for Telegram
   */
  private formatOutboundMessage(message: OutboundMessage): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    if (typeof message.content === 'object' && message.content !== null) {
      if ('text' in message.content) {
        return String((message.content as Record<string, unknown>).text);
      }
      return JSON.stringify(message.content);
    }

    return String(message.content);
  }

  /**
   * Call Telegram Bot API
   */
  private async callTelegramApi<T = unknown>(method: string, params: Record<string, unknown>): Promise<T | null> {
    try {
      const url = `${this.apiBaseUrl}/${method}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        logger.error(`[Telegram] API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = (await response.json()) as TelegramResponse<T>;

      if (!data.ok) {
        logger.error(`[Telegram] API returned error: ${data.description}`);
        return null;
      }

      return data.result;
    } catch (err) {
      logger.error(`[Telegram] API call failed: ${err}`);
      return null;
    }
  }
}

/**
 * Factory function for Telegram adapter registration
 */
export function createTelegramAdapter(): TelegramAdapter | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    logger.debug('[Telegram] Bot token not configured, skipping adapter');
    return null;
  }

  return new TelegramAdapter(botToken);
}

/**
 * Auto-register the Telegram adapter
 */
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter({
  factory: createTelegramAdapter,
});
