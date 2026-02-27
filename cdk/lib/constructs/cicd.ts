import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface CicdConstructProps {
  readonly config: OpenClawConfig;
  readonly repository: ecr.IRepository;
  readonly gatewayService: ecs.IFargateService;
  readonly workerService: ecs.IFargateService;
  readonly githubRepo?: {
    owner: string;
    repo: string;
    branch: string;
    secretArn: string;
  };
}

export class CicdConstruct extends Construct {
  public readonly pipeline: codepipeline.IPipeline;
  public readonly buildProject: codebuild.IProject;

  constructor(scope: Construct, id: string, props: CicdConstructProps) {
    super(scope, id);

    const { config, repository, gatewayService, workerService, githubRepo } = props;

    // Create S3 bucket for pipeline artifacts
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `${config.projectName}-${config.environment}-pipeline-artifacts`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create CodeBuild Project
    this.buildProject = this.createBuildProject({
      config,
      repository,
    });

    // Create Deployment Groups
    const gatewayDeploymentGroup = this.createDeploymentGroup(
      gatewayService,
      'Gateway'
    );
    const workerDeploymentGroup = this.createDeploymentGroup(
      workerService,
      'Worker'
    );

    // Create Pipeline
    this.pipeline = this.createPipeline({
      config,
      artifactBucket,
      buildProject: this.buildProject,
      repository,
      gatewayService,
      workerService,
      gatewayDeploymentGroup,
      workerDeploymentGroup,
      githubRepo,
    });

    // Tags
    cdk.Tags.of(this.pipeline).add('Project', config.projectName);
  }

  private createBuildProject(props: {
    config: OpenClawConfig;
    repository: ecr.IRepository;
  }): codebuild.IProject {
    const { config, repository } = props;

    const project = new codebuild.Project(this, 'BuildProject', {
      projectName: `openclaw-${config.environment}-build`,
      source: codebuild.Source.codeCommit({
        repository: codebuild.CodeCommitRepository.fromRepositoryName(
          this,
          'SourceRepo',
          'openclaw'
        ),
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        privileged: true, // Required for Docker builds
        environmentVariables: {
          ECR_REPO_URI: { value: repository.repositoryUri },
          ENVIRONMENT: { value: config.environment },
        },
      },
      environmentVariables: {
        ECR_REPO_URI: { value: repository.repositoryUri },
        ENVIRONMENT: { value: config.environment },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI',
              'REPOSITORY_URI=$ECR_REPO_URI',
              'COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-7)',
              'IMAGE_TAG=${COMMIT_HASH:-latest}',
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Building Gateway image...',
              'docker build -f Dockerfile.gateway -t $REPOSITORY_URI:gateway-$IMAGE_TAG .',
              'docker tag $REPOSITORY_URI:gateway-$IMAGE_TAG $REPOSITORY_URI:gateway-latest',
              'echo Building Worker image...',
              'docker build -f Dockerfile.worker -t $REPOSITORY_URI:worker-$IMAGE_TAG .',
              'docker tag $REPOSITORY_URI:worker-$IMAGE_TAG $REPOSITORY_URI:worker-latest',
            ],
          },
          post_build: {
            commands: [
              'echo Build completed on `date`',
              'echo Pushing images to ECR...',
              'docker push $REPOSITORY_URI:gateway-$IMAGE_TAG',
              'docker push $REPOSITORY_URI:gateway-latest',
              'docker push $REPOSITORY_URI:worker-$IMAGE_TAG',
              'docker push $REPOSITORY_URI:worker-latest',
              'printf \'[{"name":"gateway","imageUri":"%s:gateway-%s"},{"name":"worker","imageUri":"%s:worker-%s"}]\' $REPOSITORY_URI $IMAGE_TAG $REPOSITORY_URI $IMAGE_TAG > imagedefinitions.json',
            ],
          },
        },
        artifacts: {
          files: ['imagedefinitions.json'],
        },
      }),
    });

    // Grant permissions
    repository.grantPullPush(project);

    return project;
  }

  private createDeploymentGroup(
    service: ecs.IFargateService,
    name: string
  ): codedeploy.IEcsDeploymentGroup {
    return new codedeploy.EcsDeploymentGroup(
      this,
      `${name}DeploymentGroup`,
      {
        deploymentGroupName: `openclaw-${service.serviceName}-dg`,
        service,
        blueGreenDeploymentConfig: {
          terminationWaitTime: cdk.Duration.minutes(15),
        },
        deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
      }
    );
  }

  private createPipeline(props: {
    config: OpenClawConfig;
    artifactBucket: s3.IBucket;
    buildProject: codebuild.IProject;
    repository: ecr.IRepository;
    gatewayService: ecs.IFargateService;
    workerService: ecs.IFargateService;
    gatewayDeploymentGroup: codedeploy.IEcsDeploymentGroup;
    workerDeploymentGroup: codedeploy.IEcsDeploymentGroup;
    githubRepo?: CicdConstructProps['githubRepo'];
  }): codepipeline.IPipeline {
    const {
      config,
      artifactBucket,
      buildProject,
      repository,
      gatewayService,
      workerService,
      gatewayDeploymentGroup,
      workerDeploymentGroup,
      githubRepo,
    } = props;

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `openclaw-${config.environment}`,
      artifactBucket,
      restartExecutionOnUpdate: true,
    });

    // Source Stage
    const sourceOutput = new codepipeline.Artifact('SourceOutput');

    let sourceAction: codepipeline_actions.Action;

    if (githubRepo) {
      // GitHub Source
      sourceAction = new codepipeline_actions.GitHubSourceAction({
        actionName: 'GitHub_Source',
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        branch: githubRepo.branch,
        oauthToken: cdk.SecretValue.secretsManager(githubRepo.secretArn),
        output: sourceOutput,
        trigger: codepipeline_actions.GitHubTrigger.WEBHOOK,
      });
    } else {
      // CodeCommit Source (default)
      sourceAction = new codepipeline_actions.CodeCommitSourceAction({
        actionName: 'CodeCommit_Source',
        repository: codebuild.CodeCommitRepository.fromRepositoryName(
          this,
          'PipelineSourceRepo',
          'openclaw'
        ),
        branch: 'main',
        output: sourceOutput,
      });
    }

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    // Build Stage
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build',
          project: buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    // Deploy Stage - Gateway
    const gatewayDeployInput = codepipeline.Artifact.artifact('BuildOutput');

    pipeline.addStage({
      stageName: 'DeployGateway',
      actions: [
        new codepipeline_actions.CodeDeployEcsDeployAction({
          actionName: 'DeployGateway',
          deploymentGroup: gatewayDeploymentGroup,
          taskDefinitionInput: gatewayDeployInput,
          containerImageInputs: [
            {
              input: gatewayDeployInput,
              taskDefinitionPlaceholder: 'gateway',
            },
          ],
        }),
      ],
    });

    // Deploy Stage - Worker
    const workerDeployInput = codepipeline.Artifact.artifact('BuildOutput');

    pipeline.addStage({
      stageName: 'DeployWorker',
      actions: [
        new codepipeline_actions.CodeDeployEcsDeployAction({
          actionName: 'DeployWorker',
          deploymentGroup: workerDeploymentGroup,
          taskDefinitionInput: workerDeployInput,
          containerImageInputs: [
            {
              input: workerDeployInput,
              taskDefinitionPlaceholder: 'worker',
            },
          ],
        }),
      ],
    });

    // Add approval stage for production
    if (config.environment === 'prod') {
      pipeline.addStage({
        stageName: 'Approval',
        actions: [
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'ApproveDeployment',
            notificationTopic: this.createApprovalTopic(config),
          }),
        ],
      });
    }

    return pipeline;
  }

  private createApprovalTopic(config: OpenClawConfig): sns.ITopic {
    const sns = require('aws-cdk-lib/aws-sns') as typeof import('aws-cdk-lib/aws-sns');
    
    return new sns.Topic(this, 'ApprovalTopic', {
      topicName: `openclaw-${config.environment}-approval`,
      displayName: 'OpenClaw Deployment Approval',
    });
  }
}

// Import SNS for approval topic
import * as sns from 'aws-cdk-lib/aws-sns';
