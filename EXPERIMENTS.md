# Active Collaboration IoT - 实验规划和数据收集方案

## 目标

验证Active Collaboration IoT框架的核心架构原则和关键特性，为学术论文提供实验数据支持。

## 实验优先级分类

### P0: 核心架构验证（必须完成）
- **目标**: 验证三大核心架构原则
- **重要性**: 论文核心贡献点
- **预计时间**: 2-3周

### P1: AC特性验证（重要）
- **目标**: 验证Active Collaboration关键功能
- **重要性**: 论文创新点
- **预计时间**: 1-2周

### P2: 可扩展性和性能（可选）
- **目标**: 验证系统在更大规模下的表现
- **重要性**: 论文补充材料
- **预计时间**: 1周

---

## P0-1: Agent自主决策能力验证

### 实验目标
验证Cognitive Agent能够基于局部信息自主做出合理决策，无需中央控制。

### 实验场景
**温控场景 - 单Agent决策**

#### 环境配置
```
- 环境名称: "实验-温控-单Agent"
- 房间: 客厅 (10m x 8m x 3m)
- 初始温度: 20°C
- 目标温度: 24°C
- 外部温度: 15°C
```

#### 设备配置
1. **温度传感器** (位置: 5, 4, 1.5)
   - capabilities: ["temperature"]
   - samplingRate: 5000ms

2. **空调设备** (位置: 5, 7, 2.5)
   - capabilities: ["temperature_control"]
   - power: 2000W
   - 可调节温度范围: 16-30°C

3. **温度传感器2** (位置: 5, 1, 1.5)
   - capabilities: ["temperature"]
   - samplingRate: 5000ms

#### Agent配置
```json
{
  "name": "温控Agent-01",
  "llmConfig": "qwen3-14b-q4",
  "autonomousConfig": {
    "decisionInterval": 10000,
    "thresholds": [
      {
        "parameter": "temperature",
        "operator": "<",
        "value": 22,
        "action": "start_heating",
        "enabled": true
      },
      {
        "parameter": "temperature",
        "operator": ">",
        "value": 26,
        "action": "stop_heating",
        "enabled": true
      }
    ],
    "schedules": [],
    "triggers": []
  },
  "bindings": {
    "devices": ["temp-sensor-01", "ac-01"],
    "services": []
  }
}
```

### 实验步骤

1. **初始化阶段** (5分钟)
   - 创建环境和设备
   - 部署Agent
   - 启动物理仿真
   - 记录初始状态

2. **观察阶段** (30分钟)
   - 每5秒记录：
     - 房间温度（多个传感器读数）
     - 空调状态（开/关，功率）
     - Agent决策内容（LLM推理过程）
     - Agent执行的动作
     - 物理仿真状态（热量传播）

3. **干扰测试** (10分钟)
   - 手动打开窗户（改变隔热参数）
   - 观察Agent如何响应环境变化
   - 记录Agent适应时间和决策调整

4. **数据收集**
   - 决策延迟: 从感知到行动的时间
   - 决策准确率: 是否达到目标温度
   - 能耗效率: 达到目标消耗的能量
   - 自适应能力: 干扰后恢复稳定的时间

### 数据收集清单

#### 定量指标
```json
{
  "decisionLatency": {
    "description": "从传感器读数到Agent决策的时间",
    "unit": "ms",
    "target": "< 5000ms"
  },
  "temperatureStability": {
    "description": "温度达到稳定状态后的波动范围",
    "unit": "°C",
    "target": "± 0.5°C"
  },
  "energyEfficiency": {
    "description": "达到目标温度消耗的总能量",
    "unit": "kWh",
    "baseline": "理论最小能耗"
  },
  "adaptationTime": {
    "description": "干扰后重新稳定的时间",
    "unit": "s",
    "target": "< 300s"
  },
  "decisionAccuracy": {
    "description": "决策是否符合当前环境状态",
    "unit": "percentage",
    "target": "> 95%"
  }
}
```

#### 定性观察
- Agent的推理过程是否合理
- Agent是否考虑了多个传感器的读数
- Agent是否正确理解了设备能力
- Agent是否在决策中体现了时空上下文

### 预期结果
- ✅ Agent能够自主读取传感器数据
- ✅ Agent能够基于数据做出加热/停止决策
- ✅ Agent决策延迟 < 5秒
- ✅ 温度稳定在24°C ± 0.5°C
- ✅ 干扰后Agent能够自适应调整

### 失败标准
- ❌ Agent无法读取传感器数据
- ❌ Agent决策与实际需求相反（温度高时加热，低时停止）
- ❌ 决策延迟 > 10秒
- ❌ 温度无法稳定，持续震荡
- ❌ 干扰后Agent无响应或错误响应

---

## P0-2: Service-Device解耦验证

### 实验目标
验证Service层与Device层的解耦，Service可以独立于Device存在和演化。

### 实验场景
**照明场景 - Service合成与设备绑定**

#### 环境配置
```
- 环境名称: "实验-照明-Service解耦"
- 房间: 办公室 (8m x 6m x 3m)
- 初始光照: 300 lux
- 目标光照: 500 lux
```

#### 第一阶段：无设备Service

1. **创建Agent**
   ```json
   {
     "name": "照明Agent-01",
     "llmConfig": "qwen3-14b-q4",
     "bindings": {
       "devices": [],
       "services": []
     }
   }
   ```

2. **Agent合成Service**
   - Agent通过LLM推理需要"照明控制"能力
   - Agent创建Service描述（语义化）
   - Service在ServiceRegistry中注册
   - **关键验证**: Service存在但无绑定Device

3. **数据收集**
   - Service注册成功
   - Service描述清晰度（人工评估）
   - Service参数定义完整性

#### 第二阶段：设备接入

4. **添加物理设备**
   - 添加智能灯1 (位置: 4, 3, 2.8)
   - 添加智能灯2 (位置: 4, 6, 2.8)

5. **Resource创建**
   - Device被封装为Resource
   - Resource暴露"照明控制"接口

6. **Service-Resource绑定**
   - Agent将Service绑定到Resource
   - **关键验证**: Service功能保持不变，实现层替换

7. **功能验证**
   - 通过Service调用控制灯光
   - 验证物理设备响应正确

#### 第三阶段：设备替换

8. **移除智能灯1**
   - 从环境中删除设备
   - Service状态变为"部分可用"

9. **添加新智能灯3**
   - 新设备接入
   - Agent重新绑定Service
   - **关键验证**: Service无需修改，自动适配新设备

### 数据收集清单

```json
{
  "serviceCreation": {
    "description": "Service是否能在无设备时创建",
    "metrics": ["成功/失败", "创建时间", "描述清晰度"]
  },
  "serviceDeviceIndependence": {
    "description": "Service是否独立于具体设备",
    "metrics": ["设备移除后Service状态", "Service接口变化"]
  },
  "serviceEvolution": {
    "description": "Service是否能够动态演化",
    "metrics": ["新设备接入时间", "Service重新绑定时间"]
  },
  "abstractionQuality": {
    "description": "Service抽象层质量",
    "metrics": ["接口清晰度", "参数定义完整性", "文档可读性"]
  }
}
```

### 预期结果
- ✅ Agent能在无设备时创建Service
- ✅ Service接口独立于Device实现
- ✅ 设备移除/添加不影响Service接口
- ✅ Service绑定过程 < 5秒
- ✅ Service抽象层清晰易懂

---

## P0-3: 物理环境仿真验证

### 实验目标
验证物理环境仿真的准确性和时空传播特性。

### 实验场景
**热源传播场景**

#### 环境配置
```
- 环境名称: "实验-物理仿真-热传播"
- 房间: 20m x 20m x 3m 开放空间
- 初始温度: 均匀20°C
- 隔热参数: 混凝土墙壁
```

#### 设备配置
1. **热源** (位置: 10, 10, 0)
   - 功率: 5000W
   - 类型: 点热源

2. **温度传感器阵列** (25个传感器，5x5网格)
   ```
   (5,5)   (5,10)  (5,15)
   (10,5)  (10,10) (10,15)  ...
   (15,5)  (15,10) (15,15)
   ```
   - 采样率: 1秒

### 实验步骤

1. **初始化** (2分钟)
   - 验证所有传感器读数一致（20°C ± 0.1°C）

2. **热源启动** (30分钟)
   - 开启热源
   - 每秒记录所有传感器温度
   - 生成温度传播动画

3. **稳态观察** (10分钟)
   - 热源保持开启
   - 观察温度分布是否稳定

4. **热源关闭** (20分钟)
   - 关闭热源
   - 观察温度恢复过程

### 数据收集清单

```json
{
  "propagationSpeed": {
    "description": "温度变化从中心传播到边缘的速度",
    "unit": "m/s",
    "theoretical": "热传导方程计算值"
  },
  "spatialDistribution": {
    "description": "温度的空间分布是否符合物理规律",
    "metrics": ["径向对称性", "梯度连续性"]
  },
  "steadyState": {
    "description": "稳态时的温度分布",
    "metrics": ["中心温度", "边缘温度", "温度梯度"]
  },
  "coolingCurve": {
    "description": "热源关闭后的冷却曲线",
    "metrics": ["冷却时间常数", "温度恢复均匀性"]
  },
  "accuracy": {
    "description": "仿真结果与理论值/实测值的偏差",
    "unit": "percentage",
    "target": "< 5%"
  }
}
```

### 预期结果
- ✅ 温度传播符合热传导方程
- ✅ 空间分布径向对称
- ✅ 传播速度与理论值误差 < 5%
- ✅ 稳态分布符合物理规律
- ✅ 冷却过程符合牛顿冷却定律

---

## P1-1: 跨Agent协作验证

### 实验目标
验证多个Agent通过Active Collaboration机制自发协作完成任务。

### 实验场景
**智能办公场景 - 温度+照明+安防协作**

#### 环境配置
```
- 环境名称: "实验-协作-智能办公"
- 区域:
  - 办公区 (15m x 10m)
  - 会议室 (8m x 6m)
  - 走廊 (10m x 3m)
```

#### Agent配置

1. **温控Agent**
   ```json
   {
     "name": "温控Agent",
     "capabilities": ["temperature_control"],
     "bindings": {
       "devices": ["temp-sensors", "hvac"],
       "services": []
     }
   }
   ```

2. **照明Agent**
   ```json
   {
     "name": "照明Agent",
     "capabilities": ["lighting_control"],
     "bindings": {
       "devices": ["light-sensors", "smart-lights"],
       "services": []
     }
   }
   ```

3. **安防Agent**
   ```json
   {
     "name": "安防Agent",
     "capabilities": ["security_monitoring"],
     "bindings": {
       "devices": ["motion-sensors", "cameras"],
       "services": []
     }
   }
   ```

### 实验步骤

1. **独立运行** (10分钟)
   - 三个Agent各自管理自己的领域
   - 验证独立功能正常

2. **协作触发** (20分钟)
   - 模拟会议场景：
     - 人员进入会议室
     - 安防Agent检测到人员移动
     - **协作**: 安防Agent通过AC机制通知照明Agent和温控Agent
     - 照明Agent调整会议室灯光
     - 温控Agent调整会议室温度

3. **协作数据收集**
   - 协作提案生成时间
   - 提案接受率
   - 协作完成时间
   - 资源共享效率

### 数据收集清单

```json
{
  "collaborationProposalTime": {
    "description": "从事件触发到协作提案生成的时间",
    "unit": "ms",
    "target": "< 3000ms"
  },
  "proposalAcceptanceRate": {
    "description": "协作提案被接受的比例",
    "unit": "percentage",
    "target": "> 80%"
  },
  "collaborationEfficiency": {
    "description": "协作完成任务的时间",
    "unit": "s",
    "baseline": "单Agent完成时间"
  },
  "resourceSharingSuccess": {
    "description": "Agent间资源共享成功率",
    "unit": "percentage",
    "target": "> 90%"
  },
  "emergentBehavior": {
    "description": "是否出现设计时未预见的协作模式",
    "type": "qualitative"
  }
}
```

### 预期结果
- ✅ Agent能够自发形成协作
- ✅ 协作提案生成 < 3秒
- ✅ 提案接受率 > 80%
- ✅ 协作效率优于单Agent
- ✅ 可能出现新的协作模式

---

## P1-2: 时空上下文感知验证

### 实验目标
验证Agent在决策时正确考虑时空上下文（设备位置、可用性、环境状态）。

### 实验场景
**多房间温控 - 时空约束**

#### 环境配置
```
- 环境名称: "实验-时空-多房间"
- 房间:
  - 客厅 (10m x 8m, 温度: 20°C)
  - 卧室 (6m x 5m, 温度: 22°C)
  - 厨房 (5m x 4m, 温度: 25°C)
```

#### 设备配置
1. **客厅空调** (位置: 客厅-5,7,2.5)
   - 可控范围: 客厅

2. **卧室空调** (位置: 卧室-3,2,2.5)
   - 可控范围: 卧室

3. **温度传感器**
   - 客厅传感器 (位置: 客厅-5,4,1.5)
   - 卧室传感器 (位置: 卧室-3,2,1.5)
   - 厨房传感器 (位置: 厨房-2,2,1.5)

#### Agent配置
```json
{
  "name": "多房间温控Agent",
  "llmConfig": "qwen3-14b-q4",
  "bindings": {
    "devices": ["all-sensors", "all-ac"],
    "services": []
  }
}
```

### 实验步骤

1. **场景1: 正确选择** (10分钟)
   - 客厅温度降至18°C
   - Agent需要加热客厅
   - **验证**: Agent选择客厅空调，而非卧室或厨房空调

2. **场景2: 位置约束** (10分钟)
   - 客厅空调故障
   - Agent需要加热客厅
   - **验证**: Agent识别无法使用其他房间的空调加热客厅

3. **场景3: 时间约束** (10分钟)
   - 晚上23:00，卧室温度低
   - Agent需要考虑"夜间模式"和"静音"约束
   - **验证**: Agent决策包含时间和模式上下文

### 数据收集清单

```json
{
  "spatialAwarenessAccuracy": {
    "description": "Agent是否正确选择对应位置的设备",
    "unit": "percentage",
    "target": "> 95%"
  },
  "constraintSatisfaction": {
    "description": "Agent决策是否满足时空约束",
    "metrics": ["位置约束", "时间约束", "可用性约束"]
  },
  "contextualReasoning": {
    "description": "Agent推理过程中是否提及上下文",
    "type": "qualitative",
    "evaluation": "检查LLM推理日志"
  }
}
```

### 预期结果
- ✅ Agent正确匹配设备位置和目标区域
- ✅ Agent不尝试跨房间使用设备
- ✅ Agent考虑时间上下文（白天/夜晚/工作时段）
- ✅ 时空上下文在推理过程中明确体现

---

## P2-1: 多用户场景验证

### 实验目标
验证系统支持多用户、多环境、多Agent同时运行。

### 实验场景
**多用户并发场景**

#### 用户配置
```
- 用户1: 管理"智能家居-A"
- 用户2: 管理"智能家居-B"
- 用户3: 管理"小型办公室"
```

#### 每个用户的配置
- 1个环境
- 3-5个Agent
- 10-15个设备

### 实验步骤

1. **并发创建** (10分钟)
   - 3个用户同时创建环境
   - 记录系统响应时间

2. **并发运行** (30分钟)
   - 所有用户的Agent同时运行
   - 记录资源使用情况

3. **数据隔离验证**
   - 验证用户A无法访问用户B的环境
   - 验证数据正确隔离

### 数据收集清单

```json
{
  "concurrentUsers": {
    "description": "系统支持的最大并发用户数",
    "metrics": ["响应时间", "错误率"]
  },
  "resourceUsage": {
    "description": "系统资源使用情况",
    "metrics": ["CPU", "内存", "网络带宽"]
  },
  "dataIsolation": {
    "description": "数据隔离是否完整",
    "metrics": ["越权访问尝试", "数据泄露事件"]
  }
}
```

---

## 实验执行流程

### 前置准备

1. **环境准备**
   ```bash
   # 确保Ollama运行
   ollama serve

   # 确保模型可用
   ollama pull qwen3-14b-q4:latest

   # 启动后端服务
   cd active-collaboration-iot
   npm run dev
   ```

2. **数据收集工具准备**
   - 日志系统配置
   - 性能监控工具
   - 数据导出脚本

### 执行顺序

**Week 1: P0-1 (Agent自主决策)**
- Day 1-2: 环境搭建，设备配置
- Day 3-4: 运行实验，收集数据
- Day 5: 数据分析，生成报告

**Week 2: P0-2 + P0-3 (Service解耦 + 物理仿真)**
- Day 1-2: Service-Device解耦实验
- Day 3-4: 物理仿真验证
- Day 5: 数据分析，交叉验证

**Week 3: P1-1 + P1-2 (跨Agent协作 + 时空上下文)**
- Day 1-3: 跨Agent协作实验
- Day 4-5: 时空上下文验证

**Week 4: P2 + 综合分析**
- Day 1-2: 多用户场景（可选）
- Day 3-5: 综合数据分析，生成论文图表

### 数据存储结构

```
experiments/
├── P0-1_Agent_Autonomy/
│   ├── raw_data/
│   │   ├── agent_decisions.json
│   │   ├── device_states.json
│   │   ├── environment_states.json
│   │   └── llm_logs.json
│   ├── processed_data/
│   │   ├── metrics_summary.json
│   │   └── analysis_results.json
│   ├── visualizations/
│   │   ├── temperature_curve.png
│   │   ├── decision_timeline.png
│   │   └── adaptation_response.png
│   └── report/
│       └── P0-1_experiment_report.md
├── P0-2_Service_Decoupling/
├── P0-3_Physical_Simulation/
├── P1-1_Cross_Agent_Collaboration/
├── P1-2_Spatiotemporal_Context/
└── P2-1_Multi_User/
```

---

## 成功标准

### 整体目标
- ✅ 所有P0实验完成，数据支持核心架构原则
- ✅ 至少1个P1实验完成，展示AC特性
- ✅ 收集足够数据支持论文图表和结论
- ✅ 发现至少1个设计时未预见的涌现行为

### 数据质量标准
- ✅ 每个实验至少3次重复运行
- ✅ 数据完整性 > 99%
- ✅ 异常值有明确解释
- ✅ 数据可追溯，可复现

### 论文贡献
- ✅ P0实验提供架构验证数据
- ✅ P1实验提供创新性证据
- ✅ 实验结果支持核心论点
- ✅ 可视化图表清晰展示关键发现

---

## 风险和应对

### 风险1: LLM不稳定
**应对**:
- 使用相同的随机种子
- 多次重复实验取平均
- 记录所有LLM交互日志

### 风险2: 物理仿真不准确
**应对**:
- 与理论计算对比
- 简化场景验证
- 调整仿真参数

### 风险3: Agent协作失败
**应对**:
- 从简单场景开始
- 逐步增加复杂度
- 详细日志分析失败原因

### 风险4: 时间不足
**应对**:
- 优先完成P0实验
- P1实验可选择性完成
- P2实验作为补充材料

---

## 下一步行动

1. **立即可做**:
   - [ ] 创建实验数据存储目录结构
   - [ ] 编写数据收集脚本
   - [ ] 准备P0-1实验的环境配置文件

2. **本周完成**:
   - [ ] 执行P0-1实验（3次重复）
   - [ ] 分析P0-1数据
   - [ ] 生成P0-1可视化图表

3. **后续规划**:
   - [ ] 根据P0-1结果调整后续实验
   - [ ] 准备P0-2和P0-3实验
   - [ ] 编写自动化测试脚本
