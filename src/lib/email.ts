/**
 * Transactional email service entry point.
 *
 * Better Auth requires you to plug in an email sender for verification,
 * password reset, and organization invitations. This module routes to:
 *
 *   - AWS SES (preferred for Amplify deployments): set AWS_SES_FROM
 *     The SDK client uses the same IAM credential chain as DynamoDB.
 *   - Otherwise: logs to stdout and returns ok (dev fallback).
 *
 * The SES SDK is imported lazily so it's not in the cold-start bundle when
 * AWS_SES_FROM isn't configured.
 *
 * To plug in a different provider (Resend, Postmark, etc.), add a builder
 * branch in `getEmailService` and surface its env in `.env.example`.
 */

import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export interface EmailService {
  send: (message: EmailMessage) => Promise<void>;
}

let cached: EmailService | undefined;

const buildSesService = async (from: string): Promise<EmailService> => {
  const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
  const client = new SESv2Client({ region: getServerEnv().AWS_REGION });
  return {
    send: async ({ to, subject, text, html }) => {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [to] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: text, Charset: "UTF-8" },
                ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
              },
            },
          },
        }),
      );
    },
  };
};

const buildConsoleService = (): EmailService => ({
  send: async (message) => {
    logger.warn("email.console", {
      reason: "no provider configured",
      to: message.to,
      subject: message.subject,
    });
  },
});

export const getEmailService = async (): Promise<EmailService> => {
  if (cached) return cached;
  const { AWS_SES_FROM } = getServerEnv();
  if (AWS_SES_FROM) {
    cached = await buildSesService(AWS_SES_FROM);
    return cached;
  }
  cached = buildConsoleService();
  return cached;
};
