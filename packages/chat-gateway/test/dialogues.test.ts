import { describe, expect, it } from 'vitest';
import {
  ADHOC_CHECKIN_MAX_TURNS,
  COMPLETION_REVIEW_MAX_TURNS,
  MORNING_DIALOGUE_MAX_TURNS,
} from '@ai-manager/shared';
import { fetchRecentTurns, findOpenDialogue, type DialogueTurn } from '../src/services/dialogues.js';
import { createMockPool, findCall } from './mock-pool.js';

function turn(role: 'ai' | 'user', content: string): DialogueTurn {
  return { role, content, ts: '2026-07-13T09:00:00.000Z' };
}

describe('findOpenDialogue(ターン数上限 — v0.12 §2)', () => {
  it('朝・夕・状況確認のそれぞれにターン数上限が適用される(質問ループの終了制御)', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await findOpenDialogue(pool, 'member1', '2026-07-13');

    const call = findCall(calls, 'FROM ops.dialogues');
    // 朝: 仮説未確定でも上限に達したら「返信待ち」から外す
    expect(call?.text).toContain(
      `dialogue_type = 'morning_checkin' AND hypothesis IS NULL\n             AND jsonb_array_length(turns) < ${MORNING_DIALOGUE_MAX_TURNS}`,
    );
    // 夕: レビュー未確定でも上限に達したら外す
    expect(call?.text).toContain(
      `dialogue_type = 'completion_review' AND review IS NULL\n             AND jsonb_array_length(turns) < ${COMPLETION_REVIEW_MAX_TURNS}`,
    );
    // 状況確認: 従来どおり(v0.5)
    expect(call?.text).toContain(
      `dialogue_type = 'adhoc_checkin' AND jsonb_array_length(turns) < ${ADHOC_CHECKIN_MAX_TURNS}`,
    );
  });

  it('上限値の関係: 朝(初回AI+5往復) > 夕(5往復) > 状況確認(初回AI+3往復)', () => {
    // 定数の意味が変わったらこのテストで気づけるようにする(仕様の固定)
    expect(MORNING_DIALOGUE_MAX_TURNS).toBe(11);
    expect(COMPLETION_REVIEW_MAX_TURNS).toBe(10);
    expect(ADHOC_CHECKIN_MAX_TURNS).toBe(7);
  });
});

describe('fetchRecentTurns(随時 QA の会話履歴 — v0.12 §5)', () => {
  it('直近の対話を時系列に平坦化し、末尾 maxTurns 件を返す', async () => {
    // クエリは新しい順(DESC)で返る: 直近の QA → その前の朝の対話
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('SELECT turns')) {
        return {
          rows: [
            { turns: [turn('user', '直近の質問'), turn('ai', '直近の回答')] },
            { turns: [turn('ai', '朝の問いかけ'), turn('user', '朝の返信')] },
          ],
        };
      }
      return { rows: [] };
    });

    const turns = await fetchRecentTurns(pool, 'member1', 12);

    // 古い対話 → 新しい対話の順(時系列)に並ぶ
    expect(turns.map((t) => t.content)).toEqual([
      '朝の問いかけ',
      '朝の返信',
      '直近の質問',
      '直近の回答',
    ]);
    // 直近24時間・本人分のみが対象
    const call = findCall(calls, 'SELECT turns');
    expect(call?.text).toContain(`INTERVAL '24 hours'`);
    expect(call?.params).toEqual(['member1']);
  });

  it('maxTurns を超える履歴は末尾(直近)のみ残す', async () => {
    const { pool } = createMockPool((text) => {
      if (text.includes('SELECT turns')) {
        return {
          rows: [
            {
              turns: [
                turn('user', 'q1'),
                turn('ai', 'a1'),
                turn('user', 'q2'),
                turn('ai', 'a2'),
              ],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const turns = await fetchRecentTurns(pool, 'member1', 2);
    expect(turns.map((t) => t.content)).toEqual(['q2', 'a2']);
  });

  it('取得に失敗しても空配列で継続する(非ブロッキング — 原則4)', async () => {
    const { pool } = createMockPool(() => new Error('db down'));
    await expect(fetchRecentTurns(pool, 'member1', 12)).resolves.toEqual([]);
  });
});
