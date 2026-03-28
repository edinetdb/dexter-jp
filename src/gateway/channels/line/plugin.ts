import type { ChannelPlugin, ChannelStartContext } from '../types.js';
import type { InboundMessage } from '../../types.js';
import type { GatewayConfig } from '../../config.js';
import { logger } from '../../../utils/logger.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

type LineAccountConfig = {
  enabled: boolean;
};

type LinePluginParams = {
  loadConfig: () => GatewayConfig;
  onMessage: (inbound: InboundMessage) => Promise<void>;
};

/**
 * Create a LINE channel plugin using Messaging API webhooks.
 * Requires: LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN environment variables.
 * Starts a local HTTP server to receive webhook events from LINE Platform.
 */
export function createLinePlugin(params: LinePluginParams): ChannelPlugin<GatewayConfig, LineAccountConfig> {
  return {
    id: 'line',
    config: {
      listAccountIds: () => {
        return process.env.LINE_CHANNEL_ACCESS_TOKEN ? ['default'] : [];
      },
      resolveAccount: () => ({ enabled: true }),
      isEnabled: (account) => account.enabled,
      isConfigured: () => Boolean(process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN),
    },
    gateway: {
      startAccount: async (ctx: ChannelStartContext<LineAccountConfig>) => {
        const { messagingApi, validateSignature } = await import('@line/bot-sdk');

        const channelSecret = process.env.LINE_CHANNEL_SECRET!;
        const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
        const port = parseInt(process.env.WEBHOOK_PORT || '3000', 10);

        const client = new messagingApi.MessagingApiClient({ channelAccessToken });

        // Get bot's own user ID
        let botUserId: string | undefined;
        try {
          const profile = await client.getBotInfo();
          botUserId = profile.userId;
        } catch { /* ignore */ }

        const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST' || req.url !== '/webhook/line') {
            res.writeHead(404);
            res.end();
            return;
          }

          // Read body (1MB limit)
          const MAX_BODY_BYTES = 1024 * 1024;
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of req) {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            totalBytes += buf.length;
            if (totalBytes > MAX_BODY_BYTES) {
              res.writeHead(413);
              res.end('Payload too large');
              return;
            }
            chunks.push(buf);
          }
          const bodyBuffer = Buffer.concat(chunks);
          const bodyStr = bodyBuffer.toString('utf-8');

          // Verify signature
          const signature = req.headers['x-line-signature'] as string;
          if (!signature || !validateSignature(bodyStr, channelSecret, signature)) {
            res.writeHead(401);
            res.end('Invalid signature');
            return;
          }

          // Parse events
          let events: Array<Record<string, unknown>>;
          try {
            const parsed = JSON.parse(bodyStr) as { events?: Array<Record<string, unknown>> };
            events = parsed.events ?? [];
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
            return;
          }

          // Respond immediately (LINE expects 200 within seconds)
          res.writeHead(200);
          res.end('OK');

          // Process message events
          for (const event of events) {
            if (event.type !== 'message' || (event.message as Record<string, unknown>)?.type !== 'text') continue;

            const source = event.source as Record<string, unknown>;
            const message = event.message as Record<string, unknown>;
            const replyToken = event.replyToken as string;
            const userId = (source.userId as string) || 'unknown';
            const groupId = source.groupId as string | undefined;
            const isGroup = source.type === 'group' || source.type === 'room';

            // Get user profile for display name
            let senderName = userId;
            try {
              if (isGroup && groupId) {
                const profile = await client.getGroupMemberProfile(groupId, userId);
                senderName = profile.displayName;
              } else {
                const profile = await client.getProfile(userId);
                senderName = profile.displayName;
              }
            } catch { /* ignore */ }

            const inbound: InboundMessage = {
              channel: 'line',
              accountId: ctx.accountId,
              senderId: userId,
              senderName,
              chatId: groupId || userId,
              replyTo: userId,
              chatType: isGroup ? 'group' : 'direct',
              body: message.text as string,
              messageId: message.id as string,
              timestamp: event.timestamp as number,
              selfId: botUserId,
              sendComposing: async () => {
                // LINE doesn't have a typing indicator API
              },
              reply: async (text: string) => {
                // replyToken expires after use or after ~1 minute
                try {
                  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
                } catch {
                  // If reply token expired, fall back to push message
                  await client.pushMessage({ to: groupId || userId, messages: [{ type: 'text', text }] });
                }
              },
              send: async (text: string) => {
                await client.pushMessage({ to: groupId || userId, messages: [{ type: 'text', text }] });
              },
            };

            await params.onMessage(inbound);
          }
        });

        server.listen(port, () => {
          ctx.setStatus({ connected: true });
          logger.info(`[LINE] Webhook server listening on port ${port}`);
        });

        // Keep alive until abort
        await new Promise<void>((resolve) => {
          ctx.abortSignal.addEventListener('abort', () => {
            server.close(() => resolve());
          });
        });
      },
    },
  };
}
