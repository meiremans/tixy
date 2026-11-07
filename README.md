# Tixy

Tixy sells EUR general-admission tickets through Revolut Hosted Checkout. The seller receives payments in its Revolut Merchant account and uses the event sales export for intercompany billing. The organizer appears separately on event pages.

## Build and verify

Use Node.js 22 or later. Run `npm ci`, `npm run check`, `npm test`, and `npm run build`. Run `npm run cdk -- synth -c stage=sandbox` after building. The Vite server serves the frontend locally. Use a deployed sandbox to exercise AWS-backed flows.

## Configure AWS

1. Bootstrap AWS CDK in the target account and region. The default region is `eu-central-1`. Configure the GitHub environments `sandbox` and `production` with distinct deployment roles. Create GitHub OIDC trust scoped to `repo:meiremans/tixy:environment:<stage>` with audience `sts.amazonaws.com`. Restrict deployment environments to the main branch and use a production reviewer.
2. Set the environment variable `AWS_ROLE_ARN` in each GitHub environment's Variables settings. Optionally set `AWS_REGION`. Run the **Deploy to AWS** workflow with checkout disabled. Alternatively, use the same CDK context arguments from the workflow with your AWS credentials.
3. Set `PUBLIC_ORIGIN` to the output `Website` URL and redeploy. For a custom domain set `SITE_DOMAIN` and `CERTIFICATE_ARN` for an ACM certificate in `us-east-1`, and point DNS to CloudFront. For a first sandbox deploy the CloudFront hostname works after the second deployment registers it with Cognito.
4. Verify the SES sender identity in the deployment region. In the SES sandbox use verified recipient addresses. Request SES production access for public sales. Set `FROM_EMAIL`, `SELLER`, `ORGANIZER`, and `POLICIES` in GitHub Variables. Include the seller's legal name in `SELLER` and link to the seller's published purchase and privacy policies.
5. Register the output `Webhook` URL in the same Revolut Merchant environment as the API key. Subscribe to `ORDER_COMPLETED`, `ORDER_FAILED`, `ORDER_CANCELLED`, and the relevant payment failure events. Store a JSON secret with fields `apiKey` and `webhookSecret` in `tixy/<stage>/revolut` through AWS Secrets Manager. Keep keys out of GitHub and the browser.
6. Invite staff in Cognito using the `UserPool` output. Add each user to `admins` or `door`. Staff sign in using the link in the site header and enroll a TOTP authenticator.
7. Set `CHECKOUT_ENABLED=true` in sandbox and deploy. In production first confirm the Merchant setup covers ticket sales, then set `MERCHANT_READY=true`, `CHECKOUT_ENABLED=true`, and `SMOKE_BUYER` to the controlled buyer email. Verify a real sale, email, and dashboard refund before clearing `SMOKE_BUYER` and opening sales. Keep `RECONCILE_ENABLED=true` when pausing checkout so refund recovery continues.

## Sandbox acceptance

- Publish an event and buy two tickets. Check the total, provider return status, one QR and code per admission, and one sale row in the CSV.
- Decline a payment and retry on the same checkout. Abandon another checkout and verify that confirmed expiry returns its inventory.
- With one ticket left, submit two separate checkouts concurrently. Repeat a single checkout request with the same retry key. Confirm capacity and the number of payable provider orders.
- Simulate a timed-out order creation and verify that lookup by Tixy reference resolves it. Redeliver a signed webhook and exercise out-of-order events. Verify there is still one fulfillment and one set of ticket codes.
- Verify delivery retries by failing SES temporarily. Scan on two phones at once, then try a code from a different event. Confirm door users cannot manage events, export sales, or resend email.
- Issue a full refund in Revolut and verify the tickets are void, the refund appears once in the export, and any earlier check-in stays in the record. Check restored inventory for unused admissions during open sales.

## Operations

Use CloudWatch for reconciliation errors, orders older than 30 minutes, and dead-letter queues. Redrive failed payment messages once their cause is fixed. The email outbox dispatches via the scheduled reconciliation Lambda. A retry after an ambiguous SES response can send the same ticket codes again. Orders with an ambiguous create and no provider match keep their inventory reserved. Investigate the Tixy reference in Revolut before manually resolving these records. Use a consistent conditional DynamoDB transaction to release an unresolved reservation only after confirming it cannot be paid.

The CSV uses inclusive UTC calendar dates and reports gross customer payments and completed refunds. Review flagged partial refunds against the dashboard. Use Revolut for fee and settlement reconciliation.
