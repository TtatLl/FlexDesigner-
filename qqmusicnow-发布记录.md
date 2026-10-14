# QQMusicNow 一体包发布记录（完整版）

> 一体包固定叫 `qqmusicnow-all-<日期>.zip`，同一天多次更新会覆盖同名文件，
> 所以认包请看**字节数 + SHA256**，不要只看文件名。
> 包内 `文档/发布记录.md` 里是截止到上一版的历史；这份是含最新一版的完整记录。

| 版本 | 日期 | 内容 | 一体包大小 | 比上一版 | SHA256 前 16 位 |
| --- | --- | --- | --- | --- | --- |
| 首发 | 2026-09-26 | Windows + macOS 合并版：4 个平台包、源码、文档 | 82,285,222 字节（78.46 MB） | — | 479F75F8... |
| 第 1 版 | 2026-09-27 | 按一下任意按键即可恢复画面（布局推送自愈） | 82,293,629 字节（78.48 MB） | +8,407 字节（+0.01 MB） | 91558445... |
| 第 2 版 | 2026-09-27 | 《放》歌词版本混淆（加速版被当成原版） | 82,311,250 字节（78.50 MB） | +17,621 字节（+0.02 MB） | 9043D1B6... |
| 第 3 版 | 2026-09-27 | 切歌竞态：歌词/封面被上一首覆盖 | 82,315,961 字节（78.50 MB） | +4,711 字节（+0.00 MB） | 06CC9292... |
| 第 4 版 | 2026-09-27 | 播放器专辑名参与匹配 | 82,319,454 字节（78.51 MB） | +3,493 字节（+0.00 MB） | 3EA7CC4A... |
| 第 5 版 | 2026-09-27 | 专辑名补搜：同一首歌的封面选对发行版（《失重前幸福》） | 82,322,944 字节（78.51 MB） | +3,490 字节（+0.00 MB） | 8837B459... |
| 第 6 版 | 2026-09-27 | 加入本发布记录 + 「每次出包必报体积」的规矩（代码与第 5 版相同） | 82,324,101 字节（78.51 MB） | +1,157 字节（+0.00 MB） | 395E06A8... |
| 第 7 版 | 2026-09-28 | FlexDesigner 重启后封面/歌词不再刷新（`not alive` 被误判成坏键而永久禁用；同时不再把它当链路拥塞） | 82,329,451 字节（78.52 MB） | +5,350 字节（+0.01 MB） | E899CA26... |

四个平台包自身体积（第 5 版起未再变化）：

| 包 | 大小 |
| --- | --- |
| com.flexbar.qqmusicnow.generic.flexplugin（两系统通用） | 38.89 MB |
| com.flexbar.qqmusicnow.windows.x64.flexplugin | 14.89 MB |
| com.flexbar.qqmusicnow.macos.arm64.flexplugin | 11.70 MB |
| com.flexbar.qqmusicnow.macos.x64.flexplugin | 12.64 MB |

一体包里 90% 以上体积是平台包内置的原生渲染库（canvas），改后端代码时 zip 通常只涨几 KB。

---

## 仓库源码版 1.0.7（2026-10-14）

与第 7 版相比，这部分改动只来自 **macOS**（Windows 侧代码原样保留，`src/state.js`、
`src/lyrics/service.js`、`src/render/artwork.js`、`src/nowplaying/windows-smtc.js` 等第 7 版
的 Windows 侧修复都还在）：

| 项 | 内容 |
| --- | --- |
| 切歌延迟 | macOS 采样基准 1000ms → 500ms；跳曲后开 5 秒快采样窗口（200ms）；追歌步长 250→120ms。日志锚点 `[Plugin] track change seen <N>ms after skip` |
| 会话被占用 | 换成"后台模式"：继续显示 QQ 音乐的曲目/歌词（状态键多一行「后台」），不再谎报「未在播放」 |
| 播放控制（关键） | 会话属于别的 app（浏览器视频等）时，改为发送 **QQ 音乐自己的全局快捷键**，绕开系统媒体会话，只控制 QQ 音乐、不影响视频。键位从 QQ 音乐偏好实时读取（本机 `playpause=98 next=97 previous=100`） |
| 权限自检 | 启动时发一个未使用的 keyCode 自检；日志 `[MediaKeys] QQ Music hotkey permission: ok (System Events can send keys)`，没有权限时给出「勾选 FlexDesigner 辅助功能」的提示 |
| 走不通的路 | MediaRemote 的 `SendCommandToApp/Client/Player` 定向控制在本机 macOS 15.7 上到不了 QQ 音乐（返回值恒 true 但毫无效果），已写进 skill 的踩坑清单，不再尝试 |

实测证据（本机日志）：

```
20:51:23 [Plugin] transport key via QQ Music hotkey: playpause (media session belongs to com.microsoft.edgemac "…哔哩哔哩" playing=true)
20:51:32 [MediaKeys] QQ Music hotkey permission: ok (System Events can send keys) | playpause=98 next=97 previous=100 (qq music preferences)
```

即：网页视频占用系统会话时，Flexbar 的暂停键控制的是 QQ 音乐，视频不受影响。
