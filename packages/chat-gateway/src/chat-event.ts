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
