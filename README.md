# QQMusicNow · Flexbar 的 QQ 音乐歌词插件

把 QQ 音乐"正在播放"的内容搬到 Flexbar 上：专辑封面、歌名歌手、进度条，以及**逐字高亮的同步歌词**（含翻译与日文罗马音），并支持播放/暂停、上一首、下一首。

同时支持 **Windows** 和 **macOS**。

---

## 1. 它和 Spotify 版 LyricsNow 有什么不同

LyricsNow 面向 Spotify，可以直接问 Spotify 官方 Web API"现在在放什么"。QQ 音乐没有公开的播放状态接口，所以本项目多了一整层"播放检测"，并在歌词侧直接对接 QQ 音乐自己的歌词服务（QRC 逐字歌词）。

| 维度 | LyricsNow（Spotify） | QQMusicNow（本项目） |
| --- | --- | --- |
| 播放状态来源 | Spotify Web API | 系统媒体会话 / 媒体中心 / 窗口标题 / 手动（多级回退） |
| 授权 | Spotify OAuth（Client ID/Secret） | 不需要登录，不需要账号 |
| 歌词来源 | 第三方 + QQ 音乐歌词（跨源匹配） | QQ 音乐官方歌词接口（QRC 逐字 + 翻译 + 罗马音），LRC 兜底 |
| 播放控制 | Spotify API | 系统媒体键（QQ 音乐响应媒体键，无需窗口焦点） |
| 平台 | Windows / macOS | Windows / macOS |

---

## 2. 功能

**按键**

| 按键 | 宽度 | 说明 |
| --- | --- | --- |
| 正在播放 | 600 | 封面、歌名、歌手·专辑、进度条、时间；可开启封面主色背景 |
| 歌词 | 480 | 单行/双行、逐字高亮、翻译、罗马音；**点击可切换单行/双行** |
| 播放/暂停 | 240 | 双状态图标，跟随实际播放状态 |
| 上一首 / 下一首 | 240 | 通过系统媒体键控制 |
| 状态 | 240 | 显示当前检测方式与歌词来源，**点击可强制重新加载歌词** |

**歌词**

- QRC 逐字歌词：字/词级别的时间戳驱动高亮，长句自动缩放适配
- 翻译行：QQ 音乐提供翻译时自动显示（外语歌通常有）
- 罗马音：日文歌曲可用
- 单行/双行模式、对齐方式、字号、颜色、内边距、封面主色背景都可配置
- 全局歌词偏移（毫秒），用于修正不同设备/曲目的细微对不齐

---

## 3. 播放检测是怎么做的（重点）

插件按"优先级从高到低"尝试以下方式，前一个拿不到就自动退到下一个：

**Windows**

1. `SMTC`（系统媒体会话，PowerShell + WinRT）：QQ 音乐会把歌名/歌手/专辑/**精确播放进度和播放/暂停状态**写进系统媒体会话。这是唯一自动使用的来源。
2. `窗口标题`（需在设置页手动选择）：读取 QQ 音乐窗口标题（形如 `歌名 - 歌手`）。**不推荐**：实测 QQ 音乐在窗口不重绘时标题会停留在上一首，切歌瞬间尤其容易显示旧歌，而且没有真实进度，只能按标题变化时间推算。
3. `手动指定`：在设置页填 `歌名 - 歌手`，由你手动对齐。

**macOS**

1. `nowplaying-cli`（推荐，`brew install nowplaying-cli`）：读取系统"正在播放"（控制中心同源），含进度。
2. `MediaRemote`（内置 JXA 脚本直接调用系统私有框架）：无需额外安装，能否成功取决于 macOS 版本。
3. `窗口标题`：同 Windows。
4. `手动指定`。

> 检测方式可以在插件设置页里固定（自动/SMTC/macOS/窗口标题/手动），方便排查。

---

## 4. 环境要求

- Flexbar 设备 + FlexDesigner **v1.0.0 或更高**（本项目 manifest 的 `software.minimumVersion` 为 `1.0.0`）
- Node.js **20 或更高**
- FlexCLI：`npm install -g @eniac/flexcli`
- Windows 10+ 或 macOS 10.15+
- 网络可访问 `u.y.qq.com` / `c.y.qq.com` / `y.qq.com`（取歌词与封面）

---

## 5. 安装与运行

```bash
npm install          # 安装 SDK、canvas 渲染、qrc-decoder
npm run build        # 用 rollup 打包到 <uuid>.plugin/backend/plugin.cjs
npm run plugin:validate
npm run plugin:link  # 链接到 FlexDesigner（开发模式）
npm run plugin:debug # 查看插件日志
```

打包发布给他人：

```bash
npm run build
npm run plugin:pack     # 生成 com.flexbar.qqmusicnow.flexplugin
npm run plugin:install  # 本机安装打包结果（--force）
```

> 仓库里已经包含一份构建好的 `com.flexbar.qqmusicnow.plugin/backend/plugin.cjs`，不改代码时可以直接 `plugin:link` / 打包。
> 注意：`@napi-rs/canvas` 是原生模块，打包/安装到别的机器时该模块需要能被解析（本机 `npm install` 即可；若要发布到 FlexGate，请确认包内包含依赖，或让用户侧安装依赖）。

---

## 6. 设置页

在 FlexDesigner 里点插件设置（`configPage`）可以配置：

| 项目 | 说明 |
| --- | --- |
| 播放检测方式 | 自动（推荐）/ 固定 SMTC / 固定 macOS / 固定窗口标题 / 手动 |
| 刷新间隔 | 播放状态轮询间隔，默认 1000ms |
| 手动歌曲 | 格式 `歌名 - 歌手`，仅"手动"模式使用 |
| 歌词偏移 | -3000 ~ +3000ms，数值越大歌词越晚出现 |
| 字体覆盖 | 留空自动选择中文字体（Windows 微软雅黑 / macOS 苹方） |
| 诊断 | "测试检测"显示当前实际拿到的曲目；"重新加载歌词"清缓存重取；"打开 QQ 音乐" |

---

## 7. 出问题时怎么查

```bash
npm run doctor                 # 环境体检：canvas、字体、QQ 接口、SMTC / MediaRemote
npm run doctor -- --lyrics     # 附带歌词接口测试
npm run preview                # 不用设备，把按键画面渲染成 preview/*.png
```

状态键（240 宽）会实时显示 `检测方式 · 歌词来源`，例如 `SMTC · QRC`、`窗口 · LRC`、`手动 · --`。

| 现象 | 可能原因与处理 |
| --- | --- |
| 歌词键显示"QQ 音乐未在播放" | 检测没拿到曲目。点状态键看检测方式；Windows 上确认 QQ 音乐正在播放（暂停也能识别）；必要时在设置页切到"窗口标题"或"手动" |
| Windows 上 SMTC 一直不可用 | 部分精简系统/服务器版/无桌面会话环境没有媒体会话服务；插件会自动退到窗口标题检测 |
| 歌词显示"未找到歌词" | 匹配失败或该曲目在 QQ 音乐无歌词。换"窗口标题"模式、或把窗口标题保持为 `歌名 - 歌手`，也可提高匹配命中率 |
| 歌词不动 / 对不齐 | 位置来自系统进度；窗口标题模式只能推算时间，建议用 SMTC / nowplaying-cli 模式，或调整"歌词偏移" |
| 切歌后画面还停在上一首 | 常见于使用"窗口标题"模式：该模式下 QQ 音乐的窗口标题可能是旧歌。把设置页的检测方式改回"自动"，并在 QQ 音乐里正常播放（媒体会话建立后即可实时跟随） |
| 切歌后歌词整体偏早/偏晚一点 | 用设置页的"歌词偏移"微调（正数 = 歌词出现更晚），一般 ±200ms 内即可对齐 |
| 播放控制键无效 | 系统媒体键被其他软件抢占；在设置页配置 `customCommands`（见下） |
| 画面变成纯文字 | 缺少 `@napi-rs/canvas`，插件自动降级为设备文字渲染；执行 `npm install` 后重启插件 |
| macOS 检测不到 | 先装 `brew install nowplaying-cli`；仍不行就用窗口标题或手动模式，并反馈 `npm run doctor` 输出 |

自定义控制命令（写进插件目录的 `config.json`，可选）：

```json
{
  "customCommands": {
    "playpause": "你的命令",
    "next": "你的命令",
    "previous": "你的命令"
  }
}
```

---

## 8. 目录结构

```
qqmusicnow/
├─ src/
│  ├─ plugin.js                 # 入口：事件、定时器、按键渲染与交互
│  ├─ config.js                 # config.json 读写
│  ├─ media-keys.js             # 跨平台媒体键
│  ├─ nowplaying/               # 播放检测（SMTC / macOS / 窗口标题 / 手动）
│  ├─ lyrics/                   # QQ 音乐接口、QRC/LRC 解析、匹配与缓存
│  └─ render/                   # canvas 渲染（歌词、正在播放、颜色、封面、字体）
├─ com.flexbar.qqmusicnow.plugin/
│  ├─ manifest.json             # 按键定义 + 中英文文案
│  ├─ ui/*.vue                  # 设置页与各按键设置面板
│  ├─ helper/windows/*.ps1      # SMTC 读取、媒体键发送
│  ├─ helper/macos/*.jxa        # MediaRemote 读取与命令
│  └─ backend/plugin.cjs        # 构建产物
├─ tools/doctor.js, tools/preview.js
└─ rollup.config.mjs, package.json
```

---

## 9. 已知限制

- QQ 音乐**没有**公开的"我喜欢 / 随机 / 循环"系统接口，因此这些按键没有做；播放/暂停、上一首、下一首走系统媒体键，是唯一不依赖窗口自动化的稳定方案。
- 窗口标题模式下没有真实播放进度，只能按标题变化时间推算，长时间暂停再恢复会有偏差。
- SMTC 需要正常的 Windows 桌面会话；无桌面会话的环境（部分服务器/虚拟机）会自动跳过。
- macOS 的 `MediaRemote` 属于系统私有接口，不同 macOS 版本行为可能变化，所以默认推荐 `nowplaying-cli`。
- 歌词来自 QQ 音乐线上接口，无网络时只能显示"未找到歌词"。
- 曲目匹配是基于"歌名 + 歌手 + 时长"的模糊匹配，翻唱/重名歌曲偶尔会匹配到相邻版本（可在状态键点一次重新加载，或调整窗口标题里的歌手写法）。
- 歌词刷新率会按实际渲染/传输耗时自适应（约 20~30fps）：设备上永远显示最新一帧，不会积累滞后。日志里搜 `[Draw]` 可以看到实测帧率与往返耗时。
- 插件内置单实例锁与按键布局快照：FlexDesigner 每次 link/restart 都会新起一个进程且不一定会结束旧进程，旧进程会继续把过期画面画到设备上；现在新进程会接管，旧进程自动退出，宿主没有推送 `plugin.alive` 时还会用上次的布局快照自行恢复。

## 10. 二次开发

改插件身份（uuid、作者、仓库）：把 `com.flexbar.qqmusicnow` 全局替换成你自己的（`package.json` 脚本、`manifest.json` 的 `uuid` 与 `cid`、`src/constants.js` 的 `UUID`、目录名 `<uuid>.plugin`）。

发布到 FlexGate：先 `npm run build && npm run plugin:pack`，再按 FlexGate 的开发者流程上传 `com.flexbar.qqmusicnow.flexplugin`。

## 11. 第三方依赖与合规

- `@eniac/flexdesigner`（FlexDesigner 官方 SDK）、`@napi-rs/canvas`（渲染）、`qrc-decoder`（MIT，QRC 解密）——均为公开依赖，见 `package.json`。
- QRC 歌词使用了 QQ 音乐非公开的私有格式与加密变体；项目通过 MIT 许可的 `qrc-decoder` 完成解密，未复制任何无许可授权的第三方项目代码。
- 本项目仅用于个人学习与自有设备上的歌词显示，请遵守 QQ 音乐的服务条款，不要用于批量抓取或分发受版权保护的内容。
