/* ============================================================
   settings.mjs — LLM Provider 配置（4 个预设：OpenAI / Claude / DeepSeek / MiniMax）
   持久化：data/settings.json，权限 0600（key 明文存本地 + 文件权限收紧）。
   任何 provider 都不强写「必须有 key」：UI 在「未配置」状态仍可启用/试连，但实际请求会报错。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = process.env.AI_PLATFORM_SETTINGS_FILE || path.join(DIR, 'data', 'settings.json');

export const PRESETS = [
  {
    id: 'openai', name: 'OpenAI', apiStyle: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-mini', 'o1-preview'],
    defaultModel: 'gpt-4o-mini',
    hint: 'OpenAI 公式 API。OpenAI 互換プロキシ（Azure / Together / OpenRouter など）は Base URL を変更して利用できます。',
  },
  {
    id: 'claude', name: 'Claude (Anthropic)', apiStyle: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    hint: 'Anthropic Claude。x-api-key ヘッダーと /v1/messages を使用し、OpenAI とはプロトコルが異なります。',
  },
  {
    id: 'deepseek', name: 'DeepSeek', apiStyle: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    hint: 'DeepSeek 公式 API。OpenAI 互換プロトコルです。',
  },
  {
    id: 'minimax', name: 'MiniMax', apiStyle: 'openai',
    baseUrl: 'https://api.minimax.cn/v1',                            // 国内版默认（platform.minimax.cn 后台开的 Key）。国际版改成 https://api.minimax.io/v1。
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3.1-Flash-Preview'],
    defaultModel: 'MiniMax-M3',
    hint: 'MiniMax M3（OpenAI 互換）。M2.5 は response_format=json_object に非対応、M3 は対応しています。',
  },
];

export const VALID_IDS = PRESETS.map(p => p.id);
export const VALID_STYLES = ['openai', 'anthropic'];

let cache = null;             // 单例缓存：内存里的最终结果（preset + 用户覆盖）

export function load() {
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* 没有/坏了就用空 */ }
  const providers = {};
  for (const preset of PRESETS) {
    const saved = raw.providers && raw.providers[preset.id];
    providers[preset.id] = {
      ...preset,
      ...(saved || {}),
      id: preset.id,                                                       // id 永远以预设为准
      apiKey: (saved && typeof saved.apiKey === 'string') ? saved.apiKey : '',
    };
  }
  cache = {
    providers,
    defaultProvider: (raw && typeof raw.defaultProvider === 'string') ? raw.defaultProvider : '',
  };
  return cache;
}

function save() {
  const d = load();
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    // 只写用户能改的字段（不写 hint/hint 之类内部字段，省事）
    const out = {
      defaultProvider: d.defaultProvider || '',
      providers: {},
    };
    for (const p of Object.values(d.providers)) {
      out.providers[p.id] = {
        name: p.name, apiStyle: p.apiStyle, baseUrl: p.baseUrl,
        apiKey: p.apiKey || '',
        models: p.models, defaultModel: p.defaultModel, enabled: !!p.enabled,
      };
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2));
    try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch { /* 非 POSIX/不支持就忽略 */ }
  } catch (e) {
    console.error('[settings] 保存に失敗：', e.message);
    throw e;
  }
}

/** 把 key 掩码成 "sk-…xyz" 这种：4 头 + 4 尾；短于 8 显示 ***。 */
export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '***';
  return k.slice(0, 4) + '…' + k.slice(-4);
}

/** 给前端用的视图：永远不返回明文 key（除非 hasKey=false）；老 key 也不会被覆盖。 */
export function publicView(p) {
  return {
    id: p.id, name: p.name, apiStyle: p.apiStyle, baseUrl: p.baseUrl,
    models: p.models, defaultModel: p.defaultModel, enabled: !!p.enabled,
    hint: p.hint || '',
    hasKey: !!p.apiKey,
    apiKeyMasked: p.apiKey ? maskKey(p.apiKey) : '',
  };
}

export function getAllPublic() {
  const d = load();
  return {
    providers: Object.values(d.providers).map(publicView),
    defaultProvider: d.defaultProvider || '',
  };
}

export function getProvider(id) {
  return load().providers[id] || null;
}

/** 取默认 provider：用户显式设 → 否则「第一个 enabled 且有 key」。没有就 null。 */
export function getDefaultProvider() {
  const d = load();
  if (d.defaultProvider) {
    const p = d.providers[d.defaultProvider];
    if (p && p.enabled && p.apiKey) return p;
  }
  for (const p of Object.values(d.providers)) {
    if (p.enabled && p.apiKey) return p;
  }
  return null;
}

/** 解析 project.models[stageId] 中的 "providerId/modelName" → { provider, model }。
    兜底：在所有 enabled provider 的 models 里找原始字符串（兼容老数据 / 手动键入）。 */
export function resolveModelRef(project, stageId) {
  if (!project || !project.models) return null;
  const raw = project.models[stageId];
  if (!raw || typeof raw !== 'string') return null;
  const i = raw.indexOf('/');
  if (i > 0) {
    const pid = raw.slice(0, i);
    const m = raw.slice(i + 1);
    const p = getProvider(pid);
    if (p && p.enabled && p.apiKey) return { provider: p, model: m };
  }
  for (const p of Object.values(load().providers)) {
    if (p.enabled && p.apiKey && Array.isArray(p.models) && p.models.includes(raw)) {
      return { provider: p, model: raw };
    }
  }
  return null;
}

/** 给前端下拉用：所有 enabled 且有 key 的 provider × model 的笛卡尔积。 */
export function listEnabledModels() {
  const out = [];
  for (const p of Object.values(load().providers)) {
    if (p.enabled && p.apiKey) {
      for (const m of p.models) out.push({ providerId: p.id, providerName: p.name, model: m });
    }
  }
  return out;
}

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** 改 provider（key/apiStyle/baseUrl/models/defaultModel/enabled）。空 key 或与掩码相同 = 保留原 key。 */
export function setProvider(id, input = {}) {
  if (!VALID_IDS.includes(id)) throw new HttpError(400, `Unknown provider: ${id}`);
  const d = load();
  const cur = d.providers[id];
  if (!cur) throw new HttpError(404, `Provider not found: ${id}`);

  const next = { ...cur };
  if (input.name !== undefined) {
    const n = String(input.name).trim().slice(0, 60);
    if (n) next.name = n;
  }
  if (input.apiStyle !== undefined) {
    if (!VALID_STYLES.includes(input.apiStyle)) throw new HttpError(400, `Invalid API style: ${input.apiStyle}`);
    next.apiStyle = input.apiStyle;
  }
  if (input.baseUrl !== undefined) {
    const u = String(input.baseUrl).trim();
    try { new URL(u); next.baseUrl = u; }
    catch { throw new HttpError(400, `Invalid Base URL: ${input.baseUrl}`); }
  }
  if (input.apiKey !== undefined) {
    const k = String(input.apiKey || '').trim();
    // 掩码回显（页面显示 sk-…xyz）或空 = 用户没改，保留
    if (k === '' || k === '***' || (cur.apiKey && k === maskKey(cur.apiKey))) {
      // 保留 cur.apiKey
    } else {
      next.apiKey = k;
    }
  }
  if (input.models !== undefined) {
    if (!Array.isArray(input.models)) throw new HttpError(400, 'Models must be an array');
    const ms = input.models.map(m => String(m).trim()).filter(Boolean).slice(0, 50);
    next.models = ms.length ? ms : cur.models;
    const dm = String(input.defaultModel || '').trim();
    if (dm && next.models.includes(dm)) next.defaultModel = dm;
    else if (!next.models.includes(next.defaultModel)) next.defaultModel = next.models[0];
  } else if (input.defaultModel !== undefined) {
    const dm = String(input.defaultModel).trim();
    if (next.models.includes(dm)) next.defaultModel = dm;
  }
  if (input.enabled !== undefined) next.enabled = !!input.enabled;

  d.providers[id] = next;
  save();
  return publicView(next);
}

export function setDefaultProvider(id) {
  const d = load();
  if (!d.providers[id]) throw new HttpError(404, `Provider not found: ${id}`);
  d.defaultProvider = id;
  save();
  return { defaultProvider: d.defaultProvider };
}

/** Preset provider 只能「清空」（enabled=false、apiKey=''），不能真删；删了用户就没法重新启用。 */
export function clearProvider(id) {
  const d = load();
  if (!d.providers[id]) throw new HttpError(404, `Provider not found: ${id}`);
  if (!VALID_IDS.includes(id)) throw new HttpError(400, 'Preset providers can be cleared but cannot be deleted');
  d.providers[id] = { ...d.providers[id], apiKey: '', enabled: false };
  if (d.defaultProvider === id) d.defaultProvider = '';
  save();
  return publicView(d.providers[id]);
}

/** 测试连接：最小成本请求确认 key + 网络 + 模型都通。 */
export async function testProvider(id) {
  const p = getProvider(id);
  if (!p) throw new HttpError(404, `Provider not found: ${id}`);
  if (!p.apiKey) throw new HttpError(400, 'No API key configured');
  if (!p.enabled) throw new HttpError(400, 'Enable the provider before testing');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  const started = Date.now();
  try {
    if (p.apiStyle === 'openai') {
      const r = await fetch(`${p.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${p.apiKey}` },
        signal: ac.signal,
      });
      const ms = Date.now() - started;
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new HttpError(r.status, `HTTP ${r.status}: ${t.slice(0, 240).replace(/\s+/g, ' ')}`);
      }
      const j = await r.json().catch(() => ({}));
      const ids = (Array.isArray(j.data) ? j.data : []).map(m => m.id).sort();   // 全量返、按 id 排序
      return { ok: true, style: 'openai', ms, count: ids.length, sample: ids, baseUrl: p.baseUrl };
    }
    if (p.apiStyle === 'anthropic') {
      // Anthropic 没有 GET 列表端点 → 发 1 token 的最小 messages 请求
      const r = await fetch(`${p.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': p.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: p.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: ac.signal,
      });
      const ms = Date.now() - started;
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new HttpError(r.status, `HTTP ${r.status}: ${t.slice(0, 240).replace(/\s+/g, ' ')}`);
      }
      return { ok: true, style: 'anthropic', ms, model: p.defaultModel, baseUrl: p.baseUrl };
    }
    throw new HttpError(400, `Unknown API style: ${p.apiStyle}`);
  } catch (e) {
    if (e.name === 'AbortError') throw new HttpError(504, 'Connection timed out (30s)');
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, e.message || String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** 清缓存（测试用，正常流程不需要）。 */
export function _reset() { cache = null; }