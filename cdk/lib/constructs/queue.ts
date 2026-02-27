import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface QueueConstructProps {
  readonly config: OpenClawConfig;
}

export class QueueConstruct extends Construct {
  public readonly eventBus: events.IEventBus;
  public readonly taskQueue: sqs.IQueue;
  public readonly taskDlq: sqs.IQueue;
  public readonly dlqHandler: lambda.IFunction;
  public readonly alertTopic: sns.ITopic;

  constructor(scope: Construct, id: string, props: QueueConstructProps) {
    super(scope, id);

    const { config } = props;

    // Create SNS Topic for alerts
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      displayName: `OpenClaw ${config.environment} Alerts`,
    });

    // Create EventBridge Event Bus
    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: `openclaw-${config.environment}-bus`,
    });

    // Enable archive for replay
    this.eventBus.archive(`EventBusArchive`, {
      archiveName: `openclaw-${config.environment}-archive`,
      description: 'Archive for OpenClaw events',
      retentionPeriod: cdk.Duration.days(7),
    });

    // Create DLQ
    this.taskDlq = new sqs.Queue(this, 'TaskDlq', {
      queueName: `openclaw-${config.environment}-task-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Create Task Queue
    this.taskQueue = new sqs.Queue(this, 'TaskQueue', {
      queueName: `openclaw-${config.environment}-task-queue`,
      visibilityTimeout: cdk.Duration.seconds(config.queue.visibilityTimeout),
      retentionPeriod: cdk.Duration.days(config.queue.messageRetentionDays),
      deadLetterQueue: {
        queue: this.taskDlq,
        maxReceiveCount: config.queue.maxReceiveCount,
      },
    });

    // Create DLQ Handler Lambda
    this.dlqHandler = this.createDlqHandler(config);

    // Create EventBridge Rules
    this.createEventRules(config);

    // Add alarms
    this.createAlarms(config);

    // Tags
    cdk.Tags.of(this.eventBus).add('Project', config.projectName);
    cdk.Tags.of(this.taskQueue).add('Project', config.projectName);
  }

  private createDlqHandler(config: OpenClawConfig): lambda.IFunction {
    return new lambda_nodejs.NodejsFunction(this, 'DlqHandler', {
      functionName: `openclaw-${config.environment}-dlq-handler`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: 'lib/lambdas/dlq-handler.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        ENVIRONMENT: config.environment,
      },
    });

    // Grant permissions
    this.alertTopic.grantPublish(this.dlqHandler);
    this.taskDlq.grantConsumeMessages(this.dlqHandler);

    // Create SQS event source
    this.dlqHandler.addEventSource(
      new lambda_event_sources.SqsEventSource(this.taskDlq, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
      })
    );

    return handler;
  }

  private createEventRules(config: OpenClawConfig): void {
    // Rule: TaskCreated -> TaskQueue
    new events.Rule(this, 'TaskCreatedRule', {
      eventBus: this.eventBus,
      ruleName: 'task-created-rule',
      description: 'Route TaskCreated events to TaskQueue',
      eventPattern: {
        source: ['openclaw.gateway'],
        detailType: ['TaskCreated'],
      },
      targets: [
        new events_targets.SqsQueue(this.taskQueue, {
          messageGroupId: 'tasks', // For FIFO ordering if needed
        }),
      ],
    });

    // Rule: TaskCompleted -> Logging
    new events.Rule(this, 'TaskCompletedRule', {
      eventBus: this.eventBus,
      ruleName: 'task-completed-rule',
      description: 'Route TaskCompleted events',
      eventPattern: {
        source: ['openclaw.worker'],
        detailType: ['TaskCompleted'],
      },
    });
  }

  private createAlarms(config: OpenClawConfig): void {
    // DLQ Not Empty Alarm
    const dlqAlarm = this.taskDlq
      .metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      })
      .createAlarm(this, 'DlqNotEmptyAlarm', {
        alarmName: `openclaw-${config.environment}-dlq-not-empty`,
        alarmDescription: 'DLQ has messages - indicates processing failures',
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });

    dlqAlarm.addAlarmAction(
      new cw_actions.SnsAction(this.alertTopic)
    );

    // Queue Depth Alarm
    const queueDepthAlarm = this.taskQueue
      .metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      })
      .createAlarm(this, 'QueueDepthAlarm', {
        alarmName: `openclaw-${config.environment}-queue-depth-high`,
        alarmDescription: 'Task queue depth is high',
        threshold: 100,
        evaluationPeriods: 2,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });

    queueDepthAlarm.addAlarmAction(
      new cw_actions.SnsAction(this.alertTopic)
    );
  }
}

// Import for lambda event source
import * as lambda_event_sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
