# macOS 部署说明（Windows 不受影响）

> 这份文档记录 2026-09-26 在一台 Apple Silicon（macOS 15.7.2）真机上把插件跑通的全过程，
> 包括两个**不看源码根本看不出来**的坑。Windows 侧的逻辑完全没有改动，见文末。

## 1. 一句话结论

macOS 上"播放检测"和"媒体键"**必须有 `nowplaying-cli` 及其配套文件**，
没有它时插件只会显示「QQ 音乐未在播放」，窗口标题兜底在 macOS 上也无用
（QQ 音乐窗口标题实测为空字符串）。

## 2. 安装辅助程序（不需要 Homebrew、不需要 sudo、不需要 Xcode）

```sh
sh tools/install-macos-helper.sh          # 装到 ~/bin
sh tools/install-macos-helper.sh /some/dir
```

脚本会从 Homebrew 官方 bottle 里取出**三个**文件并校验 sha256：

| 文件 | 作用 |
| --- | --- |
| `nowplaying-cli` | 读播放状态 / 发送媒体键 |
| `lib/nowplaying-cli/MediaRemoteMini.dylib` | 真正加载 MediaRemote 的适配器 |
| `share/nowplaying-cli/scripts/mediaremote-mini.pl` | 借 `/usr/bin/perl` 的权限加载上面的 dylib |

装完后插件会自动在 `~/bin/nowplaying-cli` 找到它（候选顺序见
`src/nowplaying/macos-media.js`：`/opt/homebrew/bin` → `/usr/local/bin` →
`/opt/local/bin` → `~/bin` → `~/.local/bin` → `PATH`）。

## 3. 两个必须知道的坑

### 坑 1：GitHub release 的裸二进制**不能**直接用

release 只提供一个 59 KB 的二进制；Homebrew 版本会同时安装上面那两个配套文件。
缺配套文件时，`nowplaying-cli get-raw` **不报错**，只会返回一个空字典 `{ }`，
看起来就像"系统没有播放会话"。CLI 会在自己所在目录及父目录下按固定布局查找：

```
<exeDir>/share/nowplaying-cli/scripts/mediaremote-mini.pl
<exeDir>/lib/nowplaying-cli/MediaRemoteMini.dylib
```

（详见 `ResolveHelperPaths()` in `src/nowplaying.mm`）

### 坑 2：**不要用 `cp` 覆盖正在被插件执行的二进制**

覆盖运行中的文件后，macOS 的代码签名校验会一直判该 inode 无效，
进程被 `SIGKILL (Code Signature Invalid)` 秒杀，崩溃报告里写的是
`main_executable_path_missing`。现象是：文件哈希正确、`codesign --verify` 也通过，
但插件每次执行它都在 1~2 ms 内"退出"（日志里是 `exit null`）。

**正确做法**：写到临时文件再 `mv` 覆盖（新 inode）。`tools/install-macos-helper.sh`
就是这么做的 —— 这也是它在脚本注释里特别强调的原因。

### 顺带：JXA 兜底在 macOS 15+ 上是死的

`helper/macos/nowplaying.jxa` 调 `$.dispatch_get_main_queue()` 会得到
`is not a function`（JXA 没有 libdispatch 桥）。即使换成
`NSOperationQueue.mainQueue.underlyingQueue` 能拿到队列，也**读不到数据** ——
因为 `MediaRemote.framework` 在现代 macOS 上只是个存根，真正的实现只在
dyld 共享缓存里，脚本进程拿不到符号。所以这条兜底只对老系统有意义，
macOS 15+ 请一律使用 `nowplaying-cli`。

## 3.5 QQ 音乐（macOS）的三个怪癖

这三条是 2026-09-26 真机逐条验证出来的，处理逻辑都在
`src/nowplaying/macos-media.js` 与 `src/media-keys.js` 里：

| 现象 | 实测数据 | 处理方式 |
| --- | --- | --- |
| **不上报播放位置** | `elapsedTime` 恒为 0（或一个很久不更新的旧值），真正的定位信息在 `timestamp`（该值被记录的时刻） | 位置 = `elapsedTime + (now − timestamp) × playbackRate`，并按 duration 截断 |
| **暂停后 `playbackRate` 仍是 1** | 暂停时 `playing=false` 但 `playbackRate=1` | 以布尔字段 `playing` 为准；暂停期间位置冻结（不再外推），恢复播放自动跳回真实位置 |
| **无视系统的播放/暂停切换命令** | `MRMediaRemoteCommandTogglePlayPause` 发出后播放器无反应，而 `NextTrack`/`PreviousTrack` 正常 | 按键改为发送**显式** `play` 或 `pause`；开关基准取"用户上一次的意图"，连按一定交替，不会卡在同一个命令 |

`nowplaying-cli get` 看不到 `timestamp`（CLI 只映射了字段子集），所以插件直接用
Homebrew bottle 里的 perl 适配器读原始 JSON：

```
/usr/bin/perl <prefix>/share/nowplaying-cli/scripts/mediaremote-mini.pl \
              <prefix>/lib/nowplaying-cli/MediaRemoteMini.dylib
```

附带信息：适配器返回里还有 `bundleIdentifier`（`com.tencent.QQMusicMac`），插件用它
做应用过滤，避免播放别的播放器时被误匹配成 QQ 音乐的歌词。

**已知限制**：如果插件是在"已经暂停"的状态下启动的，QQ 音乐既不报位置也没有可用的
时间戳，此时位置只能显示 0；一恢复播放就会立刻纠正。

## 4. 验证清单

### 歌词"不跳转"的排查顺序（2026-09-26 案例）

如果某首歌的歌词停在第一行不动，多半不是时间轴问题，而是**歌词内容本身有问题**。
按日志判断：

| 日志 | 含义 | 处理 |
| --- | --- | --- |
| `[Lyrics] QRC matched "…" (2 lines)` | QQ 给这首歌的逐字歌词是**占位/片段** | 已自动退回逐行歌词（LRC）：`QRC for "…" has only N usable line(s) - checking LRC` |
| `ready in … (lrc)` + 行数正常 | 用的是逐行歌词，滚动正常但没有逐字高亮 | 正常降级 |
| 位置不推进（`pos` 不变） | 播放器没在播放 | 见第 3.5 节 |

实测：`三人游`（录音室版）QRC 只有 2 行占位、LRC 有 46 行；`特别的人` QRC 10 行、LRC 65 行。
现在的规则是：逐字歌词行数明显低于"每 20 秒一行"的经验值时，取逐行歌词对比，
**只在逐行歌词更完整时才替换**，绝不把完整的逐字歌词换成更少的逐行歌词。
缓存里遗留的占位歌词会在启动时自动丢弃（重新查询一次）。

```sh
# 1. 辅助程序自身
~/bin/nowplaying-cli get-raw      # 播放时应输出完整字典（含 ArtworkData）
~/bin/nowplaying-cli get title artist album duration elapsedTime playbackRate
~/bin/nowplaying-cli togglePlayPause   # 媒体键

# 2. 环境体检
npm run doctor

# 3. 插件日志
tail -f "$HOME/Library/Application Support/FlexDesigner/data/plugins/com.flexbar.qqmusicnow/logs/$(date +%F).log"
```

正常工作时日志应出现：

```
[NowPlaying] using /Users/<you>/bin/nowplaying-cli
[NowPlaying] "歌名 - 歌手" via macOS 媒体中心 playing=true
[Cover] "歌名" album <mid> -> https://y.qq.com/... (300x300)
[Draw] 29.2 fps, 0 skipped, 0 failed, rtt avg=6ms | lyric timer=on state=ready/qrc/18 playing=yes
```

## 5. 相关配置

`config.json`（与 `manifest.json` 同级）：

| 键 | 说明 |
| --- | --- |
| `nowplayingPath` | 手动指定 `nowplaying-cli` 绝对路径（装在非常规位置时用） |
| `provider` | `auto` / `macos` / `window` / `manual`（Windows 上还有 `smtc`） |
| `debug` | `true` 时，检测不到曲目会把 `get-raw` 原始输出打进日志（每 15 s 最多一条） |
| `pollIntervalMs` | 检测轮询间隔，默认 1000 ms |
| `offsetMs` | 歌词时间轴偏移 |

## 6. Windows 侧

- 改动集中在 macOS 侧：`src/nowplaying/macos-media.js`、`src/media-keys.js`
  （仅 `darwin` 分支）、`helper/macos/*`、`tools/doctor.js`。
- `src/plugin.js` 有一处**平台中立**的改动：播放/暂停键的开关基准改为"用户上一次的
  意图"（`desiredPlaying`），并在调用媒体键时附带目标状态提示。Windows 忽略该提示，
  仍然是发送系统的播放/暂停切换键，只是连按时不会再因为状态回读滞后而丢掉操作。
- `src/nowplaying/windows-smtc.js`、`helper/windows/*.ps1` 与 `media-keys.js`
  的 Windows 分支**一行未动**，SMTC 仍然是 Windows 上唯一的自动来源。
- 打包脚本会为四个平台分别产出安装包，Windows 包内仍包含
  `helper/windows/{smtc.ps1,media-key.ps1}` 与 `skia.win32-x64-msvc.node`。

```sh
node tools/make-platform-packages.js   # macos.arm64 / macos.x64 / windows.x64 / generic
```

## 7. 切歌延迟是怎么压下来的（2026-09-26 实测）

### 上传到 Flexbar 时进度卡住怎么办（2026-09-26 事故复盘）

FlexDesigner 日志里出现过：

```
[warn][USB] -> Too many tasks in the queue: 101      ← USB 任务队列打满
[info][USB] -> Removing device: ... BCE244BA2010     ← 设备随后掉线
```

原因：**设备链路同时被三股流量占用** —— ① 上传本身的大数据量、② FlexDesigner 自带的
「音频频谱」持续绘制、③ 本插件歌词键 ~30fps 的逐帧推送。队列超过上限后上传就卡死，
进而拖垮串口连接。

插件侧的应对（已实现）：

- 退避依据从"**平均**往返延迟"改为"**最近最差**往返延迟"——拥塞时平均值仍然是 6ms，
  只有单帧尖峰能反映出来；
- 单帧往返 > 120ms 或绘制被拒时，进入 **2.5 秒冷却**：歌词键暂停推帧（保留最后一帧），
  把链路让给上传；冷却结束后自动恢复，若仍在拥塞会再次冷却；
- 新增配置 `lyricFps`（默认 30，可设 5~30）：觉得链路吃力时调低即可，例如
  `{"lyricFps": 15}`。

遇到卡住时的人工处置：等队列排空（通常十几秒），或在 FlexDesigner 里暂时关掉「音频频谱」，
实在不行拔插一次设备（插回后插件会自动恢复绘制，无需重启插件）。

切歌时的等待由三段组成，逐段处理：

| 环节 | 优化前 | 优化后 | 做法 |
| --- | --- | --- | --- |
| 封面 | 等 QQ 搜索拿到专辑 mid 再下载图片（实测 4.2s） | **识别即上屏**（解码 1~20ms） | 直接用媒体会话里携带的 base64 封面（`artworkData`），不再走网络 |
| 歌词 | 搜索 375ms + 取词 322ms，且要**排在封面下载之后** | 搜索 375ms + 取词 136ms（并发） | 主色/封面预热改为后台任务，歌词不再排队；提前与歌词域名握手 |
| 识别（媒体会话） | 按下一首后 ~1.0~1.3s 才更新 | 歌词已提前就绪 | QQ 音乐界面更新比媒体会话快得多，按键后立刻用 Accessibility 读界面歌名（~190ms），提前把歌词查好放进缓存 |

配套的小优化：

- **请求合并**：界面预取与正式切歌常常在几百毫秒内请求同一首歌，
  现在共用同一个在途 Promise，只发一次请求，先完成的那个结果直接命中；
- **磁盘歌词缓存**（`<插件目录>/cache/lyrics.json`）：重播、回跳、插件重启后
  同一首歌的歌词是 **0ms** 命中；
- **连接保活**：播放期间每 15s 给 QQ 接口域名发一次 HEAD，避免切歌时重做 TLS 握手；
- **跳过检测**：按下一首/上一首后以 250ms 粒度盯变化，不再被上一轮轮询挡住；
- 诊断日志：`[Lyric] ready in <ms>`、`[Lyrics] timing: search=… lyric=…`、
  `[Cover] media-session artwork <尺寸> ready in <ms>`、`[Lyrics] prefetch triggered …`。

Accessibility 读取需要一次「辅助功能」授权（本机已授权）；未授权时会自动退回到
原来的轮询路径，功能不受影响，只是少这条快车道。
