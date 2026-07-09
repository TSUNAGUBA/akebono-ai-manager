import { loadVertexConfig, optionalEnv, type VertexConfig } from './config.js';
import { AppError, ERROR_CODES } from './errors.js';
import { getAccessToken, SCOPES } from './google-auth.js';
import { logger } from './logger.js';

/**
 * Vertex AI(Gemini)REST クライアント。
 * モデルルーティング方針(要件 6.5):
 *   定型 → flash-lite / 知識回答 → flash / 思考支援・エスカレーション判定 → pro
 */
export type ModelTier = 'flash-lite' | 'flash' | 'pro';

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface GenerateOptions {
  tier: ModelTier;
  system?: string;
  messages: ChatTurn[];
  temperature?: number;
  maxOutputTokens?: number;
  /** 指定時は application/json で構造化出力を要求する */
  responseSchema?: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function resolveModel(tier: ModelTier, config: VertexConfig): string {
  switch (tier) {
    case 'flash-lite':
      return config.models.flashLite;
    case 'flash':
      return config.models.flash;
    case 'pro':
      return config.models.pro;
  }
}

/**
 * モデル別概算単価(USD / 100万トークン)。実際の請求とはずれうる目安値であり、
 * dwh.v_ai_cost での日次監視・傾向把握に使う。環境変数 MODEL_PRICING_JSON で上書き可能。
 * 形式: {"モデル名": {"input": 0.3, "output": 2.5}}
 */
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
};

let pricingCache: Record<string, { input: number; output: number }> | undefined;

function pricingTable(): Record<string, { input: number; output: number }> {
  if (pricingCache !== undefined) return pricingCache;
  const raw = optionalEnv('MODEL_PRICING_JSON', '');
  if (raw === '') {
    pricingCache = DEFAULT_PRICING;
    return pricingCache;
  }
  try {
    pricingCache = { ...DEFAULT_PRICING, ...(JSON.parse(raw) as Record<string, { input: number; output: number }>) };
  } catch {
    logger.warn('MODEL_PRICING_JSON の解析に失敗したためデフォルト単価を使用します');
    pricingCache = DEFAULT_PRICING;
  }
  return pricingCache;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = pricingTable()[model];
  if (price === undefined) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function callVertex(url: string, body: unknown, errorCode: 'AIM-4001' | 'AIM-4003'): Promise<unknown> {
  const token = await getAccessToken([SCOPES.CLOUD_PLATFORM]);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    throw new AppError(errorCode, 'Vertex AI への接続に失敗しました', { cause: err });
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(errorCode, `Vertex AI がエラーを返しました (HTTP ${res.status})`, {
      details: { status: res.status, body: text.slice(0, 500) },
    });
  }
  return res.json();
}

export async function generateContent(
  options: GenerateOptions,
  config: VertexConfig = loadVertexConfig(),
): Promise<GenerateResult> {
  const model = resolveModel(options.tier, config);
  const url = `https://${config.region}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.region}/publishers/google/models/${model}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.4,
    maxOutputTokens: options.maxOutputTokens ?? 2048,
  };
  if (options.responseSchema !== undefined) {
    generationConfig['responseMimeType'] = 'application/json';
    generationConfig['responseSchema'] = options.responseSchema;
  }

  const body: Record<string, unknown> = {
    contents: options.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    generationConfig,
  };
  if (options.system !== undefined) {
    body['systemInstruction'] = { parts: [{ text: options.system }] };
  }

  const json = (await callVertex(url, body, ERROR_CODES.LLM_REQUEST_FAILED)) as GenerateContentResponse;
  const parts = json.candidates?.[0]?.content?.parts;
  const text = (parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (text === '') {
    throw new AppError(ERROR_CODES.LLM_RESPONSE_INVALID, 'LLM 応答が空でした', {
      details: { finishReason: json.candidates?.[0]?.finishReason },
    });
  }
  const inputTokens = json.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    text,
    model,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
  };
}

/** 構造化出力(JSON)を要求して型 T として解釈する。 */
export async function generateJson<T>(
  options: Omit<GenerateOptions, 'responseSchema'> & { responseSchema: Record<string, unknown> },
  config: VertexConfig = loadVertexConfig(),
): Promise<{ value: T; result: GenerateResult }> {
  const result = await generateContent(options, config);
  try {
    return { value: JSON.parse(result.text) as T, result };
  } catch (err) {
    throw new AppError(ERROR_CODES.LLM_RESPONSE_INVALID, 'LLM の JSON 応答を解析できませんでした', {
      cause: err,
      details: { text: result.text.slice(0, 300) },
    });
  }
}

interface EmbedResponse {
  predictions?: Array<{ embeddings?: { values?: number[] } }>;
}

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

/** テキストのベクトル化。rag スキーマの vector(768) に合わせ outputDimensionality を指定する。 */
export async function embedTexts(
  texts: string[],
  taskType: EmbeddingTaskType,
  config: VertexConfig = loadVertexConfig(),
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const url = `https://${config.region}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.region}/publishers/google/models/${config.embedding.model}:predict`;
  const body = {
    instances: texts.map((text) => ({ content: text, task_type: taskType })),
    parameters: { outputDimensionality: config.embedding.dimensions },
  };
  const json = (await callVertex(url, body, ERROR_CODES.EMBEDDING_FAILED)) as EmbedResponse;
  const predictions = json.predictions ?? [];
  if (predictions.length !== texts.length) {
    throw new AppError(ERROR_CODES.EMBEDDING_FAILED, 'Embedding 応答の件数が入力と一致しません', {
      details: { expected: texts.length, actual: predictions.length },
    });
  }
  return predictions.map((p, i) => {
    const values = p.embeddings?.values;
    if (values === undefined || values.length !== config.embedding.dimensions) {
      throw new AppError(ERROR_CODES.EMBEDDING_FAILED, 'Embedding の次元数が想定と異なります', {
        details: { index: i, actual: values?.length, expected: config.embedding.dimensions },
      });
    }
    return normalize(values);
  });
}

/** コサイン距離での検索安定性のため、次元削減時は正規化する(Vertex AI の推奨)。 */
function normalize(values: number[]): number[] {
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}
