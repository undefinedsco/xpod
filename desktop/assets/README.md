# 桌面产品资产清单（§9.1 资产合同）

本清单记录每个产品资产的来源与校验值，便于判断权威源与是否被就地修改。
品牌源资产在相邻的 homepage 检出，产品侧只做导入与生成，不复制几何：

- 应用图标派生自选定的 Xpod 标识：`homepage/public/brand/xpod-app.svg`（另有 `xpod-app-light.svg`、16/24 尺寸切片）；
- 托盘 template 由单色符号派生：`homepage/public/brand/xpod-symbol.svg`；
- 选定记录与来源校验值：`homepage/public/brand/manifest.json`（`selectedAt: 2026-09-26`，`xpod: B · 留缝折角`，含 `sourceSha256`）；
- 选定前的旧资产保留在 `homepage/docs/reference/archive/2026-09-26-before-selection/`（D-05「保留旧 Logo」）。

本清单的 sha256 用于判断产品侧是否被就地修改；派生过程（svg → png/icns/template）未逐像素核对。

生成/更新后请同步本清单（`shasum -a 256 <file>`）。

| 资产 | 用途 | sha256 | 字节 |
|---|---|---|---|
| `icon-master.png` | 图标母版 | `ff14633c0023f3226fbfa78524070b302184c78ce3b18908abf969dd55c79044` | 349404 |
| `icon-size-preview.png` | 尺寸预览（评审用） | `28de7a102c35484db65fb07a52e67596df05341d5e59620e33e09261deae23ba` | 34676 |
| `icon.icns` | 应用图标（打包用） | `26b346add83fae3fa0da45f012fa551bb6bac45340a91b673d6da64668c8bd57` | 917658 |
| `icon.iconset/icon_128x128.png` | iconset 切片 | `09e4b113ff83486cf9f5f527c70b823d1a4fb9e993772c3a7605355779108fe3` | 11639 |
| `icon.iconset/icon_128x128@2x.png` | iconset 切片 | `8e70f435b9025e94f1a00a598684898f0224ee468c3a0918fe3c444ecda124b3` | 43587 |
| `icon.iconset/icon_16x16.png` | iconset 切片 | `0bfb43cef5fa8a33506b5859281fd121b7347db5cabcd9f878a125b052ee0c2b` | 592 |
| `icon.iconset/icon_16x16@2x.png` | iconset 切片 | `8481e5944f396164bfcde5a81bd3debf3618a25b1cc36101c44479a391cf5042` | 1252 |
| `icon.iconset/icon_256x256.png` | iconset 切片 | `8e70f435b9025e94f1a00a598684898f0224ee468c3a0918fe3c444ecda124b3` | 43587 |
| `icon.iconset/icon_256x256@2x.png` | iconset 切片 | `256852a0aa3631202a8fb910ce3c6fa1d2de59413fe275e750873a20f9ddb71d` | 157368 |
| `icon.iconset/icon_32x32.png` | iconset 切片 | `8481e5944f396164bfcde5a81bd3debf3618a25b1cc36101c44479a391cf5042` | 1252 |
| `icon.iconset/icon_32x32@2x.png` | iconset 切片 | `76d9f5b474e2b991ae1b4973744795177f34836482f2d94445eddd1b62fb8763` | 3358 |
| `icon.iconset/icon_512x512.png` | iconset 切片 | `256852a0aa3631202a8fb910ce3c6fa1d2de59413fe275e750873a20f9ddb71d` | 157368 |
| `icon.iconset/icon_512x512@2x.png` | iconset 切片 | `5a4fda4487785ec0c7469d90b8d592f007193088cae7e5d151eb146d70351db7` | 349404 |
| `icon.png` | 应用图标 PNG | `774ca2ec641347783b3ecacc3def5ae58fa5d884127e4969e510adecf2b91980` | 349404 |
| `tray-degradedTemplate.png` | 托盘 1x 位图 | `61d0c91680707edbc17f7614ec814308fa132668bc558836b3a2e144f2bf27af` | 419 |
| `tray-degradedTemplate.svg` | 托盘状态图形源（单色模板） | `ddc32ad0a39a2b3a8435dc3e4c66d0941fdc6bbf58449136bca70d781ba5304d` | 317 |
| `tray-degradedTemplate@2x.png` | 托盘 2x 位图 | `01b8bfbd29697d4fbe0c1ccb47fb5644b5001ce8fa92c25f8603bb4b4c65b81f` | 692 |
| `tray-failedTemplate.png` | 托盘 1x 位图 | `be0e531d68d94f0f283dddf1b14d171e93c7dbd3bbdf79fa4292fc4e60bcb266` | 426 |
| `tray-failedTemplate.svg` | 托盘状态图形源（单色模板） | `69b616db54a4a5a6ef56785463cd296d068f946f6f4cba651fb96541b9e95f0b` | 327 |
| `tray-failedTemplate@2x.png` | 托盘 2x 位图 | `e4fe61616b576feffd76a67b9b785287a9fe069cd9f40ce50d19d0dc545b008b` | 694 |
| `tray-healthyTemplate.png` | 托盘 1x 位图 | `bbfd32d7719080d9bd2467c1c9a3eeb7c11b520a5a6545932a4b0efab146fde6` | 444 |
| `tray-healthyTemplate.svg` | 托盘状态图形源（单色模板） | `496347fe13d0ed0f833fe673bc9005b6083ca3373d9d759d4ceb266bd3c7a25f` | 357 |
| `tray-healthyTemplate@2x.png` | 托盘 2x 位图 | `389efbd1d4d9b42e9886271d10eab404f3a7c23df70465c1419f54e6dbf09238` | 806 |
| `tray-startingTemplate.png` | 托盘 1x 位图 | `176e4d38ca46a3151e3ea8aa08bd7e5480697271d88cac4df531570b052ef304` | 466 |
| `tray-startingTemplate.svg` | 托盘状态图形源（单色模板） | `c0f4bc41c34b9e9391e4e974429481048fd75d78c8d141e4256dcc9aeb9ec18f` | 430 |
| `tray-startingTemplate@2x.png` | 托盘 2x 位图 | `4039f6ffb42b3c80d7440aeb4f10b90b32275c92abf2823bf436fd0feee84729` | 847 |
| `tray-stoppedTemplate.png` | 托盘 1x 位图 | `d65dded546e2fc08d761b7e015ac21d12b83ac2470d7cb6e9dc4989fef7e9162` | 430 |
| `tray-stoppedTemplate.svg` | 托盘状态图形源（单色模板） | `5ed4e8f59b155f9d9dca9af66953ad146fc7572fc333c9e5b051b8183115ea0f` | 294 |
| `tray-stoppedTemplate@2x.png` | 托盘 2x 位图 | `38e34f0380641af57c90fee0837309f59c2dba77e4eda8583e85b096870d8dd4` | 712 |
| `tray.png` | 产品资产 | `bfd24c544f02cdc9f829910188c936645fdf8eacb6dba8ea7a61843228db04c6` | 146 |
| `tray@2x.png` | 产品资产 | `a6dff0334c6df024c3ce05a1a578191660c3650b29ed296eac118647713621a4` | 259 |
| `trayTemplate.png` | 产品资产 | `c71bccfefccf325ad95fdf635664758a967c503bf9cd39f9abc8ccd9e3a684ca` | 395 |
| `trayTemplate.svg` | 产品资产 | `2e690c8f7ec7990798c69bfe03e135dd40d131228f9dacf8a6305e1150fd08c3` | 281 |
| `trayTemplate@2x.png` | 产品资产 | `5467662261f1d0c15654d731c3987c1e15d5f91e90b27f881a546e86eed06e42` | 662 |
