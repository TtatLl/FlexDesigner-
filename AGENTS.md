# AGENTS.md — QQMusicNow（Flexbar 插件）

> 在本目录工作的 Codex：**先读本文件**，再读 `HANDOVER.md`（架构 + macOS 待验证清单）与 `CONVERSATION.md`（历史对话整理，含每次定位的日志证据）。

## 任务

把这个 Flexbar 插件（QQ 音乐的歌词 / 正在播放 / 播放控制）在 **macOS** 上跑通。
它在 **Windows 上已完整验证通过**，Windows 上修好的行为**一律不要回退**——原因逐条写在 `HANDOVER.md` 第 5 节（11 条），改任何相关代码前请先读那一节。

## 目录结构

```
src/                       源码（Node，CommonJS，用 @eniac/flexdesigner SDK）
com.flexbar.qqmusicnow.plugin/   FlexDesigner 实际加载的插件目录
   ├─ manifest.json        按键定义 + 中英文文案
   ├─ ui/*.vue             设置页与各按键设置面板
   ├─ helper/macos/*.jxa   MediaRemote 读写（macOS）
   ├─ helper/windows/*.ps1 SMTC 读取 / 媒体键（Windows）
   └─ backend/plugin.cjs   rollup 构建产物
tools/                     doctor（环境体检）/ prepare-pack / make-platform-packages / preview / make-store-assets
packages/                  已打好的 macOS 安装包（arm64 = Apple Silicon，x64 = Intel）
```

## 环境与常用命令

```bash
node -v                      # 需要 ≥ 20
npm install
npm run doctor               # 环境体检：canvas / 中文字体 / QQ 接口 / nowplaying-cli / MediaRemote
npm run build                # 构建到 com.flexbar.qqmusicnow.plugin/backend/plugin.cjs
npm run validate:manifest    # 本地校验（可选）
node tools/make-platform-packages.js   # 重新打平台包（需要 flexcli）
npm run preview              # 不用设备，把按键画面渲染成 preview/*.png
```

已知坑：`@eniac/flexcli` 1.0.7 用了旧式 `assert { type: 'json' }`，在 **Node 24** 上会报语法错误 →
改用 Node 20/22，或把该文件里的 `assert { type: 'json' }` 改成 `with { type: 'json' }`。

## macOS 验证顺序（每步都留证据）

1. `npm install && npm run doctor` → 保存完整输出（这是第一手环境证据）
2. 确认 `nowplaying-cli` 是否被识别；没有就 `brew install nowplaying-cli`（macOS 上最可靠的播放状态来源）
3. 在 FlexDesigner 里「从文件导入」`packages/` 中对应芯片的 `.flexplugin`，把 6 个按键拖到 Flexbar 上
4. 播放 QQ 音乐，观察**状态键**（应显示类似 `macOS · QRC`）
5. 插件日志位置：`~/Library/Application Support/FlexDesigner/*/com.flexbar.qqmusicnow.plugin/logs/YYYY-MM-DD.log`

## 不靠肉眼也能验收的数值断言

| 项目 | 期望 | 日志里的锚点 |
| --- | --- | --- |
| 检测链路 | 命中 macOS 链路并在状态键显示 | `[NowPlaying] "歌名 - 歌手" via macOS 媒体中心 ...`、`[NowPlaying] provider status: macos=ok(...)` |
| 歌词 | 切歌后 ~0.5s 就位 | `[Lyrics] QRC matched ... (N lines)` |
| 封面 | 每首都有 | `[Cover] "歌名" album <mid> -> <url>` |
| 绘制 | 20~30 fps、0 failed | `[Draw][pid ...] ... 0 failed` |
| 未播放 | 歌词键显示提示 | `[Lyric] status text: QQ 音乐未在播放` |

（Windows 基线的实测值见 `HANDOVER.md` 第 7 节。）

## 图片核对（可选）

Windows 侧用 `claude-vision-skill`（百炼视觉模型）核对渲染帧与商店图。
若本机没有该 skill / 没有 API Key，就以上面的数值断言为准，并把 `npm run preview` 生成的 PNG 交给人看。

## 不要做的事（最容易踩的几条）

- 不要给歌词渲染热路径加任何 `await` 网络调用（曾把 30fps 拖到 1fps，表现为"歌词与音乐完全不同步"）
- 不要把 Windows 自动模式改回"窗口标题优先"（QQ 音乐窗口标题会滞后，切歌时显示旧歌）
- 不要把 `plugin.alive` 改回"累加"按键集合（会向已删除的旧 uid 绘制 → 全部被拒绝）
- 不要在 `multiState` 里写死颜色（会盖掉用户的按键自定义；只保留图标）
- 不要把 `data.state`（单数）加回 manifest（用过、已撤销）
- 中文提示必须走 `src/render/text-renderer.js` 画成图片（宿主文字渲染没有中日韩字形，会变方框）

## 完成后请交回

改动说明（diff 或完整文件）+ 重新构建/重新导入的命令 + 是否重新打包（`node tools/make-platform-packages.js`）。
如果需要复现或进一步定位，请附上 `npm run doctor` 输出与对应时间段的插件日志片段。

## 每次改完代码必须做的收尾（用户明确要求的固定流程）

只要动了 `src/`、`com.flexbar.qqmusicnow.plugin/` 里的任何文件，**必须**按顺序走完，不能只改代码：

```bash
cd outputs/qqmusicnow-merged
node <runtime>/node_modules/rollup/dist/bin/rollup -c      # 1. 重新构建 backend/plugin.cjs
node tools/make-platform-packages.js --flexcli "<flexcli>"  # 2. 重新打 4 个平台包（含 generic）
```

3. 把 4 个新包、合并后的源码、文档重新装进一体包目录并压缩成
   `outputs/qqmusicnow-all-<日期>.zip`（结构见该压缩包内的 `说明-先读我.md`）。
4. 把这个 zip 复制到 `C:\Users\Administrator\Desktop\`（用户从桌面取包）。
5. 如果用户当前就在用 Windows 这台机器：顺手把新包 `plugin install --path ... --force` 装进
   FlexDesigner（装之前先 `plugin kill --uuid com.flexbar.qqmusicnow`，否则文件占用会报 EPERM，
   而且**失败的 install 会把插件从 FlexDesigner 注册表里删掉**）。

**回复里必须报数字（用户明确要求）**：每次打包更新完，都要在回复里给出
①一体包**文件大小**（MB，保留两位，例如 78.51 MB）②**比上一版增加了多少**
（字节数 + MB，例如 +3490 字节 / +0.00 MB，压缩包只加了几 KB 是正常的）③文件名带版本（第 N 版）
④SHA256 前 16 位；必要时附 4 个平台包各自的大小。用户用这些数字确认自己拿到的是不是新包。
出包时顺手把每个 zip 的字节数记下来（`work/tmp<N>-qqmusicnow-all-<日期>.zip` 都留着可对比）。

**并且每次都要把「近几版对比表」贴出来**（版本 / 内容 / 大小 / 与上一版的差值 / SHA256 前 16 位，
至少最近 5 行）。两张表要同时维护：

- `outputs/qqmusicnow-发布记录.md`：**含最新一版**的完整记录，每次出包后立刻补一行；
- 包内 `文档/发布记录.md`：截止到**上一版**的历史（zip 的大小要打包后才知道，写不进自己这一版）。

出包后**必须核对 macOS 专属文件没被动过**：解出两个 macos 包，与上一版逐文件比 SHA256，
期望只有 `backend/plugin.cjs`（共享后端）不同。命令参考 `work/` 下的对比脚本写法。

## 2026-09-27 新增的坑（Windows 实测）

- **歌词版本混淆**：`src/lyrics/service.js` 的 `normalizeText()` 会丢掉括号内容，导致
  `放` 与 `放 (加速版)` 归一化成同一个字符串，缓存键也相同 → 加速版歌词被缓存后一直显示错版本，
  表现为"歌词比声音快"。修复：`versionScore()` 给版本不一致的候选扣分、缓存键改用
  `versionAwareKey()` 保留版本文字、`CACHE_KEY_PREFIX = 'v2|'` 让旧缓存失效、读取缓存时发现版本不一致
  会重新解析一次。**不要**把括号过滤加回缓存键。
- **更新后布局丢失**：装更新会替换插件目录，`runtime.json`（布局快照）随之消失，而 FlexDesigner
  更新后不会补推 `plugin.alive` → 设备空白直到重启软件。修复：`src/state.js` 额外把布局写一份到
  `<LOCALAPPDATA>/QQMusicNow/layout.json`（macOS 为 `~/Library/Application Support/QQMusicNow/`，
  可用 `QQMUSICNOW_STATE_DIR` 覆盖），下次启动用它自恢复。E2E 脚本已用该环境变量隔离测试状态。
- **注册方式**：`plugin link` 重启 FlexDesigner 后会消失；`plugin install --path <x.flexplugin> --force`
  才会保留并在启动时自动拉起。安装/链接后必须重启一次 FlexDesigner 才会推 `plugin.alive`
  （详见 `文档/HANDOVER.md` 第 10 节）。
- **切歌竞态**：QRC 超时 + LRC 兜底可以让一次歌词查询耗时近 10 秒。用户在这期间切歌时，
  旧答案会覆盖新歌（封面 + 歌词一起变成上一首）。修复：`LyricsService.resolve()` 用
  `requestSeq` 只让最新一次调用写 `state`（过期答案仍然写缓存），`plugin.js` 的 `onMatch`
  用 `matchBelongsToTrack()` 只预热当前播放歌曲的封面。回归：`work/test-stale-lookup.js`。
  **不要**把 `resolve()` 里写 `state` 的序号判断去掉。
- **同歌不同发行版封面不对**：标题/歌手/时长完全一样但封面不同（单曲 vs 专辑，例如《失重前幸福》
  的单曲版与专辑《I》版）。修复：`service.js` 用媒体会话报告的专辑名打分（`albumScore()`），
  并且在"分数够高但专辑对不上"时追加一次 `歌名 歌手 专辑名` 的搜索（`lookup()` 的 `albumSettled()` 提前结束条件）。
  回归：`work/test-album-match.js`（离线打分）+ `work/test-album-query.js`（联网补搜）。
  QQ 搜索接口会限流，短时间连打会只剩 1~2 个候选，属正常现象。
