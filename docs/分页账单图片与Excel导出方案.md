# 分页账单图片与 Excel 导出方案

> 状态：第一版已按本方案实现，2026-09-21。PDF 仍暂缓；正式上线前还需部署云函数并完成体验版真机验收。

## 实现结果

- 已增加受 active membership 保护的 `getStatementExportMeta`、`getStatementExportPage`、`createStatementExcel`、`cleanupStatementExportFile` 四个 action；均不在 `PUBLIC_ACTIONS`。
- 分页图片由小程序前端 Canvas 按 `1242 × 1756 px` 生成，支持预览全部、保存全部、分享当前页和前后翻页。
- Excel 由 `ledger` 云函数使用 ExcelJS 4.4.0 生成，包含“账单汇总、发货明细、收款明细”三个 Sheet；客户端下载后立即请求删除云端临时文件。
- 未新增数据库集合、数据库字段、迁移或账务写入；PDF 未实现。

## 结论

第一版按以下顺序开发：

1. 分页表格图片：前端逐页绘制，支持预览全部、保存全部、分享当前页。
2. Excel：云端在真实微信身份和企业归属校验后生成，客户端下载后打开或分享。
3. PDF：暂缓；以后复用同一份只读账单导出数据，不另写一套金额计算。

不做无限长图，也不把账单做成海报。图片采用固定页面、固定表头、动态行高和可预测分页；Excel 保留真实成交快照、原数量单位和计价数量单位。

## 1. 当前现有对账单数据结构梳理

现有页面通过 `repository.getStatement(tenantId, clientId, periodId)` 读取账单。正式云端的 `tenantId` 不是前端传入的，而是云函数根据 `cloud.getWXContext().OPENID` 查到 `active membership` 后取得。当前账单对象包括：

### 企业与客户

- 企业：`id、name、contact、phone、address、defaultUnit`。
- 客户：`id、name、contact、phone、settlementDay、note、ownerMemberId、ownerNameSnapshot` 等。
- 当前开放账期使用当前客户名称；已结清历史账期优先使用真实发货/收款记录已有的 `clientNameSnapshot`，没有快照时才回退当前客户名称。现有账期没有独立企业名称快照，企业名称继续使用当前企业资料；不回填、不迁移历史数据。

### 账期

- 标识：`id、clientId、sequenceNo`。
- 状态：`open` 或兼容历史的 `settled / closed`。
- 日期：`startDate`；已结清账期有 `closedDate`。进行中账期的预览结束日为生成当日或最后业务日中的较晚者，导出文案应写“截至日期”，不写“结清日期”。
- 负责人：`ownerMemberId、ownerNameSnapshot / ownerDisplayName`。
- 汇总：`itemsSubtotalCents、freightCents、shipmentTotalCents、receivedCents、outstandingCents、shipmentCount`。
- 账期边界由人工结清决定，不按自然月切分；标题必须使用“第 N 期”。

### 发货

每笔发货实际存在：

- `id、periodId、shipmentDate、clientNameSnapshot`。
- `createdByMemberId、createdByNameSnapshot`。
- `logistics.provider、logistics.raw、note、sourceText`。
- `itemsSubtotalCents、freightCents、totalAmountCents`。
- `lines[]` 商品行。

每个商品行实际存在：

- `id、productId`。
- `productSnapshot.label、name、height、width、color、toothType、productType、lengthDescription、unitLengthMeters、specialTags` 等成交时产品快照。
- `originalQuantity、originalUnit`：客户实际发货数量和单位。
- `pricingQuantity、pricingUnit`：实际计价数量和计价单位。
- `conversion`：人工确认过的单位换算关系；同单位时为空。
- `unitPriceCents、lineAmountCents`：成交单价和商品金额。

导出必须直接使用这些成交快照，不能重新查询当前客户价格，也不能按当前产品资料重算历史名称、规格、单位或价格。

### 收款

每笔收款实际存在：

- `id、periodId、paymentDate、amountCents、method、note`。
- `createdByMemberId、createdByNameSnapshot`。

当前没有独立的银行流水号、付款账号或凭证附件字段，Excel 不虚构这些列。

### 当前实现需要注意的容量边界

当前 `bootstrap` 按企业读取各集合快照，每个集合查询上限为 1000 条；页面中的 `getStatement` 再从该快照组装账单。正式导出不能把“当前快照刚好够用”当成超大账单方案。开发时应增加只读的账单导出查询，按真实 `tenantId + periodId` 分批读取目标发货和收款，而不是把全企业数据再次发给前端。

## 2. 图片页面尺寸建议

- 固定竖版：`1242 × 1756 px`，接近 A4 比例，适合手机微信查看，也便于黑白打印。
- 页面左右安全边距：`56 px`；实际表格宽度约 `1130 px`。
- 白底、1–2 px 中性灰表格线、深色正文；金额右对齐。
- 标题 42–46 px，企业/客户/账期信息 30–34 px，表头 28–30 px，正文 28–30 px，页脚 24–26 px。
- 不使用渐变、纹理、大面积色块或装饰图。状态只用文字和浅灰/浅蓝底，黑白打印时仍能区分。
- 建议列宽：日期 132、产品/规格 430、数量 128、单位 80、单价 170、商品金额 190 px。

图片使用固定像素尺寸，而不是根据内容改变高度。每页都重复企业名称、客户名称、第 N 期、起止/截至日期、当前明细表头和“第 X / Y 页”。

## 3. 每页建议容纳多少行

不能只用固定行数分页，因为产品名可能换行。分页应按实际像素高度计算：

- 单行产品名：商品行约 82–88 px。
- 两行产品名：商品行约 112–124 px。
- 发货分组小计区：约 118–138 px。
- 收款行：约 76–88 px；有长备注时动态增高。

在上述页面尺寸下：

- 普通发货页建议约 9–11 个单行商品行。
- 多个发货分组或较多双行产品名时，通常约 6–9 个商品行。
- 纯收款页通常约 12–15 条收款记录。
- 最后一页因需保留总汇总区域，明细容量会减少；必要时自动增加一张最终汇总页。

界面不向用户承诺固定“每页 10 行”，只显示最终计算出的页数。

## 4. 自动分页算法

先把账单转换成只读导出 DTO，再生成可测量的块：

1. `documentHeader`：企业、客户、账期、日期。
2. `shipmentGroup`：一笔发货，内含商品行和分组汇总。
3. `paymentSection`：收款标题、收款行。
4. `grandSummary`：商品总额、运费总额、应收、已收、剩余应收。
5. `pageFooter`：页码与生成时间。

分页采用“两遍计算”：

1. 第一遍用与最终 Canvas 完全相同的字体、列宽、行距测量每个块的真实高度，生成页面模型。
2. 第二遍按页面模型绘制，得到确定的总页数和“第 X / Y 页”。

每页预先扣除页头、对应表头和页脚的固定高度。最后一页还要预留总汇总高度。任何商品行或收款行只有在完整高度可放下时才进入当前页，否则整体移到下一页；绝不从文字中间裁切。

输出顺序建议改为业务日期正序、同日按创建时间正序，便于客户从前往后核对。排序只作用于导出副本，不修改数据库顺序。

## 5. 发货分组如何分页

每笔发货是一组：

- 第一商品行显示日期和发货编号短标识；组内后续商品行的日期单元格留空。
- 商品行后只出现一次“商品小计、运费、本次合计”。
- 物流和备注存在时，放在分组汇总下方的小字信息行，不虚构物流单号。

分页规则：

1. 整组能放入当前页：直接放入。
2. 当前页放不下，但整组能放入新页：整组移到新页，避免拆分。
3. 整组本身超过一页：允许按商品行拆分。
4. 第一段标记正常发货日期；后续页面标记“YYYY-MM-DD · 发货编号…（续）”。
5. 中间段页尾写“本次发货未完，续下页”，不重复运费和本次合计。
6. 只有最后一段显示商品小计、运费和本次合计。
7. 最后一条商品行应尽量与分组汇总放在同页，避免出现只有汇总没有商品的孤页。

## 6. 收款如何分页

收款排在全部发货明细之后，使用独立表头：日期、方式、金额、备注、操作人。

- 第一页标题为“收款记录”，后续页为“收款记录（续）”。
- 收款按日期正序、同日按创建时间正序。
- 单条收款记录不可跨页；备注换行导致的高度纳入测量。
- 没有收款时显示一行“暂无收款”，仍在最后显示汇总。
- 如果收款记录与汇总不能同时放下，汇总移到新的最终页，不压缩字体或遮挡内容。

## 7. 汇总如何显示

最终一页底部固定显示：

- 商品总额
- 运费总额
- 应收总额
- 已收金额
- 剩余应收

“剩余应收”使用较粗字重和金额强调色，其他金额保持中性。已结清账期显示“已结清”；进行中账期显示“进行中 / 截至 YYYY-MM-DD”。

汇总金额直接使用服务端账期汇总，并在生成 DTO 时再次校验：

- 商品行金额之和 = 商品总额。
- 各发货运费之和 = 运费总额。
- 商品总额 + 运费总额 = 应收总额。
- 收款之和 = 已收金额。
- `max(应收 - 已收, 0) = 剩余应收`。

校验失败时停止生成并提示“账单数据校验失败，请勿对外发送”，不自行修正或回写正式数据。

## 8. 超长产品名称怎么处理

- 产品/规格列允许自动换行，行高随内容增加，金额列不被挤压。
- 标准情况最多使用 3 行正文，不使用省略号丢失正式名称。
- 超过 3 行时，追加同一商品的“名称续行”；商品主行和名称续行视为一个不可拆分原子块，优先整体移到下一页。
- 只有当该原子块本身接近整页高度时，才逐级缩小产品列字号，最低不低于 24 px；仍放不下则停止图片生成并提示改用 Excel，不能裁字。
- Excel 永远保存完整名称和完整成交快照，不截断。

## 9. 超大账单怎么处理

- 服务端按 `tenantId + periodId` 分批读取，不依赖全企业 1000 条快照上限。
- 客户端按页模型逐批生成，完成一页就写成本地临时文件，避免同时保留所有 Canvas 像素缓冲。
- UI 显示“已生成 X / Y 页”，允许取消；取消只清理本次临时文件，不触碰账务数据。
- 建议第一版设置保护阈值：超过 80 张图片或 800 个商品/收款行时，不再建议生成微信图片，直接推荐 Excel。阈值是设备稳定性保护，不是数据截断；用户仍可生成完整 Excel。
- Excel 采用流式/分段写入，不能把超大工作簿 Base64 塞进云函数返回值。
- 任意错误都不输出“部分账单”供对外分享；可以保留内部错误页数用于重试，但必须明确未完成。

## 10. Excel 字段设计

### Sheet 1：账单汇总

| 字段 | 真实来源/说明 |
| --- | --- |
| 企业名称 | `enterprise.name` |
| 客户名称 | 当前 `client.name`，与小程序预览一致 |
| 账期 | `第 sequenceNo 期` |
| 状态 | 进行中 / 已结清 |
| 开始日期 | `period.startDate` |
| 截至日期 / 结清日期 | 进行中写生成截止日；已结清写 `closedDate` |
| 负责人 | `ownerNameSnapshot / ownerDisplayName` |
| 商品总额 | `itemsSubtotalCents` |
| 运费总额 | `freightCents` |
| 应收总额 | `shipmentTotalCents` |
| 已收金额 | `receivedCents` |
| 剩余应收 | `outstandingCents` |
| 发货次数 | `shipmentCount` |
| 生成时间 | 本次导出时间，不写回账期 |

### Sheet 2：发货明细

建议最终列：

1. 发货日期：`shipmentDate`
2. 发货编号：`shipment.id`
3. 产品名称：优先 `productSnapshot.name`，没有时使用 `productSnapshot.label`
4. 规格：从快照中实际存在的 `height、width、productType、lengthDescription` 组合；字段不存在则留空，不猜
5. 颜色：`productSnapshot.color`，不存在留空
6. 齿型：`productSnapshot.toothType`，盖子或自定义产品没有时留空
7. 原数量：`originalQuantity`
8. 原单位：`originalUnit`
9. 计价数量：`pricingQuantity`
10. 计价单位：`pricingUnit`
11. 换算关系：`conversion`，同单位时留空
12. 单价（元）：`unitPriceCents / 100`
13. 商品金额（元）：`lineAmountCents / 100`
14. 本笔商品小计（元）：`itemsSubtotalCents`
15. 本笔运费（元）：`freightCents`
16. 本笔总额（元）：`totalAmountCents`
17. 物流：`logistics.provider`
18. 物流原文：`logistics.raw`，为空则留空
19. 发货备注：`shipment.note`
20. 录入人：`createdByNameSnapshot`

一笔发货有多个商品时，第 14–20 列只在该发货的第一条商品行填写，后续商品行留空，避免用户对 Excel 求和时重复计算整笔运费和总额。金额单元格使用数值格式，不写成带“¥”的文本。

### Sheet 3：收款明细

1. 收款日期：`paymentDate`
2. 收款编号：`payment.id`
3. 收款金额（元）：`amountCents / 100`
4. 收款方式：`method`
5. 备注：`note`
6. 操作人：`createdByNameSnapshot`

所有 sheet 冻结表头、开启筛选、设置打印区域和金额格式；不使用宏、外链公式或隐藏业务数据。

## 11. 是否需要云函数

需要，但用途要分开：

- 分页图片绘制本身放前端，不需要把客户账单图片上传云端。
- 正式导出数据建议增加受保护的只读 action，服务端按真实 membership 取得 `tenantId`，只读取目标账期并分批返回规范化 DTO。
- Excel 在云端生成，避免小程序端引入大型工作簿库、内存不足和不同机型兼容问题。

第一版优先在现有 `ledger` 云函数内增加独立的导出服务模块和受保护 action，复用现有身份、tenant 和错误处理，不新建公开入口。若 Excel 依赖导致函数包体或冷启动不可接受，再拆成独立云函数；拆分时也必须复制同等级的真实身份校验，不能信任前端 `tenantId`。

## 12. 文件生成放前端还是云端

| 输出 | 生成位置 | 原因 |
| --- | --- | --- |
| 分页 PNG | 前端 Canvas | 可即时预览；临时图片不必上传；降低账单外泄面 |
| Excel | 云函数 | 适合结构化工作簿、超长数据和稳定格式；客户端只负责下载/打开/分享 |
| PDF | 暂缓 | 以后复用同一 DTO 和服务端版式，不另算金额 |

前端只负责展示、分页和绘制，不负责重新计算价格或修改历史；云端导出服务只读业务数据。

## 13. 临时文件生命周期

### 图片

- `wx.canvasToTempFilePath` 返回本地临时路径，只用于本次预览、保存和分享。
- 页面退出、生成新账单或失败时清理内存中的路径引用；不能把临时路径当永久档案。
- 用户点“保存全部”后，逐页调用 `wx.saveImageToPhotosAlbum`。保存到系统相册后的副本由用户管理。

### Excel

- 云端使用随机、不含企业名和客户名的路径，例如 `statement-exports/{tenantHash}/{timestamp}-{random}.xlsx`。
- 文件设为私有；不返回永久公开 URL。微信官方当前说明：私有云文件换取的临时 URL 有效期为 10 分钟。
- 客户端下载到本地临时路径后立即允许 `wx.openDocument(showMenu: true)` 或 `wx.shareFileMessage`。
- 下载成功后调用清理 action 删除云端临时文件；客户端异常退出导致未删除时，由每日清理任务兜底删除超过 24 小时的导出文件。
- 清理只作用于专用 `statement-exports/` 前缀，不扫描或删除其他云文件；不新增业务集合，不改账务数据。

## 14. 微信端保存 / 分享流程

### 分页图片

1. 对账单页点击“生成分享图片”。
2. 服务端校验当前真实 membership 和目标账期归属，返回只读导出数据。
3. 前端完成分页并显示缩略图、页数和生成进度。
4. “预览全部”：调用 `wx.previewImage({ urls })`，一次浏览全部页面。
5. “保存全部”：在用户主动点击后，申请相册权限并逐张保存，显示 `已保存 X / Y`；中途失败可从失败页重试。
6. “分享当前页”：对当前页调用 `wx.showShareImageMenu({ path })`。
7. 需要一次发送多张时，建议用户先“保存全部”，再到微信聊天中从相册多选发送。

微信官方当前 `wx.showShareImageMenu` 只接收一个 `path`；没有稳定接口让小程序一次自动把多张图片作为一组发到聊天。`wx.previewImage` 虽可接收多个 `urls`，发送行为仍由用户在预览菜单中主动完成。因此不做自动连续拉起多个分享弹窗，也不模拟点击微信聊天界面。

### Excel

1. 点击“导出 Excel”。
2. 云端生成并返回私有文件标识。
3. 客户端下载到本地临时路径。
4. 提供“打开查看”和“发送文件”两个按钮：分别使用 `wx.openDocument({ showMenu: true, fileType: 'xlsx' })` 与 `wx.shareFileMessage`。

## 15. 对现有代码的影响范围

预计增量，不改现有记账协议和业务判断：

- `pages/statement/`：增加导出入口、生成进度、分页预览和失败重试。
- 新增账单图片 Canvas 组件/页面：只接收导出 DTO。
- `services/`：增加前端分页测量、绘制和导出客户端；不放价格或账期业务规则。
- `cloudfunctions/ledger/index.js`：增加受 `active membership` 保护的只读导出 action。
- `cloudfunctions/ledger/services/statement-export.js`：按 tenant 和 period 读取、校验、组装 DTO、生成 Excel。
- `cloudfunctions/ledger/package.json`：若采用 ExcelJS，增加并锁定版本；部署时必须云端安装依赖。
- 自动测试：导出数据边界、跨 tenant、disabled/unauthorized、分页算法、长名称、超大账单、金额校验、临时文件清理。
- 部署文档与隐私盘点：补充账单临时文件、相册保存权限和微信文件分享说明。

不需要数据库迁移，不修改 `shipments、payments、billing_periods` 结构，不改变 `getStatement` 当前页面行为，不新增价格计算或历史回写。

## 16. 安全风险与控制

| 风险 | 控制 |
| --- | --- |
| 前端伪造 `tenantId` 导出他企账单 | 云函数只从真实 OPENID 对应的 active membership 取 tenant；查询同时带 tenantId 和 periodId |
| 猜测 periodId 越权 | 找不到当前 tenant 下匹配账期时统一返回不存在/无权限，不暴露他企是否存在 |
| disabled / unauthorized 仍导出 | 每次生成和分批读取都重新校验 membership；不能只依赖页面已登录状态 |
| 历史价格被当前价覆盖 | 只读 `productSnapshot、unitPriceCents、lineAmountCents`，不查询当前客户价重算 |
| 导出时写回或修复账务 | DTO 校验失败即停止；绝不自动修正数据库、快照或汇总 |
| 云文件被长期暴露 | 私有存储、随机路径、短期 URL、下载后立即删、24 小时兜底清理 |
| 文件名泄露客户信息 | 云端对象名不含企业/客户名；可读文件名只在本地分享时设置 |
| Canvas/Excel 公式注入 | 所有 Excel 文本以普通字符串写入；以 `=、+、-、@` 开头的用户文本转义，不生成外链或宏 |
| 超大账单耗尽内存 | 服务端分页查询、客户端逐页落盘、Excel 流式写入、设备保护阈值 |
| 相册权限被拒绝 | 保留预览和逐页分享；说明用途并允许用户以后在设置中开启，不循环弹授权 |
| 部分生成被误发 | 只有全部页和金额校验成功后才开放“保存全部/分享”；失败结果明确标记不可发送 |

导出内容本身包含客户名称、金额、可能的联系人/备注，属于敏感经营数据。页面不默认勾选联系人、电话、企业地址；第一版图片和 Excel 默认只包含本方案列出的对账必要字段。

## 17. 开发工作量评估

在保持现有 199 项回归、补齐专项测试并完成常见 iPhone 真机验收的前提下，预计：

- 只读导出 DTO、服务端分页查询、tenant 安全测试：1.5–2.5 个开发日。
- 图片测量/分页/Canvas 绘制、预览、保存和单页分享：3–4.5 个开发日。
- Excel 生成、格式、下载/打开/分享、临时文件清理：2–3 个开发日。
- 超长/超大数据、空数据、失败恢复、真机兼容与全量回归：1.5–2.5 个开发日。

合计约 8–12 个开发工作日，不含微信平台审核等待。可拆成两个可验收版本：先交付分页图片，再交付 Excel；PDF 不计入本次工作量。

## 实施前确认点

建议确认后按以下默认口径开发：

1. 图片为 `1242 × 1756 px` 固定页，不做无限长图。
2. 图片默认不展示客户电话、企业地址和自由备注全文；发货/收款备注按表格需要展示。
3. 一次多图分享采用“保存全部后由用户在微信聊天多选”，不做不稳定自动化。
4. Excel 保留“原数量/单位”和“计价数量/单位”两套字段。
5. 超过 80 页时引导使用 Excel，但不截断 Excel 数据。

## 当前官方接口依据

- [wx.showShareImageMenu](https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.showShareImageMenu.html)：单次参数为一个本地或临时图片 `path`。
- [wx.previewImage](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.previewImage.html)：支持 `urls` 图片列表，预览中由用户保存或发送。
- [wx.saveImageToPhotosAlbum](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.saveImageToPhotosAlbum.html)：保存本地图片到系统相册，需要 `scope.writePhotosAlbum`。
- [wx.canvasToTempFilePath](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.canvasToTempFilePath.html)：Canvas 输出本地临时图片路径。
- [wx.openDocument](https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.openDocument.html)：支持打开 `xlsx`，可显示右上角菜单。
- [wx.shareFileMessage](https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareFileMessage.html)：支持把本地或临时文件转发到聊天。
- [Cloud.getTempFileURL](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/storage/Cloud.getTempFileURL.html)：私有云文件临时链接当前为 10 分钟有效。
