import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsUser } from '../src/auth.js';
import type { ChatEvent } from '../src/chat-event.js';
import { handleMessage } from '../src/handlers/message.js';
import { callIndex, createMockPool, findCall, type Responder } from './mock-pool.js';

const mocks = vi.hoisted(() => ({
  generateJson: vi.fn(),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  sendChatMessage: vi.fn(async () => ({})),
}));

vi.mock('@ai-manager/shared', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-manager/shared')>();
  return {
    ...mod,
    generateJson: mocks.generateJson,
    embedTexts: mocks.embedTexts,
    sendChatMessage: mocks.sendChatMessage,
  };
});

// 裁定の還流は shared/escalations.ts に共通化された(v0.12)。shared 内部の
// `./vertex.js` 直接 import も同じ embedTexts モックを通す
vi.mock('../../shared/src/vertex.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../shared/src/vertex.js')>();
  return { ...mod, embedTexts: mocks.embedTexts };
});

beforeEach(() => {
  mocks.generateJson.mockReset();
  mocks.embedTexts.mockClear();
  mocks.sendChatMessage.mockClear();
});

const admin: OpsUser = {
  user_id: 'admin1',
  display_name: '山下',
  email: 'admin@example.com',
  role: 'admin',
  chat_space_id: 'spaces/admin',
  active: true,
};
const member: OpsUser = {
  user_id: 'member1',
  display_name: '田中',
  email: 'member@example.com',
  role: 'member',
  chat_space_id: 'spaces/member',
  active: true,
};

function messageEvent(text: string): ChatEvent {
  return { type: 'MESSAGE', message: { text, argumentText: text } };
}

const llmResult = { model: 'test-model', inputTokens: 10, outputTokens: 20, costUsd: 0.001 };

describe('タスク指示の検知と分解(M3)', () => {
  const baseResponder: Responder = (text) => {
    if (text.includes('FROM ops.escalations')) return { rows: [] };
    if (text.includes('FROM ops.suggestions')) return { rows: [] };
    if (text.includes('FROM ops.users WHERE active')) {
      return {
        rows: [
          { user_id: 'admin1', display_name: '山下', role: 'admin' },
          { user_id: 'member1', display_name: '田中', role: 'member' },
        ],
      };
    }
    if (text.includes('FROM ops.projects')) return { rows: [{ project_id: 'p1', name: 'A社SI' }] };
    if (text.includes('INSERT INTO ops.tasks')) return { rows: [{ task_id: '7' }] };
    if (text.includes('INSERT INTO ops.dialogues')) {
      return { rows: [{ dialogue_id: '11', created_at: new Date() }] };
    }
    return { rows: [] };
  };

  it('管理者の「タスク:」指示を分解し、proposed 登録+承認カードを返す', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: {
        task_title: 'A社見積もり作成',
        description: 'A社向けの見積もりを作成する',
        expected_outcome: '提出可能な見積書',
        subtasks: [{ title: '要件整理' }, { title: '見積もり作成' }],
        estimated_hours: 6,
        suggested_deadline: '2026-07-17',
        suggested_assignee_id: 'member1',
        project_id: 'p1',
      },
      result: llmResult,
    });

    const { pool, calls } = createMockPool(baseResponder);
    const response = await handleMessage(
      pool,
      messageEvent('タスク: A社の見積もり作成を田中さんにお願いしたい'),
      admin,
    );

    // pro ティアで分解が呼ばれる
    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { tier: string; system: string };
    expect(genCall.tier).toBe('pro');
    expect(genCall.system).toContain('member1'); // active メンバー一覧を供給
    expect(genCall.system).toContain('p1'); // プロジェクト一覧を供給

    // proposed で INSERT + 履歴記録
    const insertTask = findCall(calls, 'INSERT INTO ops.tasks');
    expect(insertTask?.text).toContain(`'proposed'`);
    expect(insertTask?.params[4]).toBe('admin1'); // requester_id = 管理者
    expect(findCall(calls, 'INSERT INTO ops.task_status_log')?.params).toEqual([
      '7',
      null,
      'proposed',
      'admin',
    ]);
    // 対話ログ(task_instruction)
    expect(findCall(calls, 'INSERT INTO ops.dialogues')?.params).toContain('task_instruction');

    // 承認カード
    const json = JSON.stringify(response.cardsV2);
    expect(json).toContain('decide_task');
    expect(json).toContain('田中');
  });

  it('担当者を特定できない分解結果はタスク登録せず、出し直しを促す', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: {
        task_title: 'A社見積もり作成',
        expected_outcome: '見積書',
        subtasks: [],
        suggested_deadline: '2026-07-17',
        suggested_assignee_id: 'ghost-user',
      },
      result: llmResult,
    });
    const { pool, calls } = createMockPool(baseResponder);
    const response = await handleMessage(pool, messageEvent('タスク: A社の見積もり作成'), admin);

    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(response.text).toContain('出し直して');
  });

  it('メンバーのメッセージはタスク指示として扱わない(QA へ)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '回答です', confidence: 'high' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '12', created_at: new Date() }] };
      }
      return { rows: [] };
    });
    await handleMessage(pool, messageEvent('タスク: これはメンバーの発言'), member);
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    // QA(adhoc_qa)として記録される
    expect(findCall(calls, 'INSERT INTO ops.dialogues')?.params).toContain('adhoc_qa');
  });
});

describe('完了申告からの進捗更新(M3)', () => {
  it('完了申告時、未完了タスクと高確度で照合できたら完了確認カードを付ける', async () => {
    // 1回目: 夕の振り返り応答 / 2回目: タスク照合
    mocks.generateJson
      .mockResolvedValueOnce({
        value: { reply: 'おつかれさまです。差分はどうでしたか?', review_complete: false },
        result: llmResult,
      })
      .mockResolvedValueOnce({
        value: { matched: true, task_id: '3', confidence: 'high' },
        result: llmResult,
      });

    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '13', created_at: new Date() }] };
      }
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      if (text.includes('FROM ops.tasks t')) {
        return {
          rows: [
            {
              task_id: '3',
              title: 'A社の資料作成',
              status: 'in_progress',
              due_date: null,
              project_name: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('A社の資料作成、終わりました'), member);
    const json = JSON.stringify(response.cardsV2 ?? []);
    expect(json).toContain('confirm_task_done');
    expect(json).toContain('A社の資料作成');
  });

  it('照合に失敗しても夕の振り返り応答は返す(非ブロッキング)', async () => {
    mocks.generateJson
      .mockResolvedValueOnce({
        value: { reply: 'おつかれさまです。', review_complete: false },
        result: llmResult,
      })
      .mockRejectedValueOnce(new Error('llm down'));

    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '14', created_at: new Date() }] };
      }
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      if (text.includes('FROM ops.tasks t')) {
        return {
          rows: [
            { task_id: '3', title: 'A社の資料作成', status: 'in_progress', due_date: null, project_name: null },
          ],
        };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('終わりました'), member);
    expect(response.text).toBe('おつかれさまです。');
    expect(response.cardsV2).toBeUndefined();
  });
});

describe('裁定の受領とナレッジ還流(M6)', () => {
  it('裁定待ちの管理者メッセージを resolution に保存し、decision_rules へ還流する', async () => {
    const awaiting = {
      escalation_id: '5',
      reason: 'low_confidence',
      context: '質問: 在庫僅少時の優先順位',
      status: 'open',
      resolution: null,
      knowledge_reflected: false,
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
      if (text.includes('SET resolution = $3')) {
        return { rows: [{ ...awaiting, status: 'resolved', resolution: '出荷優先で裁定する' }] };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('出荷優先で裁定する'), admin);

    // SoT(ops.escalations)への保存が先、キャッシュ(rag)への還流が後
    const sotIndex = callIndex(calls, 'SET resolution = $3');
    const cacheIndex = callIndex(calls, 'INSERT INTO rag.knowledge_chunks');
    expect(sotIndex).toBeGreaterThan(-1);
    expect(cacheIndex).toBeGreaterThan(sotIndex);
    expect(findCall(calls, 'INSERT INTO rag.knowledge_chunks')?.params[0]).toBe('escalation/5');
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeDefined();
    expect(response.text).toContain('還流');
  });

  it('還流に失敗しても裁定の記録は保持し、「ナレッジ還流を再試行」ボタン付きカードを返す', async () => {
    mocks.embedTexts.mockRejectedValueOnce(new Error('embedding down'));
    const awaiting = {
      escalation_id: '5',
      reason: 'low_confidence',
      context: 'ctx',
      status: 'open',
      resolution: null,
      knowledge_reflected: false,
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
      if (text.includes('SET resolution = $3')) {
        return { rows: [{ ...awaiting, status: 'resolved', resolution: '裁定内容' }] };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('裁定内容'), admin);
    expect(findCall(calls, 'SET resolution = $3')).toBeDefined();
    expect(findCall(calls, 'SET knowledge_reflected = TRUE')).toBeUndefined();
    expect(response.text).toContain('裁定は記録しました');
    // 復旧経路: 再試行ボタンから card-action の再還流分岐に到達できる
    const json = JSON.stringify(response.cardsV2);
    expect(json).toContain('ナレッジ還流を再試行');
    expect(json).toContain('record_resolution');
  });
});

describe('裁定ゲートの入力ガード(M6: 無条件キャプチャ防止)', () => {
  const awaiting = {
    escalation_id: '5',
    reason: 'low_confidence',
    context: '質問: 在庫僅少時の優先順位',
    status: 'open',
    resolution: null,
    knowledge_reflected: false,
  };
  const gateResponder: Responder = (text) => {
    if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
    return { rows: [] };
  };

  it('「キャンセル」で裁定の記録を中止し、受付状態(resolution_requested_*)をクリアする', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(pool, messageEvent('キャンセル'), admin);

    expect(findCall(calls, 'SET resolution_requested_by = NULL')).toBeDefined();
    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(response.text).toContain('中止');
  });

  it('疑問符で終わる質問は裁定として記録せず、案内を返す(ゲートは維持)', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(
      pool,
      messageEvent('在庫の引き当てはどうなっていますか?'),
      admin,
    );

    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(findCall(calls, 'SET resolution_requested_by = NULL')).toBeUndefined();
    expect(response.text).toContain('裁定の記録待ち');
    expect(response.text).toContain('キャンセル');
  });

  it('タスク指示らしいメッセージは裁定として記録せず、タスク起票もしない', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(
      pool,
      messageEvent('タスク: 田中さんに棚卸しの確認をお願い'),
      admin,
    );

    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(mocks.generateJson).not.toHaveBeenCalled();
    expect(response.text).toContain('裁定の記録待ち');
  });

  it('1000字を超えるメッセージは裁定として記録しない(ゲートは維持)', async () => {
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(pool, messageEvent('あ'.repeat(1001)), admin);

    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(response.text).toContain('1000');
    expect(response.text).toContain('キャンセル');
  });

  it('担当者への言及を含む正当な裁定は flash-lite 分類を経て記録できる(締め出さない)', async () => {
    // 曖昧なタスク指示シグナル(さんに+確認して)→ flash-lite が「タスク指示でない」と判定
    mocks.generateJson.mockResolvedValueOnce({
      value: { is_task_instruction: false },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('resolution_requested_by = $1')) return { rows: [awaiting] };
      if (text.includes('SET resolution = $3')) {
        return { rows: [{ ...awaiting, status: 'resolved', resolution: '裁定' }] };
      }
      return { rows: [] };
    });

    const response = await handleMessage(
      pool,
      messageEvent('在庫僅少時は出荷を優先し、判断に迷う場合は佐藤さんに確認してください'),
      admin,
    );
    expect(findCall(calls, 'SET resolution = $3')).toBeDefined();
    expect(response.text).toContain('還流');
  });

  it('flash-lite がタスク指示と判定したメッセージは裁定として記録しない', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { is_task_instruction: true },
      result: llmResult,
    });
    const { pool, calls } = createMockPool(gateResponder);
    const response = await handleMessage(
      pool,
      messageEvent('佐藤さんに今週中に棚卸しの対応をやってもらってください'),
      admin,
    );
    expect(findCall(calls, 'SET resolution = $3')).toBeUndefined();
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(response.text).toContain('裁定の記録待ち');
  });
});

describe('随時 QA への顧客マスタ情報の供給(v0.7)', () => {
  const shimamuraResponder: Responder = (text) => {
    if (text.includes('FROM ops.suggestions')) return { rows: [] };
    if (text.includes('INSERT INTO ops.dialogues')) {
      return { rows: [{ dialogue_id: '31', created_at: new Date() }] };
    }
    if (text.includes('FROM ops.dialogues')) return { rows: [] };
    // 文脈顧客: 本人は undeux のタスクに着手中(明示一致がこれを上書きすることを検証)
    if (text.includes('FROM ops.tasks t')) return { rows: [{ customer_id: 'undeux' }] };
    // 質問文の名称照合 → しまむら(顧客照合のみ。プロジェクト照合は不一致)
    if (text.includes('WITH candidates') && text.includes('FROM ops.customers')) {
      return { rows: [{ customer_id: 'shimamura', match_text: 'しまむら' }] };
    }
    if (text.includes('WITH candidates') && text.includes('FROM ops.projects')) {
      return { rows: [] };
    }
    if (text.includes('WITH RECURSIVE reach')) {
      return { rows: [{ customer_ids: ['shimamura', 'undeux'], industry_ids: ['apparel'] }] };
    }
    if (text.includes('FROM ops.customers c')) {
      return {
        rows: [{ customer_id: 'shimamura', name: 'しまむら', industries: ['小売業', 'アパレル'] }],
      };
    }
    if (text.includes('FROM ops.customer_relations')) {
      return {
        rows: [
          {
            from_name: 'undeux',
            to_name: 'しまむら',
            label: '納品先(メーカー→小売等)',
            notes: null,
          },
        ],
      };
    }
    return { rows: [] };
  };

  it('しまむらシナリオ: 明示一致した顧客のマスタ情報(業界・取引関係)をプロンプトに供給する', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: 'しまむらの取引先は undeux です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool(shimamuraResponder);

    const response = await handleMessage(pool, messageEvent('しまむらの取引先は?'), member);

    // 明示一致(しまむら)が文脈顧客(undeux)より優先され、スコープもしまむら起点になる
    expect(findCall(calls, 'WITH RECURSIVE reach')?.params).toEqual(['shimamura', 1]);

    // プロンプトに顧客マスタ情報ブロック(業界+関係種別ラベル付きの関係)が入る
    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('## 顧客マスタ情報');
    expect(genCall.system).toContain('しまむら(所属業界: 小売業、アパレル)');
    expect(genCall.system).toContain('undeux → しまむら: 納品先(メーカー→小売等)');
    expect(genCall.system).toContain('## 参考情報'); // ナレッジの参考情報ブロックは従来どおり

    expect(response.text).toBe('しまむらの取引先は undeux です。');
  });

  it('マスタ情報の取得に失敗しても QA はナレッジのみで回答する(非ブロッキング)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: 'ナレッジに基づく回答です。', confidence: 'high' },
      result: llmResult,
    });
    // customer-context の顧客情報クエリのみ失敗させる(スコープ導出の再帰 CTE は正常のまま)
    const { pool } = createMockPool((text, params) => {
      if (text.includes('FROM ops.customers c')) return new Error('db down');
      return shimamuraResponder(text, params);
    });

    const response = await handleMessage(pool, messageEvent('しまむらの取引先は?'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).not.toContain('## 顧客マスタ情報');
    expect(response.text).toBe('ナレッジに基づく回答です。');
  });

  it('確信度 low のエスカレーションに対象顧客の特定結果を診断情報として残す(v0.9 §4)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '登録が見当たりませんでした。', confidence: 'low' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool(shimamuraResponder);

    const response = await handleMessage(pool, messageEvent('しまむらの取引先は?'), member);

    const escalation = findCall(calls, 'INSERT INTO ops.escalations');
    expect(escalation).toBeDefined();
    expect(String(escalation?.params[1])).toContain('対象顧客: shimamura');
    expect(response.text).toContain('管理者にも確認を依頼しました');
  });

  it('対象顧客を特定できない low 回答は、特定失敗の診断ヒントをエスカレーションに残す', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: 'わかりませんでした。', confidence: 'low' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '33', created_at: new Date() }] };
      }
      return { rows: [] };
    });

    await handleMessage(pool, messageEvent('ヤマダデンキの取引先は?'), member);

    const escalation = findCall(calls, 'INSERT INTO ops.escalations');
    expect(String(escalation?.params[1])).toContain('特定できず');
    expect(String(escalation?.params[1])).toContain('エイリアス');
  });

  it('ナレッジ検索(embedding)が失敗しても QA は参考情報なしで回答する(v0.9 §5)', async () => {
    mocks.embedTexts.mockRejectedValueOnce(new Error('embedding down'));
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: 'マスタ情報に基づく回答です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool } = createMockPool(shimamuraResponder);

    const response = await handleMessage(pool, messageEvent('しまむらの取引先は?'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('該当するナレッジは見つかりませんでした');
    expect(genCall.system).toContain('## 顧客マスタ情報'); // マスタ情報は供給される
    expect(response.text).toBe('マスタ情報に基づく回答です。');
  });

  it('スコープ導出が失敗しても QA は顧客固有を除外して継続する(v0.9 §5)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '一般ナレッジに基づく回答です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text, params) => {
      if (text.includes('WITH RECURSIVE reach')) return new Error('db down');
      return shimamuraResponder(text, params);
    });

    const response = await handleMessage(pool, messageEvent('しまむらの取引先は?'), member);

    // 安全側(顧客固有の除外)で検索が続行される
    const rag = findCall(calls, 'FROM rag.knowledge_chunks');
    expect(rag?.params[3]).toBe(true); // $4 = excludeCustomer
    expect(response.text).toBe('一般ナレッジに基づく回答です。');
  });

  it('プロジェクト名を含む質問には計画情報(目的・マイルストーン)を供給する(v0.10)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: 'A社SI の目的は基幹システムの刷新です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool } = createMockPool((text) => {
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '34', created_at: new Date() }] };
      }
      if (text.includes('WITH candidates') && text.includes('FROM ops.projects')) {
        return { rows: [{ project_id: 'a-sha-si', match_text: 'A社SI' }] };
      }
      if (text.includes('WITH candidates') && text.includes('FROM ops.customers')) {
        return { rows: [] };
      }
      if (text.includes('FROM ops.projects p')) {
        return {
          rows: [
            {
              project_id: 'a-sha-si',
              name: 'A社SI',
              customer_name: 'A社',
              objective: '基幹システムの刷新',
              description: null,
            },
          ],
        };
      }
      if (text.includes('FROM ops.project_milestones')) {
        return {
          rows: [
            { project_id: 'a-sha-si', title: '要件確定', due_date: '2026-07-20', status: 'planned' },
          ],
        };
      }
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('A社SI の目的を教えて'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('## プロジェクト情報');
    expect(genCall.system).toContain('目的: 基幹システムの刷新');
    expect(genCall.system).toContain('[予定] 要件確定');
    // 顧客を特定していないので顧客マスタ情報ブロックは供給されない(混同しない)
    expect(genCall.system).not.toContain('## 顧客マスタ情報');
    expect(response.text).toBe('A社SI の目的は基幹システムの刷新です。');
  });

  it('顧客とプロジェクトの両方に言及した質問には両ブロックを独立に供給する(v0.10 §5)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '回答です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool } = createMockPool((text, params) => {
      if (text.includes('WITH candidates') && text.includes('FROM ops.projects')) {
        return { rows: [{ project_id: 'a-sha-si', match_text: 'A社SI' }] };
      }
      if (text.includes('FROM ops.projects p')) {
        return {
          rows: [
            {
              project_id: 'a-sha-si',
              name: 'A社SI',
              customer_name: 'しまむら',
              objective: '基幹システムの刷新',
              description: null,
            },
          ],
        };
      }
      if (text.includes('FROM ops.project_milestones')) return { rows: [] };
      return shimamuraResponder(text, params);
    });

    await handleMessage(pool, messageEvent('しまむら向けの A社SI の目的は?'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('## 顧客マスタ情報');
    expect(genCall.system).toContain('## プロジェクト情報');
    // 境界: 顧客の関係はプロジェクトブロックに混ざらない(顧客名の属性表示のみ)
    expect(genCall.system).toContain('undeux → しまむら: 納品先'); // 顧客マスタ情報側
    expect(genCall.system).toContain('目的: 基幹システムの刷新'); // プロジェクト情報側
  });

  it('朝の対話継続にプロジェクト文脈(目的・マイルストーン)を供給する(v0.10 §4.1)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '位置づけを確認しましょう。', hypothesis_complete: false },
      result: llmResult,
    });
    const openMorning = {
      dialogue_id: '71',
      created_at: new Date(),
      user_id: 'member1',
      dialogue_type: 'morning_checkin',
      task_id: null,
      project_id: null,
      turns: [{ role: 'ai', content: '今日は何から始めますか?', ts: new Date().toISOString() }],
      hypothesis: null,
      review: null,
    };
    const { pool } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning] };
      if (text.includes('GROUP BY p.project_id')) return { rows: [{ project_id: 'p1' }] };
      if (text.includes('FROM ops.projects p')) {
        return {
          rows: [
            {
              project_id: 'p1',
              name: 'A社SI',
              customer_name: 'A社',
              objective: '基幹システムの刷新',
              description: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    await handleMessage(pool, messageEvent('A社SIの設計から始めます'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('## プロジェクト文脈');
    expect(genCall.system).toContain('目的: 基幹システムの刷新');
    expect(genCall.system).toContain('## 本人のタスク状況'); // タスクブロックとは独立(混ぜない)
  });

  it('対象顧客を特定できない質問ではマスタ情報を取得しない', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '一般的な回答です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '32', created_at: new Date() }] };
      }
      return { rows: [] };
    });

    await handleMessage(pool, messageEvent('納期の一般的な考え方は?'), member);

    expect(findCall(calls, 'FROM ops.customer_relations')).toBeUndefined();
    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).not.toContain('## 顧客マスタ情報');
  });
});

describe('対話継続の応答生成失敗の回復(v0.9: 返信テキストを失わない)', () => {
  const openMorningDialogue = {
    dialogue_id: '61',
    created_at: new Date(),
    user_id: 'member1',
    dialogue_type: 'morning_checkin',
    task_id: null,
    project_id: null,
    turns: [{ role: 'ai', content: '今日は何から始めますか?', ts: new Date().toISOString() }],
    hypothesis: null,
    review: null,
  };

  it('朝の対話継続で LLM が失敗しても、返信ターンを保存してフォールバック文言を返す', async () => {
    mocks.generateJson.mockRejectedValueOnce(new Error('llm down'));
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorningDialogue] };
      return { rows: [] };
    });

    const response = await handleMessage(
      pool,
      messageEvent('AとBの設計を進めています。順調です。'),
      member,
    );

    expect(response.text).toContain('一時的に失敗');
    expect(response.text).toContain('記録しています');
    // 返信テキストは SoT(ops.dialogues)に保存され、失われない
    const update = findCall(calls, 'UPDATE ops.dialogues');
    expect(update).toBeDefined();
    expect(String(update?.params[1])).toContain('AとBの設計を進めています');
  });

  it('夕の振り返りの継続で LLM が失敗しても、返信ターンを保存してフォールバックを返す', async () => {
    mocks.generateJson.mockRejectedValueOnce(new Error('llm down'));
    const openEvening = {
      ...openMorningDialogue,
      dialogue_id: '63',
      dialogue_type: 'completion_review',
      turns: [{ role: 'ai', content: '予想との差分はどうでしたか?', ts: new Date().toISOString() }],
    };
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openEvening] };
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('差分は特にありませんでした'), member);

    expect(response.text).toContain('一時的に失敗');
    const update = findCall(calls, 'UPDATE ops.dialogues');
    expect(String(update?.params[1])).toContain('差分は特にありませんでした');
  });

  it('完了申告の振り返り開始で LLM が失敗しても、申告ターンを保存してフォールバックを返す', async () => {
    mocks.generateJson.mockRejectedValueOnce(new Error('llm down'));
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '62', created_at: new Date() }] };
      }
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('A社の資料作成、終わりました'), member);

    expect(response.text).toContain('一時的に失敗');
    const insert = findCall(calls, 'INSERT INTO ops.dialogues');
    expect(insert?.params).toContain('completion_review');
    expect(String(insert?.params[2])).toContain('終わりました'); // 申告は失われない
  });
});

describe('進行中対話の優先(M3: タスク指示検知による横取り防止)', () => {
  const openMorning = (userId: string): Record<string, unknown> => ({
    dialogue_id: '21',
    created_at: new Date(),
    user_id: userId,
    dialogue_type: 'morning_checkin',
    task_id: null,
    project_id: null,
    turns: [{ role: 'ai', content: '今日は何から始めますか?', ts: new Date().toISOString() }],
    hypothesis: null,
    review: null,
  });

  it('明示的な「タスク:」指示は朝の対話が進行中でも起票される(v0.9 §3: 優先順の改訂)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: {
        task_title: 'A社の棚卸し',
        description: 'A社の棚卸しを実施する',
        expected_outcome: '棚卸し完了',
        subtasks: [{ title: '実施' }],
        suggested_deadline: '2026-07-13',
        suggested_assignee_id: 'member1',
      },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.escalations')) return { rows: [] };
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('FROM ops.users WHERE active')) {
        return {
          rows: [
            { user_id: 'admin1', display_name: '山下', role: 'admin' },
            { user_id: 'member1', display_name: '田中', role: 'member' },
          ],
        };
      }
      if (text.includes('FROM ops.projects')) return { rows: [] };
      if (text.includes('INSERT INTO ops.tasks')) return { rows: [{ task_id: '8' }] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '22', created_at: new Date() }] };
      }
      // 朝の対話は open のままだが、明示的指示は対話継続より先に評価される
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('admin1')] };
      return { rows: [] };
    });

    const response = await handleMessage(
      pool,
      messageEvent('タスク: 田中さんに今日中にA社の棚卸しをお願い'),
      admin,
    );

    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeDefined();
    expect(findCall(calls, 'UPDATE ops.dialogues')).toBeUndefined(); // 対話継続としては扱わない
    expect(response.text).toContain('タスク案を作成しました');
  });

  it('曖昧なタスク指示らしいメッセージは、朝の対話が進行中なら継続として扱う(横取り防止は維持)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '把握しました。成功条件はどう考えますか?', hypothesis_complete: false },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.escalations')) return { rows: [] };
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('admin1')] };
      return { rows: [] };
    });

    // 「さんに」+期限+依頼動詞 = 曖昧シグナル(ルールベース確定ではない)
    const response = await handleMessage(
      pool,
      messageEvent('佐藤さんに明日までに棚卸しをお願いしたいと思っています'),
      admin,
    );

    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(findCall(calls, 'UPDATE ops.dialogues')).toBeDefined();
    expect(response.text).toContain('成功条件');
    // flash-lite 分類も呼ばれない(朝の対話の応答生成 1 回のみ)
    expect(mocks.generateJson).toHaveBeenCalledTimes(1);
  });

  it('メンバーの「タスク:」メッセージは v0.9 でも対話の継続として扱う(指示はできない)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '内容を教えてください。', hypothesis_complete: false },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('member1')] };
      return { rows: [] };
    });

    await handleMessage(pool, messageEvent('タスク: A社の棚卸しをやります'), member);
    expect(findCall(calls, 'INSERT INTO ops.tasks')).toBeUndefined();
    expect(findCall(calls, 'UPDATE ops.dialogues')).toBeDefined();
  });

  it('朝の対話で started_task_id が [ID:7] 形式でも数値部分を抽出して着手更新する', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '着手ですね。', hypothesis_complete: false, started_task_id: '[ID:7]' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('member1')] };
      if (text.includes(`SET status = 'in_progress'`)) return { rows: [{ task_id: '7' }] };
      return { rows: [] };
    });

    await handleMessage(pool, messageEvent('今日はA社の棚卸しをやります'), member);
    const update = findCall(calls, `SET status = 'in_progress'`);
    expect(update?.params).toEqual(['7', 'member1']);
  });

  it('started_task_id から数値を抽出できなければ着手更新をスキップする(対話応答は返す)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '進めましょう。', hypothesis_complete: false, started_task_id: 'A社タスク' },
      result: llmResult,
    });
    const { pool, calls } = createMockPool((text) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM ops.dialogues')) return { rows: [openMorning('member1')] };
      return { rows: [] };
    });

    const response = await handleMessage(pool, messageEvent('進めます'), member);
    expect(findCall(calls, `SET status = 'in_progress'`)).toBeUndefined();
    expect(response.text).toBe('進めましょう。');
  });
});

describe('質問ループの終了制御(v0.12 §2: ターン数上限での締め)', () => {
  const morningWithTurns = (turnCount: number): Record<string, unknown> => ({
    dialogue_id: '41',
    created_at: new Date(),
    user_id: 'member1',
    dialogue_type: 'morning_checkin',
    task_id: null,
    project_id: null,
    turns: Array.from({ length: turnCount }, (_, i) => ({
      role: i % 2 === 0 ? 'ai' : 'user',
      content: `ターン${i + 1}`,
      ts: new Date().toISOString(),
    })),
    hypothesis: null,
    review: null,
  });

  const responderWith = (dialogue: Record<string, unknown>): Responder => (text) => {
    if (text.includes('FROM ops.suggestions')) return { rows: [] };
    if (text.includes('UPDATE ops.dialogues')) return { rows: [], rowCount: 1 };
    if (text.includes('FROM ops.dialogues')) return { rows: [dialogue] };
    return { rows: [] };
  };

  it('上限直前の往復では締めの指示(DIALOGUE_CLOSING_NOTE)をプロンプトに注入する', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: {
        reply: 'ここまでの内容で仮説をまとめますね。今日もよろしくお願いします。',
        hypothesis_complete: true,
        hypothesis: {
          position: '全体の前半',
          success_criteria: '棚卸し完了',
          expected_obstacles: '在庫差異',
          ai_assisted: true,
        },
      },
      result: llmResult,
    });
    // 現在9ターン + 今回の user/ai 2ターン = 11(= MORNING_DIALOGUE_MAX_TURNS)
    const { pool } = createMockPool(responderWith(morningWithTurns(9)));
    await handleMessage(pool, messageEvent('うーん、あまり思いつきません'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('## 重要: 対話の締め');
    expect(genCall.system).toContain('今回が最後の返信です');
  });

  it('上限まで余裕がある往復では締めの指示を注入しない', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { reply: '成功条件はどう考えますか?', hypothesis_complete: false },
      result: llmResult,
    });
    const { pool } = createMockPool(responderWith(morningWithTurns(3)));
    await handleMessage(pool, messageEvent('A社の棚卸しからやります'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).not.toContain('## 重要: 対話の締め');
  });

  it('夕の振り返りも上限直前の往復で締めの指示を注入する', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: {
        reply: 'ここまでで振り返りをまとめます。お疲れさまでした。',
        review_complete: true,
        review: {
          actual_outcome: '完了',
          gap_analysis: '想定どおり',
          next_change: '特になし',
          gap_category: 'none',
        },
      },
      result: llmResult,
    });
    const evening = {
      ...morningWithTurns(8),
      dialogue_type: 'completion_review',
    };
    // 現在8ターン + 2 = 10(= COMPLETION_REVIEW_MAX_TURNS)
    const { pool } = createMockPool(responderWith(evening));
    await handleMessage(pool, messageEvent('特に変えることはないです'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('## 重要: 対話の締め');
  });
});

describe('随時 QA の会話履歴参照(v0.12 §5)', () => {
  const historyResponder: Responder = (text) => {
    if (text.includes('FROM ops.suggestions')) return { rows: [] };
    if (text.includes('INSERT INTO ops.dialogues')) {
      return { rows: [{ dialogue_id: '51', created_at: new Date() }] };
    }
    // 会話履歴(fetchRecentTurns): 直近の QA 1件(新しい順)
    if (text.includes('SELECT turns')) {
      return {
        rows: [
          {
            turns: [
              { role: 'user', content: 'しまむらの取引先は?', ts: '2026-07-13T09:00:00Z' },
              { role: 'ai', content: '取引先は undeux です。', ts: '2026-07-13T09:00:01Z' },
            ],
          },
        ],
      };
    }
    if (text.includes('FROM ops.dialogues')) return { rows: [] };
    return { rows: [] };
  };

  it('直近の対話ターンを messages の履歴として供給する(「さっきの件」の解決)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: 'undeux はアパレルメーカーです。', confidence: 'high' },
      result: llmResult,
    });
    const { pool } = createMockPool(historyResponder);

    await handleMessage(pool, messageEvent('その会社の業種は?'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; text: string }>;
    };
    // 履歴(user → model)+ 今回の質問の順
    expect(genCall.messages.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect(genCall.messages[0]?.text).toBe('しまむらの取引先は?');
    expect(genCall.messages[1]?.text).toBe('取引先は undeux です。');
    expect(genCall.messages[2]?.text).toBe('その会社の業種は?');
  });

  it('履歴の取得に失敗しても QA は履歴なしで回答する(非ブロッキング)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '回答です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool } = createMockPool((text, params) => {
      if (text.includes('SELECT turns')) return new Error('db down');
      return historyResponder(text, params);
    });

    const response = await handleMessage(pool, messageEvent('質問です'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; text: string }>;
    };
    expect(genCall.messages).toHaveLength(1);
    expect(response.text).toBe('回答です。');
  });

  it('対話の境界で同一ロールが連続する履歴は1メッセージに結合する(Vertex の交互規約)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '回答です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool } = createMockPool((text, params) => {
      if (text.includes('SELECT turns')) {
        // 新しい順: 2件目の対話は user で終わる → 今回の user 質問と連続する
        return {
          rows: [
            { turns: [{ role: 'user', content: '記録しておいてください', ts: '2026-07-13T10:00:00Z' }] },
            {
              turns: [
                { role: 'ai', content: '朝の問いかけです', ts: '2026-07-13T09:00:00Z' },
                { role: 'user', content: '棚卸しからやります', ts: '2026-07-13T09:01:00Z' },
              ],
            },
          ],
        };
      }
      return historyResponder(text, params);
    });

    await handleMessage(pool, messageEvent('その進め方で問題ないですか?'), member);

    const genCall = mocks.generateJson.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; text: string }>;
    };
    // model → user(3連続の user が1つに結合される)
    expect(genCall.messages.map((m) => m.role)).toEqual(['model', 'user']);
    expect(genCall.messages[1]?.text).toBe(
      '棚卸しからやります\n記録しておいてください\nその進め方で問題ないですか?',
    );
  });
});

describe('顧客⇔プロジェクト相関の文脈供給(v0.13)', () => {
  it('顧客名を明示した「進んでいるプロジェクトは?」に登録プロジェクト一覧が供給される(MSJ シナリオの再現)', async () => {
    mocks.generateJson.mockResolvedValueOnce({
      value: { answer: '進行中のプロジェクトは「しまむらWMS」です。', confidence: 'high' },
      result: llmResult,
    });
    const { pool } = createMockPool((text, params) => {
      if (text.includes('FROM ops.suggestions')) return { rows: [] };
      if (text.includes('INSERT INTO ops.dialogues')) {
        return { rows: [{ dialogue_id: '61', created_at: new Date() }] };
      }
      if (text.includes('FROM ops.dialogues')) return { rows: [] };
      if (text.includes('FROM ops.tasks t')) return { rows: [] };
      // 質問文の名称照合 → 顧客のみ一致(プロジェクト名は含まれない質問)
      if (text.includes('WITH candidates') && text.includes('FROM ops.customers')) {
        return { rows: [{ customer_id: 'shimamura', match_text: 'しまむら' }] };
      }
      if (text.includes('WITH candidates') && text.includes('FROM ops.projects')) {
        return { rows: [] };
      }
      if (text.includes('WITH RECURSIVE reach')) {
        return { rows: [{ customer_ids: ['shimamura'], industry_ids: [] }] };
      }
      if (text.includes('FROM ops.customers c')) {
        return { rows: [{ customer_id: 'shimamura', name: 'しまむら', industries: ['小売業'] }] };
      }
      if (text.includes('FROM ops.customer_relations')) return { rows: [] };
      // 顧客の登録プロジェクト(v0.13)
      if (text.includes('FROM ops.projects') && text.includes('WHERE customer_id')) {
        return { rows: [{ name: 'しまむらWMS', status: 'active' }] };
      }
      return { rows: [] };
    });

    const response = await handleMessage(
      pool,
      messageEvent('しまむらで進んでいるプロジェクトは?'),
      member,
    );

    // 顧客マスタ情報ブロックに登録プロジェクトが確定情報として入る
    const genCall = mocks.generateJson.mock.calls[0]?.[0] as { system: string };
    expect(genCall.system).toContain('## 顧客マスタ情報');
    expect(genCall.system).toContain('### 登録プロジェクト');
    expect(genCall.system).toContain('- しまむらWMS(進行中)');
    expect(response.text).toBe('進行中のプロジェクトは「しまむらWMS」です。');
  });
});
