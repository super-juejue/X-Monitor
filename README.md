# X Monitor

Chrome 侧边栏里的一张卡：你的 X 头像、昵称、@handle，和粉丝 / 关注 / 帖子数。
只读、不联网请求、数据只留在这台电脑上。

![侧边栏](docs/panel.png)

## 它做什么

打开侧边栏，它显示当前登录的 X 账号：

- 头像、昵称、@handle、蓝标
- 粉丝数、关注数、帖子数
- 这些数字最后一次更新的时间

就这些，没有别的页面和按钮。

| 打开过自己的主页 | 还没读到数字 |
| --- | --- |
| ![](docs/panel-profile.png) | ![](docs/panel-partial.png) |

浅色主题：

![浅色](docs/panel-light.png)

## 安装

1. 克隆仓库：

   ```bash
   git clone https://github.com/super-juejue/X-Monitor.git
   ```

2. 打开 Chrome → `chrome://extensions`，打开右上角 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择仓库根目录（含 `manifest.json` 那一层）。
4. 在 Chrome 里登录 [x.com](https://x.com)，点工具栏图标打开侧边栏。

需要 Chrome 116 或更高版本（侧边栏 API 的最低版本）。

## 怎么拿到数据

插件不请求任何接口，也没有 API Key 或 token。数字来自三个地方，任意一个成功就够了：

1. **X 自己的 `Viewer` 响应** — 登录账号由它确定，通常也带着粉丝 / 关注 / 帖子数。
2. **你自己的主页** — 打开 `/你的用户名` 时，插件从页面头部的
   「N Followers / N Following / N posts」里读。这一步很重要：X 会缓存接口响应，
   再次访问主页时可能**一个请求都不发**，只靠拦截就永远等不到数字。
3. **粉丝 / 关注列表的 owner** — 打开粉丝列表时，响应里的列表主人同样带着计数。

```
X 页面发出 /i/api/graphql 请求          你自己的主页 DOM
        │                                      │
        ▼                                      ▼
src/page-hook.js（主世界）              src/content.js
        │  只挑 Viewer* / UserByScreenName* / Followers / Following
        │  列表只转发 owner，不搬整份名单
        ▼                                      │
src/content.js（隔离世界） ────────────────────┘
        │  CAPTURE / SELF_HINT / PROFILE_HINT
        ▼
src/background.js（Service Worker，唯一写入者）
        │  chrome.storage.local
        ▼
侧边栏（只读渲染）
```

- **按操作名匹配**：X 经常更换 query id，所以只认 `Viewer`、`UserByScreenName`
  这类操作名。
- **不会把别人当成你**：只有 `Viewer` 能确定登录账号。别人的主页、别人的粉丝列表
  都不会覆盖你的信息；切换账号时会清掉上一个账号的数字。
- **只读，不改页面**：DOM 只读取，不注入、不点击、不滚动。
- **数据只存在本地**：全部在 `chrome.storage.local`，没有任何上报。

### 如果只看到 @handle、没有数字

先打开一次你自己的主页（面板上会有一个「打开我的主页」按钮，点它即可，会复用
已打开的 x.com 标签页）。数字会在页面加载后自动补上。

## 权限

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存账号信息与计数 |
| `sidePanel` | 显示侧边栏 |
| `host_permissions` | 在 x.com 上运行内容脚本，读取页面已经收到的数据 |

## 开发

```bash
npm test                       # 解析器 + Service Worker 测试（Node 20+）
python3 scripts/make-icons.py  # 重新生成图标
```

没有构建步骤，也没有运行时依赖。改完源码后在 `chrome://extensions` 点刷新即可。

```
manifest.json
icons/              # 扩展图标
src/
  page-hook.js      # MAIN world，旁路捕获 GraphQL 响应
  content.js        # 桥接 + 读取 @handle 与主页计数
  background.js     # Service Worker：状态与三条数据来源的合并规则
  lib/              # 解析与格式化（纯函数，可单独测试）
  sidepanel/        # 侧边栏（原生 ES Modules，无框架）
tests/              # node:test
docs/               # 截图
```

## 说明

非官方工具，与 X Corp. 无关。只读取你自己账号可见的数据，请遵守 X 的服务条款。

## License

[Apache-2.0](LICENSE)
