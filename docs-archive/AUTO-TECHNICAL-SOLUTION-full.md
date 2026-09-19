# AUTO 技术方案 v1

## 1. 目标与边界

AUTO 的目标：

```text
运营人员提供产品表格和视频
→ AUTO 匹配产品、视频、账号和 Board
→ 连接对应 BitBrowser 窗口
→ 通过 Pinterest 页面发布单个视频 Pin
→ 核验结果并保存证据
```

BitBrowser 负责窗口、代理/IP、指纹隔离、登录状态和 CDP 地址。AUTO 负责账号绑定、Board 同步、导入、任务队列、页面发布、结果核验和防重复。

AUTO 不负责购买或切换 IP、修改指纹、保存密码/Cookie、绕过验证码或账号限制，也不加入点赞、关注、评论、随机浏览等行为。

Pinterest 官方明确限制未经批准的自动化、重复内容和操纵平台行为。因此，队列等待只用于稳定性、资源控制和避免并发冲突，不用于规避平台检测。[Pinterest Community Guidelines](https://policy.pinterest.com/en-gb/community-guidelines)

## 2. 总体架构

```text
AUTO 工作台
  导入 / 批次确认 / 任务队列 / 异常处理
        ↓
AUTO 本地核心
  SQLite / 任务队列 / 账号锁 / 发布账本 / 证据
        ↓                         ↓
BitBrowser 本地 API          Pinterest 页面适配器
  窗口列表 / 打开窗口 / CDP    Playwright / CDP
        ↓
窗口 A → Pinterest 账号 A → Board
窗口 B → Pinterest 账号 B → Board
```

BitBrowser 官方提供 `/browser/list`、`/browser/open`、`/browser/detail` 等接口；打开窗口后返回 WebSocket 或 HTTP 调试地址。[BitBrowser API](https://doc.bitbrowser.net/api-docs/browser-profiles)

Playwright 通过 `chromium.connectOverCDP()` 接入现有 Chromium 窗口。该方式可用，但官方说明它的能力完整度低于 Playwright 原生连接，因此每一步都必须验证页面状态。[Playwright CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)

## 3. 账号接入

运营人员先在 BitBrowser 中完成：

```text
创建窗口 → 配置代理 → 登录一个 Pinterest 账号 → 创建 Board
```

AUTO 再执行：

```text
连接 BitBrowser 本地 API
→ 读取窗口列表
→ 打开指定窗口并获取 CDP 地址
→ 识别当前 Pinterest 账号
→ 读取 Board 列表
→ 保存账号与窗口绑定
```

AUTO 保存：

```text
account_id
bit_window_id
window_name
pinterest_profile_url
pinterest_username
proxy_region_snapshot
board_name
board_url_or_id
board_synced_at
verification_state
```

如果只是换 IP，但窗口仍是同一个、账号仍登录、Board 仍可读取，则不需要重新绑定。若出现退出登录、账号身份变化、验证页面或 Board 读取失败，AUTO 暂停账号。

## 4. 导入与任务生成

```text
Pinterest导入包/
├── pins.xlsx
└── media/
    ├── P001-V01.mp4
    └── P001-V02.mp4
```

表格字段：

```text
product_id / product_name / asset_id / filename
title / description / product_url / account_group / board
```

处理过程：

```text
读取表格 → 校验字段和视频 → 计算内容哈希
→ 每个视频生成一个独立 Pin 任务
→ 展开账号组 → 匹配账号和 Board → 进入导入预览
```

Board 规则：

- 表格填写 Board 名称。
- AUTO 读取对应账号实际 Board 并匹配。
- 同名 Board 也要按账号分别绑定。
- Board 不存在时停留在导入预览，不继续发布。
- v1 不静默自动创建 Board。

## 5. 任务状态与发布流程

任务状态：

```text
导入预览 → 已确认 → 排队中 → 执行中 → 已发布
                              ↓
             发布前失败 / 结果待核验 / 需要人工处理
```

发布流程：

```text
打开对应 BitBrowser 窗口
→ 连接 CDP
→ 打开 Pinterest 创建 Pin 页面
→ 检查当前登录账号
→ 上传当前任务的单个视频
→ 等待视频处理完成
→ 填标题、描述、产品链接
→ 选择已校验 Board
→ 检查 Publish 按钮可用
→ 写入“即将点击”事件
→ 点击 Publish 一次
→ 等待 Pin URL 或页面成功状态
→ 保存截图、HTML、URL 和结果
```

Pinterest 官方说明视频 Pin 可能需要额外处理时间，页面自动化不能用固定等待代替状态判断。[Pinterest Create Boards and Pins](https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/)

关键规则：

- Publish 前失败，可以按错误类型重试。
- Publish 后断开或结果不明，禁止自动重传。
- 明确获得 Pin URL 后才写入已发布账本。
- 程序重启后根据任务状态和发布尝试恢复，不能根据文件夹重新猜测。

## 6. 任务队列与并发

第一版只做必要调度：

```text
全局并发上限 + 单账号串行 + 单窗口串行
+ 账号冷却时间 + 页面状态等待 + 失败退避
```

确认批次后立即进入队列。建议从最多 2 个账号并发开始。同一账号和同一窗口同时只能执行一个任务。失败使用递增等待，连续失败后暂停账号。

不加入随机浏览、点赞、关注、评论或“模拟真人”模块。随机延时不能保证不被平台识别，也不能改变平台对自动化和重复内容的判断。

## 7. 发布账本与证据

每次实际执行建立独立发布尝试：

```text
attempt_id / task_id / account_id / bit_window_id
board_snapshot / asset_hash / content_version
started_at / publish_click_at / result_status
pin_url / error_code
```

证据文件：

```text
evidence/task-id/attempt-id/
├── before-publish.png
├── after-publish.png
├── page.html
└── metadata.json
```

防重复键：

```text
platform + account_id + board_url_or_id + asset_hash + content_version
```

## 8. 必须处理的异常

遇到以下情况暂停任务或账号：

- Pinterest 登录过期
- CAPTCHA、身份验证或异常活动提示
- BitBrowser 窗口连接失败
- 当前账号和绑定账号不一致
- Board 不存在或无法读取
- 页面结构变化，无法确认控件
- Publish 后结果不明确

账号被限制后：暂停账号、保留截图和账本，由运营人员在 Pinterest 官方页面确认原因或申诉。AUTO 不自动删除记录，也不通过新账号规避限制。

## 9. 简化后的模块

```text
bitbrowser-connector  窗口列表、打开窗口、CDP、连接重试
account-binding       账号识别、窗口绑定、Board 同步
import-matrix         表格、素材哈希、账号/Board 任务展开
task-scheduler        任务锁、账号串行、并发和立即执行队列
pinterest-adapter     Pinterest 页面动作和结果识别
publication-ledger    发布尝试、防重复、Pin URL
evidence-store        截图、HTML、页面状态
issue-center          暂停、核验、人工恢复
```

第一版不引入 Redis、云数据库、分布式队列或微服务，使用 Electron + SQLite + Playwright + 本地证据文件即可。

## 10. 开发顺序

1. BitBrowser 连接和窗口列表。
2. Pinterest 账号识别和 Board 同步。
3. 单账号单视频发布闭环。
4. 截图、Pin URL 和结果核验。
5. 任务锁、防重复和重启恢复。
6. 账号串行、多账号有限并发和立即执行队列。
7. 导入矩阵、审核和异常中心。
8. 小规模真实账号试运行。

## 11. 验收标准

```text
连接 BitBrowser
→ 正确识别账号和 Board
→ 导入一个产品和多个视频
→ 生成正确任务
→ 导入预览并确认
→ 发布一个视频 Pin
→ 保存截图和 Pin URL
→ 模拟连接失败并安全重试
→ 模拟点击后断开并进入结果核验
→ 程序重启后任务状态不丢失
→ 重复任务被阻止
```

## 12. 参考资料

- [BitBrowser Browser Profiles API](https://doc.bitbrowser.net/api-docs/browser-profiles)
- [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Pinterest Create Boards and Pins](https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/)
- [Pinterest Community Guidelines](https://policy.pinterest.com/en-gb/community-guidelines)

## 13. 分阶段实现计划

每个阶段都必须有可运行结果和验收标准。ChatGPT 或开发人员一次只实现一个阶段，不跨阶段编写真实发布逻辑。

### 阶段 0：保留当前 Demo

范围：只做界面和模拟数据。

验收：运营人员可以点击体验导入、批次确认、任务队列、账号管理、异常处理和发布记录。

不接入 BitBrowser，不操作真实 Pinterest。

### 阶段 1：BitBrowser 连接

范围：只实现本机 API 连接。

```text
检测 API → 读取窗口列表 → 打开窗口 → 获取 CDP 地址 → 关闭连接
```

验收：

- 能判断 API 未启动、端口错误和窗口不存在。
- 能显示窗口名称和窗口 ID。
- 连接失败不会创建发布任务。

### 阶段 2：账号绑定与 Board 同步

范围：只实现一个窗口对应一个 Pinterest 账号。

```text
选择窗口 → 连接 Pinterest → 读取当前账号 → 读取 Board → 保存绑定
```

验收：

- 当前账号和已保存账号不一致时停止。
- 能显示 Board 名称和页面地址。
- Board 读取失败时显示简单的“需要处理”。

### 阶段 3：导入与任务矩阵

范围：只实现表格、视频和任务生成，不发布。

```text
读取 pins.xlsx → 校验视频 → 计算哈希 → 匹配账号和 Board → 生成导入预览
```

验收：

- 一个视频生成一个独立任务。
- 缺少视频、账号或 Board 的任务不能确认进入队列。
- 相同账号、Board、素材和内容版本的任务不能重复生成。

运营人员可以在导入预览中直接修改 Board、标题、描述和链接；点击“确认这批任务”后，任务才进入发布队列。不单独建立任务审核模块。

导入预览属于“导入与素材”页面的一部分，不单独设置导航项。一个导入包可以拆成多个批次，运营人员可以逐批修改、逐批确认；每次确认只把当前批次加入任务队列。

### 阶段 4：单账号单视频预演

范围：只允许一个账号、一个窗口、一个视频，并保留人工确认。

```text
确认导入预览 → 打开窗口 → 打开 Pinterest → 上传视频 → 填写内容 → 停在 Publish 前
```

验收：

- 页面每一步都有状态记录。
- 上传和字段填写成功后才允许进入下一步。
- 不点击 Publish，不产生真实发布。

### 阶段 5：单账号真实发布与证据

范围：在阶段 4 稳定后，才增加一次真实 Publish。

```text
发布前截图 → 点击 Publish 一次 → 等待结果 → 保存截图、HTML、Pin URL
```

验收：

- 明确得到 Pin URL 才标记已发布。
- 点击后断开时进入结果待核验。
- 不确定结果不能自动上传第二次。

### 阶段 6：多账号队列执行

范围：增加账号串行、多账号有限并行和立即执行队列。

验收：

- 同一账号同时只能执行一个任务。
- 同一窗口同时只能执行一个任务。
- 全局并发数可配置。
- 批次确认后立即进入队列，不设置单独发布时间。

### 阶段 7：异常恢复与重启

范围：增加连接重试、页面变化暂停、程序重启恢复和人工处理。

验收：

- BitBrowser 断开时可重新连接一次。
- 页面控件无法确认时停止并保存证据。
- 程序重启后不重复执行已点击 Publish 的任务。
- 运营人员只看到“重试、核验、暂不处理”等简单操作。

### 每个阶段的交付格式

每次实现只提交以下内容：

```text
本阶段目标
→ 修改的文件
→ 可运行入口
→ 验收步骤
→ 已知限制
```

禁止在同一阶段同时加入新的平台、新的 Pin 类型、自动点赞/关注/评论或复杂风控逻辑。
