import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * v0.5(adhoc_checkin)の dialogue_type 拡張の整合テスト。
 * DB なしで検証できる範囲として、SQL ファイル間の値集合の一貫性を検証する:
 * - 0006 の CHECK 拡張が 0001 の既存値をすべて保持していること(下位互換・原則7)
 * - dwh.dim_dialogue_type にも同時追加されること(ETL の INNER JOIN による欠落防止)
 * - 集計ビュー(repeatable)に adhoc_checkin の列が追加されていること
 */
describe('migration 0006(dialogue_type の adhoc_checkin 拡張)', () => {
  const read = (rel: string): Promise<string> => readFile(path.join(packageRoot, rel), 'utf8');

  it('CHECK 制約は既存の全 dialogue_type + adhoc_checkin を許可する', async () => {
    const migration = await read('migrations/0006_adhoc_checkin_dialogue_type.sql');
    expect(migration).toContain('DROP CONSTRAINT dialogues_dialogue_type_check');
    expect(migration).toContain('ADD CONSTRAINT dialogues_dialogue_type_check');
    // 0001 の既存値(順序も含めて保持)+ adhoc_checkin
    for (const type of [
      'morning_checkin',
      'completion_review',
      'adhoc_qa',
      'task_instruction',
      'escalation',
      'adhoc_checkin',
    ]) {
      expect(migration, `CHECK に ${type} が含まれること`).toContain(`'${type}'`);
    }
  });

  it('dwh.dim_dialogue_type へ adhoc_checkin を冪等に追加する(fact_dialogue の INNER JOIN 対策)', async () => {
    const migration = await read('migrations/0006_adhoc_checkin_dialogue_type.sql');
    expect(migration).toContain('INSERT INTO dwh.dim_dialogue_type');
    expect(migration).toContain(`('adhoc_checkin')`);
    expect(migration).toContain('ON CONFLICT (dialogue_type) DO NOTHING');
  });

  it('集計ビュー v_dialogue_daily_stats は adhoc_checkin の送信・返信列を末尾に持つ', async () => {
    const view = await read('etl/15_ops_views.sql');
    expect(view).toContain('morning_checkin_sent');
    expect(view).toContain('adhoc_checkin_sent');
    expect(view).toContain('adhoc_checkin_answered');
    // CREATE OR REPLACE VIEW の制約: 既存列(user_id〜dialogues)の並びは変更しない
    const columnsInOrder = ['user_id', 'jst_date', 'checkin_answered', 'review_completed', 'dialogues'];
    let cursor = -1;
    for (const column of columnsInOrder) {
      const idx = view.indexOf(`AS ${column}`, cursor + 1);
      const fallback = column === 'user_id' ? view.indexOf('user_id,') : idx;
      const position = idx === -1 ? fallback : idx;
      expect(position, `既存列 ${column} が定義順に存在すること`).toBeGreaterThan(cursor);
      cursor = position;
    }
    // 新規列は既存列より後に定義される
    expect(view.indexOf('AS adhoc_checkin_sent')).toBeGreaterThan(cursor);
  });
});
