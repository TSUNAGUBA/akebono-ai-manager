import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findAwaitingResolution,
  raiseEscalation,
  recordResolution,
  refluxResolutionToKnowledge,
} from '../src/services/escalations.js';
import { callIndex, createMockPool, findCall } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  sendChatMessage: vi.fn(async () => ({})),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return { ...mod, sendChatMessage: mocks.sendChatMessage, embedTexts: mocks.embedTexts };
});

beforeEach(() => {
  mocks.sendChatMessage.mockClear();
  mocks.sendChatMessage.mockResolvedValue({});
  mocks.embedTexts.mockClear();
  mocks.embedTexts.mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
  process.env['ADMIN_SPACE_ID'] = 'spaces/admin';
});

describe('raiseEscalation(起票+通知)', () => {
  it('起票し、「裁定を記録」ボタン付きカードで管理者へ通知する', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('INSERT INTO ops.escalations')) return { rows: [{ escalation_id: '5' }] };
      return undefined;
    });
    await raiseEscalation(pool, { reason: 'low_confidence', context: '質問: 種まきとは' });

    expect(findCall(calls, 'INSERT INTO ops.escalations')).toBeDefined();
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1);
    const [, message] = mocks.sendChatMessage.mock.calls[0] as unknown as [
      string,
      { cardsV2?: unknown[] },
    ];
    expect(JSON.stringify(message.cardsV2)).toContain('record_resolution');
  });

  it('通知失敗でも例外を投げない(主要フローを止めない)', async () => {
    mocks.sendChatMessage.mockRejectedValueOnce(new Error('chat down'));
    const { pool } = createMockPool((text) => {
      if (text.includes('INSERT INTO ops.escalations')) return { rows: [{ escalation_id: '5' }] };
      return undefined;
    });
    await expect(
      raiseEscalation(pool, { reason: 'low_confidence', context: 'ctx' }),
    ).resolves.toBeUndefined();
  });
});

describe('findAwaitingResolution(裁定待ちの検索)', () => {
  it('本人が15分以内に受付開始した open のもののみ対象にする', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    await findAwaitingResolution(pool, 'admin1');
    const call = findCall(calls, 'FROM ops.escalations');
    expect(call?.text).toContain('resolution_requested_by = $1');
    expect(call?.text).toContain(`status = 'open'`);
    expect(call?.text).toContain(`INTERVAL '15 minutes'`);
    expect(call?.params).toEqual(['admin1']);
  });
});

describe('recordResolution + refluxResolutionToKnowledge(SQL 整合)', () => {
  const resolvedRow = {
    escalation_id: '5',
    reason: 'low_confidence',
    context: '質問: 在庫僅少時の優先順位',
    status: 'resolved',
    resolution: '出荷優先で裁定する',
    knowledge_reflected: false,
  };

  it('裁定の保存は open のみ対象(裁定済みを上書きしない)', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('SET resolution = $3')) return { rows: [resolvedRow] };
      return undefined;
    });
    const row = await recordResolution(pool, '5', 'admin1', '出荷優先で裁定する');
    expect(row?.resolution).toBe('出荷優先で裁定する');
    const update = findCall(calls, 'SET resolution = $3');
    expect(update?.text).toContain(`status = 'open'`);
    expect(update?.params).toEqual(['5', 'admin1', '出荷優先で裁定する']);
  });

  it('裁定ゲートの単一化: 保存成功時に同一管理者の他の open な受付状態をクリアする', async () => {
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('SET resolution = $3')) return { rows: [resolvedRow] };
      return undefined;
    });
    await recordResolution(pool, '5', 'admin1', '出荷優先で裁定する');

    const clear = findCall(calls, 'SET resolution_requested_by = NULL');
    expect(clear).toBeDefined();
    expect(clear?.text).toContain('escalation_id <> $1'); // 記録した本体は対象外
    expect(clear?.text).toContain(`status = 'open'`); // 裁定済みには触れない
    expect(clear?.params).toEqual(['5', 'admin1']);
    // SoT への保存が先、ゲート解除が後
    expect(callIndex(calls, 'SET resolution = $3')).toBeLessThan(
      callIndex(calls, 'SET resolution_requested_by = NULL'),
    );
  });

  it('裁定ゲートの単一化: 既に裁定済み(保存されなかった)場合は他ゲートをクリアしない', async () => {
    const { pool, calls } = createMockPool(() => ({ rows: [] }));
    const row = await recordResolution(pool, '5', 'admin1', '出荷優先で裁定する');
    expect(row).toBeUndefined();
    expect(findCall(calls, 'SET resolution_requested_by = NULL')).toBeUndefined();
  });

  it('還流: decision_rules チャンクを doc_id=escalation/{id} で UPSERT し、reflected を立てる', async () => {
    const { pool, calls } = createMockPool(() => undefined);
    await refluxResolutionToKnowledge(pool, resolvedRow);

    const insert = findCall(calls, 'INSERT INTO rag.knowledge_chunks');
    expect(insert?.text).toContain(`'decision_rules'`);
    expect(insert?.text).toContain('ON CONFLICT (doc_id, chunk_index) DO UPDATE');
    expect(insert?.params[0]).toBe('escalation/5');
    const chunkText = insert?.params[2] as string;
    expect(chunkText).toContain('## 状況');
    expect(chunkText).toContain('## 裁定');
    expect(chunkText).toContain('出荷優先で裁定する');

    // キャッシュ(rag)への反映 → knowledge_reflected の順
    expect(callIndex(calls, 'INSERT INTO rag.knowledge_chunks')).toBeLessThan(
      callIndex(calls, 'SET knowledge_reflected = TRUE'),
    );
  });

  it('裁定が未記録なら還流しない', async () => {
    const { pool, calls } = createMockPool(() => undefined);
    await expect(
      refluxResolutionToKnowledge(pool, { ...resolvedRow, resolution: null }),
    ).rejects.toThrow();
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')).toBeUndefined();
  });
});
