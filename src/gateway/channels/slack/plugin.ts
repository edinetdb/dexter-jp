import type { ChannelPlugin, ChannelStartContext } from '../types.js';
import type { InboundMessage } from '../../types.js';
import type { GatewayConfig } from '../../config.js';
import { logger } from '../../../utils/logger.js';

type SlackAccountConfig = {
  enabled: boolean;
};

type SlackPluginParams = {
  loadConfig: () => GatewayConfig;
  onMessage: (inbound: InboundMessage) => Promise<void>;
};

/**
 * Create a Slack channel plugin using Socket Mode (WebSocket, no public URL needed).
 * Requires: SLACK_BOT_TOKEN + SLACK_APP_TOKEN environment variables.
 */
export function createSlackPlugin(params: SlackPluginParams): ChannelPlugin<GatewayConfig, SlackAccountConfig> {
  return {
    id: 'slack',
    config: {
      listAccountIds: () => {
        // Single account per Slack workspace
        return process.env.SLACK_BOT_TOKEN ? ['default'] : [];
      },
      resolveAccount: () => ({ enabled: true }),
      isEnabled: (account) => account.enabled,
      isConfigured: () => Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN),
    },
    gateway: {
      startAccount: async (ctx: ChannelStartContext<SlackAccountConfig>) => {
        // Dynamic import to avoid loading @slack/bolt when Slack is not configured
        const bolt = await import('@slack/bolt');
        const App = bolt.App;

        const app = new App({
          token: process.env.SLACK_BOT_TOKEN!,
          appToken: process.env.SLACK_APP_TOKEN!,
          socketMode: true,
        });

        // Get bot's own user ID once at startup (not per-message)
        let botUserId: string | undefined;
        try {
          const auth = await app.client.auth.test();
          botUserId = auth.user_id as string;
        } catch { /* ignore */ }

        // Listen for messages (DMs and mentions)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app.message(async ({ message, say, client }: { message: any; say: any; client: any }) => {
          if (ctx.abortSignal.aborted) return;
          // Skip bot messages and message edits
          if (!('text' in message) || !message.text || ('subtype' in message && message.subtype)) return;

          const userId = ('user' in message) ? message.user as string : 'unknown';
          const channelId = message.channel;
          const threadTs = ('thread_ts' in message) ? message.thread_ts as string : message.ts;

          // Determine if this is a DM or channel message
          const isDm = channelId.startsWith('D'); // Slack DM channels start with D

          // Get user info for display name
          let senderName = userId;
          try {
            const info = await client.users.info({ user: userId });
            senderName = info.user?.real_name || info.user?.name || userId;
          } catch { /* ignore */ }

          const inbound: InboundMessage = {
            channel: 'slack',
            accountId: ctx.accountId,
            senderId: userId,
            senderName,
            chatId: channelId,
            replyTo: channelId,
            chatType: isDm ? 'direct' : 'group',
            body: message.text,
            messageId: message.ts,
            timestamp: message.ts ? Math.floor(parseFloat(message.ts) * 1000) : Date.now(),
            selfId: undefined, // Set below
            sendComposing: async () => {
              // Slack doesn't have a persistent typing indicator API for bots
            },
            reply: async (text: string) => {
              await say({ text, thread_ts: threadTs });
            },
            send: async (text: string) => {
              await say({ text, thread_ts: threadTs });
            },
          };

          inbound.selfId = botUserId;

          await params.onMessage(inbound);
        });

        await app.start();
        ctx.setStatus({ connected: true });
        logger.info('[Slack] Connected via Socket Mode');

        // Keep alive until abort
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener('abort', () => {
            void app.stop().then(() => resolve());
          });
        });
      },
    },
  };
}
