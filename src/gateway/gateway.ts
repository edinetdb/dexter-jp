import { createChannelManager, type ChannelManager } from './channels/manager.js';
import { createWhatsAppPlugin } from './channels/whatsapp/plugin.js';
import {
  assertOutboundAllowed,
  sendComposing,
  sendMessageWhatsApp,
  type WhatsAppInboundMessage,
} from './channels/whatsapp/index.js';
import { formatForChannel } from './channels/send.js';
import type { InboundMessage } from './types.js';
import { resolveRoute } from './routing/resolve-route.js';
import { resolveSessionStorePath, upsertSessionMeta } from './sessions/store.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import { runAgentForMessage, isSessionRunning, enqueueForSession } from './agent-runner.js';
import { startCronRunner } from '../cron/runner.js';
import { ensureHeartbeatCronJob } from '../cron/heartbeat-migration.js';
import {
  isBotMentioned,
  recordGroupMessage,
  getAndClearGroupHistory,
  formatGroupHistoryContext,
  noteGroupMember,
  formatGroupMembersList,
} from './group/index.js';
import type { GroupContext } from '../agent/prompts.js';
import { appendFileSync } from 'node:fs';
import { dexterPath } from '../utils/paths.js';
import { getSetting } from '../utils/config.js';

const LOG_PATH = dexterPath('gateway-debug.log');
function debugLog(msg: string) {
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

export type GatewayService = {
  stop: () => Promise<void>;
  snapshot: () => Record<string, { accountId: string; running: boolean; connected?: boolean }>;
};

function elide(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Convert WhatsApp-specific inbound message to channel-agnostic InboundMessage.
 */
function normalizeWhatsAppInbound(wa: WhatsAppInboundMessage): InboundMessage {
  return {
    channel: 'whatsapp',
    accountId: wa.accountId,
    senderId: wa.senderId,
    senderName: wa.senderName,
    chatId: wa.chatId,
    replyTo: wa.replyToJid,
    chatType: wa.chatType,
    body: wa.body,
    messageId: wa.id,
    timestamp: wa.timestamp,
    groupSubject: wa.groupSubject,
    groupParticipants: wa.groupParticipants,
    mentionedIds: wa.mentionedJids,
    selfId: wa.selfJid ?? undefined,
    selfIdAlt: wa.selfLid ?? undefined,
    sendComposing: wa.sendComposing,
    reply: wa.reply,
    send: async (text: string) => { await sendMessageWhatsApp({ to: wa.replyToJid, body: text, accountId: wa.accountId }); },
  };
}

/**
 * Channel-agnostic inbound message handler.
 */
async function handleInbound(cfg: GatewayConfig, inbound: InboundMessage): Promise<void> {
  const bodyPreview = elide(inbound.body.replace(/\n/g, ' '), 50);
  const isGroup = inbound.chatType === 'group';
  console.log(`[${inbound.channel}] Inbound from ${inbound.senderId} (${inbound.chatType}, ${inbound.body.length} chars): "${bodyPreview}"`);
  debugLog(`[gateway] handleInbound channel=${inbound.channel} from=${inbound.senderId} isGroup=${isGroup}`);

  // --- Group-specific: track member, check mention gating ---
  if (isGroup) {
    noteGroupMember(inbound.chatId, inbound.senderId, inbound.senderName);

    const mentioned = isBotMentioned({
      mentionedJids: inbound.mentionedIds ?? [],
      selfJid: inbound.selfId ?? '',
      selfLid: inbound.selfIdAlt,
      body: inbound.body,
    });
    debugLog(`[gateway] group mention check: mentioned=${mentioned}`);

    if (!mentioned) {
      recordGroupMessage(inbound.chatId, {
        senderName: inbound.senderName ?? inbound.senderId,
        senderId: inbound.senderId,
        body: inbound.body,
        timestamp: inbound.timestamp ?? Date.now(),
      });
      debugLog(`[gateway] group message buffered (no mention), skipping reply`);
      return;
    }
  }

  // --- Routing ---
  const peerId = isGroup ? inbound.chatId : inbound.senderId;
  const route = resolveRoute({
    cfg,
    channel: inbound.channel,
    accountId: inbound.accountId,
    peer: { kind: inbound.chatType, id: peerId },
  });

  const storePath = resolveSessionStorePath(route.agentId);
  upsertSessionMeta({
    storePath,
    sessionKey: route.sessionKey,
    channel: inbound.channel,
    to: inbound.replyTo,
    accountId: route.accountId,
    agentId: route.agentId,
  });

  // --- Typing indicator loop ---
  const TYPING_INTERVAL_MS = 5000;
  const TYPING_MAX_MS = 120000; // Auto-stop typing after 2 minutes
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let typingMaxTimer: ReturnType<typeof setTimeout> | undefined;

  const startTypingLoop = async () => {
    await inbound.sendComposing();
    typingTimer = setInterval(() => { void inbound.sendComposing(); }, TYPING_INTERVAL_MS);
    typingMaxTimer = setTimeout(() => stopTypingLoop(), TYPING_MAX_MS);
  };

  const stopTypingLoop = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    if (typingMaxTimer) {
      clearTimeout(typingMaxTimer);
      typingMaxTimer = undefined;
    }
  };

  try {
    // For WhatsApp, verify outbound is allowed (other channels handle this internally)
    if (inbound.channel === 'whatsapp') {
      const outboundTarget = isGroup ? inbound.chatId : inbound.replyTo;
      try {
        assertOutboundAllowed({ to: outboundTarget, accountId: inbound.accountId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        debugLog(`[gateway] outbound BLOCKED: ${msg}`);
        console.log(msg);
        return;
      }
    }

    await startTypingLoop();

    // --- Build query (group context) ---
    let query = inbound.body;
    let groupContext: GroupContext | undefined;

    if (isGroup) {
      const history = getAndClearGroupHistory(inbound.chatId);
      query = formatGroupHistoryContext({
        history,
        currentSenderName: inbound.senderName ?? inbound.senderId,
        currentSenderId: inbound.senderId,
        currentBody: inbound.body,
      });
      debugLog(`[gateway] group query with ${history.length} history entries`);

      const membersList = formatGroupMembersList({
        groupId: inbound.chatId,
        participants: inbound.groupParticipants,
      });
      groupContext = {
        groupName: inbound.groupSubject,
        membersList: membersList || undefined,
        activationMode: 'mention',
      };
    }

    console.log(`Processing message with agent...`);
    const model = process.env.DEXTER_MODEL || getSetting('modelId', 'gpt-5.4') as string;
    const modelProvider = process.env.DEXTER_PROVIDER || getSetting('provider', 'openai') as string;

    // If agent is already running for this session, enqueue for mid-run injection
    if (isSessionRunning(route.sessionKey)) {
      debugLog(`[gateway] agent busy for session=${route.sessionKey}, enqueueing`);
      enqueueForSession(route.sessionKey, model, query);
      return;
    }

    debugLog(`[gateway] running agent for session=${route.sessionKey}`);
    const startedAt = Date.now();
    const agentTimeoutMs = parseInt(process.env.DEXTER_AGENT_TIMEOUT_MS || '120000', 10);
    const agentController = new AbortController();
    const agentTimer = setTimeout(() => agentController.abort(), agentTimeoutMs);
    let answer: string;
    try {
      const maxIter = process.env.DEXTER_PUBLIC_GATEWAY === '1' ? 5 : 10;
      answer = await runAgentForMessage({
        sessionKey: route.sessionKey,
        query,
        model,
        modelProvider,
        maxIterations: maxIter,
        channel: inbound.channel,
        groupContext,
        signal: agentController.signal,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort')) {
        answer = `⏱️ 処理が${agentTimeoutMs / 1000}秒を超えたため中断しました。もう少し具体的な質問にするか、時間を空けて再度お試しください。`;
      } else if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) {
        answer = '⏳ APIのレート制限に達しました。少し時間を置いてから再度お試しください。';
      } else {
        answer = `Error: ${msg.slice(0, 200)}`;
      }
    } finally {
      clearTimeout(agentTimer);
    }
    const durationMs = Date.now() - startedAt;
    debugLog(`[gateway] agent answer length=${answer.length}`);

    stopTypingLoop();

    if (answer.trim()) {
      const formatted = formatForChannel(inbound.channel, answer);

      if (isGroup) {
        debugLog(`[gateway] sending group reply to ${inbound.chatId}`);
        await inbound.reply(formatted);
      } else {
        debugLog(`[gateway] sending reply to ${inbound.replyTo}`);
        await inbound.send(formatted);
      }
      console.log(`Sent reply (${answer.length} chars, ${durationMs}ms)`);
      debugLog(`[gateway] reply sent`);
    } else {
      console.log(`Agent returned empty response (${durationMs}ms)`);
      debugLog(`[gateway] empty answer, not sending`);
    }
  } catch (err) {
    stopTypingLoop();
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${msg}`);
    debugLog(`[gateway] ERROR: ${msg}`);
  }
}

/**
 * Start the gateway with all configured channels.
 */
export async function startGateway(params: { configPath?: string } = {}): Promise<GatewayService> {
  const cfg = loadGatewayConfig(params.configPath);

  // --- Channel plugins ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const managers: ChannelManager<any, any>[] = [];

  // WhatsApp (always registered, only starts if configured)
  const waPlugin = createWhatsAppPlugin({
    loadConfig: () => loadGatewayConfig(params.configPath),
    onMessage: async (waInbound) => {
      const current = loadGatewayConfig(params.configPath);
      const inbound = normalizeWhatsAppInbound(waInbound);
      await handleInbound(current, inbound);
    },
  });
  const waManager = createChannelManager({
    plugin: waPlugin,
    loadConfig: () => loadGatewayConfig(params.configPath),
  });
  managers.push(waManager);

  // Slack (if configured)
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const { createSlackPlugin } = await import('./channels/slack/plugin.js');
    const slackPlugin = createSlackPlugin({
      loadConfig: () => loadGatewayConfig(params.configPath),
      onMessage: async (inbound) => {
        const current = loadGatewayConfig(params.configPath);
        await handleInbound(current, inbound);
      },
    });
    const slackManager = createChannelManager({
      plugin: slackPlugin,
      loadConfig: () => loadGatewayConfig(params.configPath),
    });
    managers.push(slackManager);
  }

  // Discord (if configured)
  if (process.env.DISCORD_BOT_TOKEN) {
    const { createDiscordPlugin } = await import('./channels/discord/plugin.js');
    const discordPlugin = createDiscordPlugin({
      loadConfig: () => loadGatewayConfig(params.configPath),
      onMessage: async (inbound) => {
        const current = loadGatewayConfig(params.configPath);
        await handleInbound(current, inbound);
      },
    });
    const discordManager = createChannelManager({
      plugin: discordPlugin,
      loadConfig: () => loadGatewayConfig(params.configPath),
    });
    managers.push(discordManager);
  }

  // LINE (if configured)
  if (process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    const { createLinePlugin } = await import('./channels/line/plugin.js');
    const linePlugin = createLinePlugin({
      loadConfig: () => loadGatewayConfig(params.configPath),
      onMessage: async (inbound) => {
        const current = loadGatewayConfig(params.configPath);
        await handleInbound(current, inbound);
      },
    });
    const lineManager = createChannelManager({
      plugin: linePlugin,
      loadConfig: () => loadGatewayConfig(params.configPath),
    });
    managers.push(lineManager);
  }

  // Start all channel managers
  await Promise.all(managers.map(m => m.startAll()));

  ensureHeartbeatCronJob(params.configPath);
  const cron = startCronRunner({ configPath: params.configPath });

  return {
    stop: async () => {
      cron.stop();
      await Promise.all(managers.map(m => m.stopAll()));
    },
    snapshot: () => {
      const combined: Record<string, { accountId: string; running: boolean; connected?: boolean }> = {};
      for (const m of managers) {
        Object.assign(combined, m.getSnapshot());
      }
      return combined;
    },
  };
}
