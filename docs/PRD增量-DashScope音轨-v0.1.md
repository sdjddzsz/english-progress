# PRD 增量：DashScope 音轨与 CMUdict 发音真源

| 项目信息 | 内容 |
|---|---|
| 文档语言 | 中文 |
| 基线文档 | `PRD-英语学习进度系统.md` v1.2 ｜ `架构设计-英语学习进度系统.md` |
| 增量版本 | **v0.1**（本文只写增量；基线条款一律沿用，不重述） |
| 项目名 | `english_progress_system` |
| 形态 | Vite + React + TS + MUI + 云端 PostgreSQL + RLS（PWA） |
| 变更性质 | 增量开发：新增阿里云百炼 DashScope 主轨 + 发音真源切换 CMUdict；**不改调度/计划/反馈/反自测任何逻辑** |
| 主要用户 | 周思政（单人系统） |

---

## 一、变更背景与目标

### 背景（用户已拍板）

1. **Azure 轨走不通**：用户只有招行 Young 银联单标卡，不办新信用卡；Azure 语音服务注册需 VISA/Master 身份验证。→ Azure 通道**代码保留、不再主推**。
2. **DashScope 主轨已确认**：国内直连、无需国际卡、实名即可；价格 0.8 元/万字符（新用户 90 天内 1 万字符免费）。用户日均用量估算：50 词 × 听 2 次 ≈ 700 字符/天 ≈ 2 万字符/月 ≈ **1~2 元/月**（音频缓存进一步压低）。
3. **发音真源切换**：ECDICT 的 `ipa` 字段质量不可靠（实测 `wilful → /'wilful/` 把字母拼写当音标；`eagle → /'i:gl/` 缺音素标注），会直接吐出错误发音。→ 改用 **CMU Pronouncing Dictionary（ARPAbet，14 万词条）**，与 DashScope `<phoneme alphabet="cmu">` **原生匹配、零转换**。
4. **用户硬要求不变**：严格按音标读，不可连读/吞音/敷衍；单词模式音标驱动，例句模式自然韵律（真实考试听觉输入）。

### 增量目标

| 编号 | 目标 | 度量方式 | 目标值 |
|---|---|---|---|
| G1 | **消灭音标错误导致的错误发音** | 单词模式发音 100% 由 CMUdict ARPAbet 驱动；ECDICT 错误音标（拼写当音标类）不再进入发音链路 | 5407 词 CMUdict 覆盖率 ≥ 99%；未命中词有明确降级标记，不静默 |
| G2 | **主轨"已确认可用"且可负担** | 用户填 key + 试听通过即激活；成本透明 | 月 TTS 成本 ≤ 2 元；用量与资费在设置页可见；Azure 保留为可选但不推荐 |

---

## 二、需求池（P0/P1/P2）

> P0 = 必须（不做则主轨不成立）；P1 = 应该（体验完整度）；P2 = 可延后。

### P0（必须）

| ID | 需求 | 验收标准 |
|---|---|---|
| P0-1 | **provider 枚举扩展**：`TTSProviderName` 增加 `'dashscope'`（`domain.ts:66`）；`DEFAULT_TTS_PROVIDER` 由 `'azure'` 改 `'dashscope'`（`constants.ts:95`）；设置页下拉新增选项 | 类型/ store / configRepo 默认初始化 / 设置页下拉 / 云端 patch 五处联动；azure、openai_compatible 旧值继续可选，不破坏存量配置 |
| P0-2 | **DashScope 合成通道**：`neuralProvider.ts` 新增 `synthesizeDashScope`（按 `provider` 字段分发，不动 azure/openai 现有函数） | HTTP JSON + `enable_ssml: true`；`Authorization: Bearer <key>`；非流式返回音频 URL（24h 有效，需二次 fetch）或流式 base64；复用 `fetchWithTimeout`（3s）与编排器回退；试听探针打通 |
| P0-3 | **cmu phoneme 注入**：`ssml.ts` 支持 `<phoneme alphabet="cmu">`；`TTSRequest` 增加 `arpabet?: string` | provider=dashscope 时 word/syllable 模式注入 ARPAbet（**零转换**，仅 XML 转义）；azure 通道继续 `alphabet="ipa"` 不变；`orchestrator.cacheKey` 纳入 arpabet（换发音真源必须换缓存 key） |
| P0-4 | **CMUdict 导入管线**：构建期 Node 脚本（ECDICT CET6 词表 ⋈ CMUdict）生成新 seed 数据 | 新 seed 含 5407 词全量；输出覆盖率报告（未命中清单）；多变体取**主词条**（`WORD` 优先于 `WORD(1)`，无主词条取编号最小） |
| P0-5 | **ARPAbet→IPA 派生模块**（`arpabetToIpa.ts`，单一实现、可单测） | 确定性映射（含重音 1/2 → ˈ/ˌ、AH0→ə / AH1·AH2→ʌ）；用于展示、espeak 兜底、派生 `ipa` 字段 |
| P0-6 | **存量 words 行回填**：一次性 patch 流程，按 lemma 查 CMUdict 写 `arpabet` + 覆盖 `ipa` 为派生值 | 幂等可重跑；chunked upsert（复用 seedBootstrap 模式）；入口见待确认 Q6；回填后 PronunciationLog 无异常回退潮 |
| P0-7 | **连通性实测（阻塞项）**：① 浏览器直调 DashScope 的 **CORS** 是否放行；② SSML phoneme **带重音数字**（`ph="S AY1 N"`，官方示例为 `S AY N` 不带数字）是否兼容；③ `<break>` 是否支持；④ 流式是否支持 mp3 | 四项各有一次真实请求验证记录；任一项不通过的降级策略见 §六 |
| P0-8 | **英文 SSML 音色确认**：核对 CosyVoice 音色列表中标注"支持 SSML"的英文音色；定默认 model + voice 常量（建议 `cosyvoice-v2` 起步，待核对） | 设置页预填可用默认值；试听通过 |
| P0-9 | **未命中词降级**：无 arpabet 的词，word 模式降级纯文本合成并标记来源 | 不阻断学习；标记进 PronunciationLog / Issue 候选清单，后台可见 |

### P1（应该）

| ID | 需求 | 验收标准 |
|---|---|---|
| P1-1 | **用量与成本卡**（设置页）：本地字符计数 / 请求数 / 缓存命中率 + 资费静态说明 | 数据本地聚合（不依赖新表）；免费额度将满时一次性提示；口径见 §五 |
| P1-2 | **音节切分升级**：ARPAbet 无音节点，用重音数字定位音节核 + 最大首辅音启发式 | 初版可先纯重音切分（近似）；单音节试听从 IPA 切分迁到 ARPAbet 切分 |
| P1-3 | 设置页 model / 音色下拉；Azure 选项加 helper text"需 VISA/Master 身份验证，国内用户不推荐"（代码保留） | 下拉可改可测；Azure 通道仍可配置可用 |
| P1-4 | 逐词慢读升级为逐词 cmu phoneme 注入（依赖 P1 真题语料分词音标） | word_by_word 模式每词独立 phoneme |
| P1-5 | `PronunciationLog` 增加 `chars` 字段（精确用量统计） | 落库可聚合；与 P1-1 本地计数交叉校验一致 |

### P2（可延后）

| ID | 需求 |
|---|---|
| P2-1 | 百炼官方用量/余额 API 接入（先调研是否存在开放接口；不存在则维持本地估算） |
| P2-2 | CMUdict 多变体人工校正入口（主词条不准时手动换变体，复用 L3 发音存疑流） |
| P2-3 | Azure 通道去留复盘（代码至少保留一个版本周期后再评估） |

---

## 三、发音真源切换方案（CMUdict）

### 3.1 新 seed 词条字段设计

```jsonc
// seed-cet6.json（v2，原地扩展，不新建平行 seed 文件）
{
  "lemma": "academy",
  "arpabet": "AH0 K AE1 D AH0 M IY0",   // 新增：CMUdict 真源，DashScope cmu phoneme 直用
  "ipa": "/əˈkæd.ə.miː/",                // 保留字段：由 arpabet 确定性派生（§3.2），仅用于展示与 espeak 兜底
  "translation": "n. 学院, 学会, 专科院校",
  "frq": 45890,
  "tags": ["cet4", "cet6"]
}
```

- `Word.ipa`（domain.ts:114）**字段保留不动**：WordCard / BookPage / AudioRecallPage / CnToEnPage 四处展示逻辑与 espeak 兜底读取逻辑零改动，只是值的来源从 ECDICT 换成派生 IPA。
- `Word` 新增可选 `arpabet?: string`（无该字段 = 未命中 CMUdict，走 P0-9 降级）。
- 不加 `pos` 等其他字段；词频/标签继续用 ECDICT 的（CMUdict 无词频）。

### 3.2 派生 IPA（单一真源原则）

```
CMUdict ARPAbet ──零转换──→ DashScope <phoneme alphabet="cmu">   （发音真源）
      └── arpabetToIpa.ts（确定性映射，~40 音素，可单测）──→ word.ipa（展示 + espeak 兜底）
```

- 展示用 IPA 而非 ARPAbet：与常见词典形态一致，用户无学习成本；且 `arpabetToIpa` 是纯函数，展示与发音永远同源，不会再出现"音标和读出来对不上"。
- 若用户更想直接看 ARPAbet（如 `AH0 K AE1 D AH0 M IY0`），列为待确认 Q1，改展示层一处即可。

### 3.3 存量数据迁移（老用户云端已有 words 行）

| 对象 | 策略 |
|---|---|
| 云端 `words` 行（已有 ECDICT ipa） | **一次性回填**（P0-6）：按 lemma 查 CMUdict → 写 `arpabet` + 覆盖 `ipa` 为派生值；幂等可重跑；未命中词保留原 ECDICT ipa 并标记 |
| seed JSON | 原地扩展字段（v2 注释标识）；`seedBootstrap` 幂等 upsert 对老行**跳过不冲突**，回填走独立 patch 流程，两条路径互不干扰 |
| 音频缓存（Cache Storage） | **不迁移**：`cacheKey` 含 ipa/arpabet 内容，真源切换后旧 key 自然失效，按 LRU 预算（50MB）逐步淘汰 |
| 配置/调度/反馈数据 | 零影响 |

### 3.4 未命中词（CMUdict 无该词条）

预期极少（CMUdict 14 万词条 vs CET6 5407 词，含常见变形）。策略：保留 ECDICT ipa 供展示与 espeak；DashScope word 模式降级为纯文本合成，PronunciationLog 标记 `phoneme_source: 'text'`，并进后台 Issue 候选清单（可人工补音标，P2-2）。

---

## 四、三轨/四通道 Provider 语义与默认值

### 4.1 通道语义

| provider | 定位 | 音素控制 | 说明 |
|---|---|---|---|
| **`dashscope`** | **主推默认** | `<phoneme alphabet="cmu">`（ARPAbet 零转换） | 国内直连、无需国际卡；`enable_ssml: true`；仅复刻音色与标注"支持 SSML"的系统音色可用 |
| `azure` | 保留可选，不推荐 | `<phoneme alphabet="ipa">`（ipaMap 映射） | 需 VISA/Master 身份验证，用户走不通；代码保留、设置页加劝退提示 |
| `openai_compatible` | 备选（本机网关） | 无 phoneme，文本合成降级 | 无 SSML 能力，音标驱动在该通道天然降级（现状不变） |
| `espeak`（兜底） | 兜底轨 | IPA 直读（meSpeak WASM） | 读派生 IPA；断网天然离线；主轨失败/未配置/3s 超时自动回退，逻辑零改动 |

**编排优先级不变**（架构 §1.6）：音频缓存 → 主轨（status=active 且有 key，3s 超时）→ espeak 兜底 → PronunciationLog → 前台轻提示一次。

### 4.2 默认值（新用户 / 重置）

| 字段 | 值 | 说明 |
|---|---|---|
| `provider` | `'dashscope'` | 由 `'azure'` 修改（`DEFAULT_TTS_PROVIDER`） |
| `endpoint` | 预填 DashScope 通用端点（`https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`） | 用户只需填 key；也支持 Workspace 级端点二选一 |
| `model`（新增可选字段） | 默认常量（P0-8 确认后定，建议 `cosyvoice-v2`） | `TTSProviderConfig` 增加 `model?: string`，同时方便 openai_compatible 通道换模型 |
| `voice` | 默认英文 SSML 音色常量（P0-8 确认） | 设置页可改 |
| `ssmlPhonemeEnabled` | `true` | dashscope 的 phoneme 机制即 SSML，无此开关无音标驱动 |
| `status` | **`'pending_user_setup'`** | **硬约束 #7 不变**：填 key + 试听通过才转 active |
| `fallbackEngine` | `'ipa_espeak'` | 不变 |

> 注意：`provider` 默认值变更**不影响**存量已配置用户（其配置行已存在，`initDefaultTTSConfig` 幂等跳过）。

---

## 五、成本与额度：产品化呈现（P1）

**资费口径**（阿里云官方文档核实）：qwen3-tts 系列 / cosyvoice-v3.5-flash 0.8 元/万字符；新用户开通百炼后 90 天内 TTS 1 万字符免费。

**用户用量估算**：日均 50 词 × 听 2 次 ≈ 700 字符/天 ≈ 2 万字符/月。免费额度约 **14 天**用满，之后约 **0.9~1.6 元/月**（缓存命中重复听不产生新字符，实际更低）。

**产品化方案（P1-1，设置页"用量与成本"卡）**：

1. 本地统计：本月已合成字符数、请求次数、缓存命中率（本地聚合，不新增表）；
2. 静态资费说明：0.8 元/万字符、90 天 1 万字符免费、按当前速率的月预估（1~2 元）；
3. 免费额度将满（本地计数接近 1 万字符）时**一次性提示**"即将进入按量计费（约 X 元/月）"，不阻断；
4. **不显示"余额"**：百炼余额在控制台查看，本地无法可信获取；除非 P2-1 调研到开放 API。
5. 是否接入官方用量 API 显示真实余额：P2（待调研接口存在性）。

---

## 六、待确认问题（请主理人拍板或转用户）

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | 展示形态：派生 IPA（`/əˈkæd.ə.miː/`）还是 ARPAbet 原样（`AH0 K AE1 D AH0 M IY0`）？ | 派生 IPA：与词典形态一致、无学习成本；改展示层一处即可回退 |
| Q2 | CMUdict 多变体取主词条（`WORD` 优先于 `WORD(1)`），同意？ | 同意；个别不准的走 P2-2 人工校正 |
| Q3 | **CORS 阻塞预案**：若 DashScope 不放行浏览器直调，怎么办？ | 预案 A：本机网关走 openai_compatible 通道过渡；预案 B：静态托管侧加转发（违背"前端直调"架构，尽量不选）。需先实测 |
| Q4 | 默认 model / 英文 SSML 音色：授权架构师按"支持 SSML 的音色列表"核对后定？ | 授权；建议 cosyvoice-v2 起步，试听探针验证后固化常量 |
| Q5 | 免费额度 14 天用满、之后约 1 元/月按量付费：用户是否接受并自助充值？ | 需向用户确认；不接受则 P1-1 的付费提示改为"提前 3 天提醒充值" |
| Q6 | 存量回填入口：设置页"升级发音真源"按钮（用户可见、幂等可重跑）还是运维脚本一次性跑？ | 设置页按钮：单人系统可重跑更稳，且回填进度可见 |
| Q7 | 音节切分初版用纯重音切分（近似，如 academy → ək\|kæd\|əm\|iː）可接受吗？ | 可接受则 P1-2 分两步走；不可接受则初版即上最大首辅音启发式 |
| Q8 | seed 数据原地扩展加 `arpabet` 字段（推荐）还是新建 v2 seed 文件？ | 原地扩展：避免双 seed 并存、seedBootstrap 逻辑零改 |

---

## 七、明确不变的硬约束（本增量不触碰）

1. **反自测**：前台零测试/评分/正确率/打卡/徽章入口（T04 DOM grep 禁用词表验收不变）；用量成本卡只呈现字符数与金额，**不呈现任何"学了多少分/正确率"形态**。
2. **反馈体系**：L1/L2/L3 三层标注、"发音存疑/发音错误 → Issue → 后台待处理"流完全不变；P0-9 的未命中词标记只是 Issue 的**新增候选来源**，不改反馈交互。
3. **MRCS 调度**：分层多轮、掌握度降频（首末轮不跳）、欠账重排四方案、冲刺周、时间预算校验——`src/scheduler` 及 plan 相关文件**零改动**。
4. **硬约束 #7**：`TTSProviderConfig.status` 默认 `pending_user_setup`，配置即激活的流程不变。
5. **密钥存放例外**：key 存云端配置文档（RLS owner-only）+ 运行时内存 + "跨刷新保留"开关，不落地 localStorage/代码，不变。
6. **离线矩阵**：espeak 兜底天然离线；断网时背单词/听词联想全功能可用；兜底轻提示每会话一次，不阻断。
7. **编排器优先级与 PronunciationLog 语义**：缓存 → 主轨 3s 超时 → espeak → 落库，链路不变；本增量只新增 provider 分支与 arpabet 入参。
8. **SettingsPage 近期成果不回退**：endpoint 入口、云端写入、试听探针、跨刷新保留开关保持可用，仅做增量扩展。

---

## 八、关键技术事实与风险（已核实，附依据）

| 事实 | 依据 |
|---|---|
| DashScope `<phoneme>` 的 `alphabet` 仅支持 `py`（拼音）与 `cmu`（CMU 音标），**不支持 IPA** | 阿里云官方文档《SSML 与 LaTeX》 |
| CosyVoice 系列（v2/v3/v3.5-plus/flash）与 qwen-audio-3.0/3.1-tts 支持 SSML | 同上 |
| 官方示例 `<phoneme alphabet="cmu" ph="S AY N">` 不带重音数字；CMUdict 实际输出带 0/1/2 → **兼容性待实测（P0-7）**；不通过的降级：去数字（重音信息丢失，多音节词应力趋平）或该词降级纯文本 |
| 非流式返回音频 URL（24h 有效）需二次 fetch（注意 CORS 与过期）；流式返回 base64 PCM | 同上 |
| 免费额度：新用户 90 天 TTS 1 万字符；超额 0.8 元/万字符 | 同上 |
| Azure 注册需 VISA/Master 身份验证（用户招行 Young 银联单标卡不可用） | 用户已拍板 |

**主要风险**：① CORS 不通（阻塞，Q3 预案）；② 带数字重音不兼容（P0-7 降级策略）；③ 支持 SSML 的英文音色稀缺（P0-8 核对，必要时接受复刻音色或换模型）。

---

## 九、涉及文件清单（给架构师，边界内）

| 文件 | 改动 |
|---|---|
| `src/types/domain.ts` | `TTSProviderName` +`'dashscope'`；`TTSProviderConfig` +`model?`；`Word` +`arpabet?`；`PronunciationLog` +`chars?`（P1-5） |
| `src/config/constants.ts` | `DEFAULT_TTS_PROVIDER` → `'dashscope'`；DashScope 默认 endpoint / model / voice 常量 |
| `src/tts/types.ts` | `TTSRequest` +`arpabet?` |
| `src/tts/ssml.ts` | 支持 `alphabet="cmu"` 分支（按 provider 分发） |
| `src/tts/neuralProvider.ts` | 新增 `synthesizeDashScope`（不改 azure/openai 函数签名） |
| `src/tts/orchestrator.ts` | `cacheKey` 纳入 arpabet（其余不动） |
| `src/tts/arpabetToIpa.ts`（新） | ARPAbet→IPA 确定性映射 + 单测 |
| `src/pages/SettingsPage.tsx` | 下拉 +dashscope；endpoint/voice/model 帮助文案；P1-1 用量成本卡；P0-6 回填入口 |
| `src/data/seedBootstrap.ts` / `src/data/seed/importEcdict.ts` | seed v2 字段（arpabet 透传）；CMUdict join 脚本（构建期 Node，浏览器不引入 cmudict 原文） |
| `app/public/seed-cet6.json` | 原地扩展 arpabet + 派生 ipa |

**禁止触碰**：`src/scheduler/**`、`src/features/feedback/**`、plan/欠账/降频相关任何文件。

---

**文档状态**：v0.1 增量稿。待 Q1–Q8 确认后升 v0.2 并同步基线 PRD v1.3（§4.5、P0-11、TTSProviderConfig、数据模型四处口径更新由主理人决定是否回写基线）。
