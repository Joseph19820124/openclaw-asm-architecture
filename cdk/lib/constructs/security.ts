import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { OpenClawConfig } from '../../config';

export interface SecurityConstructProps {
  readonly config: OpenClawConfig;
}

export class SecurityConstruct extends Construct {
  public readonly kmsKey: kms.IKey;
  public readonly secrets: {
    readonly openaiApiKey: secretsmanager.ISecret;
    readonly anthropicApiKey: secretsmanager.ISecret;
    readonly gatewayAuthToken: secretsmanager.ISecret;
  };

  constructor(scope: Construct, id: string, props: SecurityConstructProps) {
    super(scope, id);

    const { config } = props;

    // Create KMS Key for encryption
    this.kmsKey = new kms.Key(this, 'EncryptionKey', {
      description: `OpenClaw ${config.environment} encryption key`,
      enableKeyRotation: config.security.kmsKeyRotation,
      pendingWindow: cdk.Duration.days(7),
      alias: `alias/openclaw/${config.environment}/key`,
    });

    // Create Secrets
    this.secrets = {
      // OpenAI API Key
      openaiApiKey: new secretsmanager.Secret(this, 'OpenAiApiKey', {
        secretName: `openclaw/${config.environment}/openai-api-key`,
        description: 'OpenAI API Key for LLM calls',
        encryptionKey: this.kmsKey,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ key: '' }),
          generateStringKey: 'key',
          excludeCharacters: '"@/\\',
        },
      }),

      // Anthropic API Key
      anthropicApiKey: new secretsmanager.Secret(this, 'AnthropicApiKey', {
        secretName: `openclaw/${config.environment}/anthropic-api-key`,
        description: 'Anthropic API Key for Claude',
        encryptionKey: this.kmsKey,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ key: '' }),
          generateStringKey: 'key',
          excludeCharacters: '"@/\\',
        },
      }),

      // Gateway Auth Token
      gatewayAuthToken: new secretsmanager.Secret(this, 'GatewayAuthToken', {
        secretName: `openclaw/${config.environment}/gateway-auth-token`,
        description: 'Gateway authentication token',
        encryptionKey: this.kmsKey,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ token: '' }),
          generateStringKey: 'token',
          excludeCharacters: '"@/\\',
          passwordLength: 64,
        },
      }),
    };

    // Tags
    cdk.Tags.of(this.kmsKey).add('Project', config.projectName);
  }

  /**
   * Grant read access to secrets for a role
   */
  grantReadSecrets(role: iam.IRole): void {
    Object.values(this.secrets).forEach((secret) => {
      secret.grantRead(role);
    });
  }
}
