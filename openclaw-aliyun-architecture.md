# OpenClaw 商业环境架构设计
## 基于 ECS + ASM 的 External Key Vault 方案

**设计者:** 架构师 🏗️  
**日期:** 2026-02-27  
**目标用户:** Chen Jian

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           阿里云 VPC                                     │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                           应用子网                                 │   │
│  │   ┌─────────────────────┐     ┌─────────────────────────────┐    │   │
│  │   │   ECS Instance      │     │   SLB / ALB                 │    │   │
│  │   │   ┌───────────────┐ │     │   (可选 HTTPS 终止)          │    │   │
│  │   │   │ OpenClaw      │ │     │                             │    │   │
│  │   │   │ Gateway       │◄├─────┤   :18789                    │    │   │
│  │   │   │               │ │     │                             │    │   │
│  │   │   │ ┌───────────┐ │ │     └─────────────────────────────┘    │   │
│  │   │   │ │asm-resolver│ │ │                                       │   │
│  │   │   │ └─────┬─────┘ │ │                                       │   │
│  │   │   └───────┼───────┘ │                                       │   │
│  │   └───────────┼─────────┘                                       │   │
│  │               │ exec provider                                   │   │
│  │               ▼                                                 │   │
│  │   ┌─────────────────────┐                                       │   │
│  │   │   ECS Metadata      │                                       │   │
│  │   │   (Instance Role)   │                                       │   │
│  │   └──────────┬──────────┘                                       │   │
│  └──────────────┼──────────────────────────────────────────────────┘   │
│                 │ RAM AssumeRole (自动)                                │
│                 ▼                                                      │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                        管理子网                                   │   │
│  │   ┌─────────────────────────────────────────────────────────┐    │   │
│  │   │   KMS / Secrets Manager (ASM)                           │    │   │
│  │   │                                                         │    │   │
│  │   │   Secrets:                                              │    │   │
│  │   │   ├── openclaw/openai-api-key                          │    │   │
│  │   │   ├── openclaw/anthropic-api-key                       │    │   │
│  │   │   ├── openclaw/telegram-bot-token                      │    │   │
│  │   │   ├── openclaw/gateway-auth-token                      │    │   │
│  │   │   └── ...                                              │    │   │
│  │   │                                                         │    │   │
│  │   │   Features: 版本管理 | 审计日志 | 自动轮换              │    │   │
│  │   └─────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │   OSS (可选) - 会话存储、日志归档                               │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心组件设计

### 2.1 ASM Resolver (Exec Provider)

这是连接 OpenClaw 和 ASM 的桥梁。

**文件路径:** `/usr/local/bin/openclaw-asm-resolver`

**职责：**
1. 接收 OpenClaw 的 stdin 请求
2. 解析 secret IDs
3. 通过 ECS 实例角色认证调用 ASM API
4. 返回 JSON 格式的密钥值

**技术选型：**
- Python 3 + alibabacloud-kms SDK
- 或 Go 编译为静态二进制（推荐生产环境）

### 2.2 RAM 权限设计

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:GetSecretValue"
      ],
      "Resource": [
        "acs:kms:*:*:secret/openclaw/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:ListSecrets"
      ],
      "Resource": "*"
    }
  ],
  "Version": "1"
}
```

**最小权限原则：**
- 仅允许读取 `openclaw/*` 前缀的密钥
- 不允许创建/删除/更新密钥
- 通过 ECS 实例角色自动轮换临时凭证

### 2.3 OpenClaw 配置结构

```json5
// ~/.openclaw/openclaw.json
{
  secrets: {
    providers: {
      // 默认环境变量 provider（本地开发用）
      default: { source: "env" },
      
      // ASM provider（生产环境）
      asm: {
        source: "exec",
        command: "/usr/local/bin/openclaw-asm-resolver",
        args: ["--region", "cn-hangzhou"],
        passEnv: ["ALIBABA_CLOUD_REGION"],
        jsonOnly: true,
        timeoutMs: 5000,
        // 安全限制
        allowSymlinkCommand: false,
      },
    },
    defaults: {
      env: "default",
      exec: "asm",  // 默认 exec 使用 ASM
    },
    resolution: {
      maxProviderConcurrency: 4,
      maxRefsPerProvider: 128,
      maxBatchBytes: 65536,
    },
  },

  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
        // 密钥引用
        apiKey: {
          source: "exec",
          provider: "asm",
          id: "openclaw/openai-api-key"
        },
      },
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }],
        apiKey: {
          source: "exec",
          provider: "asm",
          id: "openclaw/anthropic-api-key"
        },
      },
    },
  },

  channels: {
    telegram: {
      enabled: true,
      botToken: {
        source: "exec",
        provider: "asm",
        id: "openclaw/telegram-bot-token"
      },
      dmPolicy: "pairing",
    },
  },

  gateway: {
    port: 18789,
    bind: "lan",
    auth: {
      mode: "token",
      token: {
        source: "exec",
        provider: "asm",
        id: "openclaw/gateway-auth-token"
      },
    },
  },
}
```

---

## 3. ASM Resolver 实现

### 3.1 Python 版本（快速原型）

```python
#!/usr/bin/env python3
"""
OpenClaw ASM Resolver - Exec Provider for Alibaba Cloud Secrets Manager
"""

import json
import sys
import os
from alibabacloud_kms20160120.client import Client
from alibabacloud_kms20160120 import models as kms_models
from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_tea_util import models as util_models


def create_client():
    """创建 KMS 客户端，使用 ECS 实例角色自动认证"""
    region = os.environ.get('ALIBABA_CLOUD_REGION', 'cn-hangzhou')
    
    config = open_api_models.Config(
        region_id=region,
        # 不设置 access_key，使用实例角色
    )
    config.credentials_provider = True  # 启用元数据服务认证
    
    return Client(config)


def get_secret_value(client, secret_name: str) -> str:
    """获取密钥值"""
    request = kms_models.GetSecretValueRequest(
        secret_name=secret_name,
        version_stage='ACSCurrent'  # 获取当前版本
    )
    
    runtime = util_models.RuntimeOptions()
    response = client.get_secret_value_with_options(request, runtime)
    
    if response.status_code != 200:
        raise Exception(f"ASM API error: {response.status_code}")
    
    return response.body.secret_value


def main():
    """主入口 - 处理 OpenClaw 的请求"""
    try:
        # 读取 stdin 请求
        request = json.load(sys.stdin)
        
        protocol_version = request.get('protocolVersion', 1)
        if protocol_version != 1:
            raise ValueError(f"Unsupported protocol version: {protocol_version}")
        
        secret_ids = request.get('ids', [])
        
        # 创建客户端
        client = create_client()
        
        # 批量获取密钥
        values = {}
        errors = {}
        
        for secret_id in secret_ids:
            try:
                values[secret_id] = get_secret_value(client, secret_id)
            except Exception as e:
                errors[secret_id] = {"message": str(e)}
        
        # 返回响应
        response = {
            "protocolVersion": 1,
            "values": values,
        }
        
        if errors:
            response["errors"] = errors
        
        print(json.dumps(response))
        
    except Exception as e:
        # 错误时返回空值
        response = {
            "protocolVersion": 1,
            "values": {},
            "errors": {"_resolver": {"message": str(e)}}
        }
        print(json.dumps(response))
        sys.exit(1)


if __name__ == "__main__":
    main()
```

### 3.2 Go 版本（生产推荐）

```go
// main.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	kms20160120 "github.com/alibabacloud-go/kms-20160120/v3/client"
	"github.com/alibabacloud-go/tea/tea"
)

// Request from OpenClaw
type Request struct {
	ProtocolVersion int      `json:"protocolVersion"`
	Provider        string   `json:"provider"`
	IDs             []string `json:"ids"`
}

// Response to OpenClaw
type Response struct {
	ProtocolVersion int               `json:"protocolVersion"`
	Values          map[string]string `json:"values"`
	Errors          map[string]Error  `json:"errors,omitempty"`
}

type Error struct {
	Message string `json:"message"`
}

func createClient(region string) (*kms20160120.Client, error) {
	config := &openapi.Config{
		RegionId: tea.String(region),
		// 使用 ECS 实例角色 - SDK 会自动从元数据服务获取凭证
	}
	return kms20160120.NewClient(config)
}

func getSecretValue(client *kms20160120.Client, secretName string) (string, error) {
	request := &kms20160120.GetSecretValueRequest{
		SecretName:   tea.String(secretName),
		VersionStage: tea.String("ACSCurrent"),
	}
	
	resp, err := client.GetSecretValue(request)
	if err != nil {
		return "", err
	}
	
	return *resp.Body.SecretValue, nil
}

func main() {
	// Parse request from stdin
	var req Request
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&req); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to parse request: %v\n", err)
		os.Exit(1)
	}

	if req.ProtocolVersion != 1 {
		fmt.Fprintf(os.Stderr, "Unsupported protocol version: %d\n", req.ProtocolVersion)
		os.Exit(1)
	}

	// Get region from env
	region := os.Getenv("ALIBABA_CLOUD_REGION")
	if region == "" {
		region = "cn-hangzhou"
	}

	// Create client
	client, err := createClient(region)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create client: %v\n", err)
		os.Exit(1)
	}

	// Fetch secrets
	resp := Response{
		ProtocolVersion: 1,
		Values:          make(map[string]string),
		Errors:          make(map[string]Error),
	}

	for _, id := range req.IDs {
		value, err := getSecretValue(client, id)
		if err != nil {
			resp.Errors[id] = Error{Message: err.Error()}
			continue
		}
		resp.Values[id] = value
	}

	// Output response
	output, err := json.Marshal(resp)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to marshal response: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(string(output))
	
	// Exit with error if any secrets failed
	if len(resp.Errors) > 0 {
		os.Exit(1)
	}
}
```

**编译：**
```bash
go build -ldflags="-s -w" -o /usr/local/bin/openclaw-asm-resolver main.go
chmod 755 /usr/local/bin/openclaw-asm-resolver
```

---

## 4. 部署流程

### 4.1 前置准备

```bash
# 1. 创建 RAM 角色
aliyun ram CreateRole \
  --RoleName OpenClawGateway \
  --AssumeRolePolicyDocument '{
    "Statement": [{
      "Action": "sts:AssumeRole",
      "Effect": "Allow",
      "Principal": {"Service": "ecs.aliyuncs.com"}
    }],
    "Version": "1"
  }'

# 2. 创建权限策略并附加
aliyun ram CreatePolicy \
  --PolicyName OpenClawSecretsReader \
  --PolicyDocument '{
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["kms:GetSecretValue"],
        "Resource": ["acs:kms:*:*:secret/openclaw/*"]
      }
    ],
    "Version": "1"
  }'

aliyun ram AttachPolicyToRole \
  --PolicyName OpenClawSecretsReader \
  --PolicyType Custom \
  --RoleName OpenClawGateway

# 3. 将角色附加到 ECS 实例
aliyun ecs AttachInstanceRamRole \
  --RamRoleName OpenClawGateway \
  --InstanceId i-xxx
```

### 4.2 创建 ASM 密钥

```bash
# 创建密钥（建议通过控制台或专用 CI/CD 流程）
aliyun kms CreateSecret \
  --SecretName openclaw/openai-api-key \
  --SecretData "sk-xxxxxxxxxxxxx" \
  --SecretDataType text

aliyun kms CreateSecret \
  --SecretName openclaw/gateway-auth-token \
  --SecretData "$(openssl rand -hex 32)" \
  --SecretDataType text
```

### 4.3 ECS 实例配置

```bash
# 安装依赖
yum install -y python3 python3-pip nodejs npm

# 或使用 Go 编译版本（无需 Python 依赖）
# 将编译好的二进制放到 /usr/local/bin/

# 安装 OpenClaw
npm install -g openclaw

# 部署 resolver
cp openclaw-asm-resolver /usr/local/bin/
chmod 755 /usr/local/bin/openclaw-asm-resolver

# 验证 resolver 工作正常
echo '{"protocolVersion":1,"provider":"asm","ids":["openclaw/test-secret"]}' | \
  /usr/local/bin/openclaw-asm-resolver
```

### 4.4 Systemd 服务配置

```ini
# /etc/systemd/system/openclaw-gateway.service
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/home/openclaw
Environment="ALIBABA_CLOUD_REGION=cn-hangzhou"
Environment="NODE_ENV=production"
ExecStart=/usr/bin/openclaw gateway
Restart=on-failure
RestartSec=10

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/openclaw/.openclaw /tmp/openclaw

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable openclaw-gateway
systemctl start openclaw-gateway
```

---

## 5. 安全加固建议

### 5.1 网络层

| 项目 | 建议 |
|------|------|
| VPC 隔离 | OpenClaw 部署在私有子网，通过 ALB/SLB 暴露 |
| 安全组 | 仅允许必要端口入站，限制管理端口来源 IP |
| TLS | 在 ALB 层终止 HTTPS，内网通信可走 HTTP |

### 5.2 应用层

| 项目 | 建议 |
|------|------|
| Gateway Auth | 使用 token 模式，token 本身从 ASM 获取 |
| CORS | 配置 `gateway.controlUi.allowedOrigins` |
| Rate Limiting | 启用 `gateway.auth.rateLimit` |

### 5.3 密钥层

| 项目 | 建议 |
|------|------|
| 密钥轮换 | ASM 支持自动轮换，建议 90 天周期 |
| 版本管理 | 保留历史版本，支持快速回滚 |
| 审计日志 | 启用 KMS 审计，对接 ActionTrail |

### 5.4 Resolver 加固

```json5
// resolver 执行权限
{
  secrets: {
    providers: {
      asm: {
        source: "exec",
        command: "/usr/local/bin/openclaw-asm-resolver",
        // 禁止 symlink（防止路径篡改）
        allowSymlinkCommand: false,
        // 超时控制
        timeoutMs: 5000,
        // 仅传递必要环境变量
        passEnv: ["ALIBABA_CLOUD_REGION"],
      },
    },
  },
}
```

---

## 6. 高可用方案

### 6.1 多实例部署

```
┌─────────────────────────────────────────────────────────────┐
│                        ALB / SLB                             │
│                    (健康检查 + 负载均衡)                      │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ ECS #1  │   │ ECS #2  │   │ ECS #3  │
   │ OpenClaw│   │ OpenClaw│   │ OpenClaw│
   └────┬────┘   └────┬────┘   └────┬────┘
        │             │             │
        └─────────────┼─────────────┘
                      │
                      ▼
              ┌──────────────┐
              │ ASM / KMS    │
              │ (托管服务)    │
              └──────────────┘
```

### 6.2 状态管理

| 状态类型 | 存储方案 |
|----------|----------|
| 配置文件 | NAS / OSS 挂载 |
| 会话数据 | OSS (配置 `session.store`) |
| 日志 | SLS (日志服务) |

```json5
// 多实例共享配置示例
{
  session: {
    store: "oss://openclaw-sessions/sessions.json",
  },
  logging: {
    file: "/var/log/openclaw/openclaw.log",  // 本地
    // SLS 通过 filebeat/ilogtail 收集
  },
}
```

---

## 7. 监控告警

### 7.1 关键指标

| 指标 | 阈值 | 告警级别 |
|------|------|----------|
| Gateway 响应时间 | > 500ms | Warning |
| Secret 解析失败 | > 0 | Critical |
| ECS CPU 使用率 | > 80% | Warning |
| ASM API 错误率 | > 1% | Critical |

### 7.2 日志集成

```bash
# 安装 ilogtail (阿里云日志服务采集器)
wget https://ilogtail-community-edition.oss-cn-shanghai.aliyuncs.com/latest/ilogtail.tar.gz
tar -xzf ilogtail.tar.gz

# 配置采集 /var/log/openclaw/*.log
# 发送到 SLS Project
```

---

## 8. 成本估算

### 8.1 资源清单（月度）

| 资源 | 规格 | 预估费用 |
|------|------|----------|
| ECS | 2 vCPU 4GB x 2 | ~300 CNY |
| SLB | 按量付费 | ~50 CNY |
| ASM/KMS | 按密钥数 + API 调用 | ~50 CNY |
| OSS | 10GB | ~5 CNY |
| 流量 | 出网流量 | 视使用量 |

**月度总成本:** ~400-500 CNY（基础配置）

### 8.2 成本优化建议

1. 使用抢占式实例降低 ECS 成本（-60%~80%）
2. 合理设置 ASM 密钥轮换周期（减少 API 调用）
3. 启用 OpenClaw 的 `contextPruning` 控制上下文大小

---

## 9. 迁移路径

### 从明文配置迁移到 ASM

```bash
# 1. 审计现有明文密钥
openclaw secrets audit

# 2. 交互式配置迁移
openclaw secrets configure

# 3. 应用迁移计划
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json

# 4. 验证
openclaw secrets audit --check
```

---

## 10. 总结

### 方案优势

✅ **零明文存储** - 所有密钥集中管理，配置文件无敏感信息  
✅ **自动认证** - ECS 实例角色无需维护 AccessKey  
✅ **审计追溯** - ASM 提供完整的访问日志  
✅ **版本管理** - 支持密钥版本回滚  
✅ **高可用** - ASM 托管服务，自动容灾  

### 下一步行动

1. [ ] 创建 RAM 角色和权限策略
2. [ ] 在 ASM 中创建所需的密钥
3. [ ] 编译/部署 ASM Resolver
4. [ ] 配置 OpenClaw 使用 exec provider
5. [ ] 部署 Gateway 服务
6. [ ] 配置监控告警

---

*设计文档 v1.0 - 架构师 🏗️*
