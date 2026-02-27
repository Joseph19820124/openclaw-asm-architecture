import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secrets-manager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface EcsConstructProps {
  readonly config: OpenClawConfig;
  readonly vpc: ec2.IVpc;
  readonly securityGroups: {
    gateway: ec2.ISecurityGroup;
    worker: ec2.ISecurityGroup;
  };
  readonly encryptionKey: kms.IKey;
  readonly secrets: {
    openaiApiKey: secretsmanager.ISecret;
    anthropicApiKey: secretsmanager.ISecret;
    gatewayAuthToken: secretsmanager.ISecret;
  };
  readonly tasksTable: dynamodb.ITable;
  readonly sessionsTable: dynamodb.ITable;
  readonly artifactsBucket: s3.IBucket;
  readonly taskQueue: sqs.IQueue;
  readonly eventBus: events.IEventBus;
  readonly redisEndpoint: string;
}

export class EcsConstruct extends Construct {
  public readonly cluster: ecs.ICluster;
  public readonly gatewayService: ecs.IFargateService;
  public readonly workerService: ecs.IFargateService;
  public readonly gatewayTaskDefinition: ecs.ITaskDefinition;
  public readonly workerTaskDefinition: ecs.ITaskDefinition;
  public readonly gatewayLoadBalancer: elbv2.IApplicationLoadBalancer;
  public readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: EcsConstructProps) {
    super(scope, id);

    const {
      config,
      vpc,
      securityGroups,
      encryptionKey,
      secrets,
      tasksTable,
      sessionsTable,
      artifactsBucket,
      taskQueue,
      eventBus,
      redisEndpoint,
    } = props;

    // Create ECR Repository
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: `openclaw/${config.environment}`,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create ECS Cluster
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `openclaw-${config.environment}`,
      vpc,
      containerInsights: true,
    });

    // Create Gateway Service
    const gatewayResult = this.createGatewayService({
      config,
      vpc,
      securityGroup: securityGroups.gateway,
      secrets,
      tasksTable,
      sessionsTable,
      eventBus,
      redisEndpoint,
    });
    this.gatewayService = gatewayResult.service;
    this.gatewayTaskDefinition = gatewayResult.taskDefinition;
    this.gatewayLoadBalancer = gatewayResult.loadBalancer;

    // Create Worker Service
    const workerResult = this.createWorkerService({
      config,
      vpc,
      securityGroup: securityGroups.worker,
      secrets,
      tasksTable,
      sessionsTable,
      artifactsBucket,
      taskQueue,
      eventBus,
      redisEndpoint,
    });
    this.workerService = workerResult.service;
    this.workerTaskDefinition = workerResult.taskDefinition;

    // Tags
    cdk.Tags.of(this.cluster).add('Project', config.projectName);
    cdk.Tags.of(this.repository).add('Project', config.projectName);
  }

  private createGatewayService(props: {
    config: OpenClawConfig;
    vpc: ec2.IVpc;
    securityGroup: ec2.ISecurityGroup;
    secrets: EcsConstructProps['secrets'];
    tasksTable: dynamodb.ITable;
    sessionsTable: dynamodb.ITable;
    eventBus: events.IEventBus;
    redisEndpoint: string;
  }): {
    service: ecs.IFargateService;
    taskDefinition: ecs.ITaskDefinition;
    loadBalancer: elbv2.IApplicationLoadBalancer;
  } {
    const {
      config,
      vpc,
      securityGroup,
      secrets,
      tasksTable,
      sessionsTable,
      eventBus,
      redisEndpoint,
    } = props;

    // Create ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'GatewayAlb', {
      vpc,
      internetFacing: true,
      securityGroup: securityGroup,
    });

    // Create Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'GatewayTaskDef',
      {
        cpu: config.gateway.cpu,
        memoryLimitMiB: config.gateway.memory,
        executionRole: this.createExecutionRole(),
        taskRole: this.createGatewayTaskRole({
          tasksTable,
          sessionsTable,
          eventBus,
          secrets,
        }),
      }
    );

    // Add container
    const logGroup = new logs.LogGroup(this, 'GatewayLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    taskDefinition.addContainer('gateway', {
      containerName: 'gateway',
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'gateway'),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDriver.awsLogs({
        logGroup,
        streamPrefix: 'gateway',
      }),
      environment: {
        NODE_ENV: config.environment,
        PORT: '8080',
        AWS_REGION: config.region,
        REDIS_URL: `redis://${redisEndpoint}:6379`,
        EVENT_BUS_NAME: eventBus.eventBusName,
        TASKS_TABLE_NAME: tasksTable.tableName,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
      },
      secrets: {
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(
          secrets.openaiApiKey,
          'key'
        ),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(
          secrets.anthropicApiKey,
          'key'
        ),
        GATEWAY_AUTH_TOKEN: ecs.Secret.fromSecretsManager(
          secrets.gatewayAuthToken,
          'token'
        ),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Create Fargate Service
    const service = new ecs.FargateService(this, 'GatewayService', {
      cluster: this.cluster,
      serviceName: 'gateway',
      taskDefinition,
      desiredCount: config.gateway.desiredCount,
      assignPublicIp: false,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      deploymentController: { type: ecs.DeploymentControllerType.ECS },
    });

    // Auto Scaling
    const scaling = service.autoScaleTaskCount({
      minCapacity: config.gateway.minCapacity,
      maxCapacity: config.gateway.maxCapacity,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // Create Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      'GatewayTargetGroup',
      {
        vpc,
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck: {
          path: '/health',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
        deregistrationDelay: cdk.Duration.seconds(30),
      }
    );

    // Create Listener
    alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      defaultTargetGroups: [targetGroup],
    });

    return {
      service,
      taskDefinition,
      loadBalancer: alb,
    };
  }

  private createWorkerService(props: {
    config: OpenClawConfig;
    vpc: ec2.IVpc;
    securityGroup: ec2.ISecurityGroup;
    secrets: EcsConstructProps['secrets'];
    tasksTable: dynamodb.ITable;
    sessionsTable: dynamodb.ITable;
    artifactsBucket: s3.IBucket;
    taskQueue: sqs.IQueue;
    eventBus: events.IEventBus;
    redisEndpoint: string;
  }): {
    service: ecs.IFargateService;
    taskDefinition: ecs.ITaskDefinition;
  } {
    const {
      config,
      vpc,
      securityGroup,
      secrets,
      tasksTable,
      sessionsTable,
      artifactsBucket,
      taskQueue,
      eventBus,
      redisEndpoint,
    } = props;

    // Create Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'WorkerTaskDef',
      {
        cpu: config.worker.cpu,
        memoryLimitMiB: config.worker.memory,
        executionRole: this.createExecutionRole(),
        taskRole: this.createWorkerTaskRole({
          tasksTable,
          sessionsTable,
          artifactsBucket,
          taskQueue,
          eventBus,
          secrets,
        }),
      }
    );

    // Add container
    const logGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    taskDefinition.addContainer('worker', {
      containerName: 'worker',
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'worker'),
      logging: ecs.LogDriver.awsLogs({
        logGroup,
        streamPrefix: 'worker',
      }),
      environment: {
        NODE_ENV: config.environment,
        AWS_REGION: config.region,
        REDIS_URL: `redis://${redisEndpoint}:6379`,
        EVENT_BUS_NAME: eventBus.eventBusName,
        TASKS_TABLE_NAME: tasksTable.tableName,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        ARTIFACTS_BUCKET_NAME: artifactsBucket.bucketName,
        SQS_QUEUE_URL: taskQueue.queueUrl,
      },
      secrets: {
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(
          secrets.openaiApiKey,
          'key'
        ),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(
          secrets.anthropicApiKey,
          'key'
        ),
      },
    });

    // Create Fargate Service
    const service = new ecs.FargateService(this, 'WorkerService', {
      cluster: this.cluster,
      serviceName: 'worker',
      taskDefinition,
      desiredCount: config.worker.desiredCount,
      assignPublicIp: false,
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
    });

    // Auto Scaling based on SQS queue depth
    const scaling = service.autoScaleTaskCount({
      minCapacity: config.worker.minCapacity,
      maxCapacity: config.worker.maxCapacity,
    });

    // Scale on SQS queue depth
    scaling.scaleOnMetric('QueueDepthScaling', {
      metric: taskQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      scalingSteps: [
        { upper: 10, change: 0 },
        { lower: 10, upper: 50, change: +1 },
        { lower: 50, upper: 100, change: +2 },
        { lower: 100, change: +5 },
      ],
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      cooldown: cdk.Duration.seconds(60),
    });

    // Scale on CPU
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    return {
      service,
      taskDefinition,
    };
  }

  private createExecutionRole(): iam.IRole {
    return new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });
  }

  private createGatewayTaskRole(props: {
    tasksTable: dynamodb.ITable;
    sessionsTable: dynamodb.ITable;
    eventBus: events.IEventBus;
    secrets: EcsConstructProps['secrets'];
  }): iam.IRole {
    const { tasksTable, sessionsTable, eventBus, secrets } = props;

    const role = new iam.Role(this, 'GatewayTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // DynamoDB permissions
    tasksTable.grantReadWriteData(role);
    sessionsTable.grantReadWriteData(role);

    // EventBridge permissions
    eventBus.grantPutEventsTo(role);

    // Secrets permissions
    Object.values(secrets).forEach((secret) => {
      secret.grantRead(role);
    });

    // Bedrock permissions (if using)
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/*`,
        ],
      })
    );

    return role;
  }

  private createWorkerTaskRole(props: {
    tasksTable: dynamodb.ITable;
    sessionsTable: dynamodb.ITable;
    artifactsBucket: s3.IBucket;
    taskQueue: sqs.IQueue;
    eventBus: events.IEventBus;
    secrets: EcsConstructProps['secrets'];
  }): iam.IRole {
    const {
      tasksTable,
      sessionsTable,
      artifactsBucket,
      taskQueue,
      eventBus,
      secrets,
    } = props;

    const role = new iam.Role(this, 'WorkerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // DynamoDB permissions
    tasksTable.grantReadWriteData(role);
    sessionsTable.grantReadWriteData(role);

    // S3 permissions
    artifactsBucket.grantReadWrite(role);

    // SQS permissions
    taskQueue.grantConsumeMessages(role);

    // EventBridge permissions
    eventBus.grantPutEventsTo(role);

    // Secrets permissions
    Object.values(secrets).forEach((secret) => {
      secret.grantRead(role);
    });

    // Bedrock permissions
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/*`,
        ],
      })
    );

    // Additional permissions for browser automation (if needed)
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:InvokeFunction',
          's3:GetObject',
          's3:PutObject',
        ],
        resources: ['*'],
      })
    );

    return role;
  }
}
