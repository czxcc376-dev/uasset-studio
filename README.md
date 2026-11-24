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
| 内嵌第三方资源 | `__HP_ASSET`(4MB) + `__HP_VOICE`(5MB) + 内透脚本 | **移除**，`index.html` 从 9.3MB → 71KB |
| 缺失依赖 | `viewer.html` 引用不存在的 `data2.js` | 移除该引用 |
| pak | 不支持 | 完整读写 |
| 结构体数组 | 定长切分，变长数组从第 2 个元素起错位 | 按 `None` 边界变长解析 |
| 快照 / 回滚 | 无 | 深拷贝解析树 |
| 保存自检 | 只查越界 | 越界 + 名称表完整性 + 重解析改动导出 |

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
npm test          # 端到端：解析 → 改值 → 保存 → 重解析
```

字节级回归：只改一个 float，输出的 `.uexp` 与原始文件**仅差 4 字节**（该 float 本身），
文件大小不变，其余字节完全一致。

```
orig 20355  new 20355  diffBytes 4
ranges 2163..2166
```

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
