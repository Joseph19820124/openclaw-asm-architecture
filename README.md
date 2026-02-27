```mermaid
graph TD
    %% 外部请求
    User((User/Client)) -- HTTPS --> WAF[AWS WAF]
    WAF --> CF[Amazon CloudFront]
    CF --> ALB[Application Load Balancer]

    %% 接入层 (Fargate)
    subgraph Ingress_Layer [接入层]
        ALB --> Gateway[OpenClaw Gateway<br/>ECS Fargate]
        Gateway -.-> Cognito[Amazon Cognito<br/>Auth/API Keys]
    end

    %% 异步路由层 (EventBridge)
    subgraph Message_Router [事件路由与分发]
        Gateway ==>|PutEvents| EB[EventBridge EventBus]
        EB --> Rule1{Rule: Browser}
        EB --> Rule2{Rule: Tools}
        EB --> Rule3{Rule: LLM}
        Rule1 --> SQS_B[SQS: browser-queue]
        Rule2 --> SQS_T[SQS: tools-queue]
        Rule3 --> SQS_L[SQS: llm-queue]
    end

    %% 执行层 (Fargate Workers)
    subgraph Worker_Fleet [执行层 - ECS Fargate]
        SQS_B ==> Worker_B[Browser Worker]
        SQS_T ==> Worker_T[Tools Worker]
        SQS_L ==> Worker_L[LLM Worker]
    end

    %% 编排与持久化
    subgraph Data_Orchestration [数据与编排]
        SFN[AWS Step Functions<br/>Workflow Orchestrator]
        DDB[(Amazon DynamoDB<br/>Task State & Metadata)]
        S3[Amazon S3<br/>Artifacts/Screenshots]
        Secrets[AWS Secrets Manager<br/>API Keys/Credentials]
    end

    %% 监控层
    subgraph Observability [全链路可观测性]
        CW[CloudWatch Logs/Metrics]
        XRay[AWS X-Ray Tracing]
    end

    %% 交互线
    Worker_B & Worker_T & Worker_L --> DDB
    Worker_B --> S3
    Worker_B & Worker_T & Worker_L -.-> Secrets
    Gateway -.-> SFN
    SFN -.-> EB

    %% 监控连接
    Gateway & Worker_B & Worker_T & Worker_L --- CW
    Gateway & Worker_B & Worker_T & Worker_L --- XRay

    %% 样式美化
    style Ingress_Layer fill:#f5f5f5,stroke:#333,stroke-width:2px
    style Message_Router fill:#fff4dd,stroke:#d4a017,stroke-width:2px
    style Worker_Fleet fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    style Data_Orchestration fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

## 架构说明

### 1. 接入层
- **AWS WAF** - Web 应用防火墙，防护恶意请求
- **CloudFront** - CDN 加速与边缘缓存
- **ALB** - 负载均衡，分发到 Gateway 实例
- **OpenClaw Gateway** - 核心网关服务（ECS Fargate）
- **Cognito** - 用户认证与 API Key 管理

### 2. 事件路由与分发
- **EventBridge** - 事件总线，按规则分发任务
- **SQS** - 消息队列，解耦 Gateway 与 Worker

### 3. 执行层
- **Browser Worker** - 浏览器自动化任务
- **Tools Worker** - 工具执行（代码、文件操作等）
- **LLM Worker** - 大模型推理调用

### 4. 数据与编排
- **Step Functions** - 工作流编排
- **DynamoDB** - 任务状态与元数据存储
- **S3** - 文件存储（截图、附件等）
- **Secrets Manager** - 密钥管理

### 5. 可观测性
- **CloudWatch** - 日志与指标
- **X-Ray** - 分布式追踪
