# Phase 3 および残移行の設計(v0.3 二段階移行の第2段階を含む)

- 位置づけ: Phase 2 実装(phase2-implementation.md)完了時点で**未実装だが設計を確定させる**項目の設計書。
  実装はいずれも本書に従えば着手可能(設計判断は本書が SoT、変更時は本書を更新)。
- 基底: 要件 v0.2 §10 Phase 3 / v0.3 追補 §6(二段階移行)・§4.3(別名)

## 1. 二段階移行・第2段階: ETL の customer_industries 切替とレガシー列削除

**目的**: `ops.customers.industry`(レガシー単一値)への依存を断ち、SoT(customer_industries)へ一本化する。

設計:
1. `packages/db/etl/20_daily_etl.sql` の dim_project 供給句で、業界を
   `LEFT JOIN ops.customer_industries ci ON ci.customer_id = c.customer_id AND ci.is_primary` の
   `ci.industry_id` に置換(NULL は 'other' に COALESCE)。dim の SCD 変更検知列は現行どおり industry を含む
2. 管理 UI(customers.ts)の industry 列書込(互換キャッシュ)を削除
3. 1〜2 の稼働を1リリース挟んで確認後、versioned migration(000N)で
   `ALTER TABLE ops.customers DROP COLUMN industry;` を適用(ロールバック不能点。適用前に
   `SELECT customer_id FROM ops.customers c WHERE NOT EXISTS (SELECT 1 FROM ops.customer_industries ci WHERE ci.customer_id=c.customer_id AND ci.is_primary)`
   が 0 件であることを前提チェックとして migration 冒頭で検証し、違反時は例外で中断)
- 影響範囲の確認(原則6): grep 対象は `customers.industry` / `c.industry`。dwh ビューは dim 経由のため無影響

## 2. 顧客エイリアス(別名照合)— v0.3 §4.3 の中期対応

**目的**: 「株式会社しまむら」登録でも「しまむらの件」で顧客特定できるようにする。

設計:
1. versioned migration: `CREATE TABLE ops.customer_aliases (customer_id TEXT NOT NULL REFERENCES ops.customers(customer_id), alias TEXT NOT NULL, PRIMARY KEY (customer_id, alias), CHECK (length(alias) >= 2));`
2. `identifyTargetCustomer` の候補 CTE を customers(name)∪ customer_aliases(alias)の UNION に拡張
   (LIKE エスケープ・最長一致・length>=2 の既存ルールを踏襲)
3. マスタ管理 UI の顧客編集フォームにエイリアス複数入力(カンマ区切り→洗い替え。customer_industries と同じトランザクションパターン)
4. GRANT: dashboard_ro に SELECT、admin_rw に SELECT/INSERT/DELETE(30_grants.sql の既存ブロックへ追記)

## 3. Phase 3: 三層モデル判定の指標設計(要件 §10 Phase 3)

**目的**: 導入 3〜6 ヶ月時点の「判定材料」を dwh に揃える。**評価の自動化はしない**(要件 M5 の明文方針)。
判定は管理者が行い、システムは観察データを提示するのみ。

指標定義(いずれも既存 fact から導出可能 — 新規収集は不要):
| 指標 | 定義 | 源泉 |
|---|---|---|
| 仮説表明率 | morning_checkin のうち hypothesis 非 NULL の率(週次) | fact_dialogue |
| 仮説的中傾向 | review.gap_category の分布推移(none/minor↑ = ②層の成長) | fact_hypothesis_outcome |
| 問いの深さ | 対話 turns 数と本人発話文字数の中央値推移 | fact_dialogue |
| AI 提案採否 | suggestions の accepted/rejected 率と理由の記録率 | fact_suggestion |
| 停滞・過負荷履歴 | member_anomaly 起票数の推移 | ops.escalations(fact 化は任意) |

実装方針: `dwh.v_growth_observation`(ユーザー×週の横持ちビュー、repeatable)を追加し、
ダッシュボード growth ページ(管理者限定)を同ビュー参照に拡張。閾値・判定ロジックは実装しない
(処遇設計・勾配は経営判断であり、システム外。ADR-12 と同じ思想)。

## 4. タスク一覧・編集 UI(必要になった場合の方針)

- 動線の SoT は Chat(M3)を維持し、ダッシュボードには**閲覧+例外操作のみ**追加する
  (一覧・フィルタ、期限変更と cancelled 化の2操作。作成・承認は Chat のみ — 「AI を通らないと仕事が進まない」要件 M3 を壊さない)
- 書込は admin_rw ではなく**新ロールを切らず** Chat 経由(app_rw)に寄せるため、
  ダッシュボードからの操作は chat-gateway の内部 API を呼ぶのではなく、
  「操作用の Chat メッセージ文面を提示してコピーさせる」軽量案を第一候補とする(権限境界を増やさない)。
  実運用の要望が確定してから ADR 化する

## 5. dwh の多対多業界分析軸(Phase 3 で判断)

- 現行: dim_project.industry = 主業界のみ(単一値)。多対多の分析が必要になった場合は
  `dwh.bridge_project_industry(project_key, industry_id, weight)` のブリッジテーブル方式を採用する
  (スタースキーマの標準手法。weight は当面 1/N)。ビュー側は主業界表示を維持し、
  業界横断集計のみブリッジ経由とする — 既存レポートの互換を壊さない

## 6. 実装順の推奨

1. §1(第2段階移行)— Phase 2 の技術的負債の解消。次の通常リリースに同乗可
2. §2(エイリアス)— ナレッジ 6 社拡張の運用開始と同時期が効果的
3. §3(観察ビュー+growth 拡張)— データが 4〜8 週貯まってから
4. §4 / §5 — 運用要望・分析要望が確定してから(本書の方針に従い ADR 化)
