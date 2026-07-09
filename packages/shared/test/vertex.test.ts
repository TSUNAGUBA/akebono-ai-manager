import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadVertexConfig } from '../src/config.js';
import { resolveModel, vertexEndpointUrl } from '../src/vertex.js';

describe('vertexEndpointUrl', () => {
  it('global はリージョンプレフィックスなしのホストに向ける', () => {
    expect(vertexEndpointUrl('global', 'my-proj', 'gemini-2.5-flash-lite', 'generateContent')).toBe(
      'https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/google/models/gemini-2.5-flash-lite:generateContent',
    );
  });

  it('リージョン指定はリージョナルエンドポイントに向ける', () => {
    expect(
      vertexEndpointUrl('asia-northeast1', 'my-proj', 'gemini-embedding-001', 'predict'),
    ).toBe(
      'https://asia-northeast1-aiplatform.googleapis.com/v1/projects/my-proj/locations/asia-northeast1/publishers/google/models/gemini-embedding-001:predict',
    );
  });
});

describe('loadVertexConfig', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    'GCP_PROJECT_ID',
    'GCP_REGION',
    'VERTEX_LOCATION',
    'VERTEX_EMBEDDING_LOCATION',
    'MODEL_FLASH_LITE',
    'MODEL_FLASH',
    'MODEL_PRO',
  ];

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env['GCP_PROJECT_ID'] = 'test-proj';
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('生成系は既定で global、embedding は既定で GCP_REGION に向ける', () => {
    process.env['GCP_REGION'] = 'asia-northeast1';
    const config = loadVertexConfig();
    expect(config.location).toBe('global');
    expect(config.embeddingLocation).toBe('asia-northeast1');
  });

  it('VERTEX_LOCATION / VERTEX_EMBEDDING_LOCATION で上書きできる', () => {
    process.env['VERTEX_LOCATION'] = 'us-central1';
    process.env['VERTEX_EMBEDDING_LOCATION'] = 'global';
    const config = loadVertexConfig();
    expect(config.location).toBe('us-central1');
    expect(config.embeddingLocation).toBe('global');
  });

  it('MODEL_* 環境変数でモデル階層を差し替えられる(2.5 系廃止時の移行経路)', () => {
    process.env['MODEL_FLASH_LITE'] = 'gemini-3.1-flash-lite';
    const config = loadVertexConfig();
    expect(resolveModel('flash-lite', config)).toBe('gemini-3.1-flash-lite');
    expect(resolveModel('flash', config)).toBe('gemini-2.5-flash');
    expect(resolveModel('pro', config)).toBe('gemini-2.5-pro');
  });
});
