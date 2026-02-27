import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface CacheConstructProps {
  readonly config: OpenClawConfig;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.ISecurityGroup;
}

export class CacheConstruct extends Construct {
  public readonly redisCluster: elasticache.CfnReplicationGroup;
  public readonly primaryEndpoint: string;
  public readonly readerEndpoint: string;

  constructor(scope: Construct, id: string, props: CacheConstructProps) {
    super(scope, id);

    const { config, vpc, securityGroup } = props;

    // Create Subnet Group
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'OpenClaw Redis subnet group',
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
    });

    // Create Parameter Group
    const parameterGroup = new elasticache.CfnParameterGroup(
      this,
      'ParameterGroup',
      {
        description: 'OpenClaw Redis parameter group',
        cacheParameterGroupFamily: 'redis7',
        properties: {
          'maxmemory-policy': 'volatile-lru',
          'timeout': '300',
        },
      }
    );

    // Create Redis Replication Group
    this.redisCluster = new elasticache.CfnReplicationGroup(
      this,
      'RedisCluster',
      {
        replicationGroupDescription: `OpenClaw ${config.environment} Redis cluster`,
        engine: 'redis',
        engineVersion: '7.1',
        cacheNodeType: config.cache.nodeType,
        numNodeGroups: 1,
        replicasPerNodeGroup: config.cache.numNodes - 1,
        automaticFailoverEnabled: config.cache.numNodes > 1,
        multiAzEnabled: config.cache.numNodes > 1,
        subnetGroupName: subnetGroup.ref,
        securityGroupIds: [securityGroup.securityGroupId],
        cacheParameterGroupName: parameterGroup.ref,
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        snapshotRetentionLimit: 7,
        snapshotWindow: '03:00-05:00',
        preferredMaintenanceWindow: 'sun:05:00-sun:07:00',
        logDeliveryConfigurations: [
          {
            logFormat: 'json',
            logType: 'slow-log',
            destinationType: 'cloudwatch-logs',
          },
          {
            logFormat: 'json',
            logType: 'engine-log',
            destinationType: 'cloudwatch-logs',
          },
        ],
      }
    );

    // Get endpoints after creation
    this.primaryEndpoint = cdk.Fn.getAtt(
      this.redisCluster.logicalId,
      'PrimaryEndpoint.Address'
    ).toString();
    this.readerEndpoint = cdk.Fn.getAtt(
      this.redisCluster.logicalId,
      'ReaderEndpoint.Address'
    ).toString();

    // Tags
    cdk.Tags.of(this.redisCluster).add('Project', config.projectName);
    cdk.Tags.of(this.redisCluster).add('Environment', config.environment);
  }

  /**
   * Get Redis connection string for environment variables
   */
  getConnectionString(): string {
    return `redis://${this.primaryEndpoint}:6379`;
  }
}
