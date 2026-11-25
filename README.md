# uasset-studio

UE4 / UE5 `.uasset` / `.uexp` 资产编辑器内核，附带 **MCP 服务器**、**CLI** 与**离线 Web GUI**。
面向「让 AI 直接读写虚幻资产」这个场景重写：路径寻址、批量编辑、失败回滚、保存自检。

原工程是一个单体 WebView App（`main.js` 8832 行全塞一个文件，UI 与二进制引擎混在一起，
并带一套拉取远端 `cfg.json` + HMAC 校验的远程停用逻辑）。本仓库把引擎拆成模块、
补齐 pak 支持、接上 MCP，并去掉全部远端依赖。

## 它做了什么

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  MCP server  │   │     CLI      │   │   Web GUI    │
│  (36 tools)  │   │ (16 commands)│   │  (offline)   │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       └──────────────────┼──────────────────┘
                    ┌─────┴──────┐
                    │  Package   │  路径寻址 / 批量 / 快照 / 自检
                    └─────┬──────┘
              ┌───────────┼───────────┐
        ┌─────┴────┐ ┌────┴────┐ ┌────┴────┐
        │  engine  │ │ names   │ │  pak    │
        │ 读写器   │ │ 名称表  │ │ 归档    │
        └──────────┘ └─────────┘ └─────────┘
```

## 快速开始

```bash
git clone <repo> && cd uasset-studio
node --version   # 需要 18+

# 看资产结构
node src/cli/uasset.mjs info  BP.uasset
node src/cli/uasset.mjs ls    BP.uasset
node src/cli/uasset.mjs tree  BP.uasset Default__BP_Rifle_AUG_C 3

# 改一个值（自动判断定长补丁 / 变长重建）
node src/cli/uasset.mjs set BP.uasset Default__BP_Rifle_AUG_C.bEnableInspect false
node src/cli/uasset.mjs save BP.uasset          # 输出 BP.mod.uasset，不覆盖源文件

# 起 MCP 服务器（stdio，给 Claude Desktop / Cursor / Roo 等）
node src/mcp/server.js
```

## MCP 接入

`node src/cli/uasset.mjs mcp` 会打印现成的配置片段：

```json
{
  "mcpServers": {
    "uasset-studio": {
      "command": "node",
      "args": ["/绝对路径/uasset-studio/src/mcp/server.js"]
    }
  }
}
```

HTTP 模式（方便远程/容器）：`node src/mcp/server.js --http 8787`，端点 `POST http://127.0.0.1:8787/mcp`，
另有 `GET /health`、`GET /tools`。

### 工具一览（36 个）

| 分组 | 工具 |
| --- | --- |
| 打开 / 会话 | `uasset_open` `uasset_open_bytes` `uasset_close` `uasset_info` `uasset_help` |
| 浏览 | `uasset_list_exports` `uasset_list_names` `uasset_tree` `uasset_get` `uasset_search` `uasset_blueprint` |
| 编辑 | `uasset_set` `uasset_set_many` `uasset_set_by_query` `uasset_batch` `uasset_add_property` `uasset_delete_property` `uasset_rename_name` |
| 二进制 | `uasset_hexdump` `uasset_patch_bytes` |
| 保存 | `uasset_verify` `uasset_save` `uasset_export_base64` `uasset_export_json` `uasset_diff` `uasset_rollback` |
| 安全网 | `uasset_validate` `uasset_snapshot` `uasset_restore` |
| 批量 | `uasset_scan_dir` `uasset_query` |
| pak | `pak_open` `pak_list` `pak_read` `pak_extract` `pak_replace` |

### 两种运行形态

| 形态 | 跑在哪 | 文件访问 | 工具数 |
| --- | --- | --- | --- |
| 桌面 / 服务器 | `node src/mcp/server.js` | 直接读目录 | 36 |
| **App 内** | 手机 App → 设置 → MCP 服务 | SAF 授权的文件 | 25 |

App 内的 MCP 是**在 App 里跑 HTTP 服务**，AI 客户端（RikkaHub、Claude Desktop 走桥接等）
填一个地址就能连，不需要电脑、不需要 Termux：

```
App 设置 → MCP 服务（给 AI 用）
├── 启用本地 MCP          ← 打开
├── 端口  8787
├── 允许局域网访问         ← 关（只监听 127.0.0.1）/ 开（手机同网段可连）
├── 运行中 · 端点 http://127.0.0.1:8787/mcp
├── 添加可读文件（授权给 AI）    ← 选 .uasset/.uexp，授权持久化
├── 选择保存位置（AI 写盘用）    ← 给 AI 一个可写目标
└── 复制 MCP 客户端配置          ← 输出可直接粘的 JSON
```

架构上刻意让 Java 只做字节搬运：

```
AI 客户端 ──HTTP──> McpHttpServer.java（手写 HTTP/1.1，258 行）
                        │ evaluateJavascript + CountDownLatch
                        ▼
                   WebView 里的 mcp-app.js（JSON-RPC + 25 个工具）
                        │
                        ▼
                   Package / Pak（与 CLI 完全同一套解析代码）
```

这样 App 与 CLI 的行为不会分叉 —— 改一处引擎，两边同时生效。

App 内工具清单（25 个）：

| 分组 | 工具 |
| --- | --- |
| 会话 | `app_status` `app_list_files` `app_open_file` `app_close` |
| 浏览 | `uasset_info` `uasset_list_exports` `uasset_list_names` `uasset_tree` `uasset_get` `uasset_search` `uasset_blueprint` |
| 编辑 | `uasset_set` `uasset_set_many` `uasset_set_by_query` `uasset_batch` `uasset_validate` |
| 安全网 | `uasset_snapshot` `uasset_restore` |
| 二进制 | `uasset_hexdump` `uasset_patch_bytes` |
| 输出 | `uasset_export_base64` `uasset_export_json` `uasset_save` `uasset_help` |

没有路径/目录概念，所以 `scan_dir`、`pak_*` 只在桌面版提供。

### 路径语法

```
Default__BP_Rifle_AUG_C.WeaponAttrModifyConfigList[0].WeaponAttrModifiers[0].ModifyValue
└── 导出名（或 #索引）  └ 属性名              └数组索引  └ 嵌套属性
```

## 面向 AI 的几处设计

**区分定长 / 变长编辑。** 改 bool、数字、枚举走字节补丁 —— 只动目标那几个字节，
文件大小与所有偏移都不变。改字符串、数组增删才重建导出。AI 不需要知道这个区别，
`uasset_set` 会自己选，并在返回值里告诉你走了哪条路（`mode: "patch" | "rebuild"`）。

**改之前能先看。** `uasset_validate` 逐个导出解析一遍，标出哪些能完整解析、
哪些退化成原始字节块。盲区提前暴露，比改完崩掉再查强。

**批量改 + 预演。** `uasset_set_by_query` 支持 `dryRun`，先返回每条 before/after
让你确认，再真写。`uasset_batch` 多条操作一次提交，任何一条失败整批回滚。

**随手快照。** `uasset_snapshot` / `uasset_restore` 用深拷贝保存解析树，
迭代试错不用重新打开文件。

**拒绝静默损坏。** 导出里有未解析的原始块时，重建会被明确拒绝并说明原因，
而不是写出一个 UE 读不了的包。确实要强推才用 `force=true`。

## pak 支持

```bash
node src/cli/uasset.mjs pak-list  pakchunk0.pak
node src/cli/uasset.mjs pak-x     pakchunk0.pak ./unpacked "\\.uasset$"
```

MCP 侧走 `pak_open` → `pak_list` → `pak_extract` → 改资产 → `pak_replace` 回写。
支持 AES-256-ECB 解密（只读）、zlib/gzip 分块解压、替换后重建、可选压缩重建。
**Oodle 压缩不内置**（需要 `oo2core` 库），遇到会明确报错而不是产出坏包。

## 原工程改动清单

| 项 | 原状 | 现在 |
| --- | --- | --- |
| 代码结构 | 单文件 8832 行，UI 与引擎混在一起 | `core/` 模块化，`web/ui.js` 与引擎分离 |
| 全局状态 | `globalNameMap` 等十几个全局变量 | 每个 `Package` 实例独立，可并发 |
| 远端门禁 | 拉 `cfg.json` + 内置 HMAC 密钥 + 远程停用 + 到期日 | **整段移除**，完全离线 |
| 内嵌第三方资源 | `__HP_ASSET`(4MB) + `__HP_VOICE`(5MB) + 内透脚本 | **移除**，`index.html` 从 9.3MB → 72KB |
| 缺失依赖 | `viewer.html` 引用不存在的 `data2.js` | 移除该引用 |
| pak | 不支持 | 完整读写 |
| 结构体数组 | 定长切分，变长数组从第 2 个元素起错位 | 按 `None` 边界变长解析 |
| 快照 / 回滚 | 无 | 深拷贝解析树 |
| 保存自检 | 只查越界 | 越界 + 名称表完整性 + 重解析改动导出 |
| 给 AI 用 | 无 | 桌面 MCP（36 工具）+ App 内 MCP（25 工具，设置面板可开关） |

### 修掉的两个真实缺陷

**1. 变长结构体数组解析错位。**
`WeaponAttrModifyConfigList` 的 header 里 `Size=2317` 是**全部元素总长**，原实现按
`2317/8=289` 定长切。但元素 0 实际是 286 字节（内层数组长度不同），于是从第 2 个
元素起全部错位，后续 7 个元素退化成原始字节块 —— 一改就写坏。
现改为按 `None` 终止符逐元素变长解析，8 个元素全部正确解出。

**2. 快照回滚丢改动。**
`set()` 改的是解析树，`this.uasset` 缓冲区仍是原始字节。用缓冲区做快照，
回滚会把快照之前的所有修改一起丢掉。现改为深拷贝解析树。

## 验证

```bash
npm test                    # 单元 + 端到端 + 字节级回归
npm run verify:web          # Web 产物洁净性（无远端依赖）
node test/full-regress.mjs <真实资产.uasset>   # 真实资产 20 项检查
```

### 字节级回归

改一个 float，输出的 `.uexp` 与原始文件**仅差目标那几个字节**，文件大小不变：

```
✓ 定长编辑：仅 4 字节变化，重载读回 0.75
✓ 布尔编辑：仅 1 字节变化
✓ 整型编辑：仅 4 字节变化
✓ 结构体分量：仅 2 字节变化
✓ 变长字符串：uexp 194 → 209，重载读回正确
```

真实资产（BP_Rifle_AUG，561 名称 / 148 导入 / 23 导出）实测：

```
✓ 文件大小不变 20355
✓ 只动目标字节 4 字节 @ 396,397,398,399
✓ 自检通过 []
✓ 重建 1 个 / 复制 22 个
✓ 重载读回 0.75
```

### full-regress 的 20 项检查

| 组 | 检查内容 |
| --- | --- |
| 定长编辑 | 文件大小不变、只动目标字节、自检通过、重建/复制计数、重载读回 |
| 嵌套变长数组 | 8 个元素全部解析（非原始块）、header 识别为总长格式、改嵌套元素后自检、读回 |
| 名称表扩容 | 名称数不变、totalHeaderSize 不变、值写入成功、所有导出偏移仍有效 |
| 批量改值 | dryRun 匹配、dryRun 不落地、实际写入、保存成功 |
| pak 端到端 | 建包读回、压缩生效、包内资产可解析且值正确 |

### App 侧（无需模拟器）

App 内的 MCP 与设置面板都是 WebView 里的普通 JS，用一个足够像的 DOM stub + 假原生桥
就能在 Node 里验证：

```
✓ 协议：initialize / tools/list / ping / 未知方法 / 坏 JSON
✓ 资产登记 + 只读工具（真实夹具字节）
✓ 编辑：set / 批量 / dryRun / 整批回滚 / 快照恢复
✓ 导出：save 自检 + base64 往返（导出→重开读回同值）
✓ 错误路径：未知 session / 属性 / 工具 / 缺参数都给可执行提示
✓ 设置面板：开关→调原生 start / 改端口自动重启 / 非法端口拒绝并弹回
  / 复制出合法客户端配置 / 文件授权列表渲染与移除
✓ 非 App 环境：提示改用 Node 版，不假装可用
```

### CI

GitHub Actions 跑三套 Node（18 / 20 / 22）+ lint + Web 构建，全部绿；
Android workflow 产出 APK（3.1 MB，无 INTERNET 权限，assets 内含 index.html/app.js）。

## 目录

```
src/core/      engine.js(读写器) names.js(名称表) serializer.js(回写) package.js(高层) pak.js
src/mcp/       server.js(零依赖 JSON-RPC) tools.js(36 个工具)
src/cli/       uasset.mjs
src/web/       ui.js(原界面逻辑)
web/           index.html + app.js + xev.js(十六进制编辑器)
scripts/       split-legacy.mjs(从原单文件拆分) build-web.mjs
test/          e2e.mjs + mcp.test.mjs + fixtures
legacy/        原工程留档（仅供对照，不参与构建）
```

## 许可

MIT
