# 月结客户记账小程序：项目偏好与进度

## 最新状态索引（2026-09-22）

- 当前源码已于2026-09-22推送至现有 GitHub 仓库 `tuopro/jizhang` 的 `main` 分支，源码提交为 `d46cc7067a03c6b98ff7ae666ddb2a9c3e5d2471`；仓库当前为公开仓库。GitHub 同步不代表微信上线。

- 最新本地结果是“客户价格负责人权限调整”，见文末记录及 `docs/客户价格负责人权限调整报告.md`；388/388 测试、24 页原生编译通过。发货修正及此前性能收尾继续保留；性能数字来自合成数据和本机 Node，不是真机 timing。
- 本轮没有部署 ledger、上传体验版、提交审核或修改正式数据。下一轮需由用户安排新版本并做 iPhone 16 Pro 真机验收；下文较早日期的部署/待办描述属于历史记录。

## 项目背景

- 用户经营 PVC 线槽工厂，需要一个面向批发/工业品销售的独立微信小程序。
- 核心目标：每次发货后快速记账，自动累计本期应收；后续生成对账单、登记收款、结清账期并永久保留历史。
- 这不是传统财务软件或 ERP；日常高频动作应尽量在约 10 秒内完成。
- 现有“线槽报价小程序”只是产品规格与可选齿型的事实来源，新项目不得与其代码、AppID、报价或数据混用。

## 最高业务与安全约束

- 第一版不接入 AI、大模型或 DeepSeek API，只用可审计的规则解析。
- 不猜价格，不设置通用价；不存在的产品只能在用户明确确认后创建为当前企业的自定义产品。
- 客户专属价格互相独立；任何商品缺价都不能正式入账。
- 所有账目在正式入账前必须人工确认；删除、修改、收款和结清后续都要有二次确认与审计。
- 价格变化不能回写历史订单；历史记录保存成交时的产品、数量、单位、单价和金额快照。
- 多企业数据从底层按 `tenantId` 隔离；正式版还要在服务端按登录身份校验，不信任前端传入的企业编号。
- 开放账期发货修正权限为 active admin 或客户当前负责人 member；使用 `client.ownerMemberId`，不依赖录入人或账期负责人。历史期任何成员均不可修正。结清权限独立按 `billingPeriod.ownerMemberId` 判断，不能与客户负责人混用。
- 客观报告风险，不为了“看起来完成”而把本地演示包装成可生产使用。

## 技术决策

- 采用原生微信小程序和普通 JavaScript，避免首版增加框架维护成本。
- 核心业务写成与页面分离的纯 JavaScript，使用 Node 内置测试器回归。
- 金额用整数“分”保存；数量最多支持三位小数；行金额统一四舍五入到分。
- 第一阶段使用带企业命名空间的本机存储适配器跑通闭环；独立记账小程序 AppID 为 `wx5093ae94c1ece97b`。
- 2026-09-19 已部署正式云环境、9 个集合和 `ledger` 云函数；各集合客户端均不可读写，首次登录已正常生成企业与管理员会员记录。
- 需求中“裸数量默认米”与示例“4040开100 → 100根”冲突；当前按更明确的默认规则实现为“米”，同时显示提示；显式写根/箱时不换算。

## 产品数据口径

- 2026-09-18 已只读核对现有报价小程序 `data/products.js`：66 个真实高×宽组合。
- 新项目复用 66 个规格及每个规格的 `availableTeeth`；没有复制 `basePrice`。
- 原报价产品源只有灰色；本记账项目按已确认的业务需求将标准产品扩为灰、白、蓝三色，齿型仍以原 `availableTeeth` 为准；未写颜色不猜测。
- 盖子作为标准产品独立管理：宽度 `15、20、25、30、33、35、40、45、50、55、60、65、80、100、120mm`，颜色白、蓝、灰、黑，不需要齿型；“盖板/盖/盖子”均归一为盖子。
- 规格按高×宽解释，`60×40` 与 `40×60` 是不同产品，绝不交换或近似匹配。
- 规格库是识别辅助而非入账门槛；自定义产品支持自由名称，经人工确认后按 `tenantId` 入库并写审计。
- 自定义产品允许确定性的模糊复用：空格/连接符差异及 `1.3米长`、`长度1.3米`、`1.3米的`、`1.3米/根`、`1.3m` 视为同一长度表达；长度数值不同不能匹配，不做不可审计的语义猜测。
- 特殊长度是产品身份，不是订单数量；`4040` 与 `40×40` 可归一匹配，但 `1.2米` 与 `1.5米` 必须严格区分。`定尺、定制、非标、短料、加长、裁切、装潢、特殊` 等确定性词会触发特殊产品流程。
- 特殊属性的匹配顺序固定为：完整属性特殊标准品 → 已有自定义规格（名称/别名/结构化属性）→ 人工选择或创建；不得忽略特殊属性后回退成普通标准品。

## 当前进度（2026-09-18）

- 2026-09-18：完成特殊长度和人工产品覆盖增强。`白色4040，1.2米长的1000根` 现在解析为 40×40、白色、1.2米/根、1000根，并锁定为待匹配特殊产品；普通 `白色4040开口100米` 仍走标准品。
- 2026-09-18：快速记账每一行新增“选择产品”入口，可分类搜索标准规格和自定义规格，也可打开可编辑表单新建自定义规格；名称可自由修改，颜色、基础规格、齿型、单根长度自动预填。
- 2026-09-18：自定义产品新增 `height、width、toothType、color、unitLengthMeters、specialTags、aliases、recognitionKeywords` 数据字段并进入成交快照。用户点击“保存并使用”才入库，不静默创建。
- 2026-09-18：自定义产品保存单根长度后，根/米计价不一致时只显示换算建议；必须再点确认才填入换算率，仓储层仍拒绝无人工换算的入账。43/43 自动测试通过，18 个 JavaScript 文件语法检查及 3 个 WXML、4 个 WXSS 微信原生编译通过。
- 2026-09-18：已支持已入库自定义产品的长度模糊复用；“白色装潢1525 1.3米长”入库后，“白色装潢1525 1.3米的 200根”会匹配原产品 ID。匹配时以产品原名重新归一，因此旧存储的 `normalizedName` 不会阻断新规则；实际再次创建时会顺带升级旧归一值。38/38 测试及微信原生编译通过。
- 2026-09-18：规格库新增 60 个标准盖子产品（15 宽度×4 颜色），支持 `15宽盖子`、`15盖子`、`盖子15`及 `盖板/盖/盖子` 别名；截图实例“银灰色盖板60 2米”已直接匹配 `60mm盖子 / 灰色`。盖子沿用客户专属价、单位计价、入账校验和快照；36/36 测试及微信原生编译通过。
- 2026-09-18：修复快速记账页“创建并加入产品库”点击无反应；原因是 `wx.showModal` 的 `confirmText` 使用 5 个字符“创建并使用”，超出微信上限而且未处理 `fail`。现改为 4 字符“确认创建”，增加打开失败提示及防回归断言；30/30 测试和微信原生编译通过。
- 2026-09-18：已在原记账闭环上增量完成灰/白/蓝标准颜色、自定义产品人工创建与防重复用、产品长度与订单数量区分、数据驱动的小规格齿型透明纠正。
- 2026-09-18：客户价已明确保存“单价+计价单位”，支持元/米、元/根、元/箱；订单单位不一致时必须人工换算或改本次计价方式，仓储层同样拒绝猜测。
- 2026-09-18：成交行快照新增原数量/单位、计价数量/单位、换算关系和自定义产品信息；新增功能后自动测试 30/30 通过，微信原生编译通过。
- 2026-09-18：已将项目从游客 AppID 切换为用户确认的独立记账小程序 AppID `wx5093ae94c1ece97b`，并同步更新项目自检规则与运行说明；切换后 `npm test` 20/20 通过，`npm run check` 和微信原生 WXML/WXSS 编译通过。
- 2026-09-18：因最初误建在短视频项目下，已按用户指定将完整项目迁移到独立根目录 `/Users/zhengxiaotuo/Desktop/codex项目/记账工具`；短视频项目内不再保留记账小程序副本，原报价小程序也未修改。
- 已完成 3 个页面：首页、快速记账、订单识别测试。
- 已实现 `×/x/X/*/紧凑规格`、齿型别名、颜色别名、米/根/箱、多行、连续文字、重复商品、未知规格、物流关键词解析。
- 已实现客户价读取、缺价锁定、本次改价/单位、保存/更新客户默认价、二次确认、原子入账、完整成交快照、审计记录和防重复请求。
- 演示客户“杭州XX电气”预置 40×40 粗齿灰色 ¥12.50/米、40×40 粗齿白色 ¥6.80/米、60×40 细齿灰色 ¥18.60/米；80×60 粗齿灰色故意缺价用于验收。
- 验收示例补入 ¥28.00 后总额为 ¥3,020.00，保存后下次可自动读取 ¥28.00。
- 自动测试 43/43 通过；项目结构、JSON 和 18 个 JavaScript 文件语法检查通过；3 个 WXML 与 4 个 WXSS 已用本机微信原生编译器编译通过。

## 正式版升级进度（2026-09-18）

- 已停止以“识别测试页”为主入口，正式底部导航为：首页、客户、历史、我的；首页主操作为“+ 记一笔”，规则识别测试移到“我的”的开发测试入口。
- 已实现 17 个正式页面：客户搜索/新增/修改、客户账本、发货详情、账目修正、收款、对账单、历史账单、标准/自定义产品管理、客户价格表、企业信息、使用说明和数据设置。
- 已完成账期领域规则：持续发货进入当前开放账期且允许跨月；支持部分/多次收款；剩余应收为 0 仍保持开放，只有用户确认“结清本期”才进入历史；结清后新发货自动开启新一期；历史账单保留成交和收款快照。
- 已实现错误账目修正：必须填写原因，保存修改前后完整快照；已结清账单只读；修正后本期货款不能低于已收款。
- 正式数据模式默认使用微信云开发。`ledger` 云函数从 `openid + memberships` 取得服务端 `tenantId` 和管理员角色，前端不能指定企业；业务写入使用云数据库事务。
- 云端集合为 `enterprises、memberships、clients、products、customer_prices、shipments、payments、billing_periods、audit_logs`；客户端应全部禁止直接读写。
- 云函数与前端领域规则保存同步副本，`npm run check` 会逐文件检查，避免产品、金额和历史快照规则漂移。
- 运费增量完成后自动测试增至 58/58，包含原有识别/价格/快速记账回归、完整账期闭环、收款边界、产品停用历史保护、修正审计、云端身份边界和运费安全校验；17 个 WXML、18 个 WXSS 通过微信原生编译。
- 对账单第一步已完成小程序内预览；长图、PDF、Excel 按需求作为后续增量，不阻塞主体上线。

## 当前上线边界与下一步

- 正式云环境、九个集合、不可由客户端直读写的权限和 `ledger` 云函数已部署；首页及管理员企业初始化已验证。
- 2026-09-19 本地 `ledger` 云函数已加入运费服务端重算逻辑；正式云环境需重新“上传并部署：云端安装依赖”后才能验收运费功能，当前不记为已部署。
- 上线前仍必须完成双企业交叉隔离、断网重试、重复提交和 20—30 条真实订单真机回归。
- 上线前仍需用户完成微信小程序名称/图标/类目、隐私政策和用户隐私保护指引、备案/审核资料、云数据库定时备份及恢复演练。
- 后续优先级：部署并真机验收单企业多人协作 → 真实使用回归和云端安全验收 → 分享长图 → PDF/Excel；不增加库存、采购、利润、生产或 CRM 功能。

## 2026-09-19 底部 Tab 路由修复

- 微信开发者工具 Stable `2.01.2510290` 曾将 `pages/clients/clients.js`、历史和我的页面误判为“无依赖文件”，随后出现 `Page route` 和 `appLaunch with non-empty page stack`。
- 核对确认：四个 Tab 原本均已正确注册于 `app.json` 主包，`pagePath` 一致，四件页面文件完整，无分包重复，也无模块错误 `require/import` 页面脚本。
- 根因为该开发者工具版本的依赖分析与旧项目编译缓存组合问题；原项目又未显式声明 `miniprogramRoot` 和主包 `pages` 打包白名单，导致错误判定被持续复用。
- 最终修复：`miniprogramRoot: "./"`、`entryPagePath: "pages/index/index"`、`packOptions.include` 显式包含 `pages`；开发与上传的无依赖文件过滤仍保持开启，热重载关闭以避免复用异常页面栈。
- 仅将本项目的编译缓存移到可恢复备份 `/private/tmp/ledger-weapp-compile-cache-6595d046-20260919`，未清理数据库、登录、本地业务数据或其他项目缓存。
- 在“过滤无依赖文件”开启时实测首页、客户、历史、我的四个 Tab：页面路径正确、内容真实渲染，控制台 `0 errors / 0 warnings`。`npm test` 49/49 通过，`npm run check` 通过 17 页、43 JS、17 WXML和 18 WXSS 微信原生编译。

## 2026-09-19 运费记账闭环

- 不改动规则识别、客户专属价、自定义规格和米/根/箱计价，只在已有发货闭环增加独立运费。
- 发货快照新增 `itemsSubtotalCents`、`freightCents`和 `totalAmountCents`，全部为整数分；`logistics` 仍只保存物流商、自提或单号等信息。
- 前端只提交运费输入和商品行；领域服务从商品行重新计算 `itemsSubtotalCents`，验证运费非负且最多两位小数，再统一生成 `totalAmountCents = itemsSubtotalCents + freightCents`，不信任前端 total。
- 快速记账、二次确认、客户账本、发货详情、对账单、历史账单和账目修正均显示或使用商品合计、运费和本次合计。账期应收、收款和结清均以含运费总额为准。
- 修改运费会重算发货总额、本期应收和剩余应收，并继续将修改前后完整发货快照与原因写入审计。
- 升级前已有发货自动按“原总额=商品合计、运费=0”读取，无需改数据库集合结构。
- `npm test` 58/58 通过；`npm run check` 通过 43 个 JS 语法、17 个 WXML 和 18 个 WXSS 微信原生编译。

## 2026-09-19 按实际结清划分账期

- 账期边界改为“上期结清后的第一笔发货 → 用户确认结清本期”；自然月不再生成账期 ID，也不会在月初拆账。开放账期可以跨月持续接收发货和多次收款。
- 收款与结清拆成两个服务动作：`recordPayment` 余额归零后仍返回 `open` 和 `needsSettlementConfirmation`；只有 `closeBillingPeriod` 在确认、余额为 0、日期合法后写入已结清状态和 `CLOSE_BILLING_PERIOD` 审计。
- 余额归零时页面显示“暂不结清 / 确认结清本期”；暂不结清后客户账本保留“结清本期”入口，后续发货仍进入原期。
- 新账期使用独立 `billing_period_*` ID，并按客户维护连续 `sequenceNo`。现有 `periodKey、sequence、startedAt、settledAt` 继续兼容，不为字段名美化批量迁移；旧月份账期在读取时派生期号和起止日期，不静默写回正式数据。
- `billing_periods` 在业务写入时同步保存商品金额、运费、总应收、已收、剩余、发货次数；结清时固化结清日期，发货和收款仍由 `periodId` 关联并在历史中只读查看。
- 历史账单改为“第 N 期 + 开始日期 ～ 结清日期”，月份只做跨区间筛选；当前对账单默认覆盖整个开放账期，结束日显示当前日期或最后业务日期。
- 客户资料中的“每月结账日”改为可选参考提醒日，仅用于联系提醒；客户列表改显当前期号，不再暗示自然月自动结账。
- 新增半月结、跨月结、部分付款、余额归零不自动关闭、暂不结清继续发货、人工结清、结清后下一期、历史标题、跨月对账单及旧月份数据只读兼容测试。`npm test` 69/69 通过；`npm run check` 通过 44 个 JS、17 个 WXML 和 18 个 WXSS 微信原生编译。
- 本地代码已同步到 `cloudfunctions/ledger`，但正式云环境仍需在微信开发者工具重新上传部署 `ledger` 云函数后，线上才会使用新账期规则。

## 2026-09-19 单企业多人协作

- 保留现有 `tenantId + memberships` 架构，改为“一个企业、一个 tenantId、多个成员共享账本”。企业已存在后，陌生微信用户不会再自动创建第二个企业，必须持管理员服务端生成的邀请加入。
- 新增 `member_invites` 集合需求；邀请由 `ledger` 云函数生成，7天内可供多个不同微信用户使用，管理员可主动作废。接受邀请时由服务端使用真实 `openid` 建立 `member` 角色，前端提交的 `tenantId、memberId、role、openid` 均不参与授权。
- 成员第一版只有 `admin/member`。普通成员可共享读取全部企业数据、创建客户、记发货和登记收款，并可结清本人负责且余额为 0 的当前账期；账目修正、负责人调整、企业/产品/价格和成员管理仍由管理员执行，管理员可结清任意账期。
- 客户新增 `ownerMemberId/ownerNameSnapshot`；新账期从客户当前负责人继承独立负责人；发货和收款保存实际 `createdByMemberId/createdByNameSnapshot`；审计保存实际操作成员，负责人和操作人永久分开。
- 当前客户与未结账期可显示成员最新企业姓名；已结清账期、历史发货和收款使用姓名快照，成员改名或停用不会改写历史。
- 管理员可只转移客户负责人、连同当前账期一起转移，或单独修改本期负责人。停用仍负责客户/未结账期的成员前必须选择接替人；当前登录管理员和最后一个有效管理员受保护。
- 客户和历史页新增“全部 / 我负责的”；“我负责的”分别按客户负责人和历史账期负责人筛选，不按发货/收款操作人筛选。新增企业成员、加入企业、负责人管理和操作记录页面。
- 旧客户不会在启动时静默迁移；“企业成员”页仅在管理员明确确认后，才把未设置负责人的旧客户及其未结账期批量指定给当前管理员，并逐项写审计。
- 为多人协作、安全和历史兼容新增 18 项测试主题，连同原有账期、运费、产品和价格回归共 `87/87` 通过；`npm run check` 通过 21 个页面、50 个 JS、21 个 WXML 和 22 个 WXSS 微信原生编译。
- 当前正式云环境仍只有原9个集合且旧 `ledger` 部署未包含本轮代码。本轮上线前必须新增 `member_invites`、设置“所有用户不可直接读写”，再对 `cloudfunctions/ledger` 执行“上传并部署：云端安装依赖”。

## 2026-09-20 客户删除

- 在现有多人协作和记账闭环上增量增加客户删除，没有加入停用、归档、恢复、软删除，也没有新增数据库集合或迁移现有客户数据。
- 普通 `member` 只能删除没有 `shipments、payments、billing_periods、customer_prices` 的空客户；任一正式关联数据存在时均由服务端拒绝，不因客户负责人身份而放宽。
- `admin` 可彻底删除客户及其 `clients、shipments、payments、billing_periods、customer_prices` 客户专属数据；企业共享标准/自定义产品、企业、成员、邀请、其它客户数据和已有审计日志均不进入删除范围。
- 有账客户删除前由服务端返回发货、收款、账期、客户价格、进行中账期、历史账期和未收金额统计；管理员必须完整输入客户名称。真正执行时服务端在事务内重新读取身份和数据、重新统计并统一删除，不信任前端提交的 `tenantId、memberId、role` 或数量统计，失败整体回滚。
- 空客户删除写入 `DELETE_EMPTY_CLIENT`，有账客户彻底删除写入 `DELETE_CLIENT_WITH_LEDGER`；摘要保留客户名称、执行成员、删除时间和各类删除数量，旧审计日志继续保留。
- 客户详情、客户编辑、负责人、客户价格、快速记账、发货详情和对账单页面已兼容删除后的旧链接与缓存，资源不存在时给出明确提示并安全返回客户列表。
- 新增 `tests/client-deletion.test.js` 覆盖成员/管理员权限、强确认、欠款与开放账期统计、共享数据保护、跨企业隔离、TOCTOU 重新统计、前端伪造无效、删除审计和旧链接读取。全量 `npm test` 为 `101/101` 通过；`npm run check` 通过 21 个页面、51 个 JavaScript、21 个 WXML 和 22 个 WXSS 的微信原生编译。
- 本地 `services/ledger-repository.js` 与 `cloudfunctions/ledger/services/ledger-repository.js` 已保持完全一致。本轮客户删除代码尚未重新部署到正式云环境；上线前需对 `cloudfunctions/ledger` 执行“上传并部署：云端安装依赖”，不需要为本功能新建集合。

## 2026-09-20 账期负责人结清权限

- “确认结清本期”权限改为：当前成员是 `admin`，或当前真实成员 ID 等于当前 `billing_period.ownerMemberId`；只看账期负责人，不用客户负责人替代或兜底。
- 云函数允许普通成员发起 `closeBillingPeriod`，但领域服务会在事务内根据真实 `openid + membership` 重新取得操作人，并重新读取目标账期校验负责人；前端提交的 `memberId、role、ownerMemberId` 均不参与授权。
- 管理员仍可结清企业内任意账期；普通成员只能结清本人负责的账期。账目修正、负责人调整、客户删除、成员管理、产品和价格等原有高风险权限没有扩大。
- 余额规则保持不变：余额大于 0 不能结清，余额归零也不会自动结清，仍须有权限的人主动确认；已结清账期不能用新请求重复结清。
- 客户账本页和收款完成提示页统一使用 `canCloseBillingPeriod(identity, period)`。无权限成员不会看到结清确认入口；直接调用服务端时仍会收到“仅账期负责人或管理员可以结清”的拒绝。
- `CLOSE_BILLING_PERIOD` 审计继续保存实际操作成员。管理员代结时记录管理员，普通账期负责人自己结清时记录该成员，账期负责人快照与实际操作人不会混淆。
- 新增 `tests/settlement-permissions.test.js` 的 13 个测试主题，覆盖管理员、账期负责人、客户负责人但非账期负责人、非负责人、余额边界、伪造字段、实际审计操作人、重复结清及前后端统一权限判断。
- 全量 `npm test` 为 `114/114` 通过；`npm run check` 通过 21 个页面、52 个 JavaScript、21 个 WXML 和 22 个 WXSS 的微信原生编译。本地与云函数内的 `ledger-repository.js` 哈希一致。
- 本地代码已同步到 `cloudfunctions/ledger`，但本轮权限修正尚未部署到正式云环境；线上生效前必须重新对 `cloudfunctions/ledger` 执行“上传并部署：云端安装依赖”。

## 2026-09-20 多人复用邀请

- `inviteToken` 保持服务端随机生成、绑定真实 `tenantId` 和 7 天 `expiresAt`，但不再因某一成员加入而写成 `used`；有效期内同一个 token 可供多个不同微信用户加入。
- 管理员“企业成员”页会重新读取并显示当前有效邀请、到期时间和状态，可分享至同事群，也可主动作废。已有有效邀请时再次生成会返回原邀请；作废或过期后才生成独立的新 token。
- 作废会把邀请写为 `status: revoked`，补充 `revokedAt/revokedByMemberId` 并写 `REVOKE_MEMBER_INVITE` 审计；没有恢复接口，旧 token 永久无效。
- 新邀请文档不再写 `usedByOpenid/usedAt`，成员加入也不修改邀请文档或维护使用者数组。旧 `status: used` 文档继续按失效处理；无需批量迁移现有集合或新增集合。
- 接受邀请时，服务端先校验 `status === active` 且当前时间早于 `expiresAt`，再根据真实 `openid` 检查 membership。已加入返回“你已加入该企业”；已停用返回“你的企业成员账号已被停用，请联系管理员”，不会新建记录绕过停用。
- 新 membership 的 `tenantId` 只来自 invite，ID 只来自真实 `openid`，角色和状态固定为 `member/active`；前端伪造 `tenantId、memberId、role` 无效。
- 加入审计改为 `JOIN_ENTERPRISE_BY_INVITE`，保存 `inviteId、memberId、displayName、joinedAt` 和实际操作成员信息，不在审计或前端快照中暴露原始 `openid`。
- 新增 `tests/invite-reuse.test.js` 的 14 个测试主题，并更新原邀请安全测试、页面文案和部署/验收文档。本轮代码尚未部署到正式云环境，线上生效前仍需重新部署 `cloudfunctions/ledger`。
- 全量 `npm test` 为 `128/128` 通过；`npm run check` 通过 21 个页面、53 个 JavaScript、21 个 WXML 和 22 个 WXSS 的微信原生编译。

## 2026-09-20 上线前陌生用户访问控制与隐私盘点

- 正式入口已收口为三种结果：`status=active` 的 membership 正常进入；无 membership 但持有效 `inviteToken` 进入加入页；无 membership 且无邀请进入统一“未授权访问”页。
- 已彻底删除云函数“数据库为空时首个微信自动创建 enterprise + admin membership”的 `ensureInitialAdmin` 逻辑。任何陌生微信都不会自动建企业或获得管理员。正式云环境已有的 enterprise/membership 不会因重新部署被修改；不得清空这两个集合。
- `ledger` 入口只保留 `inspectInvite` 和 `acceptInvite` 两个公开邀请 action；`bootstrap`、删除预览、成员邀请管理和全部业务写 action 统一要求真实 `openid → membership → status=active`。写事务内会再次查身份和 tenant，前端 `tenantId/memberId/role` 仍不参与授权。
- 业务读取继续由受保护的 `bootstrap` 下发 tenant 快照，没有发现绕过 membership 的公开客户/金额读取 action。所有正式页使用统一页面守卫；被停用或删除 membership 后，下一次页面加载或服务端操作会清空前端内存快照并跳转停用/未授权页。
- 正式小程序不再因 `wx.cloud` 不可用而回退到本机演示账本。规则识别测试页仅在 `envVersion=develop` 且当前成员是 admin 时显示；体验版/正式版入口隐藏，直接路由也会拦截。
- 前端快照现会递归脱敏 `_id/_openid/openid/token`，包括审计 `before/after` 嵌套快照；云函数错误日志只记 action 和错误代码，不打印 openid、inviteToken、payload、客户、价格、金额或数据库对象。`wx.cloud.init` 的 `traceUser` 已关闭。
- 隐私事实盘点已写入 `docs/隐私数据与微信接口盘点.md`。当前不读取微信昵称/头像，不调用 `getPhoneNumber`，不获取定位、相册/摄像头、文件、麦克风、剪贴板或通讯录，也不发送数据给第三方 AI/外部 API。但代码确实处理人工填写的企业/客户联系人、电话和企业地址，微信隐私指引不能漏报。
- 新增 `tests/access-control.test.js` 的 26 个指定访问控制场景，及 `tests/privacy-boundary.test.js` 的 4 个快照脱敏/日志/权限申明检查。全量 `npm test` 为 `158/158` 通过；`npm run check` 通过 22 个页面、61 个 JavaScript、22 个 WXML 和 23 个 WXSS 的微信原生编译；本地/云端 `ledger-repository.js` 完全一致。
- 本轮代码尚未部署到正式云环境。线上生效前必须在微信开发者工具重新对 `cloudfunctions/ledger` 执行“上传并部署：云端安装依赖”，然后上传新体验版用三个微信做管理员/受邀成员/陌生或失效邀请的最终真机验收。

## 2026-09-20 GitHub 源码备份

- 当前项目已初始化为独立 Git 仓库，默认分支为 `main`，远程仓库为 `https://github.com/tuopro/jizhang.git`；首次完整源码备份提交为 `f479a6e`。
- 备份包含小程序源码、`ledger` 云函数源码、测试、部署文档和项目偏好文档；`.DS_Store`、`project.private.config.json`、`node_modules/`、测试覆盖率目录及 npm 调试日志均通过 `.gitignore` 排除。
- 上传前未发现 `.env`、私钥、访问令牌、证书或常见 API 密钥特征；`npm test` 为 `158/158` 通过，`npm run check` 通过 22 个页面、61 个 JavaScript、22 个 WXML 和 23 个 WXSS 的微信原生编译。
- GitHub 当前只是代码与文档备份，不包含微信云数据库中的正式客户、账目、成员或审计数据，也不等于云函数部署或微信体验版上传；云端业务数据仍需单独设置定时备份并做恢复演练。

## 2026-09-20 用户生成文本内容安全检查

- 已按微信开放文档当前“文本内容安全识别”接口实现，接口英文名 `msgSecCheck`，正式云函数使用 `cloud.openapi.security.msgSecCheck`，固定 `version=2`、`scene=1（资料）`，单次最多 2500 字。
- 检查只发生在 `ledger` 服务端完成真实身份、权限和原业务校验后、数据库持久化前；openid 只取 `cloud.getWXContext().OPENID`，前端不能提交审核结果绕过。`pass` 才放行，`risky/review` 拒绝；接口异常或无法判断时也不静默放行。
- 实际审核字段：成员企业显示姓名；企业名称/联系人/地址；客户名称/联系人/备注；发货原始输入、商品行原文、发货备注、物流原始文本和非固定物流商名称；收款备注；账目修正原因；自定义产品名称/备注/非程序生成长度描述/别名/识别关键词/非固定特殊标签。
- 电话、金额、数量、日期、各类 ID、tenantId、inviteToken、role/status、规格、固定颜色/齿型/单位/支付方式/物流商和特殊标签、搜索词及删除确认文字不送审。一次请求内的短文本带标签合并检查；超长文本按 2500 字分段；历史数据读取和未变化旧文本不重复审核。
- 内容安全请求正文、风险关键词、openid、inviteToken、access token 和微信原始响应均不写日志或业务审计；被拒绝请求不会写正式数据库。隐私盘点已如实改为“自由文本会提交微信平台官方内容安全服务”，仍未接入第三方 AI 或第三方审核服务。
- 体验版首次真机验证暴露 `cloudfunctions/ledger/config.json` 完全缺失，已新建该配置并在 `permissions.openapi` 中声明 `security.msgSecCheck`。补权限后问题仍存在，且真实日志为空 `errCode/errMsg`，因此不再把当前故障归因于 `-604101` 或权限。
- 内容安全异常现仅保留并记录经长度限制和敏感值替换的微信 `errCode/errMsg`；不记录请求文本、openid、inviteToken、access token、payload 或完整错误对象。接口异常仍返回 `CONTENT_SECURITY_UNAVAILABLE` 并阻止保存，不允许失败放行。
- 本轮没有修改数据库结构或新增集合，没有新增昵称/头像/手机号/定位等授权。线上生效前必须重新对 `cloudfunctions/ledger` 执行“上传并部署：云端安装依赖”，并上传体验版验证正常文本、风险文本和接口异常三条路径。
- `wx-server-sdk` 依赖仍为 `latest`；2026-09-20 联网查询的 npm 当前版本为 `4.0.2`，其对外导出通用 `openapi` 云调用能力。为保证云端实际安装依赖和权限文件同时更新，不可只上传代码。
- 新增 `tests/content-security.test.js` 的 22 项专项测试；全量 `npm test` 为 `180/180` 通过，`npm run check` 通过 22 个页面、64 个 JavaScript、22 个 WXML 和 23 个 WXSS 的微信原生编译，`git diff --check` 通过。

## 2026-09-20 msgSecCheck v2 SDK 返回适配修复

- 微信 `msgSecCheck v2` 原始 JSON 确实是小写 `errcode/errmsg`。但当前 `wx-server-sdk 4.0.2` 的 `cloud.openapi` 通用包装会在成功时删除原始 `errcode/errmsg`、将蛇形字段转为驼峰，再返回 `errCode: 0` 和 `errMsg: openapi...:ok`；因此 `cloud.openapi.security.msgSecCheck()` 的实际返回不是未包装的原始 v2 对象。
- 原适配器只检查 `response.errcode`。SDK 已成功返回 `errCode: 0` 时，`response.errcode` 为 `undefined`，被误判为 `CONTENT_SECURITY_UNAVAILABLE`，这也解释了“测试02”未命中风险仍不能保存。
- 现增加单一归一化层：原始 v2 读 `errcode/errmsg`，SDK 包装读 `errCode/errMsg`；两者都只在状态码为 0 且 `result.suggest === pass` 时放行，`risky/review` 继续拒绝，未知结构继续失败关闭。
- 为体验版诊断临时增加 `[ledger-msg-sec-response]` 日志，仅记录 `hasResponse、keys、errcode、errmsg、suggest、label、trace_id`，不记录请求文本、openid、token 或 payload。普通 JavaScript `TypeError/Error` 只记录脱敏、限长的 `name/message`，不记录 stack。
- 本轮不改变审核字段、放行/拒绝规则、事务顺序或数据库结构；修复上线仍必须重新部署 `cloudfunctions/ledger`。
- 新增 SDK 成功包装、原始 v2 非零错误和本地 JavaScript 异常三条回归；全量 `npm test` 为 `183/183` 通过，`npm run check` 通过 22 个页面、64 个 JavaScript、22 个 WXML 和 23 个 WXSS 的微信原生编译，本地/云端 `content-security.js` 一致，`git diff --check` 通过。

## 2026-09-20 体验版 msgSecCheck 真实调用链核验

- 已在微信云函数 `ledger` 日志中按 `log` 字段检索到多条 `[ledger-msg-sec-response]`；其中 RequestId `2f217719-47e8-4042-84f9-a471d41ea763` 在保存客户返回前先记录安全审核响应，证明体验版这次 `saveClient` 实际进入了 `msgSecCheck`。
- 微信云端的 `wx-server-sdk` 实际返回键为 `detail、result、traceId、errMsg、errCode`，该次真实结果为 `suggest=pass、label=100`；不是本地绕过，而是微信官方对该次文本判定为通过。不增加自建关键词黑名单。
- 新增客户页 `name/contact/note` 绑定、前端 payload、云仓储调用、云函数事务、`collectChangedTextFields` 和 `assertTextContentSafe` 链路均已核对；`note` 会进入待审文本，无字段串位或新客户被误判为“旧文本未变化”。
- 之前难以看到 `[ledger-msg-sec-response]` 是云日志默认列表主要展示 `Report/Response` 系统行，多行 `console` 记录需用 `log 日志内容 contains` 检索；诊断代码实际已在云端执行。
- 云日志中 `Response ... RetMsg` 的整份 snapshot 是微信云函数平台自动记录函数返回值，不是项目 `console.log`；本轮不为隐藏 RetMsg 破坏 bootstrap。后续可单独评估按需加载/分页、日志保留时长和控制台权限。
- 本地仅补强脱敏诊断：`saveClient` 安全审核入口记录实际非空字段数和 `client.name/client.contact/client.note` 类型；响应日志同时记录 `errCode/errcode`、`suggest/label` 和兼容的 `traceId`，仍不记录用户正文、phone、openid、token、payload 或 stack。
- 本轮未改变审核规则：仍只有状态码为 0 且 `suggest=pass` 放行，`risky/review` 拒绝，异常 fail closed。本地全量 `npm test` 为 `183/183` 通过，`npm run check` 通过 22 个页面、64 个 JavaScript、22 个 WXML 和 23 个 WXSS 微信原生编译，`git diff --check` 通过。
- 要让新增的入口和驼峰字段诊断在云日志生效，需重新对 `cloudfunctions/ledger` 执行“上传并部署：云端安装依赖”；本轮没有改前端，不需要重新上传体验版。

## 2026-09-20 首次进入隐私同意 gate

- 已在所有正式页面的业务加载之前加入统一隐私 gate：未同意当前版本时只显示隐私页，不执行 `ledger bootstrap`、`inspectInvite` 或其它业务云函数。快速记账、邀请加入和未授权页三个特殊入口也使用同一守卫。
- 隐私页 checkbox 默认未勾选；未勾选时“同意并继续”不可用，点“不同意”只停留在未同意状态。官方指引通过 `wx.openPrivacyContract` 打开；平台授权状态通过 `wx.getPrivacySetting` 读取，必要时使用 `<button open-type="agreePrivacyAuthorization">` 完成官方同意。
- 本地只保存 `ledger_privacy_consent={version:'2026-09-v1', agreedAt:'ISO时间'}`，不保存 openid、tenantId、memberId、inviteToken、客户、电话、地址、金额或账单。修改 `PRIVACY_CONSENT_VERSION` 即可强制重新同意。
- 邀请链接被 gate 拦截时，原路由及 `inviteToken` 仅放在 JavaScript 模块内存；同意后恢复原邀请页，token 不进入隐私 storage 或日志。隐私同意不等于企业授权，后续仍继续执行 active membership、disabled、invite 和 unauthorized 规则。
- “我的”页增加长期可见的“隐私保护指引”入口；`docs/隐私数据与微信接口盘点.md` 已同步本地保存事实和微信隐私 API/组件。
- 本轮不修改 `ledger` 云函数、数据库结构或账务/权限规则，因此隐私 gate 本身不需重新部署云函数；需重新上传小程序体验版。
- 新增 16 项隐私 gate 专项回归，并修正快速记账页测试夹具以模拟已同意状态。全量 `npm test` 为 `199/199` 通过；`npm run check` 通过 23 个页面、67 个 JavaScript、23 个 WXML 和 24 个 WXSS 的微信原生编译；`git diff --check` 通过。

## 2026-09-21 审核演示企业一次性管理员初始化（已完成）

- 已有审核演示 tenant 固定为 `tenant_review_1789953866562_a8f1b7a504b3`，企业名必须精确为“德赛记账审核演示”；禁止再创建 enterprise，禁止影响“德赛塑料”。
- 本地已准备限时的 `initializeReviewDemoAdmin` 临时 action：只从 `cloud.getWXContext().OPENID` 取当前微信，拒绝前端 `openid/tenantId/memberId/role/status`；固定目标 tenant，且必须通过零成员、零业务数据、当前微信未绑定其他企业和有效服务端邀请检查。
- 临时按钮只在 `trial` 体验版的未授权页显示；成功时创建或升级当前真实 membership 为 `admin/active`，写一条初始化审计，并作废旧初始化邀请。日志不输出完整 openid 或凭证。
- 本地回归已达 `209/209`，`npm run check` 通过 23 个页面、69 个 JavaScript、23 个 WXML 和 24 个 WXSS，`git diff --check` 通过。
- 2026-09-21 已通过微信开发者工具对 `cloudfunctions/ledger` 执行“上传并部署：云端安装依赖”。随后用已开启的 `55190` 服务端口下载云端函数到临时目录，确认 `index.js`、`services/access-control.js`、`services/review-admin-initializer.js`、`services/content-security.js`、`config.json` 和 `package.json` 与本地 SHA-256 全部一致，临时 action 和 `security.msgSecCheck` 权限均已真实部署。
- 小程序代码 `1.0.1` 已上传成功，备注为“审核演示管理员一次性初始化”；开发者工具明确提示因上次提交已是体验版，本次上传会覆盖体验版。当前等待微信 B 在体验版未授权页主动点击“初始化审核管理员”，尚未创建或修改任何 membership。
- 微信 B 首次点击临时按钮无反应的根因是确认框使用了 5 字符 `confirmText: '确认初始化'`，超过微信 `wx.showModal` 最多 4 字符限制，且原代码没有 `fail` 处理；因此确认框在本地参数校验阶段失败，云函数没有被调用，也没有数据库写入。现改为 4 字符“确认执行”，增加失败 toast 和回归断言；`1.0.2` 已通过 CLI 上传并覆盖体验版。
- 微信 B 已主动执行初始化，云数据库已复核到其在既有“德赛记账审核演示” tenant 下的唯一 `admin/active` membership；未覆盖其它 membership，没有复制或改写真实客户、账目和成员数据。
- 初始化成功后，本地已删除临时 action 的导入与分支、`PUBLIC_ACTIONS` 白名单项、前端调用、体验版按钮、临时凭证、初始化服务文件和专项测试；全项目搜索仅在本进度记录中保留历史文字。
- 微信开发者工具 CLI 全量部署持续报 `EISDIR`，因此已精确增量部署云端 `index.js`；再次下载真实云端包验证其 SHA-256 与本地一致，云端入口已无初始化导入和路由，即使调用旧 action 也只会按未支持 action 拒绝。云端压缩包仍留有不再被引用的旧模块文件，但已从可执行路径停用，不构成长期初始化入口。
- 干净的小程序代码 `1.0.3` 已上传，备注为“移除一次性审核管理员初始化入口”；体验版不再显示临时初始化按钮。微信 B 后续由服务端按真实 OPENID 命中已持久化的 membership，会自动进入审核演示企业，无需再次初始化。
- 清理后最终验证：`npm test` 为 `199/199` 通过，`npm run check` 通过 23 个页面、67 个 JavaScript、23 个 WXML 和 24 个 WXSS 微信原生编译，`git diff --check` 通过。

## 2026-09-21 上线前安全清理、UI 一致性与账单导出方案

- 已再次对完整项目扫描 `initializeReviewDemoAdmin`、审核/临时管理员初始化、trial 初始化按钮、审核 tenant 硬编码、临时凭证、初始化服务/测试/前端调用和 action 白名单；当前可执行代码没有初始化入口或相关文件，`PUBLIC_ACTIONS` 仍只有 `inspectInvite、acceptInvite`。命中内容仅为本文件中的历史记录。
- `initializeTenant / initializeDemoTenant` 只属于本地领域测试和非云演示存储；正式云仓储的 `initializeTenant` 会拒绝调用，正式云函数未知 action 由 `assertKnownAction` 拒绝，不能创建正式 enterprise 或 membership。
- 未删除或修改“德赛记账审核演示”企业及微信 B 已持久化的 `admin / active membership`，也未触碰“德赛塑料”的企业、成员、客户、账目、价格和历史数据。微信 B 后续仍按真实 OPENID 命中正式 membership，不依赖一次性初始化入口。
- 已建立统一 WXSS 视觉变量并完成首页、客户、客户账本、快速记账、发货详情、收款、对账单、历史、产品、客户价格、成员、我的、未授权、隐私同意和加入企业等页面的纯 UI 优化；未修改事件绑定、路由参数、数据库字段、云函数协议或账务/权限判断。
- UI 风格采用专业、克制的企业记账方向：深蓝主色、冷灰背景、统一间距/字号/表单高度/圆角/状态色，小屏换行与底部安全区已做静态保护。危险操作继续保留明确层级。
- 微信开发者工具当前提示需要重新登录，游客模式仍报 `INVALID_LOGIN, access_token expired`；因此本轮只确认自动测试、微信原生编译和静态小屏保护，不能把 iPhone 真机或已登录模拟器检查记为通过。重新登录后仍需用微信 B 做常见 iPhone 尺寸、空/少/多数据和按钮遮挡验收。
- 第三阶段仅完成 `docs/分页账单图片与Excel导出方案.md`，没有实现或部署图片、Excel、PDF、云函数 action、文件上传或数据库变更。方案建议 1242×1756 固定分页图、动态高度分页、前端 Canvas 出图、云端生成 Excel，并用受 membership 保护的按账期分页读取避开当前企业快照每集合 1000 条的容量边界。
- 已按微信官方当前文档核对：`wx.previewImage` 可预览多图，`wx.showShareImageMenu` 每次只接收一个图片路径，因此多图采用“预览全部 / 保存全部 / 分享当前页”，不做自动连续分享；Excel 可用 `wx.openDocument` 和 `wx.shareFileMessage`。
- 本轮最终本地回归：`npm test` 199/199 通过；`npm run check` 通过 23 个页面、67 个 JavaScript、23 个 WXML 和 24 个 WXSS 微信原生编译；`git diff --check` 通过。没有执行云函数部署、体验版上传或正式数据变更。

## 2026-09-21 分页账单图片与 Excel 正式导出

- 第一版最后一项功能已按既有方案增量实现，只增加分页账单图片和 Excel；未开发 PDF、自动发好友、邮件、云打印、库存、利润、CRM 或其它业务功能，也未改动产品、价格、单位、运费、收款、账期、结清、删除、成员或 tenant 规则。
- 新增 `getStatementExportMeta、getStatementExportPage、createStatementExcel、cleanupStatementExportFile` 四个 action，全部属于 `ACTIVE_MEMBER_ACTIONS`，`PUBLIC_ACTIONS` 仍只有邀请检查/加入。tenant 只来自真实 `OPENID → membership → tenantId`；前端 `tenantId、role、memberId` 不参与授权。
- 导出服务只按目标 `clientId + periodId` 分批读取 `billing_periods、shipments、payments`，每批最多 100 条，不依赖 bootstrap 每集合 1000 条快照；已用 1005 笔发货自动测试验证。服务不读取当前产品或客户价格，不写数据库，不更新审计，不回填历史。
- 分页图片固定 `1242 × 1756 px`，使用最终 Canvas 的实际文字测量结果分页。商品/收款行不可切割，整笔发货优先同页，超长单笔按完整商品行拆页并标“续”，小计/运费/本次合计只在末段出现；每页重复抬头、账期日期、表头和页码，最后一页含五项汇总。图片超过 800 明细行或 80 页时停止并建议 Excel。
- 新增账单图片预览页，支持预览全部、上一页/下一页、保存全部、分享当前页。相册权限只在用户主动保存时申请，拒绝后可进入设置重新开启；保存失败不影响账务。微信不做自动连续发送多图。
- Excel 由云端 `exceljs@4.4.0` 生成，包含“账单汇总、发货明细、收款明细”三个 Sheet；金额为数值单元格，日期可排序，发货级运费/总额只写在该笔第一行。云路径使用 tenant/member 哈希和随机文件名，不包含企业或客户名称。
- Excel 下载成功或失败后均调用清理 action，并立即重试一次；正常云端文件生命周期为数秒。上传成功后云函数在返回前异常退出仍可能留下少量私有孤儿文件，部署后需在云存储控制台检查 `statement-exports/` 前缀，禁止设为公开读。
- 未新增数据库集合、字段、索引或迁移；新增依赖和 action 尚未部署到正式云环境。上线前必须重新“上传并部署：云端安装依赖”，再上传体验版进行 iPhone 真机验收；本轮没有提交微信审核。
- 因新增用户主动保存账单图片，相册写入权限已在 `app.json` 如实声明，隐私同意版本更新为 `2026-09-v2`，旧同意会重新进入隐私 gate。没有相册读取、摄像头、麦克风或用户文件读取权限。
- 本轮自动回归覆盖当前/历史账期、运费、多发货、多商品、多收款、部分/全额未结清、结清、长名称、发货/收款分页、空数据、1000+记录、admin/member、disabled/陌生微信、跨 tenant、伪造身份字段、历史价格快照、Excel 三 Sheet、临时文件失败和重复点击。最终 `npm test` 为 `230/230` 通过；`npm run check` 通过 24 个页面、86 个 JavaScript、24 个 WXML 和 25 个 WXSS 微信原生编译；`git diff --check` 通过。

## 2026-09-21 Excel 导出视觉样式修正

- 本轮只调整 `cloudfunctions/ledger/services/statement-excel.js` 的 Excel 展示样式及对应自动测试；未修改三个 Sheet 的字段、数据读取、账务计算、历史快照、权限、action、临时文件或 ExcelJS 版本。
- 深蓝表头统一为 `#173F67`，字体颜色改用 ExcelJS 可可靠序列化的 ARGB 颜色对象，最终文件回读确认为纯白 `#FFFFFF`、粗体、水平/垂直居中，表头行高 26；正文为白底、`#1F2937` 深灰文字和 `#D1D5DB` 浅灰细边框。
- 发货/收款明细已按字段语义统一左、中、右对齐；金额继续使用 numeric cell 和原 `¥#,##0.00` 格式，数量精度未改变。发货编号列从 25 调整为 30 并开启自动换行，产品名称列为 38、规格列为 25。
- 发货明细和收款明细冻结首行改为在创建 Sheet 时声明，确保 ExcelJS 流式写入后的最终文件真实保留冻结窗格；账单汇总保持浅蓝标签、白色数值区，应收/已收/剩余应收加粗，剩余应收使用克制的暗红色强调。
- `tests/statement-excel.test.js` 增加最终 `.xlsx` 回读断言，覆盖所有明细表头的白字/深蓝底、表头高度、冻结首行、列宽、自动换行、字段对齐、正文颜色与边框，以及汇总/发货/收款金额仍为 number。专项测试 3/3 通过；全量 `npm test` 为 230/230 通过；`npm run check` 通过 24 个页面、86 个 JavaScript、24 个 WXML 和 25 个 WXSS 微信原生编译。
- 样式修正位于 `ledger` 云函数内，正式环境生效前需要重新部署 `cloudfunctions/ledger`；本轮没有执行部署、体验版上传或审核提交。

## 2026-09-21 iPhone 响应式布局收尾

- 本轮只修改 WXML class/必要布局、WXSS 和项目静态检查脚本，没有修改小程序业务 JavaScript、云函数、数据库、权限、账务规则或导出数据。唯一变更的 JavaScript 文件是非运行时业务代码 `scripts/check-project.js`。
- iPhone 16 Pro 截图中的对账单按钮越界根因是双列 `1fr 1fr` 网格遇到全局按钮 `white-space: nowrap` 时，按钮和轨道缺少 `min-width: 0`，再叠加微信原生 button 默认 margin，长文案把网格和外层 Excel 卡片一起撑宽。
- 全项目扫描定位 17 个潜在窄屏风险区域：10 个横向按钮组，以及 7 个长文本、金额或 flex/grid 子项缺少收缩/换行边界的区域；没有发现 `width: 50% + gap`、负 margin 或普通操作按钮用 absolute 定位出屏幕的模式。
- 全局建立 `.action-row / .action-row--responsive`：父容器为全宽 flex，子按钮使用 `flex: 1 1 0`、`width: auto`、`min-width: 0`、`margin: 0` 和统一 `box-sizing`；对账单两组按钮及客户账本、收款、负责人转移、隐私同意、快速记账、账单图片预览等同类操作区统一复用。
- 断点按卡片实际内容宽度定为 `340px`：393/390/375/360px 保持双列，320px 改为上下排列。模拟渲染确认 393、375、360、320px 下按钮均未越过卡片边界；真实 iPhone 仍需在新体验版上复核。
- 长企业/客户/产品/成员/文件名使用可收缩 flex 子项、换行或省略号；金额区域保留不换行并禁止被左侧长文字推出屏幕。页面级底部安全区继续只由公共 `.page` 和 `.fixed-action` 使用 `env(safe-area-inset-bottom)`，没有重复叠加。
- `scripts/check-project.js` 新增响应式静态回归：校验统一 action row 的收缩规则和窄屏纵向降级，阻止 action 网格重新出现未受保护的 `1fr` 轨道，并要求关键按钮组继续复用公共 class。
- 最终本地回归：`npm test` 230/230 通过；`npm run check` 通过 24 个页面、86 个 JavaScript、24 个 WXML 和 25 个 WXSS 的微信原生编译；`git diff --check` 通过。未部署云函数、未上传体验版、未提交微信审核。

## 2026-09-21 上线前性能收尾（本地完成，待真机验收）

- 先保存本轮开始时的全部源码（含已有未提交工作）、Git 状态和 SHA-256，并完成 230/230 原测试与性能基线；原始副本在 `/private/tmp/ledger-performance-20260921-baseline/`。最终报告、原始数字、WXML 扫描、保护文件哈希和仅本轮补丁在 `docs/上线前性能优化完成报告.md`、`docs/performance/`。
- 实测主要瓶颈是首页/客户页循环读取时反复深拷贝完整企业快照。新增仅限一次同步读取/模型计算的脱离原缓存的工作副本，成功、异常、跨 await 均结束；没有持久化业务缓存、TTL 或角色授权缓存，云端写入和全部领域公式未改。
- 200 客户/1000 发货的合成压力样本中，首页/客户页整库复制 804/801 次降到各 1 次；固定方法三轮本机模型中位数约 5333→121 ms、5293→97 ms。不能解释为 iPhone 页面耗时。
- `ledger` 普通 action 和临时文件清理不再 require ExcelJS；只有通过原权限与范围校验后真正生成 Excel 时加载工作簿。已用 require instrumentation 与真实 xlsx 生成测试保护，三 Sheet、样式、导出数据和临时清理流程不变。
- bootstrap 在真实 OPENID/membership 与企业读取后并行八个独立集合；常规读取仍 10 次查询、相同条件/字段/1000条上限，事务内仍保持原先串行与二次身份校验。`prepareRepository` 原本已有并发去重，保留且补成功/失败测试；顺序页面进入/返回继续重新授权，不盲目删除刷新请求。
- 快速记账的完整客户/产品选项、客户/历史/产品/客户价的筛选源留在页面逻辑层，仅把可见字段送进 setData；压力样本快速记账初始 payload 430732→3874 B。所有搜索仍查完整集合。
- 客户/历史首批30条并在滚动时追加，保留完整总数、排序、筛选与返回时展开范围。客户账本/当前及历史对账单长明细分批发送，完整汇总一次给全；批次可在新模型/卸载时取消，导出不使用首批数据。长对账单最大单次335890→16264 B，代价是更多小批次；最终完整DOM和真机内存仍需验收。
- 同一已成功加载页面返回时保留内容并使用导航栏加载提示；首次加载、保存、Excel及图片原安全/防重复操作流程保留。没有改变 UI 风格、业务文案、WXSS、隐私版本、依赖或数据库结构，也没有分包。
- 原始源码对比：21个完整页面/解析/选择/价格表单场景的渲染字段一致；原业务/权限/隐私/脱敏/导出核心文件逐字节相同。只调整已有快速记账测试的3处内部选项存放位置引用，没有降低原断言。
- 最终 `npm test` 245/245通过（新增15项结构性回归，无毫秒阈值）；`npm run check` 通过24页面、92个JavaScript语法检查、24 WXML与25 WXSS微信原生编译；`git diff --check` 和关键文件 `node --check` 通过。
- 本轮严格停在本地：未部署、未上传体验版、未提交审核、未修改正式数据库。下一版需要重新部署 ledger、上传体验版；不需要数据库迁移、新索引、隐私指引修改或新增依赖。iPhone 16 Pro 验收重点与未测指标见完成报告。

## 2026-09-21 发货账目修正权限与只读状态修复（本地完成，待真机复测）

- 修复详情页将“无修改权限”通过修改按钮的 `wx:else` 误显示成“已结清”的问题。现分开 `isClosed` 与 `canEdit`；开放期非负责人可正常查看且不显示历史提示，历史期保留原只读文案。
- 对比性能优化前源码备份，详情 JS/WXML 在本轮开始前均逐字节相同，错误状态不是该轮性能修改引入。本期发货导航仅依赖精简行保留的 ID，详情重新读取完整 shipment；新增 37 笔发货分批渲染后跳转测试保护这一链路。
- `updateShipment` 只对当前开放账期新增“客户当前负责人 member”权限。最终事务重新读取真实 OPENID 对应 active membership、shipment、实际 client 和已存 billing period，检查 tenant 与关联一致，再判断 admin 或 `membership.id === client.ownerMemberId`。前端身份、客户 ID、只读标记不作为授权依据。
- 客户转移后旧负责人立即失权、新负责人获权；历史发货、录入人和负责人快照不回写。编辑页打开后发生转移、结清或成员失效时，服务端保存拒绝；本地模拟事务冲突重试也会重新校验。
- 缺失、错配或状态异常的账期拒绝修正，不因旧兼容逻辑合成 open 记录而放行。旧月份/兼容 ID 仍可关联真实已存账期读取；不新增字段、不迁移、不静默建期。
- 原修正的人工确认、必填原因、商品/运费/账期重算、已收款约束、before/after 完整审计、真实成员操作人及 msgSecCheck 保留。member 修正只影响本笔成交，不顺带保存客户默认价；其它价格、产品、删除、成员、企业、邀请、收款权限不变。
- `closeBillingPeriod` 仍只允许 admin 或 `billingPeriod.ownerMemberId` 对应成员；客户负责人不会因此获得结清权。18 个相关原业务/helper 函数与本轮基线保持原样。
- 修改前备份在 `/private/tmp/ledger-shipment-correction-20260921-baseline/`，保留此前所有未提交工作。新增 77 项专项回归，全量 `npm test` 322/322 通过；`npm run check` 通过24页面、96 JS、24 WXML、25 WXSS微信原生编译，`git diff --check` 通过；共享领域仓储副本一致。
- 仅完成本地代码及模拟测试，未部署 ledger、未上传体验版、未提交微信审核、未修改正式数据库。新规则生效需要后续重新部署 ledger 和上传体验版；本轮按用户要求停下，等真机复测。不存在数据库迁移、集合/字段/索引或历史快照格式变更。


## 2026-09-21 客户价格负责人权限调整（本地完成，未部署）

- 指定客户价格表允许真实 active admin、当前 client owner、唯一真实开放 billing period owner 查看和新增/修改。数据库成员主键为 membership.id，对外 identity.memberId 由该值派生；历史 settled/closed 账期、合成兼容期、其它客户/企业账期不授予价格权限。缺失或多开放期异常时，不使用账期负责人分支；admin 和客户负责人仍可操作。
- 原管理员写门禁位于云函数，原仓储并无客户范围校验，原快照会下发企业全部 customerPrices。现补齐价格仓储读写授权、三个 active member 读取 action、快照价格及独立价格审计过滤。没有新增价格删除/停用功能，也没有扩大产品、企业、成员、邀请、转移、客户删除、发货修正或结清权限。
- saveCustomerPrice 事务按真实 OPENID/membership/tenant 重新读取价格实际关联的 client 与开放期；明确价格 ID 编辑不相信 payload clientId。定向查询不依赖 bootstrap 前1000条是否包含目标价格；负责人转移、结清、成员停用/删除及事务冲突重试均重新鉴权。
- 客户账本独立 canManagePrices 控制入口；价格页每次进入执行服务端 list，旧数据先清空，拒绝后安全返回，不相信路由或缓存许可。编辑提交实际价格 ID；重复保存及迟到响应受保护。
- 快速记账 saveAsDefault 加同一客户权限，避免间接写价格绕过；无权客户的默认价不下发，原人工填写单笔成交价、计价/换算/缺价规则保留。原发货修正内保存默认价仍仅 admin，不扩大该流程。
- 独立客户价格新增/修改原有审计保留，更新完整 before/after，operator 和时间使用真实成员。快速记账保存默认价原无独立价格 before/after 审计，仍沿用发货审计，本轮未新建审计机制。
- 改价只作用之后新建发货，不回写任何历史成交或已结清金额；价格保存也不会顺带补齐旧发货字段。最终 Excel 回读验证成交价不变，图片/Excel 导出实现未改。
- 本轮新增66项测试，全量 npm test 388/388通过；npm run check 通过24页、99 JS、24 WXML、25 WXSS微信原生编译；git diff --check通过。19个保护文件、18个原业务/helper函数与本轮基线一致。基线及SHA清单在 /private/tmp/ledger-customer-price-permissions-20260921-baseline/。
- 未部署ledger、未上传体验版、未提交微信审核、未访问或修改正式业务数据。后续生效需要重新部署ledger并上传体验版做真机复测；不需要数据库迁移，无新增集合、字段或索引配置。完整范围、原权限位置、审计现状与测试对应关系见本轮报告。


## 2026-09-22 当前版本上传 GitHub（源码已推送）

- 按用户要求把当前完整小程序源码及此前尚未提交的改动推送至原仓库 `https://github.com/tuopro/jizhang.git` 的 `main`，未新建仓库。上传前远端与本地均为 `56f4aee`，使用正常快进推送，未强推或重写历史。
- 源码提交为 `d46cc7067a03c6b98ff7ae666ddb2a9c3e5d2471`，包含121个变更文件，覆盖客户价格负责人权限、发货修正权限、图片/Excel导出、隐私/内容安全、移动端UI、性能改进及对应测试、报告；GitHub已确认 main 接收该提交。
- 上传前确认该仓库为公开仓库，当前账号拥有管理权限；206个候选项目文件约1.42MB，常见私钥、GitHub/API/云密钥模式扫描无命中。`project.private.config.json`、node_modules、本机杂项仍被原 .gitignore 排除，没有读取或上传正式云数据库。
- 2026-09-22重跑发现一项历史保护测试依赖当天日期：recordPayment未指定日期，而结清日期固定为2026-09-21。仅给测试收款显式补同一天 paymentDate，业务代码未改；修复后 npm test 388/388通过，npm run check 通过24页、99 JS、24 WXML、25 WXSS微信原生编译。
- 全部新文件暂存后，Git将性能审计 .patch 中20条合法的单空格上下文误报为行尾空格；已核实这些行全部是补丁格式标记，原补丁未改。新增 .gitattributes 只为 `docs/performance/performance-only.patch` 关闭 blank-at-eol 检查，其它源码空白规则保留；git diff --cached --check通过。
- 本轮只完成Git源码同步，没有部署ledger、上传微信体验版、提交审核或修改正式业务数据。后续微信端生效仍需单独部署和真机验收。
