/**
 * OpenClaw Infrastructure Configuration
 */
export interface OpenClawConfig {
  readonly projectName: string;
  readonly environment: 'dev' | 'staging' | 'prod';
  readonly region: string;
  readonly drRegion?: string;

  readonly vpc: {
    readonly cidr: string;
    readonly maxAzs: number;
    readonly natGateways: number;
  };

  readonly gateway: {
    readonly cpu: number;
    readonly memory: number;
    readonly minCapacity: number;
    readonly maxCapacity: number;
    readonly desiredCount: number;
  };

  readonly worker: {
    readonly cpu: number;
    readonly memory: number;
    readonly minCapacity: number;
    readonly maxCapacity: number;
    readonly desiredCount: number;
  };

  readonly database: {
    readonly tableName: string;
    readonly readCapacity: number;
    readonly writeCapacity: number;
    readonly enableGlobalTables: boolean;
  };

  readonly cache: {
    readonly nodeType: string;
    readonly numNodes: number;
  };

  readonly queue: {
    readonly visibilityTimeout: number;
    readonly maxReceiveCount: number;
    readonly messageRetentionDays: number;
  };

  readonly dr: {
    readonly enabled: boolean;
    readonly strategy: 'pilot-light' | 'warm-standby' | 'multi-site';
  };

  readonly observability: {
    readonly enableXRay: boolean;
    readonly enableGrafana: boolean;
    readonly logRetentionDays: number;
  };

  readonly security: {
    readonly enableGuardDuty: boolean;
    readonly enableSecurityHub: boolean;
    readonly enableInspector: boolean;
    readonly kmsKeyRotation: boolean;
  };
}

/**
 * Development environment configuration
 */
export const devConfig: OpenClawConfig = {
  projectName: 'openclaw',
  environment: 'dev',
  region: 'us-east-1',

  vpc: {
    cidr: '10.0.0.0/16',
    maxAzs: 2,
    natGateways: 1,
  },

  gateway: {
    cpu: 512,
    memory: 1024,
    minCapacity: 1,
    maxCapacity: 10,
    desiredCount: 1,
  },

  worker: {
    cpu: 1024,
    memory: 2048,
    minCapacity: 1,
    maxCapacity: 20,
    desiredCount: 2,
  },

  database: {
    tableName: 'openclaw-tasks',
    readCapacity: 5,
    writeCapacity: 5,
    enableGlobalTables: false,
  },

  cache: {
    nodeType: 'cache.t3.micro',
    numNodes: 1,
  },

  queue: {
    visibilityTimeout: 900, // 15 minutes
    maxReceiveCount: 3,
    messageRetentionDays: 7,
  },

  dr: {
    enabled: false,
    strategy: 'pilot-light',
  },

  observability: {
    enableXRay: true,
    enableGrafana: false,
    logRetentionDays: 7,
  },

  security: {
    enableGuardDuty: false,
    enableSecurityHub: false,
    enableInspector: false,
    kmsKeyRotation: false,
  },
};

/**
 * Production environment configuration
 */
export const prodConfig: OpenClawConfig = {
  projectName: 'openclaw',
  environment: 'prod',
  region: 'us-east-1',
  drRegion: 'us-west-2',

  vpc: {
    cidr: '10.0.0.0/16',
    maxAzs: 3,
    natGateways: 2,
  },

  gateway: {
    cpu: 1024,
    memory: 2048,
    minCapacity: 2,
    maxCapacity: 50,
    desiredCount: 3,
  },

  worker: {
    cpu: 2048,
    memory: 4096,
    minCapacity: 2,
    maxCapacity: 100,
    desiredCount: 5,
  },

  database: {
    tableName: 'openclaw-tasks',
    readCapacity: 100,
    writeCapacity: 50,
    enableGlobalTables: true,
  },

  cache: {
    nodeType: 'cache.r6g.large',
    numNodes: 3,
  },

  queue: {
    visibilityTimeout: 900,
    maxReceiveCount: 3,
    messageRetentionDays: 14,
  },

  dr: {
    enabled: true,
    strategy: 'pilot-light',
  },

  observability: {
    enableXRay: true,
    enableGrafana: true,
    logRetentionDays: 30,
  },

  security: {
    enableGuardDuty: true,
    enableSecurityHub: true,
    enableInspector: true,
    kmsKeyRotation: true,
  },
};

/**
 * Get configuration by environment name
 */
export function getConfig(environment: string): OpenClawConfig {
  switch (environment) {
    case 'prod':
      return prodConfig;
    case 'dev':
    default:
      return devConfig;
  }
}
