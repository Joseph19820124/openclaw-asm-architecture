# OpenClaw AWS Infrastructure CDK Project

AWS CDK 项目，用于部署 OpenClaw 的生产级基础设施。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Edge Layer                                  │
│         Route 53 → WAF → CloudFront → Global Accelerator                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Ingress Layer                                  │
│                ALB → OpenClaw Gateway (Fargate)                         │
│                           │                                              │
│                           ├─ Cognito (Auth)                             │
│                           └─ EventBridge (Events)                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Event Routing Layer                              │
│              EventBridge → SQS Task Queue → DLQ                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Worker Execution Layer                            │
│                  OpenClaw Node (Fargate)                                │
│                 Browser + Tools + LLM Agent Loop                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Data & Orchestration Layer                        │
│   DynamoDB Global Tables | S3 | ElastiCache Redis | Step Functions     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Security & Compliance Layer                      │
│    Secrets Manager | KMS | GuardDuty | Security Hub | Inspector        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Observability Layer                             │
│       CloudWatch | X-Ray | Managed Prometheus | Managed Grafana        │
└─────────────────────────────────────────────────────────────────────────┘
```

## 目录结构

```
openclaw-infra/
├── bin/
│   └── openclaw-infra.ts      # CDK 入口文件
├── config/
│   └── index.ts               # 环境配置 (dev/prod)
├── lib/
│   ├── openclaw-stack.ts      # 主 Stack
│   ├── constructs/
│   │   ├── network.ts         # VPC, Subnets, Security Groups
│   │   ├── security.ts        # KMS, Secrets Manager
│   │   ├── database.ts        # DynamoDB, S3
│   │   ├── cache.ts           # ElastiCache Redis
│   │   ├── queue.ts           # SQS, EventBridge
│   │   ├── ecs.ts             # ECS Cluster, Fargate Services
│   │   ├── observability.ts   # CloudWatch, X-Ray
│   │   └── cicd.ts            # CodePipeline, CodeBuild
│   └── lambdas/
│       └── dlq-handler.ts     # DLQ 处理 Lambda
├── cdk.json                   # CDK 配置
├── package.json
└── tsconfig.json
```

## 前置条件

1. **Node.js** >= 18.x
2. **AWS CLI** 已配置 credentials
3. **CDK CLI** 安装：`npm install -g aws-cdk`
4. **Docker** (用于本地构建测试)

## 快速开始

### 1. 安装依赖

```bash
cd openclaw-infra
npm install
```

### 2. Bootstrap CDK (首次运行)

```bash
cdk bootstrap aws://ACCOUNT-ID/REGION
```

### 3. 查看将要创建的资源

```bash
# 开发环境
cdk synth -c environment=dev

# 生产环境
cdk synth -c environment=prod
```

### 4. 部署

```bash
# 开发环境
cdk deploy -c environment=dev

# 生产环境
cdk deploy -c environment=prod

# 部署到特定账户/区域
cdk deploy -c environment=prod --profile production
```

### 5. 查看差异

```bash
cdk diff -c environment=prod
```

### 6. 销毁资源

```bash
cdk destroy -c environment=dev
```

## 环境配置

### 开发环境 (dev)

```typescript
{
  vpc: { cidr: '10.0.0.0/16', maxAzs: 2, natGateways: 1 },
  gateway: { cpu: 512, memory: 1024, minCapacity: 1, maxCapacity: 10 },
  worker: { cpu: 1024, memory: 2048, minCapacity: 1, maxCapacity: 20 },
  database: { readCapacity: 5, writeCapacity: 5, enableGlobalTables: false },
  dr: { enabled: false },
}
```

### 生产环境 (prod)

```typescript
{
  vpc: { cidr: '10.0.0.0/16', maxAzs: 3, natGateways: 2 },
  gateway: { cpu: 1024, memory: 2048, minCapacity: 2, maxCapacity: 50 },
  worker: { cpu: 2048, memory: 4096, minCapacity: 2, maxCapacity: 100 },
  database: { readCapacity: 100, writeCapacity: 50, enableGlobalTables: true },
  dr: { enabled: true, strategy: 'pilot-light' },
}
```

## 部署后配置

### 1. 设置 API Keys

```bash
# OpenAI API Key
aws secretsmanager put-secret-value \
  --secret-id openclaw/prod/openai-api-key \
  --secret-string '{"key":"sk-xxxxx"}'

# Anthropic API Key
aws secretsmanager put-secret-value \
  --secret-id openclaw/prod/anthropic-api-key \
  --secret-string '{"key":"sk-ant-xxxxx"}'
```

### 2. 推送 Docker 镜像

```bash
# 登录 ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

# 构建并推送
docker build -t openclaw-gateway -f Dockerfile.gateway .
docker tag openclaw-gateway:latest <account>.dkr.ecr.us-east-1.amazonaws.com/openclaw/prod:gateway-latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/openclaw/prod:gateway-latest
```

### 3. 配置告警订阅

```bash
# 获取 SNS Topic ARN
aws cloudformation describe-stacks \
  --stack-name openclaw-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`AlertTopicArn`].OutputValue' \
  --output text

# 订阅邮件告警
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:<account>:openclaw-prod-alerts \
  --protocol email \
  --notification-endpoint your-email@example.com
```

## CI/CD 集成

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy OpenClaw

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install CDK
        run: npm install -g aws-cdk
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      
      - name: Deploy
        run: |
          cd openclaw-infra
          npm ci
          cdk deploy -c environment=prod --require-approval never
```

## 安全建议

### 生产环境检查清单

- [ ] 启用 GuardDuty
- [ ] 启用 Security Hub
- [ ] 启用 Inspector (容器镜像扫描)
- [ ] 配置 KMS Key 自动轮换
- [ ] 启用 CloudTrail
- [ ] 配置 AWS Config Rules
- [ ] 启用 MFA for IAM users
- [ ] 审计 IAM 最小权限

### 网络安全

- [ ] 限制 ALB 来源 IP (通过 WAF)
- [ ] 启用 VPC Flow Logs
- [ ] 使用 PrivateLink 访问 AWS 服务
- [ ] 配置 Network Firewall (可选)

## 成本估算

### 开发环境 (~$200-400/月)

| 服务 | 月费用 |
|------|--------|
| ECS Fargate | $50-100 |
| NAT Gateway | $32 |
| ElastiCache | $15 |
| DynamoDB | $25 |
| 其他 | $50-200 |

### 生产环境 (~$3,000-8,000/月)

| 服务 | 月费用 |
|------|--------|
| ECS Fargate | $500-1,500 |
| NAT Gateway | $64 |
| ElastiCache | $200-500 |
| DynamoDB Global Tables | $300-1,000 |
| Shield Advanced | $3,000 |
| Bedrock | 按使用量 |
| 其他 | $200-500 |

## 故障排除

### 常见问题

**Q: CDK 部署失败，提示 "Insufficient permissions"**

```bash
# 确保 IAM 用户/角色有足够权限
# 可以使用 AdministratorAccess 策略进行初始部署
```

**Q: Fargate 服务无法启动**

```bash
# 检查 CloudWatch Logs
aws logs tail /aws/ecs/openclaw-prod/gateway --follow

# 检查任务定义
aws ecs describe-tasks --cluster openclaw-prod --tasks <task-id>
```

**Q: 无法连接 Redis**

```bash
# 检查安全组规则
aws ec2 describe-security-groups --group-ids <sg-id>

# 测试连接
# 在 ECS 任务中执行:
redis-cli -h <redis-endpoint> ping
```

## 相关文档

- [OpenClaw AWS 架构设计](../../docs/openclaw-aws-architecture-enhanced.md)
- [阿里云 ASM 方案](../../docs/openclaw-aliyun-architecture.md)
- [架构讨论记录](../../docs/architecture-discussion-context.md)

## 许可证

MIT
