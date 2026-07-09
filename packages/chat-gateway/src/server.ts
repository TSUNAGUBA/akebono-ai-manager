import {
  createAppServer,
  logger,
  query,
  readJsonBody,
  sendJson,
  type ChatAppMessage,
} from '@ai-manager/shared';
import type http from 'node:http';
import type pg from 'pg';
import { resolveUser, verifyChatRequest } from './auth.js';
import { messageText, type ChatEvent } from './chat-event.js';
import { handleCardAction } from './handlers/card-action.js';
import { handleMessage } from './handlers/message.js';

const UNREGISTERED_MESSAGE =
  'このアカウントは AI マネージャーに登録されていません。管理者に登録を依頼してください。';

/** DM スペース ID を ops.users にキャッシュする(SoT は Google Chat、users 行は参照キャッシュ)。 */
async function rememberDmSpace(pool: pg.Pool, userId: string, event: ChatEvent): Promise<void> {
  const space = event.space ?? event.message?.space;
  const isDm = space?.spaceType === 'DIRECT_MESSAGE' || space?.type === 'DM';
  if (!isDm || space?.name === undefined) return;
  await query(
    pool,
    `UPDATE ops.users SET chat_space_id = $2
     WHERE user_id = $1 AND chat_space_id IS DISTINCT FROM $2`,
    [userId, space.name],
  );
}

async function dispatchEvent(pool: pg.Pool, event: ChatEvent): Promise<unknown> {
  const email = event.user?.email;
  const user = await resolveUser(pool, email);

  if (event.type === 'ADDED_TO_SPACE') {
    if (user === undefined) return { text: UNREGISTERED_MESSAGE };
    await rememberDmSpace(pool, user.user_id, event);
    return {
      text: `${user.display_name} さん、こんにちは。AIマネージャーです。\n毎朝の問いかけと夕方の振り返り、日報の自動作成、業務知識の質問対応を担当します。わからないことがあれば、いつでもこのチャットで聞いてください。`,
    };
  }

  if (event.type === 'REMOVED_FROM_SPACE') {
    return {}; // 応答不要
  }

  if (user === undefined) {
    logger.warn('未登録ユーザーからのイベント', { email: email ?? '(不明)', type: event.type });
    return { text: UNREGISTERED_MESSAGE };
  }

  if (event.type === 'CARD_CLICKED') {
    return handleCardAction(pool, event, user);
  }

  if (event.type === 'MESSAGE') {
    await rememberDmSpace(pool, user.user_id, event);
    return handleMessage(pool, event, user);
  }

  logger.warn('未対応の Chat イベント種別', { type: event.type });
  return {};
}

export function createChatGatewayServer(pool: pg.Pool): http.Server {
  return createAppServer([
    {
      method: 'POST',
      path: '/',
      handler: async (req, res) => {
        await verifyChatRequest(req);
        const event = await readJsonBody<ChatEvent>(req);
        try {
          const response = await dispatchEvent(pool, event);
          sendJson(res, 200, response ?? {});
        } catch (err) {
          // Chat 上のユーザー体験を守るため、処理エラーは 200 + 文言で返しつつログに残す
          logger.error('Chat イベント処理に失敗しました', err, {
            type: event.type,
            text: messageText(event).slice(0, 80),
          });
          const fallback: ChatAppMessage = {
            text: '申し訳ありません、処理中にエラーが発生しました。少し時間をおいて再度お試しください。解決しない場合は管理者に連絡してください。',
          };
          sendJson(res, 200, fallback);
        }
      },
    },
  ]);
}
