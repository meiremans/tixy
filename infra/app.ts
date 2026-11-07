import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamo from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { existsSync } from 'node:fs';
import { z } from 'zod';

const app = new cdk.App();
const stage = z.enum(['sandbox', 'production']).parse(app.node.tryGetContext('stage') ?? 'sandbox');
const production = stage === 'production';
const region = process.env.AWS_REGION || 'eu-central-1';
const stack = new cdk.Stack(app, `Tixy-${stage}`, { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region } });
const config = (key: string) => String(app.node.tryGetContext(key) ?? '');
const domain = config('domain');
const certificateArn = config('certificateArn');
const seller = config('seller');
const organizer = config('organizer');
const policies = config('policies');
const fromEmail = config('fromEmail');
const publicOrigin = config('publicOrigin') || (domain ? 'https://' + domain : '');
const enabled = config('checkoutEnabled') === 'true';
const smokeBuyer = config('smokeBuyer').toLowerCase();
if (smokeBuyer && !z.email().safeParse(smokeBuyer).success) throw new Error('Set smokeBuyer to a valid email address.');
if (!!domain !== !!certificateArn) throw new Error('Set domain and certificateArn together.');
if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('Set publicOrigin to an HTTPS origin without a path.');
if (enabled && (!publicOrigin.startsWith('https://') || !seller || !organizer || !policies.startsWith('https://') || !z.email().safeParse(fromEmail).success))
  throw new Error('Set public origin, seller, organizer, HTTPS policies URL and sender before enabling checkout.');
if (production && enabled && (!domain || publicOrigin !== 'https://' + domain || config('merchantReady') !== 'true'))
  throw new Error('Production checkout requires the custom domain and explicit merchantReady approval.');

const table = new dynamo.Table(stack, 'Records', {
  partitionKey: { name: 'pk', type: dynamo.AttributeType.STRING }, billingMode: dynamo.BillingMode.PAY_PER_REQUEST,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: production },
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});
const secret = new secrets.Secret(stack, 'Revolut', { secretName: `tixy/${stage}/revolut` });
const users = new cognito.UserPool(stack, 'Staff', { selfSignUpEnabled: false, signInAliases: { email: true },
  mfa: cognito.Mfa.REQUIRED, mfaSecondFactor: { sms: false, otp: true }, removalPolicy: cdk.RemovalPolicy.RETAIN });
const client = users.addClient('Web', {
  authFlows: { userSrp: true }, preventUserExistenceErrors: true,
  oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID],
    callbackUrls: [(publicOrigin || 'http://localhost:5173') + '/'], logoutUrls: [(publicOrigin || 'http://localhost:5173') + '/'] },
});
const login = users.addDomain('Login', { cognitoDomain: { domainPrefix: `tixy-${stage}-${cdk.Aws.ACCOUNT_ID}-${region}` } });
for (const group of ['admins', 'door']) new cognito.CfnUserPoolGroup(stack, group, { userPoolId: users.userPoolId, groupName: group });
function queue(id: string) {
  const dlq = new sqs.Queue(stack, id + 'DLQ', { encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: cdk.Duration.days(14) });
  new cw.Alarm(stack, id + 'DeadLetters', { metric: dlq.metricApproximateNumberOfMessagesVisible(), threshold: 1,
    evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING });
  return new sqs.Queue(stack, id, { visibilityTimeout: cdk.Duration.minutes(3), encryption: sqs.QueueEncryption.SQS_MANAGED,
    deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } });
}
const payment = queue('Payment');
const email = queue('Email');
function fn(id: string, entry: string, handler: string, timeout = 25) {
  const logGroup = new logs.LogGroup(stack, id + 'Logs', { retention: logs.RetentionDays.ONE_MONTH });
  const function_ = new NodejsFunction(stack, id, {
    entry, handler, runtime: lambda.Runtime.NODEJS_22_X, timeout: cdk.Duration.seconds(timeout), logGroup, memorySize: 512,
    bundling: { externalModules: [] },
    environment: { TABLE: table.tableName, STAGE: stage, SECRET: secret.secretArn, PAYMENT_QUEUE: payment.queueUrl,
      EMAIL_QUEUE: email.queueUrl, FROM_EMAIL: fromEmail, CHECKOUT_ENABLED: String(enabled),
      RECONCILE_ENABLED: config('reconcileEnabled'), SMOKE_BUYER: smokeBuyer, PUBLIC_ORIGIN: publicOrigin, SELLER: seller, ORGANIZER: organizer, POLICIES: policies },
  });
  table.grantReadWriteData(function_);
  return function_;
}
const apiFn = fn('ApiFunction', 'server/api.ts', 'handler');
const payFn = fn('PaymentsFunction', 'server/jobs.ts', 'payment');
const mailFn = fn('EmailFunction', 'server/jobs.ts', 'email');
const scheduled = fn('ReconcileFunction', 'server/jobs.ts', 'reconcile', 110);
for (const function_ of [apiFn, payFn, scheduled]) secret.grantRead(function_);
payment.grantSendMessages(apiFn);
email.grantSendMessages(scheduled);
payFn.addEventSource(new SqsEventSource(payment, { batchSize: 1 }));
mailFn.addEventSource(new SqsEventSource(email, { batchSize: 1 }));
if (fromEmail) mailFn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['ses:SendEmail'], resources: [`arn:${cdk.Aws.PARTITION}:ses:${region}:${cdk.Aws.ACCOUNT_ID}:identity/${fromEmail.split('@')[1]}`,
    `arn:${cdk.Aws.PARTITION}:ses:${region}:${cdk.Aws.ACCOUNT_ID}:identity/${fromEmail}`],
  conditions: { StringEquals: { 'ses:FromAddress': fromEmail } },
}));
new events.Rule(stack, 'Sweep', { schedule: events.Schedule.rate(cdk.Duration.minutes(2)), targets: [new targets.LambdaFunction(scheduled)] });
const stuck = new logs.MetricFilter(stack, 'StuckMetric', { logGroup: scheduled.logGroup, filterPattern: logs.FilterPattern.literal('"STUCK_ORDERS"'),
  metricName: 'StuckOrders', metricNamespace: 'Tixy/' + stage, metricValue: '1' });
for (const [id, metric] of [['ReconcileErrors', scheduled.metricErrors()], ['StuckOrders', stuck.metric()]] as const)
  new cw.Alarm(stack, id, { metric, threshold: 1, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING });

const api = new apigw.HttpApi(stack, 'Api');
const integration = new HttpLambdaIntegration('Lambda', apiFn);
const authorizer = new HttpJwtAuthorizer('StaffJwt', users.userPoolProviderUrl, { jwtAudience: [client.userPoolClientId] });
api.addRoutes({ path: '/api/{proxy+}', methods: [apigw.HttpMethod.ANY], integration });
api.addRoutes({ path: '/api/staff/{proxy+}', methods: [apigw.HttpMethod.ANY], integration, authorizer });
const cfnStage = api.defaultStage?.node.defaultChild as apigw.CfnStage;
cfnStage.defaultRouteSettings = { throttlingRateLimit: 30, throttlingBurstLimit: 60 };

const bucket = new s3.Bucket(stack, 'Assets', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true });
const distribution = new cf.Distribution(stack, 'Site', {
  domainNames: domain ? [domain] : undefined,
  certificate: certificateArn ? acm.Certificate.fromCertificateArn(stack, 'Certificate', certificateArn) : undefined,
  defaultRootObject: 'index.html',
  defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket), viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    responseHeadersPolicy: cf.ResponseHeadersPolicy.SECURITY_HEADERS },
  additionalBehaviors: {
    '/api/*': { origin: new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', api.apiEndpoint))),
      allowedMethods: cf.AllowedMethods.ALLOW_ALL, cachePolicy: cf.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER, viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY },
  },
});
if (!existsSync('dist/index.html')) throw new Error('Run npm run build before CDK synthesis.');
new deploy.BucketDeployment(stack, 'WebAssets', { sources: [deploy.Source.asset('dist')], destinationBucket: bucket,
  distribution, distributionPaths: ['/*'], prune: false });
new deploy.BucketDeployment(stack, 'WebConfig', {
  sources: [deploy.Source.jsonData('config.json', { cognito: login.baseUrl(), clientId: client.userPoolClientId })],
  destinationBucket: bucket, distribution, distributionPaths: ['/config.json'], prune: false, cacheControl: [deploy.CacheControl.noStore()],
});
new cdk.CfnOutput(stack, 'Website', { value: 'https://' + (domain || distribution.distributionDomainName) });
new cdk.CfnOutput(stack, 'Webhook', { value: api.apiEndpoint + '/api/webhooks/revolut' });
new cdk.CfnOutput(stack, 'UserPool', { value: users.userPoolId });
