import * as cdk from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface ObservabilityConstructProps {
  readonly config: OpenClawConfig;
  readonly alertTopic: sns.ITopic;
  readonly gatewayService: ecs.IFargateService;
  readonly workerService: ecs.IFargateService;
}

export class ObservabilityConstruct extends Construct {
  public readonly dashboard: cw.Dashboard;
  public readonly errorAlarm: cw.Alarm;
  public readonly latencyAlarm: cw.Alarm;

  constructor(scope: Construct, id: string, props: ObservabilityConstructProps) {
    super(scope, id);

    const { config, alertTopic, gatewayService, workerService } = props;

    // Create Dashboard
    this.dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: `openclaw-${config.environment}`,
    });

    // Create Alarms
    this.errorAlarm = this.createErrorAlarm(gatewayService, config);
    this.latencyAlarm = this.createLatencyAlarm(gatewayService, config);

    // Add alarm actions
    this.errorAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));
    this.latencyAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));

    // Create Dashboard Widgets
    this.createDashboardWidgets({
      config,
      gatewayService,
      workerService,
    });

    // Tags
    cdk.Tags.of(this.dashboard).add('Project', config.projectName);
  }

  private createErrorAlarm(
    service: ecs.IFargateService,
    config: OpenClawConfig
  ): cw.Alarm {
    return service
      .metric('MemoryUtilization', {
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      })
      .createAlarm(this, 'HighMemoryAlarm', {
        alarmName: `openclaw-${config.environment}-high-memory`,
        alarmDescription: 'Gateway memory utilization is high',
        threshold: 80,
        evaluationPeriods: 2,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
  }

  private createLatencyAlarm(
    service: ecs.IFargateService,
    config: OpenClawConfig
  ): cw.Alarm {
    return service
      .metric('CPUUtilization', {
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      })
      .createAlarm(this, 'HighCpuAlarm', {
        alarmName: `openclaw-${config.environment}-high-cpu`,
        alarmDescription: 'Gateway CPU utilization is high',
        threshold: 80,
        evaluationPeriods: 2,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
  }

  private createDashboardWidgets(props: {
    config: OpenClawConfig;
    gatewayService: ecs.IFargateService;
    workerService: ecs.IFargateService;
  }): void {
    const { gatewayService, workerService } = props;

    // Gateway Metrics
    const gatewayCpuWidget = new cw.GraphWidget({
      title: 'Gateway CPU Utilization',
      left: [gatewayService.metricCPUUtilization({ period: cdk.Duration.minutes(5) })],
      width: 12,
      height: 6,
    });

    const gatewayMemoryWidget = new cw.GraphWidget({
      title: 'Gateway Memory Utilization',
      left: [gatewayService.metricMemoryUtilization({ period: cdk.Duration.minutes(5) })],
      width: 12,
      height: 6,
    });

    // Worker Metrics
    const workerCpuWidget = new cw.GraphWidget({
      title: 'Worker CPU Utilization',
      left: [workerService.metricCPUUtilization({ period: cdk.Duration.minutes(5) })],
      width: 12,
      height: 6,
    });

    const workerMemoryWidget = new cw.GraphWidget({
      title: 'Worker Memory Utilization',
      left: [workerService.metricMemoryUtilization({ period: cdk.Duration.minutes(5) })],
      width: 12,
      height: 6,
    });

    // Task Count
    const gatewayTaskWidget = new cw.SingleValueWidget({
      title: 'Gateway Task Count',
      metrics: [
        new cw.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          dimensionsMap: {
            ServiceName: gatewayService.serviceName,
            ClusterName: gatewayService.cluster.clusterName,
          },
        }),
      ],
      width: 6,
      height: 6,
    });

    const workerTaskWidget = new cw.SingleValueWidget({
      title: 'Worker Task Count',
      metrics: [
        new cw.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          dimensionsMap: {
            ServiceName: workerService.serviceName,
            ClusterName: workerService.cluster.clusterName,
          },
        }),
      ],
      width: 6,
      height: 6,
    });

    // Add widgets to dashboard
    this.dashboard.addWidgets(
      gatewayCpuWidget,
      gatewayMemoryWidget,
      workerCpuWidget,
      workerMemoryWidget,
      gatewayTaskWidget,
      workerTaskWidget
    );
  }

  /**
   * Create custom metric for request latency
   */
  createRequestLatencyMetric(): cw.Metric {
    return new cw.Metric({
      namespace: 'OpenClaw/Gateway',
      metricName: 'RequestLatency',
      statistic: 'p99',
      period: cdk.Duration.minutes(1),
    });
  }

  /**
   * Create custom metric for task processing time
   */
  createTaskProcessingTimeMetric(): cw.Metric {
    return new cw.Metric({
      namespace: 'OpenClaw/Worker',
      metricName: 'TaskProcessingTime',
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });
  }
}
