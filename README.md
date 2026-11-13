# 星月语音技能（Xingyue Voice Skill）

给 **QQ Agent / SnowLuma** 用的 LLM 技能：让机器人把一句话合成真正的 QQ 语音消息，而不是打字。

> 当前版本：**1.2.0** · Skill API：**v1** · 默认不启用
>
> 技能 ID：`mimo-tts`（历史遗留，工具名因此叫 `mimo-tts__say`；不改 ID 是为了不影响已经装好的配置）
>
> 这个仓库是一个**客户端插件**，不包含任何 TTS 模型。模型可以跑在阿里云百炼、小米 MiMo，也可以跑在你自己机器上的 Qwen3-TTS-Lunar。

## 三句话版本

- **云端**：选 `qwen-*` 走百炼，选 `mimo-*` 走小米，填对应 API Key。
- **本地**：合成方式选「本地 Qwen3-TTS-Lunar」，地址填模型机的 `http://IP:36365`，Key 留空，超时调 `300000`。
- **只想用默认音色**：两个参考音频字段都留空，插件不传 `ref_audio`。

---

## 相关项目

这个仓库只负责“让 QQ 里的机器人开口说话”，模型和图形界面都在别的仓库：

| 项目 | 做什么 | 地址 |
| --- | --- | --- |
| **星月语音技能**（本仓库） | QQ Agent 技能：把文字变成 QQ 语音消息，可选百炼 / 小米 MiMo / 本地三条通道 | 就是这里 |
| **星月语音合成工作台** | Windows 一键 GUI：拉起本地模型、试听、变速、导出 WAV | <https://github.com/liang-2008/xingyue-voice-studio> |
| **Lunar-Astral-Agents** | 上游模型与推理服务，Qwen3-TTS-Lunar 的原始作者仓库 | <https://gitee.com/TayunStarry/Lunar-Astral-Agents/> |

调用关系：

```text
QQ 消息
  └─ 本技能（xingyue-voice-skill）
       ├─ 阿里云百炼 / 小米 MiMo          （云端，填 Key 就能用）
       └─ Qwen3-TTS-Lunar HTTP 服务        （本地）
            ├─ 直接跑 Qwen3-TTS-Lunar.exe（模型来自 Lunar-Astral-Agents）
            └─ 或由星月语音合成工作台一键拉起
```

- 只想在自己电脑上试听、生成 WAV、调语速 → 装[星月语音合成工作台](https://github.com/liang-2008/xingyue-voice-studio)就够了，不需要本技能。
- 想让 QQ 机器人自己判断该不该发语音，并在群里发语音气泡 → 才需要本技能。
- 想了解模型本身、训练和推理参数 → 看[原作者仓库](https://gitee.com/TayunStarry/Lunar-Astral-Agents/)。

---

## 它是怎么一步步变成现在这样的

这个插件最初不是现在这个“多通道”版本，而是写死只调小米 MiMo 的。后来经过两次比较大的改造。

### 第一阶段：只能调小米 MiMo

最早的版本（备份在 `index.js.bak`）只有一条路：

```text
POST https://api.xiaomimimo.com/v1/chat/completions
model = mimo-v2.5-tts-voicedesign
```

特点：

- 只认小米的 `tp-` 开头 API Key
- 音色是一段文字描述，写在 `voice.txt` 里，或者填在设置里的「音色描述」
- 要念的文字必须放在 `role=assistant` 的 `content` 里；放在 `user` 里会被当成音色/风格指令
- `mimo-v2.5-tts-voicedesign` 不能带 `audio.voice`；只有内置音色的 `mimo-v2.5-tts` 才能用 `audio.voice`
- 返回 base64 音频，插件转成 `record` 段发给 QQ

这个阶段的代码还在 `index.js.bak` 里，留着方便对照。

### 第二阶段：改成可以切换云端 API

后来把“服务商、地址、Key、模型、音色”从写死改成了配置项：

- 默认切到 **阿里云百炼 DashScope 的 Qwen-Audio-TTS**，因为它有免费额度
- 保留小米 MiMo 通道
- 设置里的「合成方式（模型）」选哪一项，就走哪家：
  - `qwen-audio-3.0-tts-flash` / `qwen-audio-3.1-tts-flash`
  - `qwen-audio-3.0-tts-plus` / `qwen-audio-3.1-tts-plus`
  - `mimo-v2.5-tts-voicedesign` / `mimo-v2.5-tts`
- 「接口地址」和「API Key」也变成可配置，因此除了官方地址，也可以接**兼容的中转地址或自建地址**，不再被小米一家绑死
- 百炼返回的是 24 小时有效的音频 URL，插件会再下载一次并转成 base64
- 百炼的音色是固定 ID（`longanhuan_v3.6` 等），和 MiMo 的“文字描述音色”是两套逻辑
- 增加了各服务商的 HTTP 错误提示、超时、字数上限、语音之外补文字等选项

这一阶段的重点是：**“调哪家 API”不再由代码写死，而是由设置决定。**

### 第三阶段（最新）：接自建 Qwen3-TTS-Lunar

这次新增第三条通道：**本地 / 自建 Qwen3-TTS-Lunar（星月语音合成）**。

它解决的问题是：

- 机器人跑在云端，模型跑在家里的电脑上
- 两边通过 **Tailscale / 局域网** 串起来，不需要把模型端口暴露到公网
- 不走云端 TTS，不花 API 费用
- 可以用自己的参考音频，音色不再受云端固定音色限制

设置里只需要：

```text
合成方式：本地 Qwen3-TTS-Lunar
本地服务地址：http://100.122.9.58:36365
```

这个地址可以是：

- `http://127.0.0.1:36365`（机器人和 TTS 同一台机器）
- `http://100.122.9.58:36365`（Tailscale）
- `http://192.168.1.20:36365`（局域网）
- 任何机器人能访问到的 HTTP 地址

本地模式的特点：

- **不需要 API Key**
- 直接调 Qwen3-TTS-Lunar 的 `/upload/` 和 `/tts/`
- 支持两种参考音频：
  - 服务端路径：填模型机上的 WAV 绝对路径，机器人只传路径
  - 机器人本机路径：插件先上传到 `/upload/`，拿服务端 `path` 再合成
- 参考音频上传结果按“地址 + 文件路径 + 大小 + mtime”缓存，不会每句话都重传
- 本地请求**串行排队**，避免同时来几条语音把模型机 CPU/内存打满
- 启动时会主动探一次 `/health`，日志里能看到通没通
- 返回 WAV，插件以 `base64://` 交给 `ctx.sender.sendMedia()`，QQ 端的 silk 转码仍由协议端负责

---

## 功能

- 注册工具 `mimo-tts__say`，由模型自己判断什么时候该用语音
- 支持群聊 / 私聊，发的是真正的 QQ 语音气泡，不是文字
- 三种后端：
  - 阿里云百炼 Qwen-Audio-TTS
  - 小米 MiMo TTS
  - 自建 Qwen3-TTS-Lunar
- 语音之外可选再补一条文字
- 发送走 `ctx.sender.sendMedia()`，不绕过发送队列、限频和留档
- 同一条内容有去重键，避免短时间重复念
- 文本会先清洗 markdown、表情、链接、列表符号，再送去合成
- 单条语音有字数上限，超了直接拒绝并让模型拆短句

---

## 安装

把整个目录放到 QQ Agent 的 `skills/` 下，建议目录名用 `mimo-tts`，和技能 ID 保持一致，这样和已装的旧版本不会混：

```text
<QQ Agent>/skills/mimo-tts/
  skill.json
  index.js
  voice.txt
  README.md
```

然后在 QQ Agent 的技能页里：

1. 找到「语音说话（百炼 / MiMo / 本地）」
2. 打开开关
3. 打开设置，按下面的表格填写
4. 保存后不需要重启，配置即时生效

`skill.json` 里声明了 `web_fetch` 权限；没有这个权限，插件拿不到 `fetch`，三个通道都用不了。

> 只覆盖 `index.js` 是不够的。`skill.json` 里才有「本地 Qwen3-TTS-Lunar」这个选项和三个本地字段，两个文件要一起更新。

---

## 配置项

### 云端通用

| 字段 | 说明 |
|---|---|
| `baseUrl` | 云端接口地址。百炼默认 `https://dashscope.aliyuncs.com/api/v1`；小米默认 `https://api.xiaomimimo.com/v1` |
| `apiKey` | 百炼是 `sk-` 开头，小米是 `tp-` 开头；本地模式留空 |
| `model` | 合成方式。选 `qwen-*` 走百炼，选 `mimo-*` 走小米，选「本地 Qwen3-TTS-Lunar」走自建服务 |
| `voice` | 仅百炼：固定音色 ID，例如 `longanhuan_v3.6` |
| `instruction` | 仅百炼：语气/方言/角色指令，可留空 |
| `voicePrompt` | 仅小米：音色描述，留空则用 `voice.txt` |
| `presetVoice` | 仅小米：内置音色，例如 `冰糖`、`茉莉` |
| `audioFormat` | 云端输出格式，默认 `mp3`；本地模式固定 WAV，此项无效 |
| `maxChars` | 单条语音字数上限，默认 120，范围 20–2000 |
| `alsoSendText` | 发完语音后再补一条文字 |
| `polishText` | 仅小米 voicedesign：让 MiMo 先润色文本再念 |
| `timeoutMs` | 单条合成超时，默认 60000，最大 300000 |

### 本地模式专属

| 字段 | 说明 |
|---|---|
| `localBaseUrl` | Qwen3-TTS-Lunar 的服务地址，必须带 `http://` 或 `https://`，不要带 `/tts/` |
| `localRefAudio` | 模型机上的参考 WAV 绝对路径（服务端路径），优先级最高 |
| `localRefFile` | 机器人本机上的参考 WAV 路径；插件会先上传到 `/upload/`，再拿返回的 `path` 合成 |

参考音频的优先级：

```text
localRefAudio（服务端路径）
  > localRefFile（本机路径，自动上传）
  > 不传 ref_audio（由服务端用默认音色）
```

两个都填时，用服务端路径，不会上传本机文件。

---

## 本地模式怎么配

### 1. 在模型机上启动 Qwen3-TTS-Lunar

默认监听 `0.0.0.0:36365`。先在本机确认：

```powershell
Invoke-WebRequest http://127.0.0.1:36365/health -UseBasicParsing
```

应该返回类似：

```json
{"port":36365,"service":"simple-tts","status":"ok"}
```

### 2. 确认模型机的 Tailscale / 局域网地址

在模型机上执行：

```powershell
tailscale ip -4
```

例如输出：

```text
100.122.9.58
```

那么机器人那台机器上应该能访问：

```text
http://100.122.9.58:36365/health
```

> 注意：不要把云端机器人自己那台机器的 Tailscale IP 填进来。比如 `100.79.58.26` 是 `server-pc`，`100.122.9.58` 才是跑模型的 `laptop-oosg76qo`。填错了，浏览器可能能打开云端自己的页面，但插件请求永远到不了模型机。

### 3. 填技能设置

| 设置项 | 值 |
|---|---|
| 合成方式 | `本地 Qwen3-TTS-Lunar` |
| 本地服务地址 | `http://100.122.9.58:36365`（换成你的实际地址） |
| 参考音频·服务端路径 | 先留空，或填 `/upload/` 返回的 `path` |
| 参考音频·机器人本机路径 | 先留空 |
| API Key | 留空 |
| 单条合成超时 | `300000` |

先用 3～5 个字的短句测试，不要一上来就发长句。

### 4. 看日志确认

重新加载插件后，日志里应该出现：

```text
语音说话已注册（本地 Qwen3-TTS-Lunar / qwen3-tts-lunar，地址=http://100.122.9.58:36365，...）
本地 TTS 健康检查：HTTP 200 {"port":36365,"service":"simple-tts","status":"ok"}...
```

如果第一行显示「阿里百炼」，说明「合成方式」没切到本地；如果第二行失败，日志里会带完整 URL 和错误原因。

---

## 本地服务 API 契约

插件依赖的是下面这三个接口，和 GUI 用的是同一套。

### `GET /health`

```json
{"port":36365,"service":"simple-tts","status":"ok"}
```

### `POST /upload/`

`multipart/form-data`，字段名 `audio`，文件必须是 WAV。

返回：

```json
{"success":true,"name":"ref.wav","path":"...\\ref_xxx.wav"}
```

### `POST /tts/`

```json
{
  "text": "要念的文字",
  "ref_audio": "可选的服务器端路径"
}
```

返回：

```json
{"success":true,"audio":"<base64 WAV>"}
```

注意：

- `/tts`、`/upload` 不带尾部斜杠会返回 **405**
- 输出是 24000 Hz、单声道、16-bit PCM WAV
- 不传 `ref_audio` 时，由服务端使用默认音色
- 参考音频优先用 `/upload/` 返回的 `path`，不要随便拿一个本地路径直接当 `ref_audio`

---

## 数据流

### 百炼

```text
QQ → 模型调用 mimo-tts__say
   → POST {baseUrl}/services/audio/tts/SpeechSynthesizer
   → 返回 24 小时有效的音频 URL
   → 插件下载音频 → base64
   → ctx.sender.sendMedia(record) → QQ 语音
```

### 小米 MiMo

```text
QQ → 模型调用 mimo-tts__say
   → POST {baseUrl}/chat/completions
   → 返回 base64 音频
   → ctx.sender.sendMedia(record) → QQ 语音
```

### 本地 Qwen3-TTS-Lunar

```text
QQ → 模型调用 mimo-tts__say
   → [可选] POST {localBaseUrl}/upload/ 上传参考 WAV
   → POST {localBaseUrl}/tts/  {text, ref_audio?}
   → 返回 base64 WAV
   → ctx.sender.sendMedia(record) → QQ 语音
```

---

## 常见问题

### 浏览器能打开 TTS UI，但插件请求到不了模型机

按顺序检查：

1. **「合成方式」是不是「本地 Qwen3-TTS-Lunar」**  
   只填地址、不改合成方式，插件还是会去调百炼或 MiMo。
2. **地址是不是模型机的地址**  
   不要填云端机器人自己那台机器的 Tailscale IP。
3. **`skill.json` 和 `index.js` 是不是都更新了**  
   只更新 `index.js`，设置里不会出现本地选项和字段。
4. **技能有没有启用**  
   `enabledByDefault` 是 `false`，需要手动打开。
5. **看启动日志**  
   正常会有「本地 TTS 健康检查：HTTP 200」；失败会给出 URL 和原因。

### 合成返回 405

`/tts` 和 `/upload` 必须带尾部斜杠：`/tts/`、`/upload/`。

### 合成很慢 / 插件先超时

本地 0.6B 模型在 CPU 上跑，短句也可能十几秒到几十秒。把：

```text
单条合成超时 = 300000
```

先用短句测试，不要一上来发 100 多字。

### 合成时 GPU 占用不增加，CPU 看起来也没动

这个 Qwen3-TTS-Lunar 安装包的 TTS 推理后端是 **CPU**。启动日志会打印：

```text
TTSTransformer backend: CPU
AudioTokenizerDecoder backend: CPU
```

所以 **GPU 占用为 0 是正常的**，不是插件没跑。

CPU 侧目前基本只吃满一个核；多核机器上任务管理器的“总体 CPU”只会涨几个百分点，很容易看成没动。到“详细信息”里看 `Qwen3-TTS-Lunar.exe` 的 CPU 列，或者合成前后各执行一次：

```powershell
Get-Process Qwen3-TTS-Lunar | Select-Object Id, CPU
```

CPU 秒数明显增加，说明推理确实在跑。

另外确认你看的是**跑模型那台机器**，不是云端机器人那台。

### 参考音频不起作用 / 合成卡住

- 先把两个参考音频字段都留空，确认默认音色能正常出声
- 要用参考音频时，优先走 `/upload/`，把返回的 `path` 填进 `localRefAudio`
- 不要直接填 `lunar-template.wav` 这类文件路径，除非你确认服务端接受
- 参考音频必须是 WAV

### 语音没发出来

- 检查 `ctx.sender.sendMedia` 是否可用
- 检查协议端是否支持 `record` 段的 silk 转码
- 看插件日志里的「语音说话失败：...」
- 语音太长会被 QQ 拒收，缩短句子或调低 `maxChars`

### `web_fetch` 权限

`skill.json` 里必须有：

```json
"permissions": ["web_fetch"]
```

没有这个权限，插件拿不到 `fetch`，三个通道都用不了。

### 音色和模型不匹配

百炼 3.0 系列音色带 `_v3.6`，3.1 系列带 `_v3.1`，不能混用，否则会报 `InvalidParameter`。

---

## 关于 Python 优化

当前插件调本地服务时走的是：

```text
插件 → {localBaseUrl}/tts/ → 原版模型原始 WAV → QQ
```

**没有经过** `tts_client.py` 和 `postprocess.py`，所以：

- 没有 FFmpeg `atempo` 的 1.2x 变速
- 没有峰值归一化
- 没有音高微调

GUI 的链路才是：

```text
GUI → 36365 /tts/ → Python 变速/归一化 → 播放/保存
```

如果希望 QQ 也走 Python 优化，需要在模型机上再跑一个 Python 桥接服务，例如监听 `36366`：

```text
QQ → 插件 → 36366 桥接 → 36365 原版模型 → Python 后处理 → 插件 → QQ
```

桥接服务可以复用 `tts_client.py` 的 `LocalQwenTTS`。当前插件还没有 `localSpeed` 字段；要加变速，需要桥接层给默认速度，或者后续给插件补一个 `speed` 参数。

---

## 安全

- 本地 Qwen3-TTS-Lunar **默认没有鉴权**。只通过 Tailscale / 内网访问，不要把 36365 直接映射到公网。
- 云端 API Key 存在技能设置里，`apiKey` 字段标了 `secret: true`，UI 会脱敏显示。
- 不要把带 Key 的 `skill.json` 或配置文件提交到公开仓库。
- 如果一定要公网访问本地服务，请在反向代理上加认证和 TLS，不要裸奔。

---

## 文件结构

```text
mimo-tts/                 # 仓库名 xingyue-voice-skill，放进 skills/ 时用这个目录名
  skill.json      # 技能清单、默认设置、设置表单
  index.js        # 三种后端的实现与工具注册
  voice.txt       # 小米/百炼的音色/语气描述（本地模式不用）
  index.js.bak    # 最早的“只调小米 MiMo”版本，留作对照
  README.md
```

---

## 版本记录

### 1.2.0

- 新增「本地 Qwen3-TTS-Lunar」通道
- 支持任意 HTTP 服务地址（本机 / 局域网 / Tailscale）
- 支持服务端参考音频路径和机器人本机参考音频自动上传
- 参考音频上传缓存、本地请求串行队列
- 启动时 `/health` 健康检查日志
- 本地模式不需要 API Key，固定 WAV 输出

### 1.1.0

- 从“只调小米 MiMo”改成云端多通道
- 新增阿里云百炼 Qwen-Audio-TTS，并设为默认
- 增加模型选择、接口地址、Key、音色、语气指令、超时、字数上限等配置
- 保留小米 MiMo 的 voicedesign / 内置音色两条路

### 早期

- 只支持小米 MiMo TTS
- 音色由 `voice.txt` / 设置里的文字描述决定
- 见 `index.js.bak`

---

## 致谢

- [星月语音合成工作台 / xingyue-voice-studio](https://github.com/liang-2008/xingyue-voice-studio)：本技能本地接入方式、参考音频上传和 WAV 处理的直接来源，也是这套东西最早的一环（先有 GUI，后有 QQ 技能）
- [Lunar-Astral-Agents / Qwen3-TTS-Lunar](https://gitee.com/TayunStarry/Lunar-Astral-Agents/)：本地 TTS 服务与模型，以及 `XingyueTTS.exe` 背后的推理实现，原始作者仓库
- 阿里云百炼 DashScope：Qwen-Audio-TTS
- 小米 MiMo：MiMo TTS
- QQ Agent / SnowLuma：技能宿主、发送队列与 silk 转码

本项目只是一个调用方，不包含上述模型或服务；模型、推理服务与第三方 API 的使用条款以各自仓库/平台为准。
