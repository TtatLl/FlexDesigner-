# 先读我（怎么把这份东西交给 Mac 端的 AI 助手）

## 一句话

Mac 端是 **DeepSeek**（聊天里通常**不能解压、也读不了二进制**），所以别指望它自己打开压缩包。
正确做法：把**纯文本**喂给它 —— 也就是这两个文件（同目录 `../qqmusicnow-handover-text/` 里也有副本）：

| 文件 | 大小 | 怎么给 |
| --- | --- | --- |
| `1-文档-先看这个.md` | 约 28 KB | 直接**粘贴进对话**（一次就够）或作为文本文件上传 |
| `2-源码合集.md` | 约 211 KB（42 个源文件） | 作为**文本文件上传**最省事；只能粘贴的话，按需要分 2~3 次发（它开头有文件清单，可以只发你关心的那几段） |

安装包（`packages/*.flexplugin`）**不用给它**，那是给 FlexDesigner 装插件用的，二进制它也读不了。

## 压缩包里的其它东西（给人类/有文件访问能力的助手用）

```
HANDOVER.md      主文档：现状、架构、macOS 待验证清单、11 条"不要改回去"的坑、常用命令
CONVERSATION.md  之前的完整开发对话整理（15 轮，含每次定位的日志证据）
source/          展开的完整源码（可读可改）
packages/        安装包：macos.arm64（Apple Silicon）/ macos.x64（Intel）
```

## 发给 Mac 端 AI 的第一段话（可直接复制）

```
我在做一个 Flexbar 插件（QQ 音乐的歌词 / 正在播放 / 播放控制），它在 Windows 上已经跑通并验证，
现在要让它在我这台 Mac 上正常工作。

我先给你一份纯文本资料：
- 1-文档-先看这个.md：项目现状、架构说明、macOS 上需要逐项验证的清单、以及 11 条"已经踩过、
  不要改回去"的坑，还有常用命令和已验证数据。
- 2-源码合集.md：全部源码（每个文件用 ===== 文件: 路径 ===== 分隔）。

请先读文档，再重点读源码里的：
  src/nowplaying/macos-media.js（macOS 播放检测：nowplaying-cli → MediaRemote）
  src/nowplaying/index.js（检测链编排）
  src/render/fonts.js、src/render/engine.js（渲染与字体）
  com.flexbar.qqmusicnow.plugin/helper/macos/*.jxa（MediaRemote 读写脚本）

然后：
1) 告诉我在这台 Mac 上按什么顺序验证；
2) 我会把 `npm run doctor` 的输出和插件日志贴给你；
3) 请根据实际输出定位 macOS 上"播放检测 / 媒体键 / 渲染"哪一环不工作，给最小改动的修复
   （直接给出 diff 或改完的文件内容，并说明怎么重新构建、重新导入插件）；
4) 不要回退 Windows 上已经修好的行为（文档第 5 节逐条列了原因）。
```

## 你在 Mac 上自己要做的三件事

```bash
uname -m                      # arm64 → 用 macos.arm64 包；x86_64 → 用 macos.x64 包
brew install nowplaying-cli   # 建议装：macOS 上最可靠的播放状态来源
```

1. 把源码解压到某个目录，`npm install && npm run doctor`，把输出发给 Mac 端 AI
2. FlexDesigner → 右侧插件面板 →「从文件导入」→ 选 `packages/` 里对应芯片的 `.flexplugin`
3. 把 6 个按键拖到 Flexbar 上（正在播放 / 歌词 / 播放暂停 / 上一首 / 下一首 / 状态），
   播放 QQ 音乐，看状态键显示什么（例如 `macOS · QRC`）

## 出问题时的日志位置

```
~/Library/Application Support/FlexDesigner/*/com.flexbar.qqmusicnow.plugin/logs/YYYY-MM-DD.log
```

若画面退化成纯文字（没有封面 / 逐字高亮），先执行一次再重启插件：

```bash
xattr -dr com.apple.quarantine ~/Library/Application\ Support/FlexDesigner
```
