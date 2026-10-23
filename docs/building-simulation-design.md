# 建筑内仿真设计：多楼层模型 + 图纸/BIM 导入

> 本文档是 product_design.md §11.4（地图系统）与 multi-user-simulation-design.md 的续篇，
> 回答智慧校园场景的核心建模问题：如何仿真一栋多楼层建筑的内部环境与设备效应，
> 以及如何从建筑图纸（BIM 优先、LLM+CV 兜底）自动生成内部模型。
> 状态：初版（2026-07）。

---

## 1. 现状核查（改动量的依据）

已具备：

- **房间 = zone**：bounds（轴对齐矩形，米，y 向下，可选 minZ/maxZ——schema 留了 3D 口子
  但下游未用）+ baseline（任意环境参数基准值）。
- **环境互相影响**：`SpatialField`（physics 层的活引擎）把 zone 当作位于其中心的点，
  温度/湿度/CO2/光照/PM2.5 按欧氏距离两两扩散（耦合半径 5m），向 baseline 松弛。
- **设备影响环境闭环**：hvac/heater/humidifier/light 等 → `EffectSource`（功率/半径/衰减）
  → 物理场 → 传感器读数 → agent 感知。强度目前在 `SimulatedDevice.createPhysicsEffect`
  硬编码（hvac ±3000W r=4m 等）。
- **楼层概念碎片**（可复用，勿重复发明）：`ZoneType` 枚举已含 `'building'|'floor'`；
  `ZoneConfig.parent?` 父子层级口子；`ZoneTransferModel` 已有 wall/door/floor/ceiling
  连接类型与 U 值语义（但未接线）。

需要注意的坑：

- **邻接靠手写**：loader 不做任何自动生成，`adjacentZoneIds` 必须双向手工声明。
- **扩散不认邻接也不认墙**：纯中心距 < 5m 即耦合。多楼层直接堆叠会让上下层
  （中心距 ≈ 层高 3~4m）被错当成强耦合邻居——这是多楼层的头号问题。
- **`SpatialGrid`/`GridPhysicsEngine` 是死代码**（完整 3D 六邻接扩散但无人实例化）。
  本设计不复活它，继续在 SpatialField 上演进。
- **map_data 只有 grid/geo 两档**，`EnvZone.bounds` 丢了 Z；§11.4 的 image 档
  （平面图底图）尚未实现。
- 坐标系：米，y 向下，原点左上角（见 suzhou-apartment meta）。

## 2. 设计原则

1. **楼层是元数据，不是坐标系革命**。每层保持自己的 2D 平面坐标（贴合平面图图片与
   前端渲染），楼层间通过显式声明的垂直连接耦合——不引入全 3D 几何。
2. **演进而非替换**：同层扩散保持现有距离式行为（既有场景零回归）；楼层感知只做
   增量修正。死代码（SpatialGrid）不复活、不删除。
3. **导入器产物统一**：BIM 与图纸识别只是两个前端，都产出同一份中间表示（Building IR），
   再编译为 scenario JSON v1.0——下游加载/校验/导入/仿真管道零改动。
4. **机器生成，人来定稿**：导入结果一律进人工确认界面（复用提案-审批心智），
   识别错误不出确认页。

## 3. 数据模型：建筑层级

### 3.1 scenario / map_data 增量

zone 增加两个可选属性（扁平结构，不嵌套——迁移成本最低）：

```
buildingId?: string   // 所属建筑；缺省 = 单建筑场景
floor?: number        // 楼层号（0=地面层）；缺省 = 0
```

meta 增加 `storeyHeight?: number`（默认 3.5m，用于物理层 z 换算与前端层间距）。
`EnvZone` 同步补 `floor`/`buildingId`；`bounds.minZ/maxZ` 维持可选不用。

### 3.2 垂直邻接

跨层连接**显式声明**：楼梯间/电梯井/管道井是普通 zone，其 `adjacentZoneIds`
可以指向相邻楼层的同名井道 zone。loader 校验不变（引用完整性），
物理层据此建立跨层耦合（§4）。邻接仍手写或由导入器生成，但 loader 新增
**自动补对称**（声明 A→B 即隐含 B→A，消除一半手误）与 **floor 一致性警告**
（相邻 zone 的 floor 差 >1 时校验警告）。

### 3.3 前端地图层级

geo 层（校区）→ 点击建筑 → 楼层切换器 → 单层平面（grid 视图，或 §11.4 的
image 底图）。WorldMap 按 `floor` 分组渲染，设备点归属其 zone 的楼层；
跨层井道 zone 在每层都显示（同名实体）。image 档底图（每楼层一张平面图）
随 B-A 一并落地——它是图纸导入器的天然确认界面。

## 4. 物理：楼层感知耦合

`EngineRuntime.zoneCenter` 从 2D 扩展为 `{x, y, z: floor × storeyHeight}`
（`FieldPosition` 类型本就允许 Coordinate3D）。`SpatialField` 扩散规则修正：

- **同层**（floor 相同）：维持现状——中心距 < 5m 欧氏耦合，既有场景行为不变。
- **跨层**：仅当两 zone 在 `adjacentZoneIds` 中显式互连（井道），才耦合，
  且通量乘以 **slabAttenuation**（楼板衰减系数，默认 0.15，可在 zone baseline
  或 meta 覆盖）；非互连的上下层零耦合（楼板是良隔热边界）。
- 修正 5m 半径在 3D 距离下的误判：耦合判定改为"同层用 2D 距离，跨层只看声明"。

### 4.1 围护与室外边界

- `type: 'outdoor'` 的特殊 zone：不参与建筑内扩散，其 baseline 由孪生同步
  （multi-user-simulation-design §6 的管道）喂真实天气；作为所有邻接室内 zone 的
  边界条件。
- 室内 zone 与 outdoor 的交换强度 = **envelopeU**（围护 U 值语义，简化为每 zone
  一个标量，默认按楼层/朝向给经验值；BIM 有建材数据时导入精确值）。
  复用 `ZoneTransferModel` 的类型与 U 值语义，但实现落在 SpatialField 的
  耦合系数上，不接入那个未接线的模型类。

### 4.2 人员（occupancy）模型

人是移动的热源 + CO2 源：zone 增加 `occupancy?: number`（当前人数），
每人折算固定效应（显热 ~75W、CO2 呼出速率，参数进 meta 可调），
以 EffectSource 形式注入该 zone 中心。occupancy 的驱动源三选一：
课表/日程（scenario events 按时间点设置）、实测人流（孪生同步推送）、
agent 模拟（远期）。v1 只做前两种。

## 5. Building IR 与导入器

### 5.1 中间表示（Building IR）

```json
{
  "meta": { "name": "...", "storeyHeight": 3.5, "units": "m" },
  "buildings": [{ "id": "EB", "name": "基础楼" }],
  "floors": [{ "buildingId": "EB", "floor": 1, "planImage": "eb-f1.png", "scale": {"pixelsPerMeter": 12.5} }],
  "rooms": [{ "id", "buildingId", "floor", "name", "bounds|polygon", "type" }],
  "connections": [{ "a": "roomId", "b": "roomId", "kind": "door|open|stair|elevator|shaft|window-to-outdoor" }],
  "envelope": [{ "roomId", "uValue?" }]
}
```

编译器 `BuildingIR → scenario JSON v1.0`：room→zone（矩形取包围盒，多边形
v1 也取包围盒——物理层本来就只用中心点与对角线半径）、door/open→同层邻接、
stair/elevator/shaft→跨层邻接（井道 zone 自动生成）、window-to-outdoor→
与 outdoor zone 的围护耦合。产物过 loadScenarioFile 全量校验后才允许落库。

### 5.2 IFC 导入器（BIM 优先）

- 输入：IFC（STEP）文件。解析用 web-ifc（WASM，node 可用）；提取
  `IfcProject → IfcBuilding → IfcBuildingStorey → IfcSpace` 树，
  space 的平面足迹 → room bounds，storey 标高 → floor + storeyHeight，
  `IfcDoor`/`IfcRelSpaceBoundary` → connections，建材层热工参数 → envelope.uValue。
- 降级：IFC 里 Space 缺失或几何不全时，按 storey 切分 + 提示用户转图纸通道。
- 形态：CLI 先行（`apps/cli` 或 scripts/），输出 IR JSON；API 化随前端确认界面一起做。

**实现状态（2026-07，B-C 落地）**：IR 类型（`packages/core/src/scenario/building-ir.ts`）、
IR→scenario 编译器（`building-compiler.ts`，产物内部过 `loadScenarioFile` 后才返回）、
IFC 解析器（`ifc-parser.ts`）均落在 core 的 scenario 模块；CLI 命令
`eaf import-ifc <file.ifc> [--out scenario.json] [--ir ir.json] [--name n] [--id id]`
在 apps/cli。实际解析路径是 **web-ifc 0.0.77**（core 依赖，WASM 本地运行、懒加载），
但只做**属性图遍历**（GetLine，不生成网格几何）：storey 标高 → floor/storeyHeight、
IfcRelContainedInSpatialStructure → space 归层、IfcBoundingBox + IfcLocalPlacement
平移链（忽略旋转）→ room bounds、IfcRelSpaceBoundary 按 IfcDoor/IfcWindow/虚拟边界
分组 → door / window-to-outdoor / open 连接。已知限制：space 无 BoundingBox 时按层
均分 8×6m 网格兜底并标 `estimated: true`；stair/elevator/shaft 连接不从 IFC 推导
（留空待确认界面补，编译器已支持手写 IR 的井道生成）；建材层热工参数未提取
（envelope 恒为空）；长度单位未做换算（假定米）；不组合旋转/镜像变换，IFC 的 y 轴
方向与场景 y-down 约定可能相反，均需确认界面校正。

### 5.3 图纸视觉导入器（LLM+CV 兜底）

流水线（每步产出可人工修正的中间结果）：

1. **预处理（CV 小模型）**：平面图图像 → 墙体线段检测、房间区域分割
   （经典 CV：直线检测 + 连通域；或轻量分割模型）。产出候选房间多边形与门洞位置。
2. **语义理解（多模态 LLM）**：图像 + CV 候选 → 房间功能命名（"308 教室"、
   "男卫"）、门窗确认、楼梯/电梯识别。经 llm-integration 的 OpenAI 兼容端点调用，
   ChatParams.format 约束输出 schema。
3. **比例尺标定**：用户标注一个已知尺寸（"这段墙 8m"）→ pixelsPerMeter；
   图纸自带比例尺文字时 LLM 直接读出，用户确认。
4. **人工确认**：在 image 底图上展示识别的 zone 框与邻接边，可增删改，
   确认后编译为 scenario JSON，走提案管道注入环境（builder 提交 → 审批）。

策略组合：**有 BIM 用 BIM（精确、带热工参数）；没有则 LLM+CV；
两者产物同一份 IR，确认界面同一个。**

**实现状态（2026-07，B-D 落地）**：

- **视觉流水线**：`packages/core/src/scenario/floorplan-vision.ts`。
  `recognizeFloorplan(client, {image, preprocessed?})` 把平面图（base64 +
  mimeType）发给多模态 LLM，`ChatParams.format` 约束为
  `FLOORPLAN_RECOGNITION_SCHEMA`（像素坐标矩形房间 + 门/开洞/楼梯/电梯/
  窗 connections + 可选比例尺读数）。解析宽容（剥代码围栏/散文），不合规
  输出、空调用、超时一律抛 `FloorplanVisionError`（参考 LLMReviewer 的
  降级风格，但不静默降级）。`buildFloorplanIR` 把像素坐标按确认后的
  pixelsPerMeter 换算成米制 IR（房间 id 沿用 IFC 惯例 `name-f<n>`）。
- **多模态支持**：llm-integration 的 `ChatMessage.content` 扩展为
  OpenAI 兼容 content parts（`{type:'text'}` / `{type:'image_url'}`）。
  OpenAI 兼容端点原生透传；Ollama provider 映射为其原生
  `messages[].images`（base64，自动剥 data-URI 前缀）；日志/缓存键经
  `messageContentToText` 压平（图片只留占位符）。
- **比例尺标定**：`resolveFloorplanScale` 只接受调用方确认的两种输入——
  显式 `pixelsPerMeter`，或 `pixelsPerMeterFromCalibration`（已知尺寸
  线段 x1,y1,x2,y2 + 米数换算，欧氏距离）。LLM 从图上读出的比例尺只作为
  `scaleSuggestion` 返回并在 CLI 里打印提示，**从不静默采用**。
- **CV 预处理**：仅接口 `FloorplanPreprocessor`（`preprocess(image)` →
  候选房间框 + notes，注入 prompt 文本），默认 `noopFloorplanPreprocessor`
  直通。纯 TS 自研 CV 代价过高，留待后续接 OpenCV.js 等实现。
- **CLI**：`eaf import-floorplan <image> --building <id> --floor <n>
  (--scale <pxPerM> | --calibrate x1,y1,x2,y2,<m>) [--ir out.json]
  [--out scenario.json] [--merge base-ir.json] [--from-ir ir.json]
  [--submit <server-url>] [--provider/--model/--base-url]`。LLM 配置走
  `EAF_VISION_PROVIDER`（默认 `openai-compatible`，可指 vLLM 等 OpenAI 兼容端点；
  历史 ollama 后端已移除 R44-B）/ `EAF_VISION_MODEL` /
  `EAF_VISION_BASE_URL`（`createVisionClientFromEnv`，core 导出）。
  缺省视觉模型为 `Qwen/Qwen2.5-VL-7B-Instruct`（`DEFAULT_VISION_MODEL`；
  有意不沿用 agent 决策用的文本模型）。
- **确认闭环**：无拖拽编辑界面（留待后续）。最小闭环 = `--ir` 导出 IR
  人工检查/编辑后 `--from-ir` 重编译（多层用 `--merge` 逐层追加，跨层
  楼梯连接此时手工补）；`--submit` 为可选项，POST 编译产物到
  `POST /api/environments`（场景导入端点，需登录，**新建**环境）。
  偏离设计的一点：未走 inject-scenario 提案管道——该管道规则校验只接受
  devices/events 片段，无法注入 zone（zone 属于基础层 map_data），故图纸
  导入走既有的场景导入端点，审批语义由"导入者即 owner"替代。
- **image 底图档**：未新增独立 map_type——`map_data.floorPlans`
  （`{buildingId?, floor, image(URL|dataURI), pixelsPerMeter}`）挂在 grid
  图上。编译器把带 `planImage`+`scale` 的 IR 楼层写进 scenario 的
  非校验 `map` 块（与 geo 多边形同一机制），environment-import 恢复进
  map_data；前端 WorldMap 在选中楼层把图片作为 ReactFlow 背景节点渲染
  （左上角 = 世界原点，按 pixelsPerMeter × 64px/m 缩放对齐 zone 框）。
  CLI 导入时默认把源图以 dataURI 嵌入 planImage。
- **已知限制**：单图单层识别（多层 = 多次调用 + `--merge`）；stair/
  elevator 跨层连接不由 LLM 推导，需 IR 往返手工补（编译器井道生成已
  支持）；未对图片尺寸/体积做限制（dataURI 大图会撑大 map_data）；
  底图原点固定为 (0,0)，无平移/旋转校正参数；前端底图选中逻辑按
  floor 匹配，多栋楼同层共用一张底图。

## 6. 分期路线

- **B-A 楼层模型**：zone floor/buildingId 属性 + EnvZone 同步 + loader 邻接自动
  补对称与 floor 警告 + 物理层楼层感知耦合（§4 同层/跨层规则）+ map_data/前端
  楼层分组与 image 底图档 + 一栋 3 层教学楼种子场景（含楼梯井、outdoor zone）
  端到端验证。验收：楼下开空调不会直接影响楼上非井道房间；井道上下层有耦合。
- **B-B 围护与人员**：outdoor zone 耦合 + envelopeU + occupancy 效应源 +
  课表事件驱动示例。验收：室外降温经围护缓慢渗入室内；教室上课时段 CO2 上升。
- **B-C IFC 导入器**：IR + web-ifc 解析 + 编译器 + CLI，拿真实或样例 IFC 验证。
- **B-D 图纸导入器**：CV 预处理 + 多模态 LLM + 比例尺标定 + 确认界面（前端），
  走提案管道。

## 7. 明确不做（当前阶段）

- 全 3D 物理网格（SpatialGrid 复活）、CFD 级气流仿真
- zone 多边形参与物理计算（v1 一律包围盒；多边形仅 geo 展示层）
- BIM 的反向导出、模型在线编辑（只导入，编辑在确认界面做）
- 人员个体级 agent 仿真（occupancy 是聚合计数，不是行人模拟）
