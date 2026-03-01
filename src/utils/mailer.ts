import nodemailer, { type Transporter } from 'nodemailer';

import { env } from '../config/env';

type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

type SendEmailResult = {
  sent: boolean;
  deliveryMode: 'SMTP' | 'DEV_LOG';
  messageId?: string;
  preview?: string;
};

let transporter: Transporter | null = null;

const canUseSmtp = (): boolean => {
  if (!env.SMTP_HOST || !env.SMTP_FROM) {
    return false;
  }
  if (env.SMTP_USER && !env.SMTP_PASS) {
    return false;
  }
  return true;
};

const getTransporter = (): Transporter => {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST!,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER
      ? {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS
        }
      : undefined
  });
  return transporter;
};

export const sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
  if (!canUseSmtp()) {
    const preview = `TO: ${input.to}\nSUBJECT: ${input.subject}\n\n${input.text}`;
    console.log('[MAILER DEV_LOG]\n' + preview);
    return {
      sent: true,
      deliveryMode: 'DEV_LOG',
      preview
    };
  }

  const transport = getTransporter();
  const info = await transport.sendMail({
    from: env.SMTP_FROM!,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html
  });

  return {
    sent: true,
    deliveryMode: 'SMTP',
    messageId: info.messageId
  };
};
