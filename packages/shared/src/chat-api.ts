import { AppError, ERROR_CODES } from './errors.js';
import { getAccessToken, SCOPES } from './google-auth.js';

/**
 * Google Chat REST API クライアント(アプリ認証)。
 * ランタイム SA を Chat アプリとして構成しておくこと(docs/operations/deployment-setup.md)。
 */
const CHAT_API_BASE = 'https://chat.googleapis.com/v1';

/** Chat カード(cardsV2)を含むメッセージ。構造は Google Chat API の Message に準拠。 */
export interface ChatAppMessage {
  text?: string;
  cardsV2?: unknown[];
}

export async function sendChatMessage(
  spaceName: string,
  message: ChatAppMessage,
): Promise<{ name?: string }> {
  const token = await getAccessToken([SCOPES.CHAT_BOT]);
  // spaceName は 'spaces/XXXX' 形式
  const res = await fetch(`${CHAT_API_BASE}/${spaceName}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(message),
  }).catch((err: unknown) => {
    throw new AppError(ERROR_CODES.CHAT_SEND_FAILED, 'Google Chat への接続に失敗しました', {
      cause: err,
      details: { spaceName },
    });
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(ERROR_CODES.CHAT_SEND_FAILED, `Google Chat へのメッセージ送信に失敗しました (HTTP ${res.status})`, {
      details: { spaceName, status: res.status, body: text.slice(0, 300) },
    });
  }
  return (await res.json()) as { name?: string };
}
