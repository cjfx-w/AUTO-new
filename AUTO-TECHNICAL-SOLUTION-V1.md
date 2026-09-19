# AUTO 技术方案 v1

## 1. 职责边界

BitBrowser 负责窗口、代理/IP、指纹隔离、登录状态和 CDP 地址。

AUTO 负责窗口连接、账号识别、Board 同步、素材导入、任务队列、Pinterest 页面操作、结果核验和发布账本。

AUTO 不负责购买 IP、切换代理、保存密码/Cookie、绕过验证码或账号限制。

## 2. 连接链路

```text
AUTO → BitBrowser 本地 API
→ 读取窗口列表
→ 打开指定窗口
→ 获取 CDP 地址
→ Playwright connectOverCDP
→ 控制 Pinterest 页面
```

连接失败时只做有限重连；仍失败则暂停任务并提示运营人员。

## 3. 账号绑定

```text
选择窗口
→ 读取当前 Pinterest 账号
→ 读取 Board 列表
→ 保存窗口、账号和 Board 绑定
```

保存窗口 ID、Pinterest 主页地址、账号名、Board 名称和 Board 页面地址。账号不一致或 Board 读取失败时停止执行。

## 4. 导入与批次确认

```text
读取 pins.xlsx 和 media/
→ 校验字段和视频
→ 计算素材哈希
→ 展开“视频 × 账号 × Board”任务
→ 在导入页面按产品分批显示
→ 运营人员修改并确认某一批
→ 当前批次立即加入队列
```

不设置发布时间，不设置复杂排期。

## 5. 发布状态

```text
导入预览
→ 已确认
→ 排队中
→ 执行中
→ 已发布
```

异常状态：

```text
发布前失败：可重试
Publish 后不确定：人工核验
登录/验证/Board/页面异常：暂停账号
```

## 6. 发布执行

```text
打开对应 BitBrowser 窗口
→ 检查账号
→ 打开 Pinterest 创建 Pin
→ 上传单个视频
→ 等待视频处理完成
→ 填写标题、描述、链接
→ 选择 Board
→ 点击 Publish 一次
→ 读取 Pin URL 或成功状态
→ 保存截图、HTML、URL 和错误信息
```

页面控件无法确认时停止，不猜测点击。

## 7. 队列规则

- 同一账号串行。
- 同一窗口串行。
- 全局并发默认 2 个账号。
- 确认批次后立即执行。
- 失败递增等待，连续失败暂停账号。
- Publish 后不自动重复上传。

## 8. 防重复

```text
platform + account_id + board + asset_hash + content_version
```

每次执行保存独立 `attempt_id`。明确得到 Pin URL 才写入已发布记录。

## 9. 分阶段实现

1. Demo 界面和批次预览。
2. BitBrowser API 连接和窗口列表。
3. Pinterest 账号识别和 Board 同步。
4. 表格、视频和任务生成。
5. 单账号单视频预演，停在 Publish 前。
6. 单任务真实发布和证据保存。
7. 多账号有限并行、任务锁和失败恢复。

每阶段单独验收，未通过不得进入下一阶段。

## 10. 参考

- [BitBrowser API](https://doc.bitbrowser.net/api-docs/browser-profiles)
- [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Pinterest 创建 Boards 和 Pins](https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/)
