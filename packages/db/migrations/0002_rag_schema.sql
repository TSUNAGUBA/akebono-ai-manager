-- rag スキーマ: ナレッジチャンク+ベクトル(要件 7.4)
-- 前提: PostgreSQL 15.2+ / pgvector 拡張が利用可能であること

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS rag;

-- ナレッジ文書チャンク(Drive 原本 → 同期バッチで UPSERT)
CREATE TABLE rag.knowledge_chunks (
  chunk_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id       TEXT NOT NULL,          -- Drive fileId
  doc_type     TEXT NOT NULL CHECK (doc_type IN
    ('customer_profile','glossary','domain_ops','decision_rules','analogy')),
  customer_id  TEXT,
  title        TEXT,
  chunk_index  INT NOT NULL,
  chunk_text   TEXT NOT NULL,
  embedding    vector(768),            -- Vertex AI embedding(EMBEDDING_DIMENSIONS と一致)
  content_hash TEXT NOT NULL,          -- 差分同期用
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, chunk_index)
);
CREATE INDEX idx_knowledge_hnsw ON rag.knowledge_chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_knowledge_filter ON rag.knowledge_chunks (doc_type, customer_id);

-- 過去対話の要約ベクトル(「過去の類似ケース」参照用)
CREATE TABLE rag.dialogue_embeddings (
  dialogue_id  BIGINT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  embedding    vector(768),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dialogue_emb_hnsw ON rag.dialogue_embeddings
  USING hnsw (embedding vector_cosine_ops);
