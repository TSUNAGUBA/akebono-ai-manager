import {
  ADHOC_CHECKIN_INSTRUCTION,
  ADHOC_CHECKIN_MAX_TURNS,
  ADHOC_CHECKIN_PREFIX,
  generateContent,
  jstDateString,
  logger,
  query,
  sendChatMessage,
  SYSTEM_PROMPT,
} from '@ai-manager/shared';
import type pg from 'pg';
import { memberTasksSummary, type JobSummary } from './morning-checkin.js';

/**
 * ジョブパラメータ(要件 v0.5)。
 * userId 指定時はそのメンバー1名のみ、省略時は active な member 全員に配信する。
 */
export interface AdhocCheckinParams {
  userId?: string;
}

/** LLM 不調時のフォールバック文面(グレースフルデグラデーション。朝の問いかけと同じ設計)。 */
function staticAdhocMessage(tasksSummary: string): string {
  return [
    'お疲れさまです。いまの進捗や状況を教えてください。',
    '',
    `現在のタスク状況:\n${tasksSummary}`,
    '',
    '困っていることや詰まっている点があれば、あわせて教えてください。わかる範囲で大丈夫です。',
  ].join('\n');
}

/** 同日の open な状況確認への追い問いかけ文面(返信の有無どちらでも成り立つ中立な文言)。 */
const NUDGE_MESSAGE = 'その後の進捗や状況はいかがですか?変化があれば、わかる範囲で教えてください。';

interface MemberRow {
  user_id: string;
  display_name: string;
  email: string;
  chat_space_id: string | null;
}

/**
 * 管理者発火の状況確認(要件 v0.5)。ダッシュボードの /admin/checkin から OIDC 経由で起動される。
 *
 * 朝の問いかけ(morning-checkin)と同じ配信経路だが、次の点が異なる:
 * - 休日ガード・「1日1回」冪等ガードは適用しない(管理者の意志による都度発火が目的。
 *   二重送信はボタン側の PRG で防止する — v0.5 §2)
 * - 冪等性の設計判断: 同日の open(返信待ち)な adhoc_checkin が既にあるメンバーには
 *   新しい対話を作らず、同じ対話へ追い問いかけを1ターン追記して再送する。
 *   対話が分裂すると返信の帰属(findOpenDialogue)が曖昧になるため
 * - 文面の冒頭に管理者発火であることを示す固定プレフィックスをコード側で必ず付与する
 *   (LLM 出力・フォールバック・追い問いかけの全経路)
 *
 * 非ブロッキング: 個別メンバーの失敗は記録して次のメンバーへ進む(原則4)。
 */
export async function runAdhocCheckin(
  pool: pg.Pool,
  params: AdhocCheckinParams = {},
): Promise<JobSummary> {
  const summary: JobSummary = { sent: 0, skipped: 0, failed: 0 };
  const today = jstDateString();

  const members =
    params.userId === undefined
      ? await query<MemberRow>(
          pool,
          `SELECT user_id, display_name, email, chat_space_id
           FROM ops.users WHERE active AND role = 'member'`,
        )
      : await query<MemberRow>(
          pool,
          `SELECT user_id, display_name, email, chat_space_id
           FROM ops.users WHERE active AND role = 'member' AND user_id = $1`,
          [params.userId],
        );
  if (params.userId !== undefined && members.rows.length === 0) {
    // 画面側でも実在検証するが、フォーム偽装・登録解除との競合に備えた防御(スキップとして報告)
    logger.warn('指定ユーザーが active なメンバーに見つからないためスキップします', {
      userId: params.userId,
    });
    summary.skipped += 1;
    return summary;
  }

  for (const member of members.rows) {
    try {
      if (member.chat_space_id === null) {
        logger.warn('DM スペース未登録のためスキップ(本人が Chat アプリに一度話しかけると登録されます)', {
          userId: member.user_id,
        });
        summary.skipped += 1;
        continue;
      }

      // 同日の open(返信待ち)な状況確認があれば、追い問いかけに切り替える(冒頭コメント参照)
      const open = await query<{ dialogue_id: string }>(
        pool,
        `SELECT dialogue_id FROM ops.dialogues
         WHERE user_id = $1 AND dialogue_type = 'adhoc_checkin'
           AND created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Tokyo')
           AND created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
           AND jsonb_array_length(turns) < ${ADHOC_CHECKIN_MAX_TURNS}
         ORDER BY created_at DESC
         LIMIT 1`,
        [member.user_id, today],
      );
      const openDialogueId = open.rows[0]?.dialogue_id;
      if (openDialogueId !== undefined) {
        await sendNudge(pool, member.chat_space_id, openDialogueId);
        logger.info('open な状況確認があるため追い問いかけを送信しました', {
          userId: member.user_id,
          dialogueId: openDialogueId,
        });
        summary.sent += 1;
        continue;
      }

      const tasksSummary = await memberTasksSummary(pool, member.user_id);

      let messageText: string;
      let modelUsed: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      try {
        const result = await generateContent({
          tier: 'flash-lite',
          system: `${SYSTEM_PROMPT}\n\n${ADHOC_CHECKIN_INSTRUCTION}`,
          messages: [
            {
              role: 'user',
              text: `メンバー: ${member.display_name}\n本人のタスク状況:\n${tasksSummary}`,
            },
          ],
        });
        messageText = result.text;
        modelUsed = result.model;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        costUsd = result.costUsd;
      } catch (err) {
        logger.warn('状況確認の文面生成に失敗したため定型文を使用します', {
          userId: member.user_id,
          error: String(err),
        });
        messageText = staticAdhocMessage(tasksSummary);
      }
      // 管理者発火の明示(要件 v0.5)はコード側で必ず付与する
      const fullText = `${ADHOC_CHECKIN_PREFIX}\n${messageText}`;

      // 対話レコードを先に作成(SoT)、その後 Chat へ配信(morning-checkin と同じ補償設計)
      const inserted = await query<{ dialogue_id: string }>(
        pool,
        `INSERT INTO ops.dialogues
           (user_id, dialogue_type, turns, model_used, input_tokens, output_tokens, cost_usd)
         VALUES ($1, 'adhoc_checkin', $2::jsonb, $3, $4, $5, $6)
         RETURNING dialogue_id`,
        [
          member.user_id,
          JSON.stringify([{ role: 'ai', content: fullText, ts: new Date().toISOString() }]),
          modelUsed ?? null,
          inputTokens,
          outputTokens,
          costUsd,
        ],
      );
      const dialogueId = inserted.rows[0]?.dialogue_id;
      try {
        await sendChatMessage(member.chat_space_id, { text: fullText });
      } catch (sendErr) {
        // 配信に失敗したまま対話レコードが残ると、open 判定により以後の発火が
        // 「届いていない対話」への追い問いかけになってしまうため、補償として削除する
        if (dialogueId !== undefined) {
          await query(pool, 'DELETE FROM ops.dialogues WHERE dialogue_id = $1', [dialogueId]).catch(
            (cleanupErr: unknown) => {
              logger.error('配信失敗後の対話レコード削除に失敗しました(次回発火は追い問いかけになります)', cleanupErr, {
                userId: member.user_id,
                dialogueId,
              });
            },
          );
        }
        throw sendErr;
      }
      logger.info('状況確認を配信しました', {
        userId: member.user_id,
        dialogueId,
      });
      summary.sent += 1;
    } catch (err) {
      logger.error('状況確認の配信に失敗しました(次のメンバーへ継続)', err, {
        userId: member.user_id,
      });
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * open な対話への追い問いかけ: ターン追記(SoT)→ Chat 配信。
 * 配信に失敗した場合は追記したターンを取り除く(morning-checkin の補償削除と同旨。
 * 未配信ターンが残るとターン上限による早期クローズや文脈のずれを招くため)。
 */
async function sendNudge(pool: pg.Pool, chatSpaceId: string, dialogueId: string): Promise<void> {
  const nudgeText = `${ADHOC_CHECKIN_PREFIX}\n${NUDGE_MESSAGE}`;
  await query(
    pool,
    `UPDATE ops.dialogues SET turns = turns || $2::jsonb WHERE dialogue_id = $1`,
    [dialogueId, JSON.stringify([{ role: 'ai', content: nudgeText, ts: new Date().toISOString() }])],
  );
  try {
    await sendChatMessage(chatSpaceId, { text: nudgeText });
  } catch (sendErr) {
    // jsonb の負数インデックスは末尾からの位置(-1 = 直前に追記したターン)
    await query(pool, `UPDATE ops.dialogues SET turns = turns - -1 WHERE dialogue_id = $1`, [
      dialogueId,
    ]).catch((cleanupErr: unknown) => {
      logger.error('配信失敗後の追い問いかけターン削除に失敗しました', cleanupErr, { dialogueId });
    });
    throw sendErr;
  }
}
