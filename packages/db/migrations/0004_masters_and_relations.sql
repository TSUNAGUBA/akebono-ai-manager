-- v0.3 追補: 業界マスタ・顧客×業界(多対多)・顧客間関係(要件 v0.3 §3)
-- 既存データの移行を含む(変換対応表は本ファイル下部のコメント参照)

-- ── 業界マスタ ─────────────────────────────────────────────
CREATE TABLE ops.industries (
  industry_id   TEXT PRIMARY KEY,          -- 例: 'retail', 'apparel', 'warehouse'
  name          TEXT NOT NULL,             -- 表示名(例: '小売業')
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 顧客×業界(多対多。主業界は dwh の分析軸用)──────────────
CREATE TABLE ops.customer_industries (
  customer_id TEXT NOT NULL REFERENCES ops.customers(customer_id),
  industry_id TEXT NOT NULL REFERENCES ops.industries(industry_id),
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (customer_id, industry_id)
);
-- 主業界は顧客ごとに 1 件のみ
CREATE UNIQUE INDEX idx_customer_industries_primary
  ON ops.customer_industries (customer_id) WHERE is_primary;

-- ── 関係種別マスタ+顧客間関係(有向エッジ)────────────────────
CREATE TABLE ops.relation_types (
  relation_type TEXT PRIMARY KEY,   -- 例: 'supplies_to'
  label         TEXT NOT NULL,      -- 表示名(例: '納品先')
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE ops.customer_relations (
  from_customer_id TEXT NOT NULL REFERENCES ops.customers(customer_id),
  to_customer_id   TEXT NOT NULL REFERENCES ops.customers(customer_id),
  relation_type    TEXT NOT NULL REFERENCES ops.relation_types(relation_type),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_customer_id, to_customer_id, relation_type),
  CHECK (from_customer_id <> to_customer_id)
);
CREATE INDEX idx_customer_relations_to ON ops.customer_relations (to_customer_id);

-- ── ナレッジチャンクへの業界帰属(v0.3 §3.4)─────────────────
ALTER TABLE rag.knowledge_chunks ADD COLUMN industry_id TEXT;
CREATE INDEX idx_knowledge_chunks_industry ON rag.knowledge_chunks (industry_id);

-- ── 初期マスタ投入 ──────────────────────────────────────────
-- 業界は直交軸で表現する(v0.3 設計原則 1)。「アパレル小売」のような複合値は作らない
INSERT INTO ops.industries (industry_id, name, display_order) VALUES
  ('retail',    '小売業',     10),
  ('maker',     'メーカー',   20),
  ('apparel',   'アパレル',   30),
  ('zakka',     '雑貨',       40),
  ('bedding',   '寝具',       50),
  ('logistics', '物流・倉庫', 60),
  ('other',     'その他',     90);

INSERT INTO ops.relation_types (relation_type, label) VALUES
  ('supplies_to',  '納品先(メーカー→小売等)'),
  ('fulfills_for', '物流受託先(倉庫→荷主)'),
  ('sells_via',    '販売チャネル(ブランド→EC/店舗)');

-- ── 既存顧客の移行 ──────────────────────────────────────────
-- 変換対応表(旧 CHECK 制約の enum → 直交軸の業界の組。先頭が主業界):
--   apparel_retail → retail(主) + apparel
--   apparel_maker  → maker(主)  + apparel
--   zakka          → zakka(主)
--   bedding        → bedding(主)
--   logistics      → logistics(主)
--   other          → other(主)
-- 移行後、レガシー列 ops.customers.industry は新しい industry_id(主業界)を保持する。
-- 管理 UI は主業界を industry 列へ書き込むため、旧 enum 値のままでは値空間が混在する。
-- dwh ETL は当面この列を参照するため、本マイグレーション下部の UPDATE で値空間を統一する。
INSERT INTO ops.customer_industries (customer_id, industry_id, is_primary)
SELECT c.customer_id, m.industry_id, m.is_primary
FROM ops.customers c
JOIN LATERAL (
  VALUES
    ('apparel_retail', 'retail',    TRUE),
    ('apparel_retail', 'apparel',   FALSE),
    ('apparel_maker',  'maker',     TRUE),
    ('apparel_maker',  'apparel',   FALSE),
    ('zakka',          'zakka',     TRUE),
    ('bedding',        'bedding',   TRUE),
    ('logistics',      'logistics', TRUE),
    ('other',          'other',     TRUE)
) AS m(old_value, industry_id, is_primary) ON m.old_value = c.industry
ON CONFLICT DO NOTHING;

-- ── CHECK 制約の撤廃(industry カラム自体は二段階移行のため当面残す。v0.3 §6)──
DO $$
DECLARE con TEXT;
BEGIN
  SELECT conname INTO con
    FROM pg_constraint
   WHERE conrelid = 'ops.customers'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%industry%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ops.customers DROP CONSTRAINT %I', con);
  END IF;
END $$;

-- ── レガシー列の値空間統一 ──────────────────────────────────
-- 既存顧客の industry 列を旧 enum 値から新しい industry_id(主業界)へ更新する。
-- 管理 UI(マスタ管理)は主業界を industry 列へ書き込むため、これで新旧の値空間が統一される。
-- 注意: 新 industry_id('retail' 等)は旧 CHECK 制約の enum に含まれないため、
--       この UPDATE は上記の CHECK 制約撤廃の後に実行する必要がある。
UPDATE ops.customers c
SET industry = ci.industry_id
FROM ops.customer_industries ci
WHERE ci.customer_id = c.customer_id AND ci.is_primary;

COMMENT ON COLUMN ops.customers.industry IS
  '旧・単一業界(廃止予定)。SoT は ops.customer_industries。値は主業界の industry_id(値空間統一済み)。dwh ETL の切替完了後のバージョンで削除する';
