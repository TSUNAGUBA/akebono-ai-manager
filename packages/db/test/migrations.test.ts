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
    // responding(v0.5)はさらに末尾(CREATE OR REPLACE VIEW は列の途中挿入を許さない)
    expect(view.indexOf('AS responding')).toBeGreaterThan(view.indexOf('AS adhoc_checkin_answered'));
  });
});

/**
 * v0.8(問いかけ可否のユーザー単位設定)の整合テスト。
 * - 0007 の列追加と、既存行の初期値がロールから導出されること(従来動作の保存・原則7)
 * - admin_rw への権限が列単位で、表レベル REVOKE の後に付与されること(最小権限の維持)
 * - seed テンプレートの再実行が UI で変更した可否設定を巻き戻さないこと(原則2)
 */
describe('migration 0007(問いかけ可否のユーザー単位設定)', () => {
  const read = (rel: string): Promise<string> => readFile(path.join(packageRoot, rel), 'utf8');

  it('checkin_enabled 列を NOT NULL DEFAULT TRUE で追加し、既存行はロールから初期化する', async () => {
    const migration = await read('migrations/0007_user_checkin_enabled.sql');
    expect(migration).toContain(
      'ALTER TABLE ops.users ADD COLUMN checkin_enabled BOOLEAN NOT NULL DEFAULT TRUE',
    );
    // 従来動作の保存: member のみ問いかけ対象だった(admin は対象外)
    expect(migration).toContain(`SET checkin_enabled = (role = 'member')`);
  });

  it('admin_rw への ops.users 権限は列単位で、表レベル REVOKE の後に付与される', async () => {
    const grants = await read('etl/30_grants.sql');
    const revokeIdx = grants.indexOf('REVOKE SELECT ON ops.users FROM ai_manager_admin_rw');
    const grantSelectIdx = grants.indexOf('GRANT SELECT (user_id');
    const grantUpdateIdx = grants.indexOf('GRANT UPDATE (checkin_enabled) ON ops.users');
    expect(revokeIdx).toBeGreaterThan(-1);
    // repeatable マイグレーションは毎回上から順に実行されるため、
    // REVOKE(表レベル)→ GRANT(列レベル)の順でないと権限が消える
    expect(grantSelectIdx).toBeGreaterThan(revokeIdx);
    expect(grantUpdateIdx).toBeGreaterThan(revokeIdx);
    // 更新は checkin_enabled 列のみ(表レベルの UPDATE は付与しない)
    expect(grants).not.toContain('GRANT INSERT, UPDATE ON ops.users');
    expect(grants).not.toContain('GRANT UPDATE ON ops.users');
  });

  it('seed テンプレートは checkin_enabled を初期投入のみ設定し、ON CONFLICT で上書きしない', async () => {
    const seed = await readFile(
      path.join(packageRoot, '..', '..', 'scripts', 'setup', 'seed-users.sample.sql'),
      'utf8',
    );
    expect(seed).toContain('checkin_enabled');
    // 冒頭コメントにも「ON CONFLICT」が現れるため、実際の句(最後の出現)以降を検証する。
    // 句自体の存在を先に検証する(存在しないと slice(-1) が末尾1文字になり検証が無効化される)
    const conflictIdx = seed.lastIndexOf('ON CONFLICT (user_id) DO UPDATE');
    expect(conflictIdx, '再実行安全のための ON CONFLICT 句が存在すること').toBeGreaterThan(-1);
    // 再実行で UI の可否設定を巻き戻さない(原則2: 設定系データの保護)
    expect(seed.slice(conflictIdx)).not.toContain('checkin_enabled');
  });
});
