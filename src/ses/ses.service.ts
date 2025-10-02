import { Injectable, Logger } from '@nestjs/common';
import {
  SESClient,
  SendEmailCommand,
  SendEmailCommandInput,
} from '@aws-sdk/client-ses';

export interface EmailOptions {
  to: string | string[];
  subject: string;
  htmlBody?: string;
  textBody?: string;
  from?: string;
  replyTo?: string;
}

@Injectable()
export class SesService {
  private readonly logger = new Logger(SesService.name);
  private readonly sesClient: SESClient;
  private readonly defaultFromEmail: string;

  constructor() {
    const region = process.env.AWS_REGION || 'eu-central-1';
    this.defaultFromEmail =
      process.env.SES_FROM_EMAIL || 'info@togeda.net';

    this.sesClient = new SESClient({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
  }

  /**
   * Send an email using Amazon SES
   * @param options Email options
   * @returns Promise with the MessageId if successful
   */
  async sendEmail(options: EmailOptions): Promise<string | null> {
    try {
      const toAddresses = Array.isArray(options.to)
        ? options.to
        : [options.to];

      const params: SendEmailCommandInput = {
        Source: options.from || this.defaultFromEmail,
        Destination: {
          ToAddresses: toAddresses,
        },
        Message: {
          Subject: {
            Data: options.subject,
            Charset: 'UTF-8',
          },
          Body: {
            ...(options.htmlBody && {
              Html: {
                Data: options.htmlBody,
                Charset: 'UTF-8',
              },
            }),
            ...(options.textBody && {
              Text: {
                Data: options.textBody,
                Charset: 'UTF-8',
              },
            }),
          },
        },
        ...(options.replyTo && {
          ReplyToAddresses: [options.replyTo],
        }),
      };

      const command = new SendEmailCommand(params);
      const response = await this.sesClient.send(command);

      this.logger.log(
        `Email sent successfully to ${toAddresses.join(', ')}. MessageId: ${response.MessageId}`,
      );

      return response.MessageId || null;
    } catch (error) {
      this.logger.error(`Failed to send email: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Send a simple text email
   * @param to Recipient email address(es)
   * @param subject Email subject
   * @param text Email text content
   * @returns Promise with the MessageId if successful
   */
  async sendTextEmail(
    to: string | string[],
    subject: string,
    text: string,
  ): Promise<string | null> {
    return this.sendEmail({
      to,
      subject,
      textBody: text,
    });
  }

  /**
   * Send an HTML email
   * @param to Recipient email address(es)
   * @param subject Email subject
   * @param html Email HTML content
   * @param text Optional plain text fallback
   * @returns Promise with the MessageId if successful
   */
  async sendHtmlEmail(
    to: string | string[],
    subject: string,
    html: string,
    text?: string,
  ): Promise<string | null> {
    return this.sendEmail({
      to,
      subject,
      htmlBody: html,
      textBody: text,
    });
  }
}
