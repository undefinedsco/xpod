# Xpod 桌面外壳画板（归档）

这是 [Xpod 桌面外壳与共用 applet 产品设计](../../2026-10-01-xpod-desktop-shell-and-applets-design.md) 的画板源文件，归档于 2026-10-01。

- 在线画板：https://claude.ai/artifact/5935iJ5q9fds4esW61jaAo （需要登录 claude.ai）
- `canvas.json`：画板索引，记录每张画板在画布上的位置和标题。
- `*.dc.html`：一个文件对应一张画板。名字以场景结尾的文件（如 `AiCreated.dc.html`）只是外壳：它用 `<dc-import>` 引入对应的主画板，并传入 `scenario` 参数。

## 本地渲染

这些文件要靠 Design 画板的运行时才能渲染。仓库里不放这个运行时，需要时从在线画板取：

1. 用 Claude 的 Artifact 读取在线画板的 `artifact-type/dc-runtime.js`，放到本目录的一个副本里。
2. 在同一目录新建 `support.js`，内容只有一行：
   ```js
   document.write('<script src="./dc-runtime.js"><\/script>');
   ```
3. 在这个目录起一个静态服务器，用浏览器打开任意 `*.dc.html`：

   ```bash
   python3 -m http.server 8766 --bind 127.0.0.1
   ```

   画板尺寸以 `canvas.json` 里的 `w`、`h` 为准。桌面画板是 1280×800，其中 P1 是 1280×980；窄窗画板是 390 宽；托盘画板是 600×600。

画板里的数字和名字（小林、阿杰、书店等）都是示例数据。标着「待接入」的项目，目前还没有接口支撑，对应的缺口见 spec 的 §10。智能和快速已由 Xpod 提供，通过 AI Gateway 连接已有能力，不属于「待接入」。
