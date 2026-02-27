import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as dynamodb_global from 'aws-cdk-lib/aws-dynamodb-global';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface DatabaseConstructProps {
  readonly config: OpenClawConfig;
  readonly encryptionKey: kms.IKey;
}

export class DatabaseConstruct extends Construct {
  public readonly tasksTable: dynamodb.ITable;
  public readonly sessionsTable: dynamodb.ITable;
  public readonly artifactsBucket: s3.IBucket;
  public readonly logsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    const { config, encryptionKey } = props;

    // Tasks Table
    this.tasksTable = this.createTasksTable(config, encryptionKey);

    // Sessions Table
    this.sessionsTable = this.createSessionsTable(config, encryptionKey);

    // Artifacts Bucket (screenshots, files, etc.)
    this.artifactsBucket = this.createArtifactsBucket(config, encryptionKey);

    // Logs Bucket (for long-term log storage)
    this.logsBucket = this.createLogsBucket(config, encryptionKey);

    // Tags
    cdk.Tags.of(this.tasksTable).add('Project', config.projectName);
    cdk.Tags.of(this.sessionsTable).add('Project', config.projectName);
  }

  private createTasksTable(
    config: OpenClawConfig,
    encryptionKey: kms.IKey
  ): dynamodb.ITable {
    const table = new dynamodb.Table(this, 'TasksTable', {
      tableName: `${config.projectName}-${config.environment}-tasks`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: config.database.readCapacity,
      writeCapacity: config.database.writeCapacity,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI 1: Query by user
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      readCapacity: config.database.readCapacity,
      writeCapacity: config.database.writeCapacity,
    });

    // GSI 2: Query by status
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      readCapacity: config.database.readCapacity,
      writeCapacity: config.database.writeCapacity,
    });

    // Auto-scaling
    const readScaling = table.autoScaleReadCapacity({
      minCapacity: config.database.readCapacity,
      maxCapacity: config.database.readCapacity * 10,
    });
    readScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });

    const writeScaling = table.autoScaleWriteCapacity({
      minCapacity: config.database.writeCapacity,
      maxCapacity: config.database.writeCapacity * 10,
    });
    writeScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });

    return table;
  }

  private createSessionsTable(
    config: OpenClawConfig,
    encryptionKey: kms.IKey
  ): dynamodb.ITable {
    const table = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `${config.projectName}-${config.environment}-sessions`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: Query by user
    table.addGlobalSecondaryIndex({
      indexName: 'UserIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    return table;
  }

  private createArtifactsBucket(
    config: OpenClawConfig,
    encryptionKey: kms.IKey
  ): s3.IBucket {
    const bucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `${config.projectName}-${config.environment}-artifacts-${config.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          id: 'ArchiveOldObjects',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CORS configuration for browser access
    bucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
      allowedOrigins: ['*'], // Restrict in production
      allowedHeaders: ['*'],
      maxAge: 3600,
    });

    return bucket;
  }

  private createLogsBucket(
    config: OpenClawConfig,
    encryptionKey: kms.IKey
  ): s3.IBucket {
    return new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${config.projectName}-${config.environment}-logs-${config.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(config.observability.logRetentionDays),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
