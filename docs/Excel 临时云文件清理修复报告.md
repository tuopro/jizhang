# Excel 临时云文件清理修复报告

日期：2026-09-22。范围：`客户往来记账小程序 / tuopro/jizhang`。

本轮完成本地即时清理修复、独立 48 小时 GC 云函数、自动测试和报告。没有部署、上传体验版、修改云存储权限、修改正式数据库、提交微信审核或推送本轮代码到 GitHub。

## 1. 残留原因：已确认的事实与尚未确认的部分

**不能仅凭本地源码确定 2026-09-21 20:28～20:29 那三份真实文件各自为什么残留。** 本轮没有读取正式云函数日志、下载线上已部署包或操作那三份文件；不能声称已经复现其具体失败原因。

修改前源码已经在下载流程的 `finally` 调用 `cleanupStatementExportFile`，最多尝试两次，然后才打开本地 Excel。用户正常查看 Excel 时已经发生了程序内部下载，不需要再手动点击“下载到本地”。微信文件转发使用本机 `filePath`，不存在“必须分享完才可以删除云文件”的依赖。因此不能把本次现象归因于“没有手动下载”或“分享成功后忘记加 cleanup”。

本地确认的缺陷及残留窗口：

1. `finally` 中先调用页面进度回调，再调用 cleanup。回调如果抛错，会跳过 cleanup；原页面没有针对异步导出完成前退出的保护。自动测试模拟回调抛错和页面退出，确认修复后仍能清理。**没有证据表明那三次真实操作一定发生了回调抛错。**
2. 两次 cleanup 失败时错误被吞掉，没有脱敏诊断日志；未限定清理调用的等待时间。原页面还会显示让用户联系管理员检查的内部清理状态。
3. 服务端在 `deleteFile` 没有返回有效结果时也会返回成功，可能产生“客户端认为已清理、实际未确认”的状态；不存在文件没有作为幂等成功处理。
4. 上传成功但返回响应丢失、客户端进程被杀、网络持续中断时，客户端可能拿不到 `fileID` 或无法执行 `finally`。客户端代码无法保证进程终止后继续运行，原实现没有服务端兜底扫描。
5. 原服务端路径判断采用 `includes(prefix)` 与 `.xlsx` 后缀，约束不够精确；本轮同时收紧为完整生成路径和归属判断。

后续如需追溯那三份文件，需要核对当时使用的小程序/ledger 版本及相应生成、删除调用日志；本轮没有把这些未核实项写成已确认根因。

## 2. 原生命周期 A–G 与修复后行为

| 问题 | 根据真实代码得出的结论 |
| --- | --- |
| A. 原 cleanup 何时调用 | 前端收到 `createStatementExcel` 的 `fileID` 后，下载成功或失败均进入 `finally`，尝试清理，失败再试一次。进度回调抛错、进程终止或从未拿到响应会妨碍此路径。 |
| B. 正常打开后是否调用 | 正常路径在 `wx.openDocument` **之前已经调用**，没有在关闭文档后再调用。 |
| C. 微信转发成功后是否调用 | 转发之前生成/下载阶段已尝试清理；分享成功回调没有重复删除，也无需依赖该回调删除。 |
| D. 用户取消分享后是否调用 | 同上，取消前已尝试清理；取消不会撤销清理，也不弹清理错误。 |
| E. 转发依赖什么 | `wx.shareFileMessage({filePath: this.excelFile.filePath})`，使用 `downloadFile` 返回的本机 `tempFilePath`，没有使用云端 URL/fileID 转发。 |
| F. 安全删除时点 | 确认下载成功得到非空本机路径后，即可清理云端，然后打开/分享本机文件。下载失败也尽力清理，本次导出失败后可重新生成。 |
| G. 三份真实残留的具体原因 | 未取得线上版本和调用日志，不能逐文件判定；以上源代码缺陷和不可避免的进程/网络窗口已经分别修复或加 GC 兜底。 |

最终流程：

```text
真实 OPENID → active membership → 服务端 tenant
→ 读取原对账单成交快照 → 原三 Sheet 工作簿 → 上传 statement-exports/
→ 返回 fileID → wx.cloud.downloadFile → 确认本机 tempFilePath
→ finally 中清理云文件（最多两次，每次等待上限 6 秒）
→ wx.openDocument / wx.shareFileMessage 使用本机文件
```

- 即时清理仍为主机制；常规成功时立即清理，不等打开、分享或页面关闭。
- 进度回调异常不能中断清理；页面退出后回调仍执行清理，但不再更新退出页面或自动打开文档。
- cleanup 两次失败或超时仍保留可用的本机文件，页面只显示“Excel 已准备好，可打开或发送”。清理错误不弹窗，不改账单数据。
- 打开失败、分享失败或取消均不会跳过此前的清理。打开/分享本身的失败沿用已有处理；取消分享不弹错误。
- 超时只是停止等待，不是取消云函数；迟到的删除与重试可能重叠，服务端幂等处理保证重复调用可接受。
- 云端生成器在上传前计算下载文件名，减少上传后的可抛错操作；若已取得 `fileID` 后本地构造响应失败，会补偿清理。上传响应未返回/进程终止的情况仍由 GC 兜底。服务端本地临时工作簿仍在 `finally` 删除。

## 3. 即时 cleanup 的授权和删除边界

既有 `ledger/index.js` 路由保持不变：实际 `cloud.getWXContext().OPENID` → 读取真实 membership → `requireActiveMembership` → 以 membership 的 `tenantId` 和 `id` 构造归属前缀。陌生微信、成员停用、成员删除、缺失 OPENID 均在文件删除前拒绝。

只接受完整 CloudBase fileID，逻辑路径必须满足：

```text
statement-exports/<24位tenant SHA256前缀>/<24位member SHA256前缀>/
<10至16位时间戳>-<24位随机十六进制>.xlsx
```

实际实现为单行路径。tenant/member hash 使用真实 membership 生成并比对；有真实 `WXContext.ENV` 时还核对 fileID 环境部分。前端传入的 tenantId、role、memberId、status 不参与授权。禁止其它企业/成员、其它目录、嵌套伪造前缀、图片、手工任意命名文件、路径穿越、编码路径和查询串。

删除后按请求的完整 `fileID` 查找对应返回项，不能只取数组第一项；缺失/错配结果视为“未确认”，不会报成功。成功状态 `0` 或官方不存在码 `-503003 / STORAGE_FILE_NONEXIST / TCB_STORAGE_FILE_NOT_EXISTS` 等按幂等成功处理。

没有新增 ledger action，`PUBLIC_ACTIONS` 仍为原有邀请相关入口；其它业务权限没有变化。

## 4. 48 小时 GC 的实现与实际可用边界

新增独立云函数 `cloudfunctions/statement-export-gc`，入口不读取 event 参数。它不会接收请求指定的 prefix、directory、fileID、tenantId、cutoff、age 或 deleteAll；伪造 `Type/TriggerName` 不构成授权。真实 `WXContext.OPENID` 非空时直接拒绝小程序主动调用；其它入口即使被触发，也只能执行以下固定逻辑。

| 项目 | 固定行为 |
| --- | --- |
| 扫描范围 | 当前服务端环境的 `statement-exports/`；共享桶时先加当前环境的真实 BasePath，不能扫其它环境目录。 |
| 文件类型 | 只认与即时 cleanup 相同的本项目生成 `.xlsx` 完整路径格式。 |
| 时间门槛 | 本轮服务端开始时间减 `48 * 60 * 60 * 1000`；只比较真实存储 `LastModified`，不按文件名时间戳删除。 |
| 绝对时间 | 支持带明确时区的 ISO 时间或 HTTP GMT；无时区、不可解析及未来时间不进入删除候选。 |
| 删除前复核 | 对候选执行 HEAD，读取 `last-modified`，再次核对年龄、原时间和 ETag；已更新/替换的候选跳过。不能把 HTTP `Date` 当作文件最后修改时间。 |
| 分页 | 使用 COS 字典序 Marker 分页，每页最多 100 条；跨 tenant/member 子目录继续扫描，删除后不会因 offset 移位漏页。 |
| 上限 | 每次最多扫描 1000 条、最多尝试删除 200 个、每批最多 20 个；40 秒为启动后续批次的软时间预算，单次外部操作最多等待 8 秒。 |
| 进度 | 每个已处理页/部分页保存游标，下一次从游标继续；完整扫描后重置，从头覆盖新文件和上轮失败项。 |
| 部分失败 | 记录成功、失败、缺失、变化等计数和脱敏 code，其它文件继续处理。列表顺序/范围/续页异常时停止，不能继续扩大范围。 |
| 重复运行 | 已不存在文件视为幂等；并发调用可能重复扫描，但每次均执行同一固定路径和年龄校验。 |

进度保存在唯一固定的云存储对象 `statement-exports/.gc-cursor.json`，内容只有 `{version, marker}`，marker 使用哈希路径，不含客户/账单正文。**这是新增的一个小型存储对象，不是数据库集合或数据库字段**；它不是 Excel，不参加删除。损坏或不存在时安全从头扫描，不改 ACL。若平台不能读取/写入该对象，函数记录失败，不假装完成续跑。

定时器配置为每小时整点一次：`0 0 * * * * *`（平台七段 cron）。在触发器正常运行、权限可用、无积压和删除错误时，残留通常在达到 48 小时后的约一小时内处理。超过单次上限、持续网络/权限故障或积压时可能更晚，不能承诺 49 小时硬上限。

本项目导出使用时间戳加 96 bit 随机名，每次新建，不覆盖原 key。新文件即使在扫描中出现，真实 LastModified 未满 48 小时也不会删除；列表后更新会在 HEAD 复核时跳过。HEAD 与删除不是存储事务，本轮没有宣称支持外部人为在两步之间覆盖同名对象的原子条件删除；本项目正常生成路径不会复用这些 key。

## 5. SDK、运行时身份及依赖

- 本地既有 `wx-server-sdk 4.0.2` / `@cloudbase/node-sdk 3.17.2` 有上传、下载和删除接口，没有可用的文件枚举接口。
- 已核对官方 Manager SDK 文档及 `@cloudbase/manager-node 5.8.8` 发布源码：云函数内可省略显式 SecretId/SecretKey，SDK 从 SCF 环境读取运行时身份；session token 表示临时凭证。
- 独立 GC 包锁定 `@cloudbase/manager-node: 5.8.8`、`wx-server-sdk: 4.0.2`，新增自己的 `package-lock.json`。ledger 依赖没有修改，小程序前端没有新增依赖。
- GC 只在 `TENCENTCLOUD_RUNENV === SCF` 且运行时 ID、Key、**SessionToken 同时存在**时启用；要求 token，避免无 token 的长期密钥降级。没有硬编码、索取、读取本机凭据文件或新增任何真实长期密钥值；源码只有官方环境变量名，测试只有明确的 mock 占位值。
- 环境 ID 只取服务端 `TCB_ENV / SCF_NAMESPACE`，桶及共享前缀来自 Manager 当前环境元数据。SDK 默认目录辅助函数会聚合全目录，本轮使用同一 SDK 创建的 COS 客户端做有限分页和 HEAD；固定 SDK 版本以便复核适配器。
- **未部署，所以未验证这个微信云环境是否实际注入所需临时身份，以及该身份是否具备环境元数据查询、列对象、HEAD、删除、游标读写能力。** 缺失身份返回 `GC_CREDENTIALS_UNAVAILABLE`，权限错误按脱敏 code 记录并停止相应操作，不用永久密钥补齐。本地模拟通过不能等同正式 GC 已可运行。

官方依据：

1. [Manager SDK 初始化和临时凭证](https://docs.cloudbase.net/api-reference/manager/node/introduction)。
2. [Manager SDK 存储与文件列表](https://docs.cloudbase.net/api-reference/manager/node/storage)。
3. [云函数定时触发器及上传触发器](https://docs.cloudbase.net/cloud-function/timer-trigger)。
4. [wx.openDocument 本机文件路径](https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.openDocument.html)。
5. [wx.shareFileMessage 本机或临时文件路径](https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareFileMessage.html)。

## 6. 日志、业务和数据保护

清理日志仅输出固定标签、尝试次数、扫描/候选/删除/失败等计数及白名单/数字 code。未知错误 code 归一化，不打印完整 fileID、原始错误正文、openid、客户名、联系人、电话、地址、商品/账目正文、Excel 内容或 inviteToken。

正式云存储“仅创建者可读写”设置没有读取或修改；适配器没有 set ACL 操作。没有新建数据库集合、字段、索引或迁移，没有修改正式账目或历史 shipment。

修改前保存了 177 个文件的 SHA256 基线，目录为 `/private/tmp/ledger-excel-cleanup-20260922-baseline/`。最终核验结果 170 个文件完全一致，7 个已有文件变化仅为即时清理、页面异步生命周期、共享策略检查、两处旧测试夹具适配和本轮偏好进度记录。以下实现保持原样：

- `cloudfunctions/ledger/services/statement-excel.js`：三个 Sheet、字段、样式和工作簿内容。
- `services/statement-export.js` 及云端副本、`statement-export-cloud.js`：历史成交快照和对账单来源。
- 图片 renderer、paginator、图片导出页面及图片导出 client。
- 两份 ledger repository、cloud repository、ledger 入口、access-control、content-security、隐私逻辑和既有配置。

不重读当前产品价覆盖历史成交，收款、运费、账期、金额、图片账单计算和客户价格权限均未改。

## 7. 自动测试与回归

新增 62 项测试，原 388 项继续通过：**`npm test` 450/450 通过，0 失败、0 跳过。**

`npm run check` 通过：24 页面、107 个 JavaScript、24 WXML、25 WXSS；包括微信原生 WXML/WXSS 编译及两个清理策略副本完全一致检查。`git diff --check` 通过。

| 用户要求的测试编号 | 覆盖情况 |
| --- | --- |
| 1–7 正常打开/分享、云端删除不影响本机、成功/取消/失败清理 | `excel-cleanup-security.test.js` 实际页面脚本及真实导出 client；断言 cleanup 发生在打开和分享之前。原 `excel-export-client.test.js` 保留下载失败清理测试。 |
| 8 页面退出 | 下载中退出页面，收到回调后仍删除且不更新退出页面；回调抛错也能清理。进程强杀无法执行本地代码，GC 残留测试验证后续服务端处理算法，未伪称模拟了真机强杀。 |
| 9–10 有限重试、两次失败 | 首次失败重试成功；两次失败仍返回本机文件；未确认结果及挂起调用超时最多两次，不写账务。 |
| 11–13 幂等、目录限制、身份伪造 | 官方不存在码、错配结果、跨成员/企业/环境、目录穿越/图片/非生成文件拒绝；真实 ledger 入口验证 active/disabled/删除/陌生/无 OPENID 及伪造身份，数据库快照前后相同。 |
| 14–17 年龄、真实时间、类型/目录 | 47h59m/48h/48h以上/未来/时区/无效时间；文件名时间戳不参与判断；非 xlsx、非项目路径及游标不删。 |
| 18–22 分页、上限、部分失败、幂等、扫描中新建 | 跨目录多页、删除后 marker 续页、1000 扫描/200 删除/20 批量上限、冷启动持久游标、软时间预算、部分及全批失败、重复运行、新文件/HEAD更新/ETag变化。 |
| 23–24 伪造 event | 执行真正 GC 入口和筛选算法，伪造 prefix/cutoff/age/deleteAll/fileID/tenantId/Type 无效；真实 OPENID 调用在创建 adapter 前拒绝。 |
| 25 三 Sheet/原 Excel 内容 | 原真实生成并回读 xlsx 的 sheet/金额/快照/样式测试全部继续通过；工作簿实现 SHA 不变。 |
| 26 图片导出 | 原图片模型/分页/历史快照相关测试全部通过，图片实现 SHA 不变。 |
| 27 数据库不变 | 真实 ledger cleanup 入口的只读数据库 mock 拒绝写事务，快照不变；原上传失败测试继续验证账务不变。GC 没有数据库适配器。 |
| 28 存储权限不变 | GC adapter mock 断言游标写入没有 ACL 参数；既有配置不变，本轮没有执行云端配置工具。 |

另外覆盖：无临时 token 拒绝、当前环境及共享桶隔离、无效游标/列表拒绝、异常日志脱敏、`HEAD Date` 不能代替 `LastModified`。全部采用合成数据和可控存储 mock，没有访问正式云文件列表或真实数据库。

## 8. 修改文件

| 文件 | 作用 |
| --- | --- |
| `services/excel-export-client.js` | finally 可靠性、确认清理结果、两次有限重试、超时和脱敏日志。 |
| `pages/statement/statement.js` | 页面退出保护、沿用本机打开/分享、隐藏内部清理错误。 |
| `cloudfunctions/ledger/services/statement-export-file.js` | 完整路径和归属校验、删除结果确认/幂等、生成异常清理。 |
| `cloudfunctions/ledger/services/export-file-policy.js`（新增） | 路径格式、官方缺失码及日志 code 白名单。 |
| `cloudfunctions/statement-export-gc/index.js`（新增） | 固定 GC 入口、真实客户端拒绝、统计日志。 |
| `cloudfunctions/statement-export-gc/services/gc.js`（新增） | 固定年龄、分页、HEAD复核、批次/时间上限及续跑。 |
| `cloudfunctions/statement-export-gc/services/storage-adapter.js`（新增） | 官方临时身份、真实当前环境存储、COS分页/HEAD/游标与云存储删除。 |
| `cloudfunctions/statement-export-gc/services/export-file-policy.js`（新增） | 与 ledger 同步的独立可部署策略副本。 |
| `cloudfunctions/statement-export-gc/package.json`、`package-lock.json`、`config.json`（新增） | 隔离依赖锁定、Node >=18要求、每小时触发器配置。 |
| `tests/excel-cleanup-security.test.js`、`tests/statement-export-gc.test.js`、`tests/statement-export-gc-adapter.test.js`（新增） | 62 项生命周期、安全、筛选及适配器测试。 |
| `tests/statement-excel.test.js`、`tests/performance-cloud.test.js` | 将旧随意文件名和删除返回 mock 换成真实生成格式/fileID，对应原测试含义不变。 |
| `scripts/check-project.js` | 增加两份清理策略一致性检查。 |
| 本报告、`PREFERENCES.md` | 记录实际结果及未部署状态。 |

## 9. 最终 21 项答复与后续生效步骤

| 编号 | 答复 |
| --- | --- |
| 1 昨天为什么残留 | 单个文件原因尚未查明；确认存在进度回调跳过清理、失败无日志、删除未确认误报及无GC等源码缺陷，见第1节。 |
| 2 原哪些路径未执行 | finally前的进度回调抛错、未取得fileID、进程终止可无法执行；正常打开/分享/取消分享前原本已尝试，不是缺少分享后调用。 |
| 3 最终何时清理 | 下载回调取得本地路径后、打开/分享前；下载失败也在finally尽力清理。 |
| 4 分享依赖 | 本机tempFilePath，不依赖已删除云文件。 |
| 5 失败处理 | 最多两次、每次等待6秒；安全日志，本地文件仍可用，残留等GC。 |
| 6 GC实现 | 独立云函数、官方运行时临时身份、固定prefix+真实LastModified、分页批量删除及云对象游标。 |
| 7 频率 | 本地配置每小时整点；尚未上传触发器。 |
| 8 48h依据 | 存储真实LastModified与服务端绝对时间，删除前HEAD复核。 |
| 9 其它文件保护 | 当前真实环境范围、固定完整生成路径、年龄门槛、HEAD复核、event全部忽略；即时清理再加tenant/member归属。 |
| 10 新密钥/凭证 | 没有新建/保存长期密钥；使用平台已有运行时临时身份，要求session token。真实环境能力待部署后核实。 |
| 11 新依赖 | 仅独立GC包加入锁定版本的Manager SDK和wx-server-sdk；ledger依赖不变。 |
| 12 新云函数 | 本地新增statement-export-gc，未部署。 |
| 13 新定时触发器 | 本地新增statementExportGcHourly配置，未上传或启用。 |
| 14 数据库集合/字段 | 没有。增加的是一个固定云存储游标对象。 |
| 15 云存储权限 | 没改，“仅创建者可读写”保持原状。 |
| 16 测试 | 450/450、24页原生编译、git diff --check全部通过；云端身份、触发器和真机未验收。 |
| 17 重新部署ledger | 后续需要，才能使即时删除结果校验和幂等修复生效；本轮未部署。 |
| 18 部署新GC | 后续需要部署statement-export-gc并云端安装其依赖，验证运行时临时身份/操作权限；本轮未部署。 |
| 19 开发者工具操作 | 后续部署该函数后，右键该云函数→“上传触发器”，再核对每小时触发及执行日志；只上传函数源码不等于触发器已部署。 |
| 20 重新上传体验版 | 后续需要，前端finally/页面退出/内部提示修复属于小程序代码。 |
| 21 数据库迁移 | 不需要。 |

未来获得部署授权后，新 GC 使用 Node >=18 的可用运行时；建议函数超时给到120秒，以容纳40秒软预算和外部操作/保存游标开销。先确认官方临时身份及读列表/HEAD/删除/游标权限能工作，不能用永久密钥绕过缺失能力。原“仅创建者可读写”设置保持不变。届时需另做真机打开、微信转发和正常文件即时删除验收，并观察真实定时触发日志。

**本轮止于本地代码、测试和报告；没有清理用户现有三份云文件，也没有让正式环境中的48小时GC开始运行。**
