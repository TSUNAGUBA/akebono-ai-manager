-- v0.9 追補: 顧客エイリアス(表記ゆれ照合。設計 SoT: phase3-and-migration-design.md §2)
-- 「株式会社しまむら」のような法人格付きの登録名は、質問文「しまむらの取引先は?」に
-- 部分一致しない(照合は「質問文 ⊇ 登録名」方向)ため、対象顧客の特定に失敗する。
-- 通称・略称をエイリアスとして登録し、名称・顧客IDとの UNION で照合できるようにする。

CREATE TABLE ops.customer_aliases (
  customer_id TEXT NOT NULL REFERENCES ops.customers(customer_id),
  alias       TEXT NOT NULL,
  PRIMARY KEY (customer_id, alias),
  -- 1文字エイリアス(「A」等)による過剰一致の防止(名称照合の length(name) >= 2 と同じルール)
  CHECK (length(alias) >= 2)
);

COMMENT ON TABLE ops.customer_aliases IS
  '顧客の別名(通称・略称・表記ゆれ)。質問文からの対象顧客特定(identifyTargetCustomer)で名称・顧客IDと同列に照合される。管理はダッシュボードの顧客編集フォームから';
