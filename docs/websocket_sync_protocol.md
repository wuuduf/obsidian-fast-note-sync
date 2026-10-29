# WebSocket 同步协议对接文档

本文档按照 **“发送请求 -> 接收响应 -> 详细结构”** 的逻辑组织，供前端开发人员参考。

---

## 1. 笔记同步 (`NoteSync`)

### 第一步：客户端发送同步请求
**Action**: `NoteSync`
**参数结构:**
```json
{
  "vault": "MyVault",             // 仓库名称
  "lastTime": 1704560000000,      // 客户端记录的上次同步时间戳 (毫秒)
  "notes": [                      // 客户端本地的笔记信息清单
    {
      "path": "test/abc.md",      // 路径
      "pathHash": "32位哈希",      // 路径唯一标识
      "contentHash": "内容哈希",   // 用于判定内容是否变动
      "mtime": 1704560000000      // 修改时间 (毫秒)
    }
  ]
}
```

### 第二步：服务端返回同步结果通知
**Action**: `NoteSyncEnd`
**数据结构 (`data` 字段内容):**
```json
{
  "lastTime": 1704569999999,      // 本次同步后最新的服务端时间戳 (下次同步请传这个值)
  "messages": [                   // 任务队列：需要客户端执行的具体操作
    { "action": "NoteSyncDelete", "data": { ... } },
    { "action": "NoteSyncModify", "data": { ... } },
    { "action": "NoteSyncNeedPush", "data": { ... } },
    { "action": "NoteSyncMtime",  "data": { ... } }
  ],
  "needUploadCount": 1,           // 统计：需上传数
  "needModifyCount": 1,           // 统计：需下载修改数
  "needDeleteCount": 1,           // 统计：需删除数
  "needSyncMtimeCount": 1         // 统计：仅需同步时间数
}
```

### 第三步：详细任务数据结构 (`messages[i].data`)

| 任务类型 (Action)      | 对应 Data 结构                                                                   | 说明                                                   |
|:-----------------------|:---------------------------------------------------------------------------------|:-------------------------------------------------------|
| **`NoteSyncDelete`**   | `{ "path": "string" }`                                                           | 服务端已删，客户端应删除本地对应文件                    |
| **`NoteSyncNeedPush`** | `{ "path": "string" }`                                                           | 客户端本地更新，需客户端再次发送 `NoteModify` 进行上传  |
| **`NoteSyncModify`**   | `{ "path", "pathHash", "content", "contentHash", "ctime", "mtime", "lastTime" }` | 服务端较新，客户端应直接使用 Data 中的 content 覆盖本地 |
| **`NoteSyncMtime`**    | `{ "path", "ctime", "mtime" }`                                                   | 内容一致，仅需更新本地文件的修改时间                    |

---

## 2. 文件同步 (`FileSync`)

### 第一步：客户端发送同步请求
**Action**: `FileSync`
**参数结构:**
```json
{
  "vault": "MyVault",
  "lastTime": 1704560000000,
  "files": [
    {
      "path": "img/a.png",
      "pathHash": "...",
      "contentHash": "...",
      "size": 10240,              // 文件大小 (字节)
      "mtime": 1704560000000
    }
  ]
}
```

### 第二步：服务端返回同步结果通知
**Action**: `FileSyncEnd`
**数据结构:** 与 `NoteSyncEnd` 类似。

### 第三步：详细任务数据结构 (`messages[i].data`)

| 任务类型 (Action)    | 对应 Data 结构                                                                | 说明                                                        |
|:---------------------|:------------------------------------------------------------------------------|:------------------------------------------------------------|
| **`FileSyncDelete`** | `{ "path": "string" }`                                                        | 服务端已删                                                  |
| **`FileSyncUpdate`** | `{ "path", "pathHash", "contentHash", "size", "ctime", "mtime", "lastTime" }` | 服务端较新，客户端应发起 `FileChunkDownload` 进行下载        |
| **`FileUpload`**     | `{ "path", "sessionId", "chunkSize" }`                                        | 客户端较新，请求上传。客户端需根据 `sessionId` 发送二进制分块 |
| **`FileSyncMtime`**  | `{ "path", "ctime", "mtime" }`                                                | 仅同步修改时间                                              |

---

## 3. 设置同步 (`SettingSync`)

### 第一步：客户端发送同步请求
**Action**: `SettingSync`
**参数结构:**
```json
{
  "vault": "MyVault",
  "lastTime": 1704560000000,
  "cover": false,                 // 是否强制云端覆盖本地
  "settings": [ ... ]             // 结构同笔记同步
}
```

### 第二步：服务端返回同步结果通知
**Action**: `SettingSyncEnd`
**数据结构:** 结构同上。

### 第三步：详细任务数据结构 (`messages[i].data`)

| 任务类型 (Action)           | 对应 Data 结构                                                                            | 说明                                             |
|:----------------------------|:------------------------------------------------------------------------------------------|:-------------------------------------------------|
| **`SettingSyncDelete`**     | `{ "path": "string" }" }`                                                                 | 删除本地配置                                     |
| **`SettingSyncModify`**     | `{ "vault", "path", "pathHash", "content", "contentHash", "ctime", "mtime", "lastTime" }` | 服务端较新，覆盖本地                              |
| **`SettingSyncNeedUpload`** | `{ "path": "string" }`                                                                    | 客户端较新，需客户端发起 `SettingModify` 进行上传 |
| **`SettingSyncMtime`**      | `{ "path", "ctime", "mtime" }`                                                            | 仅同步时间                                       |

---

## 4. 二进制分块协议
在分块上传/下载时，二进制帧的前 **40 字节** 为固定报头：
- **0~35 字节**: `SessionID` (UUID 字符串)
- **36~39 字节**: `ChunkIndex` (uint32, 大端序)
- **40 字节开始**: 分块原始数据

## 5. 失败分页重试与缓存过期

正文读取失败时，服务端返回 code `439`，`data` 包含 `retryable: true`、`resourceType` 和 0-based `pageIndex`，外层保留 `context`、`vault`。客户端发送对应的 `Note/File/Setting/FolderSyncPageAck`，`pageIndex` 为失败页减一（第 0 页使用 `-1`），请求重发该页。收到分页不代表恢复成功，需要等待本地处理完成。

下载缓存不存在、超过 10 分钟未更新或不属于请求 vault 时，返回如下结构；即使连接使用 Protobuf，未带 action 的错误也会以现有 JSON 通道传输，客户端不能依赖 action 才记日志：

```json
{
  "code": 439,
  "context": "original-sync-context",
  "vault": "MyVault",
  "data": {
    "retryable": false,
    "restartRequired": true,
    "reason": "download_cache_expired",
    "resourceType": "note",
    "pageIndex": 2
  }
}
```

客户端把该回执关联到原失败条目，释放单页重试锁并提供新一轮全量比对入口；不把无关联的迟到过期回执当成新的用户错误。正常末页发送后，服务端保留轻量完成标记（10 分钟、最多 1024 条），使流水线中迟到的普通 ACK 继续静默处理，兼容旧客户端。此错误对象的内层页码为 0-based，与分页明细信封的 1-based `pageIndex` 含义不同。
