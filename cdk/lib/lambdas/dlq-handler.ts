import {
  SQSEvent,
  SQSRecord,
  Context,
  Callback,
} from 'aws-lambda';
import {
  SNSClient,
  PublishCommand,
} from '@aws-sdk/client-sns';

const snsClient = new SNSClient({});

interface DLQMessage {
  messageId: string;
  body: string;
  receiptHandle: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, unknown>;
}

export const handler = async (
  event: SQSEvent,
  context: Context,
  callback: Callback
): Promise<void> => {
  console.log(`Processing ${event.Records.length} DLQ messages`);

  const alertTopicArn = process.env.ALERT_TOPIC_ARN;
  const environment = process.env.ENVIRONMENT;

  if (!alertTopicArn) {
    console.error('ALERT_TOPIC_ARN not set');
    return;
  }

  for (const record of event.Records) {
    try {
      await processDlqMessage(record, alertTopicArn, environment);
    } catch (error) {
      console.error(`Failed to process message ${record.messageId}:`, error);
      // Continue processing other messages
    }
  }
};

async function processDlqMessage(
  record: SQSRecord,
  alertTopicArn: string,
  environment: string | undefined
): Promise<void> {
  const messageBody = JSON.parse(record.body);

  // Parse original event if it's from EventBridge
  let originalEvent: unknown;
  try {
    if (messageBody.detail) {
      originalEvent = messageBody.detail;
    } else {
      originalEvent = messageBody;
    }
  } catch {
    originalEvent = messageBody;
  }

  // Create alert message
  const alertMessage = {
    type: 'DLQ_ALERT',
    environment,
    timestamp: new Date().toISOString(),
    messageId: record.messageId,
    originalEvent,
    receiptHandle: record.receiptHandle,
    error: 'Message failed processing and moved to DLQ',
  };

  // Publish to SNS
  await snsClient.send(
    new PublishCommand({
      TopicArn: alertTopicArn,
      Subject: `[OpenClaw] DLQ Alert - ${environment}`,
      Message: JSON.stringify(alertMessage, null, 2),
      MessageAttributes: {
        alertType: {
          DataType: 'String',
          StringValue: 'DLQ',
        },
        environment: {
          DataType: 'String',
          StringValue: environment || 'unknown',
        },
      },
    })
  );

  console.log(`Published alert for message ${record.messageId}`);

  // Optional: Implement retry logic here
  // For example, send to a dead-letter storage or trigger manual review
}

/**
 * Retry logic placeholder
 * In production, you might want to:
 * 1. Store failed messages in DynamoDB for manual review
 * 2. Send to an error tracking service (e.g., Sentry)
 * 3. Trigger a PagerDuty incident for critical failures
 */
async function handleRetry(
  record: SQSRecord,
  attemptCount: number
): Promise<boolean> {
  // Implement custom retry logic
  // Return true if retry should be attempted, false otherwise
  return false;
}
