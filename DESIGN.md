# 课堂客观题竞答 H5（classbuzz）设计方案

> 目标：先做 H5 版进课堂实战，跑通玩法与实时协议；小程序资质审核通过后，
> 复用同一后端与 WS 协议出小程序端。更新于 2026-10-27。
> 核心玩法为**全员竞速**：每题全班同时作答，答对保底得分、越快分越高。
> 身份采用**实名免注册**：教师导入名单，学生凭「房间号 + 学号」进入。

## 1. 是什么

老师课堂上投出一道客观题，学生手机扫码进入房间，全班同时作答：在限时内
提交选项，答对按速度得分，大屏实时显示提交人数，揭晓后展示选项分布、
本题最快和累计榜单。

- 规模：单课堂 ≤ 100 人，一节课一个房间，服务跑在教师笔记本上
- 实名免注册：教师导入学生名单，学生只填「房间号 + 学号」，姓名自动带出
- 定位：独立小应用，与 md2slides / mdcode2run 并列的新顶级项目（以后独立 git 仓）

## 2. 玩法（全员竞速，人人有分）

一题的生命周期（房间状态机）：

```
idle --开题--> open(全班作答,限时30s) --到期/教师收卷--> revealed(揭晓) --下一题--> idle
                   |
                   +--教师作废--> idle(本题不计分)
```

- 老师开题后所有人的选项按钮才亮；**人人可答**，提交即锁定，不能反悔改答案
- 提交越早分越高：**得分 = 60 + 40 ×（剩余时间 ÷ 限时）**，四舍五入取整
  - 首秒答对 ≈ 100 分；答对保底 60 分；答错或未提交 0 分
- 答题期间大屏只显示「已提交 N / 全班 M」，**不显示选项分布**——防后来者
  抄人气答案；分布图揭晓后才放出
- 到期自动收卷；教师可「提前收卷」（正常判分）或「作废本题」（不计分，防录错题）
- 揭晓时大屏放出：正确答案、四个选项的人数分布、本题最快答对者（如
  「张三 3.2s +99」）、实时榜单（实名）
- 比赛期间新进的学生本题观战，下一题起可答
- 抢答模式（先按先得、单人作答）与连对加成（streak）放 V2，作为模式开关

## 3. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 后端 | Node.js + `ws`（唯一 npm 依赖） | 生态里 Node 现成；单进程串行处理，判分无竞态；一个 `node server` 起全部 |
| 通信 | WebSocket，文本 JSON 消息 | 倒计时同步与实时提交人数要双向推送 |
| 前端 | 零构建原生 HTML/CSS/JS，静态文件由同一服务托管 | 总共 4 个页面，不上框架不上打包器，改起来最快 |
| 存储 | MVP 内存态 + 对局记录追加写 `data/*.jsonl` | 一节课一房间，重启重开即可；题库/SQLite 放 V2 |
| 二维码 | 本地内联 qrcode.min.js | **禁用一切 CDN**，见 §4 |

备选：Spring Boot 2.7（JDK8 兼容）+ spring-boot-starter-websocket 也完全可行，
如果你更想用 Java 写；协议层设计不变，只是启动重一些。默认按 Node 出 MVP。

## 4. 部署形态（关键决策）

**主方案：教师笔记本开「移动热点」**。学生连笔记本热点，访问
`http://<笔记本IP>:3000`——无公网、无备案、不怕校园网 AP 隔离（校园 WiFi
普遍开 AP 隔离，客户端互不通，走校园网必挂）。

- 静态资源 100% 本地化（系统字体、内联 qrcode.min.js），不引任何 CDN——
  这样无论学生手机有没有外网都能玩
- Windows 防火墙首次要放行 Node 的 3000 端口（专用网络），写成启动文档一节
- 教师页自动生成入房二维码（`http://IP:3000/?room=XXXX`），投影扫一次进全班

**辅方案（为小程序铺路，V3）**：公网 VPS + Caddy + HTTPS/WSS + 备案域名。
课堂内用不到，等小程序上架时再上。

### 4.1 公网地址配置（natapp 穿透，2026-10-27 增）

跨网课堂用：`classbuzz.studybigdata.com` → CNAME → `*.natapp.cc` → natapp 服务器，
转发到本机 3000。

- **配置在服务端**，不是前端也不是 URL 参数：`public-url.txt` 第一行非注释内容就是公网基址
  （也可用环境变量 `CB_PUBLIC_URL` 覆盖）。
- 服务端新增 `GET /api/config` → `{ publicBase, port }`；教师页加载时取它，
  **自动填进「或填公网/穿透地址」并刷新入房链接与二维码**。
- 三级优先级：`?public=xxx`（临时覆盖）> 服务端 `public-url.txt` > 页面自身域名
  （仅当本页就在公网域名上时）。手动改过输入框就不覆盖。
- **为什么必须放服务端**：只靠 `?public=` 的话，老师直接打开 `http://域名/host`
  （不带参数）就会退回局域网地址，二维码编出来的学生就进不来——这是实测踩到的坑。
- **该 natapp 隧道只走明文 http**：https 请求失败，wss 握手报
  `tls_get_more_records: packet length too long`。地址必须写 `http://`，
  WS 走 `ws://`（`net.js` 按 `location.protocol` 自动选 ws/wss）。
  风险：个别手机浏览器会自动把 http 升级成 https，真要规避得换有证书的隧道。
- 实测：公网 `/`、`/host`、`/qr`、`/api/config` 均 200；WS 穿隧道可用，
  端到端（老师本机 + 学生公网）答题往返 135ms。

## 5. 名单与身份

**名单导入（教师）**：从 Excel 全选「学号、姓名」两列复制，粘贴到教师页的
名单框——浏览器粘贴板自动带出 Tab 分隔文本（兼容逗号分隔），前端解析即得
名单，**零依赖、不上传文件**。名单存两处：当前房间（内存）+ 教师本机
localStorage（一学期一份名单，下次课一键载入，不用反复粘）。

| 角色 | 进入方式 | 身份凭证 |
|---|---|---|
| 学生 | 房间号 + 学号 | 姓名**只从名单带出**，学生不可自填；服务端签发 uuid token 存 localStorage |
| 教师 | 首页点「创建房间」 | hostToken 只出现在教师自己的 URL 里，热点内不外泄 |

### 5.1 房口令与「第二个教师端」（2026-10-27 增）

一个房间可以有**多个教师端**同时在线：教师浏览器页（管名单、导出 CSV）+ md2slides
放映宿主（讲义里点「发放」、看结果回讲义）。

- **房口令**：房间创建时生成 6 位（避开易混字符），教师页上显示并可复制。它是
  **第二个教师端的授权凭据**——`host_attach {room, passcode}` 校验通过即拿到 host 角色。
- **为什么不用 hostToken 授权**：hostToken 是 36 位 UUID，藏在教师浏览器的 localStorage
  里，别的进程（Typora 插件里的 md2slides）**读不到**；要授权只能靠能抄的短码。
- **口令位数**：30^6 ≈ 7.3 亿，课堂场景猜不中。校验失败只说「口令不正确」，不说第几位错
  ——试口令的成本要抬高。
- **顶替规则只针对学生**：同学号的新连接顶替旧连接（学生换设备）；
  **教师端之间不互相顶替**——早期这里一视同仁，第二个教师端一连就把第一个踢了。
- 第二个教师端**不产生** hostToken，导出 CSV 仍归主教师端。

- 未导入名单的房间自动降级为**自由昵称模式**（join 传 name），两者共存
- 校验开关（默认**严格**）：开 = 学号不在名单拒入，提示「学号不在名单」；
  关 = 放行但标注「名单外」
- 同一学号再次进入（换设备/断线重连）：视为同一玩家，新连接顶替旧连接，
  旧端收到 `replaced` 提示；得分累计不变
- 学号输入框 `inputmode=numeric`（弹数字键盘），localStorage 记住学号——
  下次上课只需填房间号
- 冒用学号：课堂信任场景不设密码；大屏与榜单实名展示，教师目视可发现异常
- **成绩导出**：教师页「导出成绩」→ HTTP `GET /export/<room>?token=…` 下
  CSV（学号、姓名、出勤=首次进入时间、总分、答题数、答对数、最快单题用时），
  名单的价值最终落在平时分登记上

断线重连全靠 token：客户端 15s 心跳，40s 无心跳判掉线但不删（保留整节课）；
重连后发 `resume {token}`，服务端回全量快照 `sync`。**手机息屏必断 WS，
重连 + 快照回放是必修不是可选项**；快照里含本题 deadline 和「我是否已提交」，
未提交者可在剩余时间内继续作答（用时从 openAt 起算，对先答者公平）。
所有计时判分用服务端时钟，客户端只做展示与倒计时动画。

## 6. 公平性与防作弊底线

1. 正确答案只在 `question_result` 里下发，作答期间 F12 也偷看不到
2. 提交以**服务端接收时间**为准：elapsed = 接收时间 − openAt，过 deadline
   的提交直接拒收
3. 提交即锁定，不能反悔——防「看提交人数变化再换答案」
4. 作答期间大屏与任何广播都不含各选项人数，防抄
5. 服务端在 deadline 到点时统一收卷判分（setTimeout），与客户端倒计时无关

## 7. WS 消息协议（小程序端照此实现，协议即资产）

客户端 → 服务端：

| type | 载荷 | 说明 |
|---|---|---|
| `join` | `{room, sid}`（名单模式）或 `{room, name}`（自由模式） | 入房，回 `join_ok{token, self, snapshot}` |
| `resume` | `{token}` | 断线重连，回 `sync{snapshot}` |
| `answer` | `{choice}` | 提交选项（open 阶段有效），回 `answer_ack` |
| `host_create` | `{}` | 创建房间，回 `host_ok{room, token, joinUrl}` |
| `host_attach` | `{room, passcode}` | **第二个教师端接入**（凭房口令换 host 角色），回 `host_attach_ok` 或 `host_attach_fail` |
| `host_import_roster` | `{rows: [[sid, name], …]}` | 导入/覆盖名单，回 `roster_ok{count}` |
| `host_open` | `{qid, stem, options, answer, limitSec}` | 开题（MVP 题目内联；题库 V2） |
| `host_close` | `{}` | 提前收卷并正常判分揭晓 |
| `host_abort` | `{}` | 作废本题，不计分 |
| `host_next` | `{}` | 结束本题，回待机 |
| `host_scores` | `{}` | 拉成绩明细（成绩管理页），回 `host_scores` 带全班逐人成绩 |
| `host_reset_player` | `{sid}` | **单人成绩清零**，回刷新后的 `host_scores` |
| `host_reset_scores` | `{}` | **全班成绩清零**，回刷新后的 `host_scores` |

服务端 → 客户端：

| type | 载荷 | 目标 |
|---|---|---|
| `join_ok` / `host_ok` / `sync` | token + 快照 | 单播 |
| `host_attach_ok` | `{room, snapshot}` | 单播（第二个教师端） |
| `host_attach_fail` | `{reason}` | 单播（房口令不对） |
| `roster_ok` | `{count, strict}` | 单播（教师） |
| `room_state` | `{phase, players}` | 广播（有人进出房） |
| `question_open` | `{qid, stem, options, limitSec, deadline}` | 广播（**answer 不下发**） |
| `answer_ack` | `{accepted, elapsedMs}` | 单播（客户端转「已提交，等待中…」） |
| `progress` | `{answered, total}` | 广播（open 阶段，每次有人提交） |
| `question_result` | `{answer, distribution[], fastest{name, elapsedMs}, gains{}, scores{}}` | 广播（scores 为排序后榜单） |
| `round_closed` | `{reason}` | 广播（作废本题时） |
| `host_scores` | `{room, phase, playerCount, rosterSize, students[]}` | 单播（教师；明细含未进房的学生） |
| `scores_reset` | `{scope, sid?, leaderboard[]}` | 广播（清零后大屏榜单跟着换） |
| `self_score` | `{score, rank}` | 单播（清零后学生手机刷新自己的分数） |
| `replaced` | — | 单播（被同号新连接顶替的旧端） |
| `pong` | — | 单播 |

成绩导出走 HTTP `GET /export/<room>?token=…`（浏览器直接触发下载，不走 WS）。

### 7.1 成绩清零（2026-10-28 增）

**为什么必须有**：分数在 `closeRound` 那一刻统一入账，`host_abort` 只能撤**还没收卷**的题——
一旦揭晓，成绩就落在 `room.scores` 和各人 `stats` 里，原先没有任何手段拿回来（只能换房间或重启服务，
代价是全班重来）。

清零会同时抹掉三处（漏一处就会「分数 0 了但答题数还在」这种不一致）：
`room.scores`、每位玩家的 `stats{answers, correct, fastestMs}`、`room.lastResult`（它带着旧榜单）。

护栏：
1. **有题在进行中一律拒清**——那题的分数还没入账，清了会把账算乱
2. **主动推送到端**：学生端的分数只在 join/resume/question_result 三条路径下发，清零不在其中；
   不推的话老师清了分、学生手机还挂着旧分，大屏榜单也还是旧的
3. **写 jsonl 留痕**（`scores_reset` 事件），对局记录仍可复盘——清零不可恢复，但发生过什么要能查

顺带修了一个老 bug：`host_abort` 原来无条件广播 `round_closed`，对一道**已揭晓**的题点「作废」
会清空大屏、学生跳待机，分数却一分没动——老师以为撤了，其实没有。现在只有真作废了才广播。

## 8. 页面（5 个，同一服务托管）

| 路由 | 谁 | 职责 |
|---|---|---|
| `/` | 全体 | 学生填房间号+学号（URL 带 `?room=` 时自动填充）；教师「创建房间」 |
| `/host` | 教师 | 名单管理（粘贴导入/一键载入缓存/校验开关/名单人数）、出题（现场录入 +
  粘贴 JSON）、开题/收卷/作废、实时提交进度、入房二维码、下课导出成绩 |
| `/board` | 投影 | 只读大屏：题干+选项+倒计时+「已提交 N/M」；揭晓后分布条形图+最快+实名榜单，
  配合 md2slides 放映 Alt+Tab 切换 |
| `/play` | 学生 | 四个大选项按钮 + 提交后的等待态 + 个人得分与排名 |
| `/scores` | 教师 | **成绩管理**：全班成绩表（学号/姓名/总分/答题/答对/正确率/最快/出勤/在线）、
  排序、单人清零、全班清零、导出 CSV。凭证走 localStorage 里的 hostToken（URL 不带，
  成绩是敏感数据）；有人进出房或收卷时自动重拉 |

成绩管理页与 CSV 导出**共用同一份口径**（`room.scoresDetail()`）——两处各算一遍必然漂移。
名单模式列全班（未进房的也占一行，标「未进入」）；名单外却进了房的补在末尾并标「名单外」
（以前 CSV 会把他们整个漏掉）。

## 9. 内存数据模型

```
rooms: Map<roomCode, Room>
Room {
  code, hostToken, phase,          // idle | open | revealed
  roster: Map<sid, {name}> | null, // null = 自由昵称模式
  strict: bool,                    // 学号必须在名单（默认 true）
  players: Map<token, {sid, name, firstSeen, lastSeen}>,
  bySid: Map<sid, token>,          // 同学号顶替用
  scores: Map<token, int>,
  current: Round | null,
  createdAt
}
Round { qid, stem, options, answer, limitSec,
        openAt, deadline,
        answers: Map<token, {choice, elapsedMs, gained}> }
```

对局记录追加写 `data/<date>-<room>.jsonl`，每题一行（题面、每人的选择/
用时/得分、分布、榜单快照），下课可复盘、可导出错题率（V2）。

## 10. 范围与路线

**MVP（一个周末量级）**：单选题 + 全员竞速 + 服务端判分 + 榜单 + 分布图 +
二维码 + **名单粘贴导入与成绩 CSV 导出** + 热点部署文档。题目来源：教师
控制台现场录入/粘贴 JSON。

- V2：xlsx 文件上传导入名单、多选/判断题、抢答模式（模式开关）、连对加成
  streak、JSON/Excel 题库导入、对局统计导出
- V3（小程序）：后端原样不动；前端把 WS 封装（net.js）换 `wx.connectSocket`
  实现同一协议，页面重写 wxml——或者干脆届时用 uni-app 重写前端一套两端；
  公网 wss + 备案域名。开发期小程序工具勾「不校验合法域名」即可连本机

## 11. 已知坑清单

- 校园 WiFi 的 AP 隔离 → 用笔记本热点规避（§4 主方案的原因）
- Windows 防火墙拦 3000 端口 → 启动文档写清放行步骤
- 手机息屏断 WS → 心跳 + token 重连 + 快照回放（§5）
- 热点无外网时 CDN 资源全挂 → 静态资源全本地，零 CDN（§4）
- 小程序正式环境要求 wss + 备案域名 → H5 阶段不受影响，V3 处理

## 12. 与现有生态的衔接

- 课堂形态：投影主屏跑 md2slides 放映讲义，`/board` 用浏览器另一窗口全屏，
  Alt+Tab 或双屏切换，不入侵现有放映流程
- **竞答结果回流讲义（已落地，2026-10-27）**：md2slides 讲义里用
  `<!--quiz {"answer":"B","limit":30}-->` 写题，放映时题干旁出现「发放」按钮 →
  走 `host_open` 把题发给学生 → 学生抢答 → `question_result` **回到讲义的底部浮层**
  （正确答案 / 选项分布 / 最快 / 榜单）。md2slides 侧凭「房间号 + 房口令」以第二个
  教师端身份接入（`host_attach`）。
- 远期一句：题库 JSON 可以由讲义块标注生成（mdcode2run 的 fence 标注思路），
  做到「讲义里写题、课堂上竞答」——**这条已经落地**（就是上面的 `<!--quiz-->` 标记），
  剩下的只是题库化与多选/判断题。
