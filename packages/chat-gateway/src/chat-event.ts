/**
 * Google Chat イベントペイロードの型(本実装で使用するフィールドのみ)。
 * https://developers.google.com/workspace/chat/receive-respond-interactions
 */
export interface ChatUser {
  name?: string; // 'users/XXXX'
  displayName?: string;
  email?: string;
}

export interface ChatSpace {
  name?: string; // 'spaces/XXXX'
  type?: string; // 'DM' | 'ROOM'(旧形式)
  spaceType?: string; // 'DIRECT_MESSAGE' | 'SPACE'
}

export interface ChatMessagePayload {
  name?: string;
  text?: string;
  argumentText?: string;
  sender?: ChatUser;
  space?: ChatSpace;
}

export interface ChatActionPayload {
  actionMethodName?: string;
  parameters?: Array<{ key?: string; value?: string }>;
}

export interface ChatEvent {
  type?: 'MESSAGE' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'CARD_CLICKED' | string;
  eventTime?: string;
  user?: ChatUser;
  space?: ChatSpace;
  message?: ChatMessagePayload;
  action?: ChatActionPayload;
  common?: { invokedFunction?: string; parameters?: Record<string, string> };
}

/** カードアクションのパラメータを新旧両形式から取り出す。 */
export function actionParameters(event: ChatEvent): Record<string, string> {
  const params: Record<string, string> = {};
  for (const p of event.action?.parameters ?? []) {
    if (p.key !== undefined && p.value !== undefined) params[p.key] = p.value;
  }
  Object.assign(params, event.common?.parameters ?? {});
  return params;
}

export function actionName(event: ChatEvent): string | undefined {
  return event.common?.invokedFunction ?? event.action?.actionMethodName;
}

/** イベントからメッセージ本文を取り出す(メンション除去済みの argumentText を優先)。 */
export function messageText(event: ChatEvent): string {
  const text = event.message?.argumentText ?? event.message?.text ?? '';
  return text.trim();
}

// ── Workspace アドオン基盤経由のイベント形式(新方式)──────────────
// 新方式では Chat 固有のデータが `chat` オブジェクトに包まれて届き、
// 応答も hostAppDataAction でラップした形式を要求される。
// https://developers.google.com/workspace/add-ons/chat/build

/** 新方式イベント(本実装で使用するフィールドのみ)。 */
export interface AddonChatEvent {
  commonEventObject?: {
    invokedFunction?: string;
    parameters?: Record<string, string>;
  };
  chat?: {
    user?: ChatUser;
    eventTime?: string;
    messagePayload?: { message?: ChatMessagePayload; space?: ChatSpace };
    addedToSpacePayload?: { space?: ChatSpace };
    removedFromSpacePayload?: { space?: ChatSpace };
    buttonClickedPayload?: { message?: ChatMessagePayload; space?: ChatSpace };
    appCommandPayload?: { message?: ChatMessagePayload; space?: ChatSpace };
  };
}

export type ChatEventMode = 'classic' | 'addon';

export interface NormalizedChatEvent {
  event: ChatEvent;
  mode: ChatEventMode;
}

/**
 * 新旧どちらの形式で届いても、従来の ChatEvent に正規化する。
 * 判定: `chat` キーの有無(新方式のみに存在)。
 */
export function normalizeChatEvent(raw: unknown): NormalizedChatEvent {
  const addon = raw as AddonChatEvent;
  if (addon !== null && typeof addon === 'object' && addon.chat !== undefined) {
    const chat = addon.chat;
    const common = {
      invokedFunction: addon.commonEventObject?.invokedFunction,
      parameters: addon.commonEventObject?.parameters,
    };
    if (chat.messagePayload !== undefined) {
      return {
        mode: 'addon',
        event: {
          type: 'MESSAGE',
          user: chat.user,
          space: chat.messagePayload.space ?? chat.messagePayload.message?.space,
          message: chat.messagePayload.message,
          common,
        },
      };
    }
    if (chat.buttonClickedPayload !== undefined) {
      return {
        mode: 'addon',
        event: {
          type: 'CARD_CLICKED',
          user: chat.user,
          space: chat.buttonClickedPayload.space ?? chat.buttonClickedPayload.message?.space,
          message: chat.buttonClickedPayload.message,
          common,
        },
      };
    }
    if (chat.addedToSpacePayload !== undefined) {
      return {
        mode: 'addon',
        event: {
          type: 'ADDED_TO_SPACE',
          user: chat.user,
          space: chat.addedToSpacePayload.space,
          common,
        },
      };
    }
    if (chat.removedFromSpacePayload !== undefined) {
      return {
        mode: 'addon',
        event: { type: 'REMOVED_FROM_SPACE', user: chat.user, space: chat.removedFromSpacePayload.space, common },
      };
    }
    // chat はあるが既知のペイロードがない: 種別不明として扱う(呼び出し元でログされる)
    return { mode: 'addon', event: { type: undefined, user: chat.user, common } };
  }
  return { mode: 'classic', event: (raw ?? {}) as ChatEvent };
}

/**
 * アプリの応答(text / cardsV2 / actionResponse)を、受信時の形式に合わせてラップする。
 * - classic: そのまま返す
 * - addon: hostAppDataAction.chatDataAction でラップする
 *   (UPDATE_MESSAGE は updateMessageAction、それ以外は createMessageAction)
 */
export function wrapChatResponse(mode: ChatEventMode, response: unknown): unknown {
  if (mode === 'classic') return response ?? {};
  const r = (response ?? {}) as {
    text?: string;
    cardsV2?: unknown[];
    actionResponse?: { type?: string };
  };
  const message: Record<string, unknown> = {};
  if (r.text !== undefined) message['text'] = r.text;
  if (r.cardsV2 !== undefined) message['cardsV2'] = r.cardsV2;
  if (Object.keys(message).length === 0) return {};

  const action =
    r.actionResponse?.type === 'UPDATE_MESSAGE'
      ? { updateMessageAction: { message } }
      : { createMessageAction: { message } };
  return { hostAppDataAction: { chatDataAction: action } };
}
