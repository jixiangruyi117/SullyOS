import { ActiveMsg2InboxMessage, APIConfig, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';
import { applyAssistantPostProcessing, type XhsCaches } from './applyAssistantPostProcessing';

let initialized = false;

// Phase 1: 用 module-level ref 缓存 XHS 跨消息 token (与 useChatAI 行为对齐)。
// 跨整个 push 路径共享, 不每条 inbox 消息重建; XHS 在 push 路径默认被 skipSecondPassLLM
// 跳过, 所以这里实际上始终是空 Map, 留着是为了满足 ctx 接口契约。
const pushXhsCaches: XhsCaches = {
  xsecTokenCache: new Map(),
  noteTitleCache: new Map(),
  commentUserIdCache: new Map(),
  commentAuthorNameCache: new Map(),
  commentParentIdCache: new Map(),
};

/** 从 localStorage 读 APIConfig (与 OSContext load 逻辑保持一致, 但这里在 React 之外跑) */
const loadApiConfigFromLocalStorage = (): APIConfig => {
  const fallback: APIConfig = { baseUrl: '', apiKey: '', model: '' };
  try {
    const raw = localStorage.getItem('os_api_config');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || '',
      apiKey: parsed.apiKey || '',
      model: parsed.model || '',
      ...parsed,
    };
  } catch {
    return fallback;
  }
};

/** 从 localStorage 读 RealtimeConfig — 整个 push 路径里我们不会再回连 LLM, 但 ChatParser
 *  及 DIARY 写入(可执行的副作用)需要这些配置, 缺失时返回 undefined 让消费方走 fallback。 */
const loadRealtimeConfigFromLocalStorage = (): RealtimeConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_realtime_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    return undefined;
  }
};

/**
 * 用 applyAssistantPostProcessing 把 push 收到的 inbox message 走一遍 13 步管线。
 * skipSecondPassLLM=true: 不回连 LLM (worker 现在还没续跑能力, Phase 2 才解决),
 * 二轮标签 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) 留在
 * 原文里, 由 ChatParser.sanitize 等步骤兜底剥掉。
 * 副作用类标签 (POKE / TRANSFER / ADD_EVENT / schedule_message / 写日记) 仍会执行。
 * 失败时抛出, 由调用方决定是否重新入队。
 */
const processInboxMessageWithPostProcessing = async (message: ActiveMsg2InboxMessage): Promise<void> => {
  const characters = await DB.getAllCharacters();
  const char = characters.find(c => c.id === message.charId);
  if (!char) {
    throw new Error(`character not found for charId=${message.charId}`);
  }

  const userProfile: UserProfile = (await DB.getUserProfile())
    ?? { name: 'User', avatar: '', bio: '' };
  const emojis = await DB.getEmojis();
  const contextMsgs = await DB.getRecentMessagesByCharId(message.charId, 200);

  const apiConfig = loadApiConfigFromLocalStorage();
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // Phase 1: 副作用 (DIARY 写入等) 会调 DB.saveMessage, 它内部已经 fire 'messages-updated' 事件;
  // 但 OSContext 真正驱动 chat UI 重新 reloadMessages 的是 lastMsgTimestamp, 而那个 state 现在
  // 只由 'active-msg-received' handler 改。为了让 push 路径下的 per-chunk 落库也立刻反映到 UI,
  // 用一个独立的 side-channel 事件 'active-msg-progress': OSContext 监听它后只 setLastMsgTimestamp,
  // 不 fire toast / 不增加未读 / 不 resolve sendInstantPush 的 one-shot promise。
  // 单条 inbox message 进来时 fire 一次 'active-msg-received' 即可保证 toast / 未读 / 通知一次发生。
  const dispatchProgress = () => {
    window.dispatchEvent(new CustomEvent('active-msg-progress', {
      detail: { charId: message.charId },
    }));
  };

  await applyAssistantPostProcessing(message.body || '', {
    char,
    userProfile,
    emojis,
    realtimeConfig,
    contextMsgs,
    // fullMessages / initialData: worker 不会传过来 (Phase 2 才有续跑), 二轮 LLM 又被关掉,
    // 这两个字段在 skipSecondPassLLM=true 时实际上不会被消费; 给个最小占位避免 undefined NPE。
    fullMessages: [],
    initialData: null,
    historyMsgCount: contextMsgs.length,
    // 把 source / activeMsg2 元数据通过 mcdInheritMeta 继承到每条 assistant message, 这样
    // UI 还能区分 "这条是 push 来的"。
    mcdInheritMeta: {
      source: 'active_msg_2',
      activeMsg2: {
        messageId: message.messageId,
        taskId: message.taskId,
        messageType: message.messageType,
        messageSubtype: message.messageSubtype,
        avatarUrl: message.avatarUrl,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
      },
      ...(message.metadata || {}),
    },
    xhsCaches: pushXhsCaches,
    api: {
      baseUrl: apiConfig.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
      },
      effectiveApi: {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
      },
    },
    hooks: {
      // setMessages 在 React 外面跑, 没法直接 setState, 只 fire 一次 progress 事件让
      // OSContext 推 lastMsgTimestamp, 然后 Chat.tsx 自然 reloadMessages 重新读库。
      setMessages: () => { dispatchProgress(); },
      // push 路径 deliberately 静默 toast — 避免在用户没在 chat 这个角色时狂弹 toast。
      // 如果真要给用户可见反馈, 应该走 'active-msg-received' 那条线 (toast / 未读 / 通知)。
      addToast: (msg: string, type: 'info' | 'success' | 'error') => {
        console.log('[push:toast]', type, msg);
      },
      // 不传 musicHooks: ChatParser 检测到没钩子时会静默丢弃 MUSIC_ACTION 标签 (chatParser.ts:155)。
      // Phase 1 接受 "push 来的消息看不到音乐卡片" 这个 trade-off, Phase 2 再补回来。
    },
    skipSecondPassLLM: true,
    directives: [],
  });
};

const flushInboxToChat = async () => {
  const pendingMessages = await ActiveMsgStore.consumeInboxMessages();
  // consumeInboxMessages 是 "先 ack 后处理" 语义 —— inbox 已经原子地清空。
  // 这里 per-message try/catch: 单条处理抛错 (quota / DB 故障 / postprocess 异常) 不连累
  // 后续条目。Phase 1 改成: 先尝试走 applyAssistantPostProcessing (与本地 fetch 路径
  // 行为对齐 — emoji / 翻译 / HTML / 引用 / chunking 全部复用同一管线); 如果走管线失败,
  // 降级回原来的 "原文一次性 saveMessage" 防止消息丢失。dispatchEvent 始终 fire 一次,
  // 保证 toast / 未读 / 通知 / sendInstantPush resolver 语义不变。
  for (const message of pendingMessages) {
    const messageTimestamp = message.sentAt || message.receivedAt || Date.now();

    // 非 assistant 普通文本类型 (e.g. 'system') 直接走老路径, 不进 post-processing 管线。
    // post-processing 假设是 AI 文本输出, 强行套到 system 消息会乱解析。
    const looksLikeAssistantText =
      !message.messageType
      || message.messageType === 'text'
      || message.messageType === 'assistant'
      || message.messageType === 'normal';

    let routed = false;

    if (looksLikeAssistantText) {
      try {
        await processInboxMessageWithPostProcessing(message);
        routed = true;
      } catch (postErr) {
        console.warn('[ActiveMsg] post-processing failed, falling back to raw save', message.messageId, postErr);
        // 落库失败: 有可能 post-processing 中途已经写了部分 chunk 进 DB, 这里再 raw save 一遍
        // 会重复; 但中途失败时通常是初始化阶段就挂了 (char 找不到 / DB 故障), 部分写入概率低。
        // 为了不丢消息, 仍尝试 raw save; 若它也失败, 会进下面的 catch 把消息 requeue。
      }
    }

    if (!routed) {
      try {
        await DB.saveMessage({
          charId: message.charId,
          role: 'assistant',
          type: 'text',
          content: message.body,
          timestamp: messageTimestamp,
          metadata: {
            source: 'active_msg_2',
            activeMsg2: {
              messageId: message.messageId,
              taskId: message.taskId,
              messageType: message.messageType,
              messageSubtype: message.messageSubtype,
              avatarUrl: message.avatarUrl,
              sentAt: message.sentAt,
              receivedAt: message.receivedAt,
            },
            ...(message.metadata || {}),
          },
        });
      } catch (e) {
        console.warn('[ActiveMsg] saveMessage failed, requeue to inbox', message.messageId, e);
        try {
          await ActiveMsgStore.saveInboxMessage(message);
        } catch (reputErr) {
          // re-put 也挂了 (大概率同一根因, 比如 quota / DB 关停), 没救了, 至少留个日志
          console.error('[ActiveMsg] requeue failed, message lost', message.messageId, reputErr);
        }
        // requeue 后跳过这条消息的 dispatchEvent —— UI 不该误以为收到了
        continue;
      }
    }

    // 不管走 post-processing 还是 raw fallback, 单条 inbox message 触发一次 'active-msg-received',
    // 保留原有 toast / 未读 / 通知 / sendInstantPush resolver 语义。body 用原文做预览即可。
    window.dispatchEvent(new CustomEvent('active-msg-received', {
      detail: {
        charId: message.charId,
        charName: message.charName,
        body: message.body,
        avatarUrl: message.avatarUrl,
        sentAt: messageTimestamp,
      },
    }));
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    window.history.replaceState({}, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type === 'active-msg-received') {
          void flushInboxToChat();
          return;
        }

        if (type === 'active-msg-open') {
          void flushInboxToChat().then(() => {
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
          });
        }
      });
    }

    await flushInboxToChat();
    handleDeepLink();
  },
};
