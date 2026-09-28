# QQMusicNow · macOS 交接文档

> 这是给 **Mac 端的 ChatGPT / 开发者**看的交接说明。
> 同目录还有：`CONVERSATION.md`（整段开发对话的整理）、`source/qqmusicnow-source.zip`（当前完整源码）、`packages/`（macOS 安装包）。

---

## 0. 一句话现状

Flexbar 插件 **QQMusicNow**（QQ 音乐歌词 / 正在播放 / 播放控制）已经在 **Windows 上完整跑通并验证**；
**macOS 的代码路径都写好了，但从未在 Mac 真机上验证过**。

本包的目的：把 Windows 上验证过的工程搬到 Mac，跑通 macOS 的"播放检测"和渲染，然后按需修正。

---

## 1. 目标与验收标准

在 Mac 上装好插件后，应当满足：

1. FlexDesigner 里出现插件，6 个按键可以拖到 Flexbar 上：
   `正在播放(600)` · `歌词(480)` · `播放暂停(240)` · `上一首(240)` · `下一首(240)` · `状态(240)`
2. 播放 QQ 音乐时：封面、歌名、歌手·专辑、进度条正确；歌词逐字高亮跟得上；切歌 1 秒内跟上
3. 暂停时：保留歌词与进度（不显示提示）
4. **停止 / 关闭 QQ 音乐**时：歌词键与正在播放键显示「QQ 音乐未在播放」
5. 点按播放/暂停、上一首、下一首能控制 QQ 音乐（走系统媒体键 / MediaRemote）

验收手段（很重要，都是现成的）：

- **状态键**会显示当前检测链路与歌词来源，例如 `SMTC · QRC`（Windows）/ `macOS · QRC`（Mac）；中文/英文标签都会画成图片
- **日志**：`<插件安装目录>/logs/YYYY-MM-DD.log`，里面每一条曲目识别、歌词匹配、封面解析、绘制帧率都有记录
- **`npm run doctor`**：一键环境体检（canvas、字体、QQ 接口、nowplaying-cli / MediaRemote 是否可用）

---

## 2. 环境要求

- FlexDesigner **≥ 1.0.0**（插件 manifest 里声明的最低版本），一台 Flexbar 设备
- 开发用：Node **≥ 20**（SDK 要求）
- 建议：`brew install nowplaying-cli`（macOS 上最可靠的播放状态来源）
- 网络：能访问 `u.y.qq.com` / `c.y.qq.com` / `y.qq.com`（取歌词与封面）

---

## 3. macOS 上需要验证 / 可能要改的地方（按优先级）

| # | 事项 | 现状 | 怎么验证 / 怎么改 |
| --- | --- | --- | --- |
| 1 | `nowplaying-cli` 探测 | 已实现：`src/nowplaying/macos-media.js` 会依次探测 `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`，再退回 PATH（GUI 启动的进程 PATH 很干净，这是必须的） | 装好后看日志是否出现 `[NowPlaying] ... via macOS 媒体中心` |
| 2 | MediaRemote（JXA）兜底 | `helper/macos/nowplaying.jxa`，调用系统私有框架读取"正在播放" | 没装 nowplaying-cli 时会走这条；失败会打印 `[NowPlaying] provider status: macos=unavailable(...)` |
| 3 | 媒体键 | `helper/macos/media-key.jxa`，用 `MRMediaRemoteSendCommand` 发送 play/pause、next、previous（私有接口，**未在真机验证**） | 点按设备上的按键看 QQ 音乐是否响应；不行就用设置页的 `customCommands`（config.json 里可配置自定义命令） |
| 4 | 窗口标题兜底 | `src/nowplaying/window-title.js`，通过 FlexDesigner 的窗口枚举读标题 | macOS 上需要给 FlexDesigner「屏幕录制」权限，否则拿不到窗口标题 |
| 5 | 中文字体 | `src/render/fonts.js` 会注册 `/System/Library/Fonts/PingFang.ttc` 等 | 日志出现 `[Fonts] using /System/Library/Fonts/PingFang.ttc` 即正常 |
| 6 | 原生渲染库被 Gatekeeper 隔离 | `@napi-rs/canvas` 的 `skia.darwin-*.node` | 若画面退化成纯文字：`xattr -dr com.apple.quarantine <插件安装目录>` 后重启插件 |
| 7 | QQ 音乐是否向"控制中心/媒体中心"注册播放状态 | 未知（Windows 上 QQ 音乐是注册的，但早期版本有时不注册） | 看状态键/日志里 `macos=ok` 还是 `unavailable`；不注册就只能用窗口标题或手动模式 |

---

## 4. 技术架构（按这个顺序读代码）

```
com.flexbar.qqmusicnow.plugin/          ← FlexDesigner 实际加载的插件目录
├─ manifest.json                        按键定义 + 中英文文案（flexcli 会校验）
├─ config.json                          用户设置（检测方式/偏移/字体…）
├─ backend/plugin.cjs                   rollup 打包产物（由 src/ 构建）
├─ ui/*.vue                             设置页与各按键的设置面板（Vue3 options API）
├─ helper/windows/smtc.ps1              读 Windows 系统媒体会话（SMTC），按行输出 JSON
├─ helper/windows/media-key.ps1         发送系统媒体键（常驻进程，走 stdin）
├─ helper/macos/nowplaying.jxa          MediaRemote 读取（私有框架，兜底用）
└─ helper/macos/media-key.jxa           MediaRemote 发送媒体命令

src/
├─ plugin.js            入口：事件、定时器、按键渲染与交互、诊断日志
├─ constants.js         cid / 配置默认值
├─ config.js            config.json 读写
├─ state.js             单实例锁 + 按键布局快照（见第 5 节）
├─ media-keys.js        跨平台媒体键（Windows 常驻 PS / macOS osascript）
├─ nowplaying/
│  ├─ index.js          检测链编排：按优先级取第一个可用来源，带"短暂缺口"桥接
│  ├─ windows-smtc.js   SMTC provider（精确进度 + 播放状态）
│  ├─ macos-media.js    macOS provider（nowplaying-cli → MediaRemote）
│  ├─ window-title.js   窗口标题 provider（快轮询 300ms，位置为推算）
│  ├─ helper-process.js 常驻子进程 + JSON 行解析 + 自动重启
│  └─ text.js           标题/歌手解析（"歌名 - 歌手" 等格式）
├─ lyrics/
│  ├─ qqmusic-api.js    QQ 音乐接口：搜索 / lyric_download / 明文 LRC / 封面候选
│  ├─ qrc-parser.js     QRC 逐字歌词解析（[行时间,时长] + 每字 (偏移,时长)）
│  ├─ lrc-parser.js     LRC 兜底解析
│  └─ service.js        曲目匹配（歌名+歌手+时长打分）、缓存、歌词来源选择
└─ render/
   ├─ engine.js         @napi-rs/canvas 懒加载（缺失则降级文字模式）
   ├─ fonts.js          中文字体注册（Win 雅黑 / Mac 苹方 / Linux Noto）
   ├─ cover.js          封面下载缓存（5s 超时 + 60s 失败负缓存）
   ├─ artwork.js        封面解析：多主机/尺寸/后缀候选 → songmid 反查正式专辑
   ├─ color.js          主色提取、颜色工具
   ├─ draw.js           圆角矩形、省略号截断、时间格式
   ├─ lyric-renderer.js 歌词键渲染（单/双行、逐字高亮、翻译、动态背景）
   ├─ nowplaying-renderer.js 正在播放键渲染（封面/文字/进度条）
   └─ text-renderer.js  文字键渲染（中文提示必须走这里，见第 5 节）
```

---

## 5. 关键设计决策与"踩过的坑"（不要改回去）

1. **Windows 自动模式只使用系统媒体会话（SMTC）**，窗口标题仅作为手动可选。
   原因：QQ 音乐的**窗口标题会滞后**——实测同一时刻 SMTC 已是新歌、窗口标题仍停在上一首。切歌瞬间 SMTC 会话会短暂消失（~0.6–1s），如果这时回退到窗口标题就会显示旧歌。

2. **绘制必须背压**：每个按键同一时刻只允许一帧在途，新帧覆盖旧帧。
   原因：设备端只显示"最后收到的那一帧"，如果推得比链路快，画面会越来越滞后。现在帧率自适应（`interval = max(33ms, ack×1.15)`）。

3. **`plugin.alive` 必须整表替换按键集合**。
   原因：FlexDesigner 每次布局变化推的是"当前完整按键列表"。早期实现是累加，导致继续往**已被删除的旧按键（旧 uid）**上画 → 绘制全部被拒绝（实测 10 秒 76 次失败），新按键只剩默认图标。

4. **单实例锁 + 按键布局快照**（`src/state.js`）。
   原因：FlexDesigner 重启/链接插件时不一定会结束旧进程，旧进程会继续往设备画过期画面；而且它**只在布局变化时**推 `plugin.alive`，重启后插件手里没有按键。现在新进程接管、旧进程自杀，并且宿主没推 alive 时用上次的布局快照自救。

5. **歌词渲染热路径里绝对不能有网络等待**。
   原因：曾经在每帧里 `await` 封面下载（封面失败时每帧重下），30fps 直接掉到 **1fps**，表现就是"歌词和音乐完全不同步"。现在封面只在 1 秒的状态循环里后台预热，热路径零网络。

6. **封面解析要有候选链**：`y.qq.com / y.gtimg.cn × 300/500 × 普通/_2 后缀`，全失败再用 `songmid` 反查该曲的正式专辑 mid。
   原因：QQ 搜索里同一首歌有大量翻唱/DJ/纯音乐版本，**这些条目没有专辑信息**（albummid 为空），一旦匹配到就没有封面。现在打分还会**优先选择带专辑信息的版本**（+0.04），顺带也让歌词匹配更准。

7. **歌词载荷不一定是密文**：QQ 有时返回明文（"此歌曲为没有填词的纯音乐，请您欣赏"、制作名单）。必须判断再解密，否则会报错并显示"未找到歌词"。

8. **中文提示必须画成图片**（`src/render/text-renderer.js`）。
   原因：FlexDesigner 自带的文字渲染字体**不含中日韩字形**，中文会变成方框（实测只显示出了 "QQ"）。歌词、提示语、状态键现在全部走插件的画布渲染。

9. **多状态按键（播放/暂停）的 `multiStyle` 只保留图标**。
   原因：FlexDesigner 的合成规则是"状态自己的样式优先；另外状态 0 会被基础样式强制覆盖"。如果我们在 `multiStyle[1]` 里写死 `bgColor`，用户在按键上设置的背景色在"播放态"就会被盖成黑色。现在两个状态只差图标，颜色全部跟随用户自定义。

10. **按下播放/暂停后有一个"以用户为准"的窗口**（`pendingPlayback`）。
    原因：QQ 音乐/系统媒体会话需要 ~0.6s 才反映新状态，如果按下后立刻回读并同步，会先显示旧状态 → 图标来回跳。现在按下即更新，之后每 200ms 确认，确认到就结束窗口；若两次读到播放器仍坚持旧状态则放弃乐观值（避免媒体键没送到时图标骗人）。

11. **停止播放要清空歌词状态**（保留查询缓存）。
    原因：早期只在"切歌"时重置歌词，停止播放后歌词键会一直画上一首；另外"桥接短暂缺口"的保持窗口从 10s 收紧到 2.5s。

---

## 6. 常用命令（在源码目录执行）

```bash
npm install                 # 安装依赖（rollup、SDK、@napi-rs/canvas、qrc-decoder）
npm run build               # 构建到 com.flexbar.qqmusicnow.plugin/backend/plugin.cjs
npm run plugin:validate     # 用 flexcli 校验 manifest（需要全局 flexcli）
npm run plugin:pack         # 打包（会自动把渲染依赖塞进插件目录）
npm run preview             # 不用设备，把按键画面渲染成 preview/*.png
npm run doctor              # 环境体检（canvas / 字体 / QQ 接口 / 检测链路）

node tools/make-platform-packages.js   # 生成平台专用包（mac arm64 / mac x64 / win x64 / generic）
node tools/make-store-assets.js        # 生成商店展示图 3000x152（FLEXGATE 用）
```

安装 / 调试（需要 `npm install -g @eniac/flexcli`；注意 flexcli 1.0.7 在 Node 24 上因旧式 JSON import 语法会报错，
需要 Node 20/22，或把 `assert { type: 'json' }` 改成 `with { type: 'json' }`）：

```bash
flexcli plugin link --path com.flexbar.qqmusicnow.plugin --uuid com.flexbar.qqmusicnow
flexcli plugin restart --uuid=com.flexbar.qqmusicnow
flexcli plugin list
```

Mac 上导入：FlexDesigner 右侧插件面板 →「从文件导入」→ 选 `packages/` 里对应芯片的 `.flexplugin`。
（FlexDesigner 也认平台命名：`<名字>.macos.arm64.flexplugin` / `.macos.x64.flexplugin`）

---

## 7. Windows 上已实测的数据（作为对照基线）

- 曲目识别：`[NowPlaying] "歌名 - 歌手" via Windows 媒体会话 playing=true`
- 歌词匹配：搜索 15 个候选，命中分 0.93~1.00，QRC 逐字歌词 30~95 行/首
- 封面：`[Cover] "歌名" album <mid> -> https://y.qq.com/... (300x300)`；混合歌单实测 **封面 18/18、歌词 18/18**
- 渲染：歌词键 **20~30 fps**、绘制确认往返 **5~8ms**、0 失败、0 丢帧
- 切歌：识别 ≤1s（SMTC 采样 1s），歌词就位 ~0.4s
- 停止播放：歌词键与正在播放键 → 「QQ 音乐未在播放」（识图核对过成图中文字，无方框）
- 播放/暂停按键：按下即变图标，播放器确认耗时实测 **600ms**，无回跳

---

## 8. 尚未验证 / 已知限制

- **macOS 的三条检测链路全部未在真机验证**（nowplaying-cli / MediaRemote / 窗口标题）
- macOS 的**媒体键**未验证（私有 MediaRemote 命令）；不行就用 `customCommands` 配置自定义命令
- macOS 上 QQ 音乐是否注册系统媒体会话未知 → 不注册时退到窗口标题（位置为推算）或手动模式
- 窗口标题模式没有真实进度，暂停/拖动后会漂移；建议优先 nowplaying-cli
- FlexGate 上传（发布到商店）需要：① 登录 FlexGate ② 一个公开的 **GitHub 仓库**（上传第一步就是填仓库地址并 Verify，元数据从仓库读取）。本包已带 `.github/workflows/release.yml`：打 `v*` tag 会自动 build + pack 并把 `.flexplugin` 挂到 Release

---

## 9. 建议发给 Mac 端 AI 助手（DeepSeek）的提示词

```
我在做一个 Flexbar 插件（QQ 音乐的歌词/正在播放/播放控制），它在 Windows 上已经跑通，
现在要让它在我这台 Mac 上正常工作。我会先给你一份纯文本资料：
- 1-文档-先看这个.md：项目现状、架构、已知坑、macOS 待验证清单、常用命令
- 2-源码合集.md：全部源码（每个文件用 ===== 文件: 路径 ===== 分隔）

请先读 HANDOVER.md 和源码里的 src/nowplaying/*（尤其是 macos-media.js、windows-smtc.js、window-title.js）
与 src/render/*，然后：
1) 告诉我在这台 Mac 上按什么顺序验证（我会把 npm run doctor 和插件日志的输出贴给你）
2) 根据我的实际输出，定位 macOS 播放检测/媒体键/渲染哪一环不工作，并给出最小改动的修复
3) 需要改代码时，直接给出 diff 或改完的文件内容，并告诉我怎么重新构建和重新导入插件

注意：不要在 Windows 已修好的行为上回退（见 HANDOVER 第 5 节"不要改回去"）。
```

---

## 10. 2026-09-27 更新：安装方式与 `plugin.alive` 的真相（Windows 实测）

这一节解释"插件明明装好了，设备上却没画面 / 重启后插件从列表里消失"。

**FlexDesigner 的两种注册方式（实测，端口每次启动都会变，用网卡监听端口 + 进程 pid 找）：**

| 方式 | 命令 | 重启后是否还在 |
| --- | --- | --- |
| 链接（开发用） | `plugin link --path <插件目录> --uuid com.flexbar.qqmusicnow` | **不持久**。实测 00:02 link 成功 → 00:04:48 重启 FlexDesigner → `plugin list` 里已经没有这个插件了 |
| 正式安装 | `plugin install --path <x.flexplugin> --force` | **持久**。00:07 安装 → 00:09:07 重启后 FlexDesigner 自动拉起插件并推 `plugin.alive`，5 个按键全部恢复，稳定 25 fps |

**`plugin.alive` 什么时候才来（关键）：**

- 只有 **FlexDesigner 启动时**、或**布局发生变化**时才推 `plugin.alive`（里面带这台设备的完整按键列表）。
- `link` / `install` 成功后 FlexDesigner 会立刻重启插件进程，但**不会**补推 `plugin.alive`；日志表现为
  `[warn] [Plugin] no plugin.alive and no layout snapshot`，随后 `keys=none`、设备保持旧画面或空白。
- `plugin restart` 不推；对着 FlexDesigner 的 WS 端口重发 `startup` 也没有任何回应（已实测）。
- 结论：**注册完必须重启一次 FlexDesigner**，否则插件手里没有按键列表。

**另一个坑：安装失败会连带把注册删掉。**

`install --force` 若报
`EPERM: operation not permitted, rename '...\data\temp\plugin' -> '...\data\plugins\com.flexbar.qqmusicnow'`
（旧插件目录/旧插件进程占用文件），这次失败会把这个插件从注册表里抹掉，`plugin kill` 也救不回来，
只能重新 `link` 一次。踩到这个坑时：先 `plugin kill --uuid`、再 `Stop-Process` 掉残留的插件进程，然后重新 link/install。

**为此插件端新增自愈逻辑（`src/plugin.js`）：**

1. 启动 3 秒内没收到 `plugin.alive` → 尝试用 `runtime.json` 里的布局快照自恢复（原有逻辑，快照只在收到过一次 alive 后才会写）。
2. **新增**：`plugin.data`（按键事件）回来时，如果这个 key 还没登记就顺手登记；如果此前一个 key 都没有，
   直接按"新布局"处理并触发一次 `tick()` —— `learnKeyFromInteraction()`。

效果：插件重启后只要**按一下任意一个 QQ 音乐按键**，画面立刻恢复（实测 189 帧 / 7.8 fps），不必重启 FlexDesigner；
按到哪个键，哪个键就加入绘制。

**推荐的安装流程（Windows，实测可用）：**

1. `plugin install --path <包>.flexplugin --force`（持久）或 `plugin link ...`（临时调试）；
2. **完全退出 FlexDesigner 再重新打开**（托盘右键退出，不是关窗口）；
3. 插件日志出现 `[Plugin] device <serial> loaded N key(s): ...` 就是成功了，之后会写布局快照，以后重启能自恢复。

**Windows 调试日志**：插件会把日志镜像到 `%TEMP%\qqmusicnow\plugin.log`（因为
`%APPDATA%\FlexDesigner\**` 对沙箱/命令行读取是拒绝访问的，这个镜像是唯一能直接看的日志）。
排查布局问题的关键行：`no plugin.alive ...`、`learned key ... from interaction`、`Draw ... keys=... fps=...`。

---

## 11. 2026-09-27 更新：歌词版本混淆与"更新后丢布局"

### 11.1 症状：某一首歌"歌词比声音快"（实例：《放 - 我是土豆》）

日志证据：

```
[NowPlaying] "放 - 我是土豆" via Windows 媒体会话 playing=true
[Lyric] ready in 0ms (qrc, 放 (加速版))          <- 命中缓存，但缓存的是加速版
[Cover] "放 (加速版)" album 0040yqnF1bnIFq -> ...
[Draw] ... state=ready/qrc/45 ...               <- 加速版 45 行；原版是 50 行
```

原因有两层：

1. `src/lyrics/service.js` 的 `normalizeText()` 会把括号内容整段删掉，于是 `放` 和
   `放 (加速版)`、`放 (DJ版)` 归一化成同一个字符串，标题相似度都是 1.0 —— 靠标题根本分不出哪个才是正在播的版本；
2. 缓存键用的是同一个归一化结果（`放|我是土豆`），所以**一旦加速版进了缓存，之后播原版也会一直拿加速版的歌词**，
   而加速版的时间轴是把整首歌压快的，表现就是"歌词一路跑在声音前面"。

### 11.2 修复（改的都是共享文件，macOS 逻辑未动）

| 改动 | 作用 |
| --- | --- |
| 新增 `versionScore(playerTitle, candidateTitle)` | 候选版本带版本词（加速/降速/慢速/DJ/remix/伴奏/现场/live/翻唱/女声…）而正在播的没有 → 该候选直接 0 分 |
| `scoreCandidate()` 权重调整 | `0.50 标题 + 0.28 歌手 + 0.14 时长 + 0.08 版本 + 0.04 专辑加成`（时长权重提高，加速版与原版通常差 20~30s，会被明显压下去） |
| `cacheKey()` 改用 `versionAwareKey()` | 保留括号里的版本文字，`放` 与 `放 (加速版)` 不再共用缓存 |
| `CACHE_KEY_PREFIX = 'v2|'` | 旧缓存（可能存着错版本）直接失效；读写缓存时都会过滤掉旧前缀的条目 |
| `isVersionMismatch()` | 万一缓存里仍是"另一个版本"的答案，丢一次并重新解析（同一个 key 只重试一次，避免反复打接口） |

实测（真实 QQ 音乐接口）：

```
放             score=1.000 title=1.00 artist=1.00 duration=1.00 version=1.00
放 (加速版)     score=0.820 title=1.00 artist=1.00 duration=0.00 version=0.00
放 (DJ版)      score=0.820 title=1.00 artist=1.00 duration=0.00 version=0.00
新鲜查询        -> 匹配 "放" [我是土豆] 50 lines
投毒的缓存      -> 日志 "[Lyrics] cached match "放 (加速版)" is a different version of "放" - resolving again" -> 重新匹配到 "放" 50 lines
```

回归脚本：`work/test-lyric-version.js`（打分 + 缓存键 + 投毒缓存三组断言）。

### 11.3 症状：每次更新插件后，设备空白直到重启 FlexDesigner

装更新 = 替换插件目录，目录里的 `runtime.json`（布局快照）一起没了；而 FlexDesigner 只在启动/布局变化时
推 `plugin.alive`，因此新装的插件手里一个按键都没有。

修复（`src/state.js`）：布局快照额外镜像一份到插件目录之外 ——
Windows `<LOCALAPPDATA>\QQMusicNow\layout.json`、macOS `~/Library/Application Support/QQMusicNow/layout.json`、
其它平台 `$XDG_CONFIG_HOME/QQMusicNow/layout.json`，可用环境变量 `QQMUSICNOW_STATE_DIR` 覆盖（E2E 脚本用它做隔离）。
写入时按 `serialNumber` 合并（最多保留 4 台设备），所以旧设备/测试数据不会覆盖当前设备的布局。

效果：以后装更新，插件启动就能用镜像里的布局恢复画面，**不需要再重启 FlexDesigner**。

### 11.4 每次改完代码的固定收尾（用户要求）

1. 重新构建：`node node_modules/rollup/dist/bin/rollup -c`
2. 重新出包：`node tools/make-platform-packages.js --flexcli "<flexcli 路径>"`
3. 重新生成一体包 `outputs/qqmusicnow-all-<日期>.zip`（安装包 + 源码 + 文档 + 文本版）
4. 拷贝到桌面 `C:\Users\Administrator\Desktop\`
5. Windows 这台机器顺手 `plugin install --path <新包> --force` 装上（装前先 `plugin kill`）
6. 校验 macOS 专属文件哈希未变（只剩共享的 `backend/plugin.cjs` 应该不同）

### 11.5 症状：切歌后封面和歌词变成上一首的（实例：《有一天 - 张震岳》）

日志证据（时间顺序）：

```
14:25:27.682  [NowPlaying] "C-c - 羊炯秋"            <- 慢歌开始查歌词
14:25:35.313  [NowPlaying] "有一天 - 张震岳"          <- 用户切歌
14:25:35.899  [Lyrics] QRC matched "有一天" ... (39 lines)   <- 新歌正确显示
14:25:37.173  [Lyrics] QRC unavailable for 347051782: This operation was aborted
14:25:37.242  [Lyrics] LRC matched "C-c" ... (34 lines)      <- 9 秒前的旧请求回来了
14:25:37.533  [Cover] "C-c" album 004TEPu02NyEob            <- 封面也被旧歌覆盖
14:25:46      [Draw] ... state=ready/lrc/34                   <- 屏幕上已经是 C-c 的歌词
```

根因是**竞态**，不是识别错误：`LyricsService.resolve()` 在 await 之后无条件写 `this.state`，
而 QRC 超时 + LRC 兜底可以让一次查询耗时 9 秒。用户在等待期间切歌，新歌先正确显示，
随后旧歌的结果落地，把 `state`（`match` + `lines`）覆盖成旧歌，渲染层用的正是 `getState().match`，
于是封面和歌词一起变成了上一首。`loadLyricsFor()` 里的 `lyricRequestId` 只挡住了它自己后面的代码，
挡不住 service 内部的覆盖。

修复：

| 改动 | 作用 |
| --- | --- |
| `LyricsService.resolve()` 增加 `requestSeq` 序号 | 只有"最新一次 resolve"才允许写 `state`；过期答案照常 `writeCache()`（回到那首歌仍是 0ms），但不再上屏，日志记 `dropped stale answer for "..."` |
| 错误分支同样判断序号 | 旧查询失败也不会把新歌标成 error |
| `plugin.js` 的 `onMatch` 钩子加 `matchBelongsToTrack()` | 只给"当前正在播的那首"预热封面，避免旧歌的封面请求把当前封面顶掉 |

回归脚本：`work/test-stale-lookup.js`（1.5s 的旧查询 + 100ms 的新查询，断言最终屏幕上是新歌，
并且旧答案仍留在缓存里）。

### 11.6 症状：歌词对、封面却是别的图（实例：《失重前幸福 - 艾薇 Ivy》）

同一首歌常同时存在于单曲 / 专辑 / 合辑等多个发行版：标题、歌手、时长完全一致，**封面不同**。
仅靠标题+歌手+时长无法区分，搜索结果里排第一的那张不一定就是播放器正在播的那张。

修复（共享文件，未动 macOS 逻辑）：

| 改动 | 作用 |
| --- | --- |
| `service.js` 新增 `albumScore()` | 把**媒体会话报告的专辑名**（`windows-smtc.js` 里的 `albumTitle` → `snapshot.album`）纳入候选打分，权重 0.08；专辑一致 1 分、包含 0.9、明确不同 0 分、任一侧未知 0.5（中立） |
| `scoreCandidate()` 权重重排 | `0.46 标题 + 0.26 歌手 + 0.13 时长 + 0.07 版本 + 0.08 专辑 + 0.04 专辑图加成` |
| `resolve()` 把 `track.album` 带进 player | 之前 album 字段被丢掉了，打分根本看不到 |
| 日志 | `[SMTC] sessions: ... (album "...")`、`[Lyrics] ... [album "A" -> "B"]`、`[Cover] ... album <mid> "<name>"`，一眼能看出播放器报的专辑和匹配到的专辑是否一致 |

注意：`helper/windows/smtc.ps1` 里读媒体会话自带缩略图（`Thumbnail` → `OpenReadAsync`）在当前这台机器上
仍然失败（`无法将 System.__ComObject 转换为 Windows.Storage.Streams.IInputStream`），所以封面一律走
专辑图兜底。**如果能修好这条路**，插件就能直接显示播放器自己那张图，从根上避免版本差异——修的时候
记得保留 `no media-session artwork (...)` 这行日志作为回退证据。

回归脚本：`work/test-album-match.js`；封面候选接口探测脚本：`work/probe-cover.js <albumMid>`。

### 11.7 专辑名补搜：同歌不同发行版的终极修法（实例仍是《失重前幸福》）

实测日志两条对照：

```
[SMTC] QQMusic.exe "失重前幸福" (album "I")                                  <- 播放器报的专辑是《I》
[Lyrics] matched "失重前幸福" [艾薇 Ivy] score=0.83 ... [album "I" -> "失重前幸福"]  <- 我们匹配到单曲版
```

QQ 音乐里这首歌有两个版本：单曲《失重前幸福》（album mid `000XTQ0N3cOm5v`，222s）和专辑《I》
（album mid `002PYpS70OpE91`，220s），封面不同。**只用 "歌名 + 歌手" 搜，永远只能拿到单曲版**；
把专辑名加进搜索词后，专辑版立刻排第一：

```
"失重前幸福 艾薇 Ivy"   -> 失重前幸福 [艾薇 Ivy] 222s album="失重前幸福" mid=000XTQ0N3cOm5v
"失重前幸福 艾薇 Ivy I" -> 失重前幸福 [艾薇 Ivy] 220s album="I"          mid=002PYpS70OpE91
```

实现（`service.js` 的 `lookup()`）：

1. 查询列表变成 `[歌名 歌手]` → （有专辑名时）`[歌名 歌手 专辑名]` → `[歌名]`，相同查询会去重；
2. 提前结束条件从"分数 ≥ 0.8 就停"改成"分数 ≥ 0.8 **且专辑已对上**（`scoring.album >= 0.9`）才停"，
   这样播放器报了专辑、而首选候选不是那张专辑时会自动多打一次补搜；
3. 没有专辑信息（例如 macOS 端某些链路）时行为不变。

实测：`album "I"` → 匹配到 album `I` / mid `002PYpS70OpE91`，score 1.00；`album ""` → 仍是单曲版 0.97。

**注意 QQ 搜索接口会限流**：短时间连续打太多次会只返回 1~2 个候选（甚至 0 个），
过十几秒恢复正常。插件本身对此有瞬态重试与缓存，测试脚本里若看到候选数异常先等一会儿再跑。

回归脚本：`work/test-album-query.js`（联网，断言专辑版被选中且封面 mid 正确）。

### 11.8 症状：FlexDesigner 重启后封面/歌词不再刷新（"像没连上设备"）

这是**插件自己的 bug**，2026-09-28 定位并修复。日志链路：

```
18:42:24  [Plugin] QQMusicNow starting on win32          <- FlexDesigner 被重启，插件随之启动
18:42:27  [Plugin] restored 5 key(s) from the layout snapshot   <- 宿主没推 plugin.alive，插件用快照自恢复
18:42:27  [Draw] ... (uid 352) rejected: Plugin key is not alive      <- 宿主这时还没激活这些键
18:42:31  [Draw] ... (uid 352) disabled after 5 rejections            <- 被当成坏键，永久禁用
18:42:46  [Draw] ... (uid 353) disabled after 5 rejections
18:43:24  [Draw][pid] 0.0 fps ... keys=2010:nowplaying+lyric+... | state=ready/qrc/49   <- 有键有歌词，但不再画
```

链条：① FlexDesigner **只在启动时 / 布局变化时**推 `plugin.alive`（重启 App 不推，见第 10 节）；
② 插件用布局快照自恢复并立刻开始绘制；③ 宿主此时尚未激活这些键 → 返回
`Request failed: Plugin key is not alive`；④ `safeDraw()` 把这当成"坏键"，累计 5 次后
`if (pipe.failures >= 5) return;` **永久丢弃该键**；⑤ 之后没有 `plugin.alive` → `drawPipes.clear()`
 never 触发 → 封面与歌词键一直不刷新，设备停在最后一帧，看起来"像没连上"。

修复（`src/plugin.js` 的 `safeDraw()`）：

- `not alive` 单独判定，**不计入** `failures`，因此永远不会触发"禁用"；
- 记 `pipe.notAliveUntil = now + 2000ms`，2 秒后再试（不刷屏、不放弃），日志 `not activated by the host yet - retrying every 2s`；
- 其它错误（键真的没了/uid 变了）仍按原逻辑 5 次后禁用。

回归脚本：`work/test-notalive-recover.js` —— 模拟"宿主不推 alive + 前 9 秒全部拒绝绘制"，
断言拒绝阶段之后绘制自动恢复。实测 `rejected=5 accepted=158`：键没有被禁用。

顺带说明：设备上"某一页没有 QQ 音乐按键"时，宿主会推 `loaded 0 key(s)`，插件停画是**正确**行为，
不是掉线（那种情况看日志会一直是 `loaded 0 key(s)`，切回那一页立刻恢复）。
