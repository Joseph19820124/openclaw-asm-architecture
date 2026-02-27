import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { getConfig, OpenClawConfig } from '../config';
import { NetworkConstruct } from './constructs/network';
import { SecurityConstruct } from './constructs/security';
import { DatabaseConstruct } from './constructs/database';
import { CacheConstruct } from './constructs/cache';
import { QueueConstruct } from './constructs/queue';
import { EcsConstruct } from './constructs/ecs';
import { ObservabilityConstruct } from './constructs/observability';

export interface OpenClawStackProps extends cdk.StackProps {
  readonly config: OpenClawConfig;
}

export class OpenClawStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpenClawStackProps) {
    super(scope, id, props);

    const { config } = props;

    // ========== Network Layer ==========
    const network = new NetworkConstruct(this, 'Network', { config });

    // ========== Security Layer ==========
    const security = new SecurityConstruct(this, 'Security', { config });

    // ========== Database Layer ==========
    const database = new DatabaseConstruct(this, 'Database', {
      config,
      encryptionKey: security.kmsKey,
    });

    // ========== Cache Layer ==========
    const cache = new CacheConstruct(this, 'Cache', {
      config,
      vpc: network.vpc,
      securityGroup: network.securityGroups.redis,
    });

    // ========== Queue Layer ==========
    const queue = new QueueConstruct(this, 'Queue', { config });

    // ========== Compute Layer ==========
    const ecs = new EcsConstruct(this, 'Ecs', {
      config,
      vpc: network.vpc,
      securityGroups: {
        gateway: network.securityGroups.gateway,
        worker: network.securityGroups.worker,
      },
      encryptionKey: security.kmsKey,
      secrets: security.secrets,
      tasksTable: database.tasksTable,
      sessionsTable: database.sessionsTable,
      artifactsBucket: database.artifactsBucket,
      taskQueue: queue.taskQueue,
      eventBus: queue.eventBus,
      redisEndpoint: cache.primaryEndpoint,
    });

    // ========== Observability Layer ==========
    const observability = new ObservabilityConstruct(this, 'Observability', {
      config,
      alertTopic: queue.alertTopic,
      gatewayService: ecs.gatewayService,
      workerService: ecs.workerService,
    });

    // ========== Outputs ==========
    this.createOutputs({
      config,
      network,
      security,
      database,
      cache,
      queue,
      ecs,
      observability,
    });
  }

  private createOutputs(props: {
    config: OpenClawConfig;
    network: NetworkConstruct;
    security: SecurityConstruct;
    database: DatabaseConstruct;
    cache: CacheConstruct;
    queue: QueueConstruct;
    ecs: EcsConstruct;
    observability: ObservabilityConstruct;
  }): void {
    const { config, ecs, cache, queue, database, security } = props;

    // VPC
    new cdk.CfnOutput(this, 'VpcId', {
      value: props.network.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${config.projectName}-${config.environment}-vpc-id`,
    });

    // ALB
    new cdk.CfnOutput(this, 'GatewayLoadBalancerDns', {
      value: ecs.gatewayLoadBalancer.loadBalancerDnsName,
      description: 'Gateway ALB DNS Name',
      exportName: `${config.projectName}-${config.environment}-alb-dns`,
    });

    // Redis
    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: cache.primaryEndpoint,
      description: 'Redis Primary Endpoint',
      exportName: `${config.projectName}-${config.environment}-redis-endpoint`,
    });

    // SQS
    new cdk.CfnOutput(this, 'TaskQueueUrl', {
      value: queue.taskQueue.queueUrl,
      description: 'Task Queue URL',
      exportName: `${config.projectName}-${config.environment}-task-queue-url`,
    });

    // DynamoDB
    new cdk.CfnOutput(this, 'TasksTableName', {
      value: database.tasksTable.tableName,
      description: 'Tasks Table Name',
      exportName: `${config.projectName}-${config.environment}-tasks-table`,
    });

    // EventBridge
    new cdk.CfnOutput(this, 'EventBusName', {
      value: queue.eventBus.eventBusName,
      description: 'EventBridge EventBus Name',
      exportName: `${config.projectName}-${config.environment}-event-bus`,
    });

    // ECR
    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: ecs.repository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: `${config.projectName}-${config.environment}-ecr-uri`,
    });

    // Dashboard
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${cdk.Aws.REGION}.console.aws.amazon.com/cloudwatch/home?region=${cdk.Aws.REGION}#dashboards:name=${observability.dashboard.dashboardName}`,
      description: 'CloudWatch Dashboard URL',
    });

    // Secrets
    new cdk.CfnOutput(this, 'OpenAiSecretArn', {
      value: security.secrets.openaiApiKey.secretArn,
      description: 'OpenAI API Key Secret ARN',
    });

    // SNS Topic
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: queue.alertTopic.topicArn,
      description: 'Alert SNS Topic ARN',
    });
  }
}
