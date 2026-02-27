graph TD
    %% 外部请求
    User((User/Client)) -- HTTPS --> WAF[AWS WAF]
    WAF --> CF[Amazon CloudFront]
    CF --> ALB[Application Load Balancer]

    %% 接入层 (Fargate)
    subgraph Ingress_Layer [接入层]
        ALB --> Gateway[OpenClaw Gateway ECS Fargate]
        Gateway -.-> Cognito[Amazon Cognito Auth]
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
        SFN[AWS Step Functions Orchestrator]
        DDB[(Amazon DynamoDB Task State)]
        S3[Amazon S3 Artifacts]
        Secrets[AWS Secrets Manager]
    end

    %% 连接关系
    Worker_B & Worker_T & Worker_L --> DDB
    Worker_B --> S3
    Worker_B & Worker_T & Worker_L -.-> Secrets
    Gateway -.-> SFN
    SFN -.-> EB
