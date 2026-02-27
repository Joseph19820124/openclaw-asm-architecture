#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenClawStack } from '../lib/openclaw-stack';
import { getConfig } from '../config';

// Get environment from context or default to 'dev'
const app = new cdk.App();

const environment = app.node.tryGetContext('environment') || 'dev';
const config = getConfig(environment);

// Main Stack
new OpenClawStack(app, `OpenClawStack-${config.environment}`, {
  stackName: `openclaw-${config.environment}`,
  description: `OpenClaw ${config.environment} infrastructure stack`,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
  tags: {
    Project: config.projectName,
    Environment: config.environment,
    ManagedBy: 'CDK',
  },
  config,
});

// DR Stack (if enabled)
if (config.dr.enabled && config.drRegion) {
  const drConfig = { ...config, region: config.drRegion };
  new OpenClawStack(app, `OpenClawStack-${config.environment}-DR`, {
    stackName: `openclaw-${config.environment}-dr`,
    description: `OpenClaw ${config.environment} DR infrastructure stack`,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: config.drRegion,
    },
    tags: {
      Project: config.projectName,
      Environment: `${config.environment}-dr`,
      ManagedBy: 'CDK',
    },
    config: drConfig,
  });
}

app.synth();
