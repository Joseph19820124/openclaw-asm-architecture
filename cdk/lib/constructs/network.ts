import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface NetworkConstructProps {
  readonly config: OpenClawConfig;
}

export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.PublicSubnet[];
  public readonly privateSubnets: ec2.PrivateSubnet[];
  public readonly isolatedSubnets: ec2.PrivateSubnet[];
  public readonly securityGroups: {
    readonly alb: ec2.SecurityGroup;
    readonly gateway: ec2.SecurityGroup;
    readonly worker: ec2.SecurityGroup;
    readonly redis: ec2.SecurityGroup;
  };

  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);

    const { config } = props;

    // Create VPC with 3 tiers: public, private, isolated
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpc.cidr),
      maxAzs: config.vpc.maxAzs,
      natGateways: config.vpc.natGateways,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        },
        DynamoDB: {
          service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        },
      },
    });

    // Get subnet arrays
    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;
    this.isolatedSubnets = this.vpc.isolatedSubnets;

    // Create VPC Endpoints for AWS services (PrivateLink)
    this.createVpcEndpoints();

    // Create Security Groups
    this.securityGroups = this.createSecurityGroups();

    // Add VPC Flow Logs
    this.createFlowLogs(config);

    // Tags
    cdk.Tags.of(this.vpc).add('Project', config.projectName);
    cdk.Tags.of(this.vpc).add('Environment', config.environment);
  }

  private createVpcEndpoints(): void {
    // Interface VPC Endpoints
    const endpointServices = [
      ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      ec2.InterfaceVpcEndpointAwsService.ECR,
      ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      ec2.InterfaceVpcEndpointAwsService.SQS,
      ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
      ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
      ec2.InterfaceVpcEndpointAwsService.API_GATEWAY,
    ];

    // Add Bedrock endpoint if available
    // Note: Bedrock VPCE may not be available in all regions

    endpointServices.forEach((service) => {
      new ec2.InterfaceVpcEndpoint(this, `${service.name}Endpoint`, {
        vpc: this.vpc,
        service,
        privateDnsEnabled: true,
        subnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      });
    });
  }

  private createSecurityGroups(): {
    alb: ec2.SecurityGroup;
    gateway: ec2.SecurityGroup;
    worker: ec2.SecurityGroup;
    redis: ec2.SecurityGroup;
  } {
    // ALB Security Group
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    // Allow HTTPS from anywhere (0.0.0.0/0 via CloudFront)
    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from CloudFront/Internet'
    );

    // Gateway Security Group
    const gatewaySg = new ec2.SecurityGroup(this, 'GatewaySecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for OpenClaw Gateway',
      allowAllOutbound: true,
    });

    // Allow traffic from ALB
    gatewaySg.addIngressRule(
      albSg,
      ec2.Port.tcp(8080),
      'Allow traffic from ALB'
    );

    // Worker Security Group
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for OpenClaw Workers',
      allowAllOutbound: true,
    });

    // Allow traffic from Gateway
    workerSg.addIngressRule(
      gatewaySg,
      ec2.Port.allTcp(),
      'Allow traffic from Gateway'
    );

    // Redis Security Group
    const redisSg = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for ElastiCache Redis',
      allowAllOutbound: false,
    });

    // Allow Redis access from Gateway and Workers
    redisSg.addIngressRule(
      gatewaySg,
      ec2.Port.tcp(6379),
      'Allow Redis from Gateway'
    );
    redisSg.addIngressRule(
      workerSg,
      ec2.Port.tcp(6379),
      'Allow Redis from Workers'
    );

    return {
      alb: albSg,
      gateway: gatewaySg,
      worker: workerSg,
      redis: redisSg,
    };
  }

  private createFlowLogs(config: OpenClawConfig): void {
    const logGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
      maxAggregationInterval: ec2.FlowLogMaxAggregationInterval.ONE_MINUTE,
    });
  }
}
