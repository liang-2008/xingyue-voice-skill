// 语音说话（云端 / 本地 TTS）：让机器人把一句话「说出来」，而不只是打字。
//
// 支持三家，默认走**阿里云百炼（DashScope）Qwen-Audio-TTS**，因为它有免费额度：
//   · dashscope（默认）→ POST {baseUrl}/services/audio/tts/SpeechSynthesizer
//                         model=qwen-audio-3.0-tts-flash 等，返回一个 24 小时有效的音频 URL
//   · mimo（旧版）     → POST {baseUrl}/chat/completions
//                         model=mimo-v2.5-tts-voicedesign，返回 base64 音频
//   · local（自建）    → POST {localBaseUrl}/tts/
//                         Qwen3-TTS-Lunar（星月语音合成），返回 base64 WAV
// 拿到音频字节后统一 → ctx.sender.sendMedia() 发一条 record 段 → QQ 里是一颗语音气泡。
//
// ── 怎么切到阿里（三步）────────────────────────────────────────────────
//   ① 百炼控制台 → API-KEY 里建一个 `sk-` 开头的 Key（和「免费额度」同一个账号/地域）
//   ② 技能设置：apiKey 填这个 sk- Key；model 填 qwen-audio-3.0-tts-flash
//      （如果 baseUrl 还留着小米的 api.xiaomimimo.com，不用管，选阿里时会自动忽略它）
//   ③ 音色 voice 填 longanhuan_v3.6 之类（见「音色列表」），或留空用默认
//
// ── 怎么接自建 Qwen3-TTS-Lunar（星月语音合成）──────────────────────────
//   ① 在跑 TTS 的那台机器上启动服务（默认监听 0.0.0.0:36365）
//   ② 技能设置：合成方式选「本地 Qwen3-TTS-Lunar」；
//      「本地服务地址」填机器人能访问到的地址：
//        · 同一台机器        http://127.0.0.1:36365
//        · 局域网 / Tailscale http://100.79.58.26:36365
//   ③ 参考音频二选一：
//        · 「服务端路径」填 TTS 机器上的 WAV 绝对路径（推荐，机器人不读文件）
//        · 「本机路径」填机器人机器上的 WAV，插件会先 POST /upload/ 再合成
//      两个都空则不传 ref_audio，由服务端用默认音色。
//   本地模型不擅长并发，插件内部会把所有本地请求串成一条队列；
//   服务端没有 speed 参数，语速由参考音频/服务端控制，插件不做变速。
//
// ── 为什么音色从"描述"变成了"音色 ID" ─────────────────────────────────
//   小米的 voicedesign 是「用一段文字描述生成音色」；百炼这边音色是**固定 ID**
//   （longanhuan_v3.6 龙安欢 / longanlingxin_v3.1 龙安灵心 …），描述文字换成了
//   另一个字段 `instruction`（控制情绪、方言、角色）。所以：
//     · voice     = 音色 ID（必填，默认 longanhuan_v3.6）
//     · instruction = 语气/角色指令，来源三级回退：设置里的 instruction →
//                    voice.txt → （小米那边的 voicePrompt 设置，如果还留着）
//
// ── 音色/指令的兼容说明 ───────────────────────────────────────────────
//   旧配置里 voicePrompt 那一大段「少女音、偏软、语速偏快…」原本是给小米
//   voicedesign 用的。阿里这边没有人声克隆就没法"造"出那个音色，只能退一步
//   把它当 instruction 喂进去，让模型尽量贴这个气质。想换味道就改 voice.txt。
//
// ── 发送为什么走 ctx.sender.sendMedia ────────────────────────────────────
// src/sender.js 明确写着：插件**不得**绕过发送队列直接调 onebot.sendSegments，
// 否则会跳过限频与留档（表现为"媒体把配额吃光后突然发不出话"、重启后重复发）。
// sendMedia 就是为此准备的公共入口，record 段的 silk 转码由协议端自己做
// （snowluma 的 loadPtt → encodeSilk，自带 ffmpeg 转码，mp3/wav 都吃）。
//
// ── 两个必须写对的地方（写错就静默不出声）──────────────────────────────
//   ① 小米 voicedesign：要念的文字必须放在 role=assistant 的 content 里；
//      放在 user 里会被当成"音色/风格指令"，结果是没有声音或念出别的东西。
//   ② 百炼：文字放 `input.text`，音色放 `input.voice`，两者都属于同一个模型；
//      音色 ID 和模型对不上会直接报 InvalidParameter（例如 3.1 的音色配 3.0 的模型）。

import fs from 'node:fs';
import path from 'node:path';

let cfg = () => ({});
let log = () => {};
let apiFetch = null;

/** 音色/语气描述文件（与 index.js 同目录）。见文件头的"三级回退"说明。 */
const VOICE_FILE = new URL('./voice.txt', import.meta.url);

// ── 小米 MiMo ────────────────────────────────────────────────────────────
const MIMO_BASE = 'https://api.xiaomimimo.com/v1';
const VOICEDESIGN = 'mimo-v2.5-tts-voicedesign';
const BUILTIN = 'mimo-v2.5-tts';
/** 内置音色白名单（官方列表）。填了别的值就回落到默认。 */
const PRESET_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
/** 最后兜底：voice.txt 和设置项都读不到时用它，保证 voicedesign 永远有描述可用。 */
const DEFAULT_VOICE_PROMPT = '少女音，中高音，音色清脆、偏软，共鸣不太靠前，尾音带一点闷闷的厚度。语速偏快，说话像打字：短句连发，句子之间几乎不留停顿，句尾收得干脆、常把最后半个字轻轻吞掉，绝不拖长腔。语气随性灵动、带点懒散的撒娇感，像在群里跟熟人聊天，不是播音腔，也不甜腻。';

// ── 阿里云百炼 DashScope ─────────────────────────────────────────────────
const DASH_BASE = 'https://dashscope.aliyuncs.com/api/v1';
/** 非实时语音合成的固定路径（挂在 /api/v1 后面）。 */
const DASH_TTS_PATH = '/services/audio/tts/SpeechSynthesizer';
const DASH_MODEL_DEFAULT = 'qwen-audio-3.0-tts-flash';
/** 系统音色默认值：龙安欢。3.0 系列用 _v3.6 后缀，3.1 系列用 _v3.1，填错会报 InvalidParameter。 */
const DASH_VOICE_DEFAULT = 'longanhuan_v3.6';
const DASH_FORMATS = ['mp3', 'wav', 'opus', 'pcm'];
/** 阿里只接受这几个采样率。 */
const DASH_SAMPLE_RATES = [8000, 12000, 16000, 22050, 24000, 44100, 48000];

// ── 本地 / 自建 Qwen3-TTS-Lunar ───────────────────────────────────────────
// 服务地址可以是 127.0.0.1，也可以是 Tailscale / 内网 IP，例如
// http://100.79.58.26:36365。插件只依赖 HTTP，不关心 TTS 跑在哪台机器。
const LOCAL_BASE = 'http://127.0.0.1:36365';
const LOCAL_MODEL = 'qwen3-tts-lunar';
const LOCAL_TTS_PATH = '/tts/';           // 必须带尾斜杠，否则服务端返回 405
const LOCAL_UPLOAD_PATH = '/upload/';
/** 本机参考音频上传缓存：同一份文件只传一次，按 地址+路径+大小+mtime 判断。 */
const localRefCache = new Map();
/** 本地模型通常不擅长并发：所有本地请求串行，避免 CPU/内存被打满或请求互相拖慢。 */
let localQueue = Promise.resolve();

/**
 * 读 voice.txt。以 # 开头的行当注释丢掉，其余按行拼成一句话。
 * 文件不存在 / 读不出来都返回空串（交给下一级回退，绝不抛错）。
 */
export function readVoiceFile() {
  try {
    const raw = fs.readFileSync(VOICE_FILE, 'utf8').replace(/^\uFEFF/, '');
    return raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * 判断这次该用哪家。设置里显式写了 provider 就以它为准（auto 除外）；
 * 否则看 model / baseUrl 长什么样 —— 这样"把 model 改成 qwen-* 就切到阿里"，
 * 不用再去找 provider 这个开关。
 */
export function detectProvider(c = {}) {
  const model = String(c.model || '').trim().toLowerCase();
  // 本地模式优先看模型：模型值既支持机器名，也支持下拉里给人看的中文标签。
  // 放在 provider 之前，避免老配置里残留的 provider=dashscope 盖掉用户新选的本地。
  if (model.includes('local') || model.includes('lunar') || model.includes('本地') || model === LOCAL_MODEL) return 'local';
  const p = String(c.provider || '').trim().toLowerCase();
  if (p === 'local' || p === 'lunar' || p === 'selfhost' || p === '本地') return 'local';
  if (p === 'mimo' || p === 'mi' || p === 'xiaomi') return 'mimo';
  if (['dashscope', 'aliyun', 'ali', 'qwen', 'bailian', '百炼', '阿里'].includes(p)) return 'dashscope';
  const base = String(c.baseUrl || '').trim().toLowerCase();
  // 再看模型名：换模型是最常做的一步，"把 mimo-* 改成 qwen-* 就算切家"
  if (model.startsWith('mimo')) return 'mimo';
  if (/^(qwen|cosyvoice|sambert|paraformer|fun-|gummy)/.test(model)) return 'dashscope';
  // 模型名认不出来时再看地址
  if (base.includes('xiaomimimo')) return 'mimo';
  return 'dashscope';
}

/**
 * 解析接口地址。
 *  - mimo：默认 https://api.xiaomimimo.com/v1
 *  - dashscope：默认 https://dashscope.aliyuncs.com/api/v1
 *    自定义地址会被采用（业务空间专属域名、中转都行），但**小米的地址会被忽略** ——
 *    老配置里留着 api.xiaomimimo.com 时不至于把百炼的请求打到小米去。
 */
export function resolveBaseUrl(provider, raw) {
  const b = String(raw || '').trim().replace(/\/+$/, '');
  const lower = b.toLowerCase();
  if (provider === 'local') {
    // 自建服务没有公网默认值；留空就按本机 36365 处理。
    return b || LOCAL_BASE;
  }
  if (provider === 'mimo') {
    if (!b || lower.includes('dashscope') || lower.includes('maas.aliyuncs') || lower.includes('qianwenaiapi')) return MIMO_BASE;
    return b;
  }
  if (!b || lower.includes('xiaomimimo')) return DASH_BASE;
  return b;
}

/** 拼出真正的 TTS 端点：允许设置里直接写全路径。 */
export function ttsEndpoint(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/SpeechSynthesizer$/i.test(b)) return b;
  return `${b}${DASH_TTS_PATH}`;
}

/**
 * 配置清洗。纯函数（除了读 voice.txt），方便自检与回归。
 * @param {object} raw  技能设置
 * @param {object} deps { fileVoice } —— 自检时注入假文件内容
 */
export function readConfig(raw, deps = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const provider = detectProvider(c);
  const isDash = provider === 'dashscope';
  const isLocal = provider === 'local';

  // 本地模式单独用 localBaseUrl，避免和云端「接口地址」互相覆盖。
  const baseUrl = resolveBaseUrl(provider, isLocal ? c.localBaseUrl : c.baseUrl);
  const apiKey = String(c.apiKey || '').trim();

  // 音色/语气描述三级回退：设置里的 instruction → voice.txt → 旧的小米 voicePrompt → 内置兜底
  const settingInstruction = String(c.instruction || c.voiceStyle || '').trim();
  const settingPrompt = String(c.voicePrompt || '').trim();
  const fileVoice = ('fileVoice' in deps ? String(deps.fileVoice || '') : readVoiceFile()).trim();
  const voicePrompt = settingInstruction || settingPrompt || fileVoice || DEFAULT_VOICE_PROMPT;
  const voiceSource = settingInstruction
    ? '设置里的「语气指令」'
    : (settingPrompt ? '设置里的「音色描述」（旧小米字段）' : (fileVoice ? 'voice.txt' : '内置兜底'));

  let model;
  let voice;
  let presetVoice;
  if (isLocal) {
    model = LOCAL_MODEL;
    // 本地没有「音色 ID」这个概念，音色由参考音频决定；这里只用于日志。
    voice = String(c.localRefAudio || '').trim()
      ? '服务端参考音频'
      : (String(c.localRefFile || '').trim() ? '本机参考音频（自动上传）' : '服务默认音色');
    presetVoice = '';
  } else if (isDash) {
    model = String(c.model || '').trim() || DASH_MODEL_DEFAULT;
    // voice 是百炼的音色 ID；presetVoice 是小米时代的旧字段。
    // 只有它"看起来不像小米内置音色"（用户把音色 ID 填进了旧框）时才借用，
    // 否则老配置里的「冰糖」会被当成音色 ID 发到百炼 → InvalidParameter。
    const rawVoice = String(c.voice || '').trim();
    const legacyVoice = String(c.presetVoice || '').trim();
    const borrowLegacy = !rawVoice && legacyVoice && !PRESET_VOICES.includes(legacyVoice);
    voice = (borrowLegacy ? legacyVoice : rawVoice) || DASH_VOICE_DEFAULT;
    presetVoice = voice;
  } else {
    model = String(c.model || '').trim() === BUILTIN ? BUILTIN : VOICEDESIGN;
    const presetRaw = String(c.presetVoice || c.voice || '').trim();
    presetVoice = PRESET_VOICES.includes(presetRaw) ? presetRaw : '冰糖';
    voice = presetVoice;
  }

  const formatRaw = String(c.audioFormat || '').trim().toLowerCase();
  const format = isLocal
    ? 'wav'  // Qwen3-TTS-Lunar 固定返回 24k 单声道 WAV
    : (isDash
      ? (DASH_FORMATS.includes(formatRaw) ? formatRaw : 'mp3')
      : (formatRaw === 'wav' ? 'wav' : 'mp3'));

  const rateRaw = Math.floor(Number(c.sampleRate));
  const sampleRate = DASH_SAMPLE_RATES.includes(rateRaw) ? rateRaw : 24000;

  const rateSpeedRaw = Number(c.speechRate);
  const speechRate = isLocal
    ? 1  // 服务端没有 speed 参数；变速应由服务端/参考音频控制
    : Math.min(2, Math.max(0.5, Number.isFinite(rateSpeedRaw) && rateSpeedRaw > 0 ? rateSpeedRaw : 1));

  const languageRaw = String(c.language || c.languageHint || '').trim().toLowerCase();
  const language = /^[a-z]{2,5}$/.test(languageRaw) ? languageRaw : '';

  const maxChars = Math.min(2000, Math.max(20, Math.floor(Number(c.maxChars)) || 120));
  const timeoutMs = Math.min(300000, Math.max(5000, Math.floor(Number(c.timeoutMs)) || 60000));

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    voice,
    presetVoice,
    voicePrompt,
    voiceSource,
    instruction: isDash ? voicePrompt : '',
    format,
    sampleRate,
    speechRate,
    language,
    maxChars,
    timeoutMs,
    // 本地专属：服务端参考音频优先；没有就上传本机文件；两个都空则用服务默认音色。
    localRefAudio: isLocal ? String(c.localRefAudio || '').trim() : '',
    localRefFile: isLocal ? String(c.localRefFile || '').trim() : '',
    // 小米专属：whether to let voicedesign 自己润色文本（百炼没有这个开关）
    polishText: c.polishText === true,
    alsoSendText: c.alsoSendText === true
  };
}

/**
 * 把模型给的 text 洗成"适合念出来"的样子。
 *
 * 为什么要洗：模型经常带 markdown（**加粗**、`代码`、列表符号）和表情符号，
 * 这些会被逐字念出来（念出"星号星号"），或者让 TTS 停顿怪异。
 * 换行合成一句：语音是一段连续音频，换行在 QQ 语音里没有意义。
 */
export function normalizeSpeakText(input) {
  let s = String(input ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ');            // 代码块整段丢掉（念不了）
  s = s.replace(/`([^`]*)`/g, '$1');                // 行内代码保留内容
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // 图片
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // 链接保留文字
  s = s.replace(/https?:\/\/\S+/gi, '链接');         // 裸链接念出来很糟
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');         // 标题
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ''); // 列表符号
  s = s.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1'); // 加粗/斜体/删除线
  s = s.replace(/[*_~#>|]/g, ' ');                  // 残留符号
  s = s.replace(/[\r\n]+/g, '，');                   // 换行 → 逗号停顿（比直接连读自然）
  s = s.replace(/[ \t\u3000]+/g, ' ');
  s = s.replace(/，{2,}/g, '，').replace(/^[，、\s]+|[，、\s]+$/g, '');
  return s.trim();
}

/** 拼这一句要用的语气/角色指令：默认描述 + 可选的单句微调。没描述就只留微调。 */
export function buildVoiceInstruction(voicePrompt, style) {
  const base = String(voicePrompt || '').trim();
  const extra = String(style || '').trim();
  if (base && extra) return `${base}。这一句的语气：${extra}`;
  return extra || base;
}

/** 短指纹：用来给发送队列做去重键，避免同一句话在去重窗口内被念两遍。 */
function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/** 响应体压成一行短摘要（别把整页 HTML 灌进日志）。 */
function snippet(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** HTTP 状态码 → 能直接照做的提示。 */
function httpHint(status, provider = 'dashscope') {
  if (provider === 'mimo') {
    if (status === 401 || status === 403) return '（API Key 不对或没有权限：确认 apiKey 与「接口地址」是同一家的——套餐/中转的 tp- 开头 Key 只在套餐地址下有效，填官方地址会被拒）';
    if (status === 404) return '（接口地址不对，或这个地址不提供音频模型：把「接口地址」改回官方 https://api.xiaomimimo.com/v1 再试）';
    if (status === 429) return '（调用太频繁，或额度/余额用尽）';
    if (status === 400) return '（参数被拒：确认「合成方式」与音色设置匹配——voicedesign 不能带 audio.voice，mimo-v2.5-tts 必须带）';
    if (status >= 500) return '（MiMo 服务端异常，稍后自己会好）';
    return '';
  }
  if (status === 401 || status === 403) return '（API Key 无效或地域不匹配：百炼的 Key 分地域（北京 / 新加坡），Key 和接口域名必须是同一地域；确认用的是 sk- 开头、和「免费额度」同一个账号的 Key）';
  if (status === 404) return '（接口地址不对：默认应为 https://dashscope.aliyuncs.com/api/v1，业务空间专属域名则为 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1）';
  if (status === 429) return '（触发限流（RPM 180）或免费额度/余额用尽：控制台「免费额度」页看一眼剩余量）';
  if (status === 400) return '（参数被拒：最常见是「音色 ID 与模型不匹配」——3.0 系列音色带 _v3.6，3.1 系列带 _v3.1，不能混用；其次检查 format/sample_rate 取值）';
  if (status >= 500) return '（百炼服务端异常，稍后自己会好）';
  return '';
}

/** 把一段二进制转 base64（Node 里 Buffer 是全局的）。 */
function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(bytes).toString('base64');
}

/**
 * 百炼的等值返回是「一个 24 小时有效的音频 URL」，不是 base64。
 * 这里把音频下载下来再转 base64 —— sendMedia 要的就是 base64://。
 */
async function downloadAsBase64(url, doFetch, timeoutMs) {
  const res = await doFetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`音频下载失败：HTTP ${res.status}（链接有效期 24 小时，可能已过期，重试一次即可）`);
  const buf = await res.arrayBuffer();
  if (!buf || !buf.byteLength) throw new Error('音频下载回来是空的（合成可能没真正完成）');
  return toBase64(buf);
}

/** 走小米 MiMo：chat/completions + base64 音频。 */
async function synthesizeMimo(c, spoken, style, doFetch) {
  const useDesign = c.model === VOICEDESIGN;

  // ⚠️ 要念的文字必须在 assistant；user 放音色/风格指令
  const messages = [];
  if (useDesign) {
    messages.push({ role: 'user', content: buildVoiceInstruction(c.voicePrompt, style) });
  } else if (String(style || '').trim()) {
    // 内置音色也支持自然语言风格指令，但不需要"设计音色"，所以只说风格
    messages.push({ role: 'user', content: String(style).trim() });
  }
  messages.push({ role: 'assistant', content: spoken });

  const audio = { format: c.format };
  if (!useDesign) audio.voice = c.presetVoice;          // voicedesign 传 voice 会报错
  if (useDesign && c.polishText) audio.optimize_text_preview = true;

  const res = await doFetch(`${c.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'api-key': c.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.model, messages, audio, stream: false }),
    signal: AbortSignal.timeout(c.timeoutMs)
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`MiMo 返回 HTTP ${res.status}${httpHint(res.status, 'mimo')}：${snippet(body)}`);

  let data = null;
  try { data = JSON.parse(body); } catch { throw new Error(`MiMo 返回的不是 JSON：${snippet(body)}`); }
  if (data?.error) {
    const e = data.error;
    throw new Error(`MiMo 报错：${snippet(typeof e === 'string' ? e : (e.message || e.code || JSON.stringify(e)))}`);
  }

  const msg = data?.choices?.[0]?.message;
  const b64 = String(msg?.audio?.data || '').trim();
  if (!b64) throw new Error(`没拿到音频数据${snippet(body, 120) ? `（原始响应：${snippet(body, 120)}）` : ''}`);

  // polish 打开时，实际念的可能不是原话 —— 用 MiMo 回传的最终文本，日志与存档才准
  const finalText = c.polishText ? (String(msg?.final_text_preview || '').trim() || spoken) : spoken;
  return { audioB64: b64, spoken: finalText, polished: c.polishText && finalText !== spoken };
}

/**
 * 发请求。中心域名（dashscope.aliyuncs.com）在个别地域/白名单下可能不挂这个端点，
 * 这时会自动再试一次「试用域名」——同一把 Key、跨业务空间可用，只是限流更紧。
 * 只对 404 回退：401 是 Key/地域问题，重试没用，早点报出来更好排查。
 */
const DASH_TRIAL_TTS = 'https://trial.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

async function postTts(c, input, doFetch) {
  const urls = [ttsEndpoint(c.baseUrl)];
  if (/^https:\/\/dashscope\.aliyuncs\.com\/api\/v1$/i.test(c.baseUrl)) urls.push(DASH_TRIAL_TTS);
  let last = null;
  for (let i = 0; i < urls.length; i++) {
    const res = await doFetch(urls[i], {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: c.model, input }),
      signal: AbortSignal.timeout(c.timeoutMs)
    });
    const body = await res.text();
    last = { res, body, url: urls[i] };
    if (res.status === 404 && i + 1 < urls.length) continue;
    return last;
  }
  return last;
}

/** 走阿里云百炼：services/audio/tts/SpeechSynthesizer + 音频 URL。 */
async function synthesizeDash(c, spoken, style, doFetch) {
  const instruction = String(buildVoiceInstruction(c.instruction, style) || '').trim();

  const input = {
    text: spoken,
    voice: c.voice,
    format: c.format
  };
  if (c.format !== 'pcm') input.sample_rate = c.sampleRate;
  if (c.speechRate !== 1) input.rate = c.speechRate;
  if (c.language) input.language_hints = [c.language];
  // instruction 控制情绪/方言/角色。太长没意义，截一下并写进日志。
  if (instruction) input.instruction = instruction.slice(0, 300);

  const { res, body, url } = await postTts(c, input, doFetch);
  if (!res.ok) throw new Error(`百炼返回 HTTP ${res.status}${httpHint(res.status)}：${snippet(body)}`);

  let data = null;
  try { data = JSON.parse(body); } catch { throw new Error(`百炼返回的不是 JSON：${snippet(body)}`); }
  // 百炼的错误体是 { code, message, request_id }，有些场景 HTTP 仍是 200
  if (data?.code && !data?.output) {
    throw new Error(`百炼报错 ${data.code}：${snippet(data.message || '')}${data.request_id ? `（request_id=${data.request_id}）` : ''}`);
  }
  if (data?.error) {
    const e = data.error;
    throw new Error(`百炼报错：${snippet(typeof e === 'string' ? e : (e.message || e.code || JSON.stringify(e)))}`);
  }

  const audioObj = data?.output?.audio || {};
  let b64 = String(audioObj.data || '').trim();       // 流式才有 base64 块，这里兜一手
  if (!b64) {
    const url = String(audioObj.url || '').trim();
    if (!url) throw new Error(`没拿到音频（output.audio 里既没有 data 也没有 url）：${snippet(body, 160)}`);
    b64 = await downloadAsBase64(url, doFetch, c.timeoutMs);
  }

  const usedChars = Number(data?.usage?.characters);
  return {
    audioB64: b64,
    spoken,
    polished: false,
    usage: Number.isFinite(usedChars) && usedChars > 0 ? usedChars : null,
    fallback: url !== ttsEndpoint(c.baseUrl)
  };
}

// ── 本地 Qwen3-TTS-Lunar ─────────────────────────────────────────────────

/** 拼本地服务端点，统一去掉地址末尾的斜杠。 */
function localEndpoint(c, suffix) {
  return `${String(c.baseUrl || LOCAL_BASE).replace(/\/+$/, '')}${suffix}`;
}

/** 本地模型串行队列：同一时刻只处理一条，避免并发把 CPU/内存打爆。 */
function localRun(task) {
  const run = localQueue.then(task, task);
  localQueue = run.then(() => {}, () => {});
  return run;
}

/** 本地服务的 HTTP 状态码 → 能直接照做的提示。 */
function localHint(status) {
  if (status === 401 || status === 403) return '（服务可能开了鉴权或防火墙拦截；确认机器人能访问这个地址）';
  if (status === 404) return '（地址或路径不对：确认端口正确，且这是 Qwen3-TTS-Lunar 服务）';
  if (status === 405) return '（路径少了尾部斜杠：插件已使用 /tts/，检查服务地址是否被反向代理改写）';
  if (status === 429) return '（请求太频繁，本地服务忙不过来）';
  if (status >= 500) return '（TTS 服务端异常：模型可能没加载完、内存不足，或服务日志里有报错）';
  return '';
}

/**
 * 把机器人本机上的参考 WAV 上传到 TTS 服务，返回服务端路径。
 * 结果按「服务地址 + 文件绝对路径 + 大小 + mtime」缓存；文件改了会自动重传。
 */
async function uploadLocalReference(c, doFetch) {
  const filePath = String(c.localRefFile || '').trim();
  if (!filePath) return '';

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`本机参考音频读不到：${filePath}（${error?.message ?? error}）`);
  }
  if (!stat.isFile()) throw new Error(`本机参考音频不是文件：${filePath}`);
  if (!/\.wav$/i.test(filePath)) throw new Error(`参考音频必须是 WAV：${filePath}`);

  const key = `${localEndpoint(c, '')}|${path.resolve(filePath).toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
  const cached = localRefCache.get(key);
  if (cached) return cached;

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`本机参考音频读不出来：${filePath}（${error?.message ?? error}）`);
  }

  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), path.basename(filePath));

  let res;
  try {
    res = await doFetch(localEndpoint(c, LOCAL_UPLOAD_PATH), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(c.timeoutMs)
    });
  } catch (error) {
    throw new Error(`上传参考音频失败（${localEndpoint(c, LOCAL_UPLOAD_PATH)}）：${error?.message ?? error}`);
  }

  const body = await res.text();
  if (!res.ok) throw new Error(`参考音频上传失败：HTTP ${res.status}${localHint(res.status)}：${snippet(body)}`);

  let data = null;
  try { data = JSON.parse(body); } catch {
    throw new Error(`参考音频上传返回的不是 JSON：${snippet(body)}`);
  }
  if (!data || !data.success) {
    throw new Error(`参考音频上传被拒绝：${snippet(data?.error || data?.message || body)}`);
  }
  const serverPath = String(data.path || '').trim();
  if (!serverPath) throw new Error(`参考音频上传成功，但服务端没有返回 path：${snippet(body)}`);

  // 缓存别无限长：换过很多次参考音频时清一下旧的即可。
  if (localRefCache.size > 32) localRefCache.clear();
  localRefCache.set(key, serverPath);
  return serverPath;
}

/**
 * 走本地 / 自建 Qwen3-TTS-Lunar：
 *   POST /tts/  { text, ref_audio? } -> { success:true, audio:"<base64 WAV>" }
 * 兼容直接返回 audio/wav 二进制的版本。参考音频优先级：
 *   设置里的服务端路径 → 本机路径上传 → 不传（用服务默认音色）。
 */
async function synthesizeLocal(c, spoken, doFetch) {
  return localRun(async () => {
    let refAudio = String(c.localRefAudio || '').trim();
    if (!refAudio && c.localRefFile) refAudio = await uploadLocalReference(c, doFetch);

    const payload = { text: spoken };
    if (refAudio) payload.ref_audio = refAudio;

    const url = localEndpoint(c, LOCAL_TTS_PATH);
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(c.timeoutMs)
      });
    } catch (error) {
      throw new Error(`连接本地 TTS 失败（${url}）：${error?.message ?? error}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      throw new Error(`本地 TTS 返回 HTTP ${res.status}${localHint(res.status)}：${snippet(buf.toString('utf8'))}`);
    }

    // 有些版本直接回 WAV 二进制，省掉 base64 解码。
    if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'RIFF') {
      return { audioB64: buf.toString('base64'), spoken, refAudio, bytes: buf.length, usage: null };
    }

    let data = null;
    try { data = JSON.parse(buf.toString('utf8')); } catch {
      throw new Error(`本地 TTS 返回的不是 JSON/WAV：${snippet(buf.toString('utf8'))}`);
    }
    if (data?.success === false || data?.error) {
      throw new Error(`本地 TTS 合成失败：${snippet(data.error || data.message || '服务端未返回原因')}`);
    }

    const audioValue = data?.audio || data?.audio_base64 || data?.data?.audio || data?.data?.audio_base64;
    if (typeof audioValue !== 'string' || !audioValue.trim()) {
      throw new Error(`本地 TTS 没有返回 audio 字段（顶层字段：${Object.keys(data || {}).join(', ')}）`);
    }

    const clean = audioValue.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(clean)) throw new Error('本地 TTS 返回的 audio 不是合法 base64');
    const audioBuf = Buffer.from(clean, 'base64');
    if (audioBuf.length < 4 || audioBuf.subarray(0, 4).toString('latin1') !== 'RIFF') {
      throw new Error('本地 TTS 返回的音频不是 WAV（缺少 RIFF 头）');
    }

    return { audioB64: audioBuf.toString('base64'), spoken, refAudio, bytes: audioBuf.length, usage: null };
  });
}

/**
 * 合成一段语音。返回 { audioB64, spoken, text, voiceSource, provider }。
 * @param {object} args { text, style }
 * @param {object} deps { fetchImpl }（自检时注入假 fetch）
 */
export async function synthesize({ text, style } = {}, { fetchImpl } = {}) {
  const c = readConfig(cfg());
  if (c.provider !== 'local' && !c.apiKey) {
    throw new Error(c.provider === 'dashscope'
      ? '还没填百炼 API Key（技能设置 → apiKey，sk- 开头）'
      : '还没填 MiMo API Key（技能设置 → apiKey）');
  }
  const spoken = normalizeSpeakText(text);
  if (!spoken) throw new Error('要说的内容是空的（去掉表情/markdown 之后什么都没剩下）');
  if (spoken.length > c.maxChars) {
    throw new Error(`这句话太长（${spoken.length} 字，上限 ${c.maxChars} 字）。`
      + '把内容拆成几条短句分别调用，或者改用打字回复——QQ 语音太长会被拒收，念出来也像念稿。');
  }
  const doFetch = fetchImpl || apiFetch;
  if (typeof doFetch !== 'function') throw new Error('缺少 fetch（清单里需要声明 web_fetch 权限）');

  const result = c.provider === 'dashscope'
    ? await synthesizeDash(c, spoken, style, doFetch)
    : (c.provider === 'local'
      ? await synthesizeLocal(c, spoken, doFetch)
      : await synthesizeMimo(c, spoken, style, doFetch));

  const who = c.provider === 'dashscope' ? '百炼' : (c.provider === 'local' ? '本地 Qwen3-TTS-Lunar' : 'MiMo');
  log(`语音合成完成（${who} / ${c.model}）：${result.spoken.length} 字，格式 ${c.format}`
    + (c.provider === 'local'
      ? `，参考音频=${result.refAudio || '服务默认'}`
      : `，音色=${c.provider === 'dashscope' ? c.voice : c.presetVoice}，音色来源=${c.voiceSource}`)
    + `${result.usage ? `，计费 ${result.usage} 字` : ''}`
    + `${result.fallback ? '，已回落到试用域名' : ''}`
    + `${result.polished ? '（文本已被润色）' : ''}`);

  return {
    audioB64: result.audioB64,
    spoken: result.spoken,
    text: spoken,
    voiceSource: c.voiceSource,
    provider: c.provider
  };
}

// ── 技能生命周期 ──────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  apiFetch = api.fetch;
  api.registerTool({
    id: 'say',
    name: '用语音说话',
    category: 'media',
    icon: '🔊',
    description: '把一句话用你自己的声音说出来，发成一条真正的QQ语音消息（不是文字）。只在用户明确要你用语音（用语音回我/说句话/念一下/唱一段），或语音明显比文字更合适时用。一次只适合一两句短话；发完不要再把同一句话用文字发一遍。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要说出口的话。会被逐字念出来，所以别写表情符号、markdown、括号里的动作描写；一两句、60 字内最好。' },
        style: { type: 'string', description: '可选：只针对这一句的语气微调，自然语言。例如「压低声音，装正经」「带点笑意，语速更快」「有气无力地」。不填就用默认音色。' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用/回复的消息 id（聊天记录里每条消息前的 #数字）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      try {
        if (!ctx?.chatKey) return { content: '错误：当前环境没有会话上下文，无法发语音', isError: true };
        if (typeof ctx.sender?.sendMedia !== 'function') {
          return { content: '错误：当前环境缺少发送接口（sender.sendMedia），语音没发出去', isError: true };
        }
        const { audioB64, spoken } = await synthesize({ text: args?.text, style: args?.style });

        await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: `base64://${audioB64}` } }], {
          label: `[语音]${spoken.slice(0, 30)}`,
          dedupeKey: `tts:${fingerprint(spoken)}`,
          replyToMessageId: args?.replyToMessageId ?? null
        });

        if (readConfig(cfg()).alsoSendText) {
          try { await ctx.sender.sendTextBatch(ctx.chatKey, [spoken], {}); }
          catch (error) { log(`语音已发出，但补发的文字失败：${error?.message ?? error}`); }
        }

        // 会话页留痕（与内置发图/发表情工具同一口径）；失败不影响主流程
        try {
          ctx.session?.sent?.push({
            type: 'voice',
            text: `[语音]${spoken.slice(0, 40)}`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit?.('session-update', ctx.session?.id);
        } catch { /* 留痕失败不影响这条语音已经发出去的事实 */ }

        return {
          content: `已用语音说出：「${spoken}」。这条语音已经直接发到会话里了——不要再把同一句话用文字发一遍，也不要向用户汇报"已发送"。`
        };
      } catch (error) {
        const msg = String(error?.message ?? error);
        log(`语音说话失败：${msg}`);
        return { content: `语音发送失败：${msg}。可以改用文字回复，不要立刻重复调用本工具。`, isError: true };
      }
    }
  });
  const now = readConfig(cfg());
  const providerLabel = now.provider === 'dashscope'
    ? '阿里百炼'
    : (now.provider === 'local' ? '本地 Qwen3-TTS-Lunar' : 'MiMo');
  log(`语音说话已注册（${providerLabel} / ${now.model}`
    + (now.provider === 'local'
      ? `，地址=${now.baseUrl}，参考音频=${now.localRefAudio || now.localRefFile || '服务默认'}）`
      : `${now.provider === 'dashscope' ? `，音色=${now.voice}` : ''}，音色来源=${now.voiceSource}）`));

  // 本地模式启动时主动探一次 /health：浏览器能打开 UI 不代表插件进程一定能连上，
  // 地址填错 / Tailscale 没通 / 防火墙拦了都会在这里留下一条明确的日志。
  if (now.provider === 'local' && typeof apiFetch === 'function') {
    void (async () => {
      const url = `${now.baseUrl.replace(/\/+$/, '')}/health`;
      try {
        const res = await apiFetch(url, { signal: AbortSignal.timeout(5000) });
        const body = await res.text();
        log(`本地 TTS 健康检查：HTTP ${res.status} ${snippet(body, 120)}（${url}）`);
      } catch (error) {
        log(`本地 TTS 健康检查失败（${url}）：${error?.message ?? error}`
          + '。检查「本地服务地址」是否为跑模型那台机器的 Tailscale/局域网 IP，以及服务是否监听 0.0.0.0。');
      }
    })();
  }
}

/**
 * 自检：必须同步返回（返回 Promise 会被当成"可用"），所以只做配置校验，不发网络请求。
 *
 * ⚠️ 刻意**不**把"音色描述是否为空"当不可用条件：描述有三级回退，永远读得到；
 *    曾经把空描述判成不可用，结果保存设置时把描述存成空值，插件就静默失声了。
 *    描述来源写在合成日志里，需要排查时看日志即可。
 */
export function available() {
  let c;
  try { c = readConfig(cfg()); } catch (error) { return { ok: false, reason: `配置读不出来：${error?.message ?? error}` }; }
  if (c.provider !== 'local' && !c.apiKey) {
    return {
      ok: false,
      reason: c.provider === 'dashscope'
        ? '还没填百炼 API Key（设置里的 apiKey，sk- 开头）'
        : '还没填 MiMo API Key（设置里的 apiKey）'
    };
  }
  if (!/^https?:\/\//i.test(c.baseUrl)) {
    return { ok: false, reason: `${c.provider === 'local' ? '本地服务地址' : '接口地址'}要以 http(s):// 开头（当前：${c.baseUrl}）` };
  }
  if (c.provider === 'local') return { ok: true };
  if (!c.model) return { ok: false, reason: '模型名为空（百炼填 qwen-audio-3.0-tts-flash）' };
  if (!c.voice) return { ok: false, reason: '音色 ID 为空（百炼填 longanhuan_v3.6 之类）' };
  return { ok: true };
}

export const internals = {
  synthesize,
  synthesizeLocal,
  uploadLocalReference,
  readConfig,
  readVoiceFile,
  normalizeSpeakText,
  buildVoiceInstruction,
  detectProvider,
  resolveBaseUrl,
  ttsEndpoint,
  fingerprint
};
