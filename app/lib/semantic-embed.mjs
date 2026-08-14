'use client';

/**
 * Embedded local semantic search.
 *
 * - Model: BAAI/bge-small-zh-v1.5 (MIT) — int8 ONNX, shipped inside the
 *   app bundle (app/public/models/), NO network needed at runtime.
 * - Inference: @huggingface/transformers (Apache-2.0) running in WASM
 *   inside the WebView — nothing leaves the machine.
 * - Indexing: notes are embedded in the background (idle-time batching)
 *   and vectors are cached in IndexedDB (512 floats ≈ 2 KB/note).
 * - Search: query embedding → cosine similarity → top-K.
 * - Degradation: if the model/WASM fails to load, the caller falls back
 *   to the TF-IDF search already in place.
 */
import { env, AutoModel, XLMRobertaTokenizer } from '@huggingface/transformers';

// Android：模型经 Rust sidecar 提供（<data>/models，首启从 assets 部署）；
// 桌面：Tauri 内嵌 assets 提供 /models/。以 OcrBridge 是否存在区分平台。
const isAndroid = typeof window !== 'undefined' && Boolean(window.OcrBridge);
env.allowLocalModels = true;
// 完全离线：本地模型文件齐全，禁止 HF 远程请求 —— 避免 metadata 拉取失败
// 干扰 tokenizer/pipeline 构造（此前 embed 报 this.tokenizer is not a function）
env.allowRemoteModels = false;
// WebView 的 Cache API 对 16MB tokenizer.json 的 put 可能失败/超时，导致
// tokenizer 构造异常（Tokenizer must be a valid object）→ 禁用浏览器缓存
env.useBrowserCache = false;
env.useWasmCache = false;
env.localModelPath = isAndroid ? 'http://127.0.0.1:4318/models/' : '/models/';
// ONNX Runtime WASM 与模型同目录本地加载（WebView 无 SAB/WebGPU → asyncify 变体，
// 由 android-assets.cjs 以固定名复制；桌面 /models/ 内嵌同文件）
if (env.backends?.onnx) {
  env.backends.onnx.wasm ??= {};
  env.backends.onnx.wasm.wasmPaths = env.localModelPath;
}

const MODEL_ID = 'multilingual-e5-base';
const EMBEDDING_DIM = 768;
const DB_NAME = 'shoucang-semantic';
const DB_STORE = 'vectors';
// v3: e5-base -> 768-d; bump wipes stale v1/v2 (512d/1024d) vectors.
const DB_VERSION = 3;

let embedderPromise = null;
let cacheDbPromise = null;

function openCacheDb() {
  if (cacheDbPromise) return cacheDbPromise;
  cacheDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v2: e5 model -> 1024-d vectors; wipe any v1 (512-d bge) cache.
      if (db.objectStoreNames.contains(DB_STORE)) {
        db.deleteObjectStore(DB_STORE);
      }
      db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return cacheDbPromise;
}

async function getEmbedder() {
  if (!embedderPromise) {
    // eslint-disable-next-line no-console
    console.log('[semantic] loading model', MODEL_ID, 'localPath=', env.localModelPath, 'wasm=', JSON.stringify(env.backends?.onnx?.wasm?.wasmPaths ?? null));
    // 不用 pipeline/from_pretrained：4.2.0 的 get_tokenizer_files 依赖
    // get_file_metadata，而对 URL 形式的 localModelPath 跳过本地探测（isURL
    // 分支），离线时 metadata.exists=false → 文件列表空 → tokenizer 构造失败
    // （Tokenizer must be a valid object）。手动加载 tokenizer 文件直接构造。
    embedderPromise = Promise.all([
      AutoModel.from_pretrained(MODEL_ID, { quantized: true }),
      (async () => {
        const base = env.localModelPath;
        const [tokenizerJson, tokenizerConfig] = await Promise.all([
          fetch(`${base}${MODEL_ID}/tokenizer.json`).then((r) => r.json()),
          fetch(`${base}${MODEL_ID}/tokenizer_config.json`).then((r) => r.json()),
        ]);
        return new XLMRobertaTokenizer(tokenizerJson, tokenizerConfig);
      })(),
    ]).then(
      ([model, tokenizer]) => {
        // eslint-disable-next-line no-console
        console.log('[semantic] model+tokenizer loaded', 'tokenizerType=', typeof tokenizer);
        return { model, tokenizer };
      },
      (err) => {
        console.error('[semantic] model load FAILED:', String((err && err.message) || err).slice(0, 300));
        embedderPromise = null;
        throw err;
      },
    );
  }
  return embedderPromise;
}

/** Mean-pool + L2-normalize the model output into a 512-d vector. */
function normalizeEmbedding(output) {
  const data = output.data;
  const dim = EMBEDDING_DIM;
  const numTokens = Math.floor(data.length / dim);
  if (numTokens === 0) return null;
  const vector = new Float32Array(dim);
  for (let token = 0; token < numTokens; token += 1) {
    const offset = token * dim;
    for (let i = 0; i < dim; i += 1) vector[i] += data[offset + i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) vector[i] /= norm;
  return vector;
}

/** Embed a single text into a normalized vector.
 *  e5 models use role prefixes: 'query: ' for search input,
 *  'passage: ' for indexed documents. */
export async function embedText(text, role = 'query') {
  const { model, tokenizer } = await getEmbedder();
  const prefix = role === 'passage' ? 'passage: ' : 'query: ';
  const truncated = String(text || '').slice(0, 800);
  if (!truncated.trim()) return null;
  // eslint-disable-next-line no-console
  console.log('[semantic] embedding', role, truncated.slice(0, 30));
  try {
    // tokenizer 调用兼容函数化/对象两种形态（4.2.0 在 WebView 中可能非函数）
    const tokenizeFn = typeof tokenizer === 'function'
      ? (input, opts) => tokenizer(input, opts)
      : (input, opts) => tokenizer._call(input, opts);
    const inputs = await tokenizeFn(prefix + truncated, {
      padding: true,
      truncation: true,
      max_length: 512,
      return_tensor: 'pt',
    });
    // 4.2.0 AutoModel forward 返回对象 { last_hidden_state }（非 Tensor 本身）
    const raw = await model(inputs);
    const tensor = raw?.last_hidden_state || raw?.logits || raw;
    // eslint-disable-next-line no-console
    console.log('[semantic] embed output dims', JSON.stringify(tensor?.dims ?? null), 'len', tensor?.data?.length ?? 'n/a');
    return normalizeEmbedding(tensor);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[semantic] embed FAILED:', String((err && err.message) || err).slice(0, 300));
    throw err;
  }
}

export async function getCachedVector(noteId) {
  try {
    const db = await openCacheDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const request = tx.objectStore(DB_STORE).get(noteId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function putCachedVector(noteId, vector) {
  try {
    const db = await openCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(vector, noteId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // cache is best-effort
  }
}

export function noteEmbeddingText(note) {
  return [
    note.title || '',
    note.rawContent || '',
    note.ocrText || '',
    (note.tags || []).join(' '),
    note.author?.name || '',
  ].join('\n');
}

/** Background indexing: embed notes in idle batches; stops when done. */
export async function indexNotesInBackground(notes, { onProgress } = {}) {
  try {
    await getEmbedder();
  } catch {
    return { indexed: 0, failed: true };
  }

  let indexed = 0;
  for (const note of notes) {
    if (!note?.id) continue;
    const existing = await getCachedVector(note.id);
    if (existing) {
      indexed += 1;
      continue;
    }
    const vector = await embedText(noteEmbeddingText(note), 'passage');
    if (vector) {
      await putCachedVector(note.id, vector);
      indexed += 1;
    }
    // yield to the UI thread periodically (one note per idle slice)
    await new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 2000 });
      } else {
        setTimeout(resolve, 30);
      }
    });
    onProgress?.(indexed, notes.length);
  }
  return { indexed, failed: false };
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic search over the archive using cached embeddings.
 * Returns [{ note, score }] sorted desc; empty on any failure.
 */
export async function semanticSearchEmbedded(notes, query, { limit = 50 } = {}) {
  try {
    const queryVector = await embedText(query);
    if (!queryVector) return [];
    const scored = [];
    for (const note of notes) {
      if (!note?.id) continue;
      const vector = await getCachedVector(note.id);
      if (!vector) continue;
      const score = cosine(queryVector, vector);
      if (score > 0.35) scored.push({ note, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  } catch {
    return [];
  }
}

export async function semanticIndexStatus(notes) {
  try {
    let cached = 0;
    for (const note of notes) {
      if (await getCachedVector(note.id)) cached += 1;
    }
    return { cached, total: notes.length };
  } catch {
    return { cached: 0, total: notes.length };
  }
}
