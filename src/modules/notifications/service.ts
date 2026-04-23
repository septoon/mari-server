import {
  ActorType,
  AppointmentStatus,
  DiscountType,
  PaymentMethod,
  Prisma,
  PushEnvironment,
  StaffRole,
} from '@prisma/client';
import dayjs from 'dayjs';

import { prisma } from '../../db/prisma';
import { toNumber } from '../../utils/money';
import { sendEmail } from '../../utils/mailer';
import { env } from '../../config/env';
import { formatDateMsk, MSK_TZ } from '../../utils/time';
import { NOTIFICATION_ID_SET } from './catalog';
import { getOrCreateAppConfig, normalizeNotificationSettings } from '../settings/service';
import { sendPushAlert } from '../push/service';

const WORKER_INTERVAL_MS = 60_000;
const NO_SHOW_REINVITE_DAYS = 7;
const REPEAT_VISIT_DAYS = 30;
const SCHEDULE_LOOKAHEAD_DAYS = 7;
const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.ARRIVED,
];

let jobsTimer: NodeJS.Timeout | null = null;
let jobsRunning = false;

type AppointmentMailContext = Awaited<ReturnType<typeof loadAppointmentMailContext>>;
type StaffEmailRecipient = {
  staffId: string;
  email: string;
  role: StaffRole;
};

type StaffPushRecipient = {
  staffId: string;
  role: StaffRole;
  devices: Array<{
    id: string;
    token: string;
    environment: PushEnvironment;
  }>;
};

const SUPPORTED_NOTIFICATION_IDS = [
  'clients.onlineBookingCreated',
  'clients.journalBookingCreated',
  'clients.bookingConfirmed',
  'clients.bookingChanged',
  'clients.confirmationRequest',
  'clients.visitReminder',
  'clients.bookingCancelled',
  'clients.noShowCancelled',
  'clients.noShowInvite',
  'clients.reviewRequestWidget',
  'clients.reviewRequestJournal',
  'clients.birthdayGreeting',
  'clients.newDiscount',
  'clients.discountExpiring',
  'clients.repeatVisitInvite',
  'clients.phoneConfirmationWidget',
  'clients.onlinePaymentSuccess',
  'admins.clientBookingCreated',
  'admins.adminBookingCreated',
  'admins.widgetBookingRescheduled',
  'admins.widgetBookingCancelled',
  'admins.scheduleEndingSoon',
  'staff.clientBookingCreated',
  'staff.adminBookingCreated',
  'staff.bookingRescheduled',
  'staff.bookingCancelled',
  'staff.noShowMarked',
] as const;

type SupportedNotificationId = (typeof SUPPORTED_NOTIFICATION_IDS)[number];

const supportedNotificationIdSet = new Set<string>(SUPPORTED_NOTIFICATION_IDS);
const missingCatalogNotificationIds = [...NOTIFICATION_ID_SET].filter(
  (id) => !supportedNotificationIdSet.has(id),
);
const extraSupportedNotificationIds = [...supportedNotificationIdSet].filter(
  (id) => !NOTIFICATION_ID_SET.has(id),
);

if (missingCatalogNotificationIds.length > 0 || extraSupportedNotificationIds.length > 0) {
  throw new Error(
    [
      'Notification catalog and delivery logic are out of sync.',
      missingCatalogNotificationIds.length > 0
        ? `Missing in delivery logic: ${missingCatalogNotificationIds.join(', ')}.`
        : null,
      extraSupportedNotificationIds.length > 0
        ? `Unknown in catalog: ${extraSupportedNotificationIds.join(', ')}.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

const buildHtml = (title: string, lines: string[]) => `
  <div style="margin:0;padding:24px;background:#f5f1ec;font-family:Arial,Helvetica,sans-serif;color:#20343a;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid rgba(12,77,85,.08);border-radius:20px;padding:32px;">
      <div style="font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:#5f7478;">MARI Beauty Salon</div>
      <h1 style="margin:16px 0 18px;font-size:28px;line-height:1.1;color:#0c4d55;">${title}</h1>
      ${lines
        .map(
          (line) =>
            `<p style="margin:0 0 12px;font-size:16px;line-height:1.7;color:#20343a;">${line}</p>`,
        )
        .join('')}
    </div>
  </div>
`.trim();

const getNotificationConfig = async () => {
  const config = await getOrCreateAppConfig();
  return {
    minNoticeMinutes: config.notificationMinNoticeMinutes,
    toggles: normalizeNotificationSettings(config.notificationSettings),
  };
};

const isNotificationEnabled = async (notificationId: SupportedNotificationId) => {
  const config = await getNotificationConfig();
  return {
    enabled: Boolean(config.toggles[notificationId]),
    minNoticeMinutes: config.minNoticeMinutes,
  };
};

const createDispatch = async (input: {
  dispatchKey: string;
  notificationId: SupportedNotificationId;
  recipientEmail: string;
  meta?: Prisma.InputJsonValue;
}) => {
  await prisma.notificationDispatch.create({
    data: {
      dispatchKey: input.dispatchKey,
      notificationId: input.notificationId,
      recipientEmail: input.recipientEmail,
      meta: input.meta ?? {},
    },
  });
};

const sendNotificationEmail = async (input: {
  notificationId: SupportedNotificationId;
  dispatchKey: string;
  recipientEmail: string | null | undefined;
  subject: string;
  lines: string[];
  meta?: Prisma.InputJsonValue;
}) => {
  const email = input.recipientEmail?.trim().toLowerCase();
  if (!email) {
    return false;
  }

  const { enabled } = await isNotificationEnabled(input.notificationId);
  if (!enabled) {
    return false;
  }

  const existing = await prisma.notificationDispatch.findUnique({
    where: { dispatchKey: input.dispatchKey },
    select: { id: true },
  });
  if (existing) {
    return false;
  }

  const text = input.lines.join('\n');
  await sendEmail({
    to: email,
    subject: input.subject,
    text,
    html: buildHtml(input.subject, input.lines),
  });

  try {
    await createDispatch({
      dispatchKey: input.dispatchKey,
      notificationId: input.notificationId,
      recipientEmail: email,
      meta: input.meta,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return false;
    }
    throw error;
  }

  return true;
};

const appointmentDateTimeLabel = (appointment: {
  startAt: Date;
  endAt: Date;
}) =>
  `${formatDateMsk(appointment.startAt, 'DD.MM.YYYY')} c ${formatDateMsk(
    appointment.startAt,
    'HH:mm',
  )} до ${formatDateMsk(appointment.endAt, 'HH:mm')}`;

const loadAppointmentMailContext = async (appointmentId: string) => {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      client: {
        include: {
          account: {
            select: { email: true },
          },
        },
      },
      staff: {
        select: { id: true, name: true, email: true },
      },
      appointmentServices: {
        orderBy: { sortOrder: 'asc' },
        select: {
          serviceNameSnapshot: true,
          priceSnapshot: true,
          priceWithDiscountSnapshot: true,
        },
      },
    },
  });
};

const formatServiceNames = (appointment: AppointmentMailContext) =>
  appointment?.appointmentServices.map((item) => item.serviceNameSnapshot).join(', ') || 'Услуга';

const normalizeRecipientEmail = (value: string | null | undefined) => value?.trim().toLowerCase() || null;

const buildAppointmentCommentLines = (appointment: AppointmentMailContext) => {
  const comment = appointment?.comment?.trim();
  return comment ? [`Комментарий к записи: ${comment}`] : [];
};

const resolveAssignedStaffEmail = async (staffId: string, fallbackEmail?: string | null) => {
  const normalizedFallback = normalizeRecipientEmail(fallbackEmail);
  if (normalizedFallback) {
    return normalizedFallback;
  }

  const row = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { email: true },
  });

  return normalizeRecipientEmail(row?.email);
};

const sendAssignedStaffNotificationEmail = async (input: {
  appointmentId: string;
  staffId: string;
  fallbackEmail?: string | null;
  notificationId: SupportedNotificationId;
  dispatchKey: string;
  subject: string;
  lines: string[];
  meta?: Prisma.InputJsonValue;
}) => {
  const recipientEmail = await resolveAssignedStaffEmail(input.staffId, input.fallbackEmail);
  return sendNotificationEmail({
    notificationId: input.notificationId,
    dispatchKey: input.dispatchKey,
    recipientEmail,
    subject: input.subject,
    lines: input.lines,
    meta: input.meta ?? {
      appointmentId: input.appointmentId,
      audience: 'staff',
    },
  });
};

const listOwnerRecipients = async (): Promise<StaffEmailRecipient[]> => {
  const rows = await prisma.staff.findMany({
    where: {
      isActive: true,
      firedAt: null,
      deletedAt: null,
      email: { not: null },
      role: StaffRole.OWNER,
    },
    select: { id: true, email: true, role: true },
  });
  return rows
    .map((row) => {
      const email = normalizeRecipientEmail(row.email);
      if (!email) {
        return null;
      }
      return {
        staffId: row.id,
        email,
        role: row.role,
      };
    })
    .filter((value): value is StaffEmailRecipient => Boolean(value));
};

const listGlobalAppointmentNotificationRecipients = async (input?: {
  excludeStaffIds?: string[];
  includeOwners?: boolean;
}): Promise<StaffEmailRecipient[]> => {
  const excludeStaffIds = [...new Set(input?.excludeStaffIds?.filter(Boolean) ?? [])];
  const rows = await prisma.staff.findMany({
    where: {
      isActive: true,
      firedAt: null,
      deletedAt: null,
      email: { not: null },
      ...(excludeStaffIds.length > 0 ? { id: { notIn: excludeStaffIds } } : {}),
      ...(input?.includeOwners === false ? { role: { not: StaffRole.OWNER } } : {}),
      OR: [
        ...(input?.includeOwners === false ? [] : [{ role: StaffRole.OWNER }]),
        { receivesAllAppointmentNotifications: true },
      ],
    },
    select: { id: true, email: true, role: true },
  });

  const byEmail = new Map<string, StaffEmailRecipient>();
  rows.forEach((row) => {
    const email = normalizeRecipientEmail(row.email);
    if (!email) {
      return;
    }
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        staffId: row.id,
        email,
        role: row.role,
      });
    }
  });
  return [...byEmail.values()];
};

const sendGlobalAppointmentNotification = async (input: {
  notificationId: SupportedNotificationId;
  dispatchKeyPrefix: string;
  appointmentId: string;
  subject: string;
  lines: string[];
  excludeStaffIds?: string[];
  includeOwners?: boolean;
}) => {
  const recipients = await listGlobalAppointmentNotificationRecipients({
    excludeStaffIds: input.excludeStaffIds,
    includeOwners: input.includeOwners,
  });

  await Promise.all(
    recipients.map((recipient) =>
      sendNotificationEmail({
        notificationId: input.notificationId,
        dispatchKey: `${input.dispatchKeyPrefix}:${recipient.staffId}`,
        recipientEmail: recipient.email,
        subject: input.subject,
        lines: input.lines,
        meta: {
          appointmentId: input.appointmentId,
          audience: recipient.role === StaffRole.OWNER ? 'owner' : 'staff-broadcast',
          staffId: recipient.staffId,
        },
      }),
    ),
  );
};

const buildPushBody = (lines: string[]) => {
  const text = lines
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');

  if (text.length <= 180) {
    return text;
  }

  return `${text.slice(0, 177).trimEnd()}...`;
};

const listGlobalAppointmentPushRecipients = async (input?: {
  excludeStaffIds?: string[];
  includeOwners?: boolean;
  includeAdmins?: boolean;
}): Promise<StaffPushRecipient[]> => {
  const excludeStaffIds = [...new Set(input?.excludeStaffIds?.filter(Boolean) ?? [])];
  const rows = await prisma.staff.findMany({
    where: {
      isActive: true,
      firedAt: null,
      deletedAt: null,
      pushDevices: { some: {} },
      ...(excludeStaffIds.length > 0 ? { id: { notIn: excludeStaffIds } } : {}),
      OR: [
        ...(input?.includeOwners === false ? [] : [{ role: StaffRole.OWNER }]),
        ...(input?.includeAdmins === false ? [] : [{ role: StaffRole.ADMIN }]),
        { receivesAllAppointmentNotifications: true },
      ],
    },
    select: {
      id: true,
      role: true,
      pushDevices: {
        select: {
          id: true,
          token: true,
          environment: true,
        },
      },
    },
  });

  return rows
    .map((row) => ({
      staffId: row.id,
      role: row.role,
      devices: row.pushDevices,
    }))
    .filter((row) => row.devices.length > 0);
};

const loadDirectPushRecipient = async (staffId: string): Promise<StaffPushRecipient | null> => {
  const row = await prisma.staff.findFirst({
    where: {
      id: staffId,
      isActive: true,
      firedAt: null,
      deletedAt: null,
      pushDevices: { some: {} },
    },
    select: {
      id: true,
      role: true,
      pushDevices: {
        select: {
          id: true,
          token: true,
          environment: true,
        },
      },
    },
  });

  if (!row || row.pushDevices.length === 0) {
    return null;
  }

  return {
    staffId: row.id,
    role: row.role,
    devices: row.pushDevices,
  };
};

const sendPushToRecipients = async (input: {
  notificationId: SupportedNotificationId;
  dispatchKeyPrefix: string;
  appointmentId: string;
  title: string;
  lines: string[];
  recipients: StaffPushRecipient[];
}) => {
  const { enabled } = await isNotificationEnabled(input.notificationId);
  if (!enabled || input.recipients.length === 0) {
    return;
  }

  const body = buildPushBody(input.lines);

  await Promise.all(
    input.recipients.flatMap((recipient) =>
      recipient.devices.map((device) =>
        sendPushAlert({
          dispatchKey: `${input.dispatchKeyPrefix}:${device.id}`,
          notificationId: input.notificationId,
          device,
          title: input.title,
          body,
          payload: {
            appointmentId: input.appointmentId,
            notificationId: input.notificationId,
            staffId: recipient.staffId,
            audience:
              recipient.role === StaffRole.OWNER
                ? 'owner'
                : recipient.role === StaffRole.ADMIN
                  ? 'admin'
                  : 'staff',
          },
        }),
      ),
    ),
  );
};

const sendDirectStaffPushNotification = async (input: {
  notificationId: SupportedNotificationId;
  dispatchKeyPrefix: string;
  appointmentId: string;
  staffId: string;
  title: string;
  lines: string[];
}) => {
  const recipient = await loadDirectPushRecipient(input.staffId);
  if (!recipient) {
    return;
  }

  await sendPushToRecipients({
    notificationId: input.notificationId,
    dispatchKeyPrefix: input.dispatchKeyPrefix,
    appointmentId: input.appointmentId,
    title: input.title,
    lines: input.lines,
    recipients: [recipient],
  });
};

const sendGlobalAppointmentPushNotification = async (input: {
  notificationId: SupportedNotificationId;
  dispatchKeyPrefix: string;
  appointmentId: string;
  title: string;
  lines: string[];
  excludeStaffIds?: string[];
  includeOwners?: boolean;
  includeAdmins?: boolean;
}) => {
  const recipients = await listGlobalAppointmentPushRecipients({
    excludeStaffIds: input.excludeStaffIds,
    includeOwners: input.includeOwners,
    includeAdmins: input.includeAdmins,
  });

  await sendPushToRecipients({
    notificationId: input.notificationId,
    dispatchKeyPrefix: input.dispatchKeyPrefix,
    appointmentId: input.appointmentId,
    title: input.title,
    lines: input.lines,
    recipients,
  });
};

const getDiscountLabel = (client: {
  discountType: DiscountType;
  discountValue: Prisma.Decimal | null;
  temporaryDiscountType: DiscountType;
  temporaryDiscountValue: Prisma.Decimal | null;
  temporaryDiscountFrom: Date | null;
  temporaryDiscountTo: Date | null;
}) => {
  const now = new Date();
  const useTemporary =
    client.temporaryDiscountType !== DiscountType.NONE &&
    client.temporaryDiscountValue !== null &&
    (!client.temporaryDiscountFrom || client.temporaryDiscountFrom <= now) &&
    (!client.temporaryDiscountTo || client.temporaryDiscountTo > now);

  const type = useTemporary ? client.temporaryDiscountType : client.discountType;
  const value = useTemporary ? client.temporaryDiscountValue : client.discountValue;
  if (!value || type === DiscountType.NONE) {
    return null;
  }
  const numeric = toNumber(value);
  if (type === DiscountType.PERCENT) {
    return `${numeric}%`;
  }
  return `${numeric}₽`;
};

export const notifyOnAppointmentCreated = async (appointmentId: string) => {
  const appointment = await loadAppointmentMailContext(appointmentId);
  if (!appointment) {
    return;
  }

  const baseLines = [
    `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
    `Ваша запись оформлена на ${appointmentDateTimeLabel(appointment)}.`,
    `Услуги: ${formatServiceNames(appointment)}.`,
    `Специалист: ${appointment.staff.name}.`,
    ...buildAppointmentCommentLines(appointment),
  ];

  if (appointment.createdByType === ActorType.CLIENT) {
    await sendNotificationEmail({
      notificationId: 'clients.onlineBookingCreated',
      dispatchKey: `clients.onlineBookingCreated:${appointment.id}`,
      recipientEmail: appointment.client.account?.email,
      subject: 'Запись через онлайн-виджет создана',
      lines: [
        ...baseLines,
        'Запись создана через сайт MARI Beauty Salon.',
      ],
      meta: { appointmentId: appointment.id },
    });

    await sendNotificationEmail({
      notificationId: 'clients.phoneConfirmationWidget',
      dispatchKey: `clients.phoneConfirmationWidget:${appointment.id}`,
      recipientEmail: appointment.client.account?.email,
      subject: 'Номер телефона подтверждён в онлайн-записи',
      lines: [
        `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
        `Мы зафиксировали номер ${appointment.client.phoneE164} для вашей онлайн-записи на ${appointmentDateTimeLabel(appointment)}.`,
      ],
      meta: { appointmentId: appointment.id },
    });

    const ownerRecipients = await listOwnerRecipients();
    await Promise.all(
      ownerRecipients.map((recipient) =>
        sendNotificationEmail({
          notificationId: 'admins.clientBookingCreated',
          dispatchKey: `admins.clientBookingCreated:${appointment.id}:${recipient.staffId}`,
          recipientEmail: recipient.email,
          subject: 'Клиент создал новую запись',
          lines: [
            `Клиент ${appointment.client.name || appointment.client.phoneE164} создал запись на ${appointmentDateTimeLabel(appointment)}.`,
            `Специалист: ${appointment.staff.name}.`,
            `Услуги: ${formatServiceNames(appointment)}.`,
            ...buildAppointmentCommentLines(appointment),
          ],
          meta: { appointmentId: appointment.id, audience: 'admins' },
        }),
      ),
    );

    await sendAssignedStaffNotificationEmail({
      appointmentId: appointment.id,
      staffId: appointment.staff.id,
      fallbackEmail: appointment.staff.email,
      notificationId: 'staff.clientBookingCreated',
      dispatchKey: `staff.clientBookingCreated:${appointment.id}:${appointment.staff.id}`,
      subject: 'Клиент записался к вам',
      lines: [
        `Клиент ${appointment.client.name || appointment.client.phoneE164} записался к вам на ${appointmentDateTimeLabel(appointment)}.`,
        `Услуги: ${formatServiceNames(appointment)}.`,
        ...buildAppointmentCommentLines(appointment),
      ],
      meta: { appointmentId: appointment.id, audience: 'staff' },
    });

    await sendDirectStaffPushNotification({
      notificationId: 'staff.clientBookingCreated',
      dispatchKeyPrefix: `staff.clientBookingCreated:${appointment.id}:${appointment.staff.id}`,
      appointmentId: appointment.id,
      staffId: appointment.staff.id,
      title: 'Клиент записался к вам',
      lines: [
        `Клиент ${appointment.client.name || appointment.client.phoneE164} записался к вам на ${appointmentDateTimeLabel(appointment)}.`,
        `Услуги: ${formatServiceNames(appointment)}.`,
      ],
    });

    await sendGlobalAppointmentNotification({
      notificationId: 'staff.clientBookingCreated',
      dispatchKeyPrefix: `staff.clientBookingCreated:broadcast:${appointment.id}`,
      appointmentId: appointment.id,
      excludeStaffIds: [appointment.staff.id],
      includeOwners: false,
      subject: `Новая запись к ${appointment.staff.name}`,
      lines: [
        `Клиент ${appointment.client.name || appointment.client.phoneE164} создал запись на ${appointmentDateTimeLabel(appointment)}.`,
        `Специалист: ${appointment.staff.name}.`,
        `Услуги: ${formatServiceNames(appointment)}.`,
        ...buildAppointmentCommentLines(appointment),
      ],
    });

    await sendGlobalAppointmentPushNotification({
      notificationId: 'staff.clientBookingCreated',
      dispatchKeyPrefix: `staff.clientBookingCreated:broadcast:${appointment.id}`,
      appointmentId: appointment.id,
      excludeStaffIds: [appointment.staff.id],
      includeOwners: true,
      includeAdmins: true,
      title: `Новая запись к ${appointment.staff.name}`,
      lines: [
        `Клиент ${appointment.client.name || appointment.client.phoneE164} создал запись на ${appointmentDateTimeLabel(appointment)}.`,
        `Специалист: ${appointment.staff.name}.`,
        `Услуги: ${formatServiceNames(appointment)}.`,
      ],
    });
    return;
  }

  await sendNotificationEmail({
    notificationId: 'clients.journalBookingCreated',
    dispatchKey: `clients.journalBookingCreated:${appointment.id}`,
    recipientEmail: appointment.client.account?.email,
    subject: 'Запись создана через журнал',
    lines: [
      ...baseLines,
      'Запись создана администратором салона.',
    ],
    meta: { appointmentId: appointment.id },
  });

  await sendNotificationEmail({
    notificationId: 'clients.confirmationRequest',
    dispatchKey: `clients.confirmationRequest:${appointment.id}`,
    recipientEmail: appointment.client.account?.email,
    subject: 'Пожалуйста, подтвердите запись',
    lines: [
      `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
      `Для записи на ${appointmentDateTimeLabel(appointment)} требуется подтверждение.`,
      'Если запись актуальна, просто ответьте на это письмо или свяжитесь с салоном.',
    ],
    meta: { appointmentId: appointment.id },
  });

  const ownerRecipients = await listOwnerRecipients();
  await Promise.all(
    ownerRecipients.map((recipient) =>
      sendNotificationEmail({
        notificationId: 'admins.adminBookingCreated',
        dispatchKey: `admins.adminBookingCreated:${appointment.id}:${recipient.staffId}`,
        recipientEmail: recipient.email,
        subject: 'Администратор создал запись',
        lines: [
          `Создана запись на ${appointmentDateTimeLabel(appointment)}.`,
          `Клиент: ${appointment.client.name || appointment.client.phoneE164}.`,
          `Специалист: ${appointment.staff.name}.`,
          ...buildAppointmentCommentLines(appointment),
        ],
        meta: { appointmentId: appointment.id, audience: 'admins' },
      }),
    ),
  );

  await sendAssignedStaffNotificationEmail({
    appointmentId: appointment.id,
    staffId: appointment.staff.id,
    fallbackEmail: appointment.staff.email,
    notificationId: 'staff.adminBookingCreated',
    dispatchKey: `staff.adminBookingCreated:${appointment.id}:${appointment.staff.id}`,
    subject: 'Администратор создал запись к вам',
    lines: [
      `Администратор создал запись на ${appointmentDateTimeLabel(appointment)}.`,
      `Клиент: ${appointment.client.name || appointment.client.phoneE164}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
      ...buildAppointmentCommentLines(appointment),
    ],
    meta: { appointmentId: appointment.id, audience: 'staff' },
  });

  await sendDirectStaffPushNotification({
    notificationId: 'staff.adminBookingCreated',
    dispatchKeyPrefix: `staff.adminBookingCreated:${appointment.id}:${appointment.staff.id}`,
    appointmentId: appointment.id,
    staffId: appointment.staff.id,
    title: 'Администратор создал запись к вам',
    lines: [
      `Администратор создал запись на ${appointmentDateTimeLabel(appointment)}.`,
      `Клиент: ${appointment.client.name || appointment.client.phoneE164}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
    ],
  });

  await sendGlobalAppointmentNotification({
    notificationId: 'staff.adminBookingCreated',
    dispatchKeyPrefix: `staff.adminBookingCreated:broadcast:${appointment.id}`,
    appointmentId: appointment.id,
    excludeStaffIds: [appointment.staff.id],
    includeOwners: false,
    subject: `Создана запись к ${appointment.staff.name}`,
    lines: [
      `Администратор создал запись на ${appointmentDateTimeLabel(appointment)}.`,
      `Клиент: ${appointment.client.name || appointment.client.phoneE164}.`,
      `Специалист: ${appointment.staff.name}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
      ...buildAppointmentCommentLines(appointment),
    ],
  });

  await sendGlobalAppointmentPushNotification({
    notificationId: 'staff.adminBookingCreated',
    dispatchKeyPrefix: `staff.adminBookingCreated:broadcast:${appointment.id}`,
    appointmentId: appointment.id,
    excludeStaffIds: [appointment.staff.id],
    includeOwners: true,
    includeAdmins: true,
    title: `Создана запись к ${appointment.staff.name}`,
    lines: [
      `Администратор создал запись на ${appointmentDateTimeLabel(appointment)}.`,
      `Клиент: ${appointment.client.name || appointment.client.phoneE164}.`,
      `Специалист: ${appointment.staff.name}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
    ],
  });
};

export const notifyOnAppointmentStatusChanged = async (input: {
  appointmentId: string;
  previousStatus: AppointmentStatus;
  nextStatus: AppointmentStatus;
}) => {
  const appointment = await loadAppointmentMailContext(input.appointmentId);
  if (!appointment) {
    return;
  }

  if (input.previousStatus === input.nextStatus) {
    return;
  }

  if (input.nextStatus === AppointmentStatus.CONFIRMED) {
    await sendNotificationEmail({
      notificationId: 'clients.bookingConfirmed',
      dispatchKey: `clients.bookingConfirmed:${appointment.id}:${appointment.updatedAt.toISOString()}`,
      recipientEmail: appointment.client.account?.email,
      subject: 'Запись подтверждена',
      lines: [
        `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
        `Ваша запись на ${appointmentDateTimeLabel(appointment)} подтверждена.`,
      ],
      meta: { appointmentId: appointment.id },
    });
  }

  if (input.nextStatus === AppointmentStatus.CANCELLED) {
    await sendNotificationEmail({
      notificationId: 'clients.bookingCancelled',
      dispatchKey: `clients.bookingCancelled:${appointment.id}:${appointment.updatedAt.toISOString()}`,
      recipientEmail: appointment.client.account?.email,
      subject: 'Запись отменена',
      lines: [
        `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
        `Запись на ${appointmentDateTimeLabel(appointment)} отменена.`,
      ],
      meta: { appointmentId: appointment.id },
    });

    await sendAssignedStaffNotificationEmail({
      appointmentId: appointment.id,
      staffId: appointment.staff.id,
      fallbackEmail: appointment.staff.email,
      notificationId: 'staff.bookingCancelled',
      dispatchKey: `staff.bookingCancelled:${appointment.id}:${appointment.staff.id}:${appointment.updatedAt.toISOString()}`,
      subject: 'Запись отменена',
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} отменена.`,
      ],
      meta: { appointmentId: appointment.id, audience: 'staff' },
    });

    await sendDirectStaffPushNotification({
      notificationId: 'staff.bookingCancelled',
      dispatchKeyPrefix: `staff.bookingCancelled:${appointment.id}:${appointment.staff.id}:${appointment.updatedAt.toISOString()}`,
      appointmentId: appointment.id,
      staffId: appointment.staff.id,
      title: 'Запись отменена',
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} отменена.`,
      ],
    });

    await sendGlobalAppointmentNotification({
      notificationId: 'staff.bookingCancelled',
      dispatchKeyPrefix: `staff.bookingCancelled:broadcast:${appointment.id}:${appointment.updatedAt.toISOString()}`,
      appointmentId: appointment.id,
      excludeStaffIds: [appointment.staff.id],
      includeOwners: true,
      subject: `Запись отменена у ${appointment.staff.name}`,
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} у специалиста ${appointment.staff.name} отменена.`,
      ],
    });

    await sendGlobalAppointmentPushNotification({
      notificationId: 'staff.bookingCancelled',
      dispatchKeyPrefix: `staff.bookingCancelled:broadcast:${appointment.id}:${appointment.updatedAt.toISOString()}`,
      appointmentId: appointment.id,
      excludeStaffIds: [appointment.staff.id],
      includeOwners: true,
      includeAdmins: true,
      title: `Запись отменена у ${appointment.staff.name}`,
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} у специалиста ${appointment.staff.name} отменена.`,
      ],
    });
  }

  if (input.nextStatus === AppointmentStatus.NO_SHOW) {
    await sendNotificationEmail({
      notificationId: 'clients.noShowCancelled',
      dispatchKey: `clients.noShowCancelled:${appointment.id}:${appointment.updatedAt.toISOString()}`,
      recipientEmail: appointment.client.account?.email,
      subject: 'Запись закрыта как неявка',
      lines: [
        `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
        `Запись на ${appointmentDateTimeLabel(appointment)} закрыта со статусом «Клиент не пришёл».`,
      ],
      meta: { appointmentId: appointment.id },
    });

    await sendAssignedStaffNotificationEmail({
      appointmentId: appointment.id,
      staffId: appointment.staff.id,
      fallbackEmail: appointment.staff.email,
      notificationId: 'staff.noShowMarked',
      dispatchKey: `staff.noShowMarked:${appointment.id}:${appointment.staff.id}:${appointment.updatedAt.toISOString()}`,
      subject: 'Запись отмечена как неявка',
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} отмечена как «Клиент не пришёл».`,
      ],
      meta: { appointmentId: appointment.id, audience: 'staff' },
    });

    await sendDirectStaffPushNotification({
      notificationId: 'staff.noShowMarked',
      dispatchKeyPrefix: `staff.noShowMarked:${appointment.id}:${appointment.staff.id}:${appointment.updatedAt.toISOString()}`,
      appointmentId: appointment.id,
      staffId: appointment.staff.id,
      title: 'Запись отмечена как неявка',
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} отмечена как «Клиент не пришёл».`,
      ],
    });

    await sendGlobalAppointmentNotification({
      notificationId: 'staff.noShowMarked',
      dispatchKeyPrefix: `staff.noShowMarked:broadcast:${appointment.id}:${appointment.updatedAt.toISOString()}`,
      appointmentId: appointment.id,
      excludeStaffIds: [appointment.staff.id],
      includeOwners: true,
      subject: `Неявка у ${appointment.staff.name}`,
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} у специалиста ${appointment.staff.name} отмечена как «Клиент не пришёл».`,
      ],
    });

    await sendGlobalAppointmentPushNotification({
      notificationId: 'staff.noShowMarked',
      dispatchKeyPrefix: `staff.noShowMarked:broadcast:${appointment.id}:${appointment.updatedAt.toISOString()}`,
      appointmentId: appointment.id,
      excludeStaffIds: [appointment.staff.id],
      includeOwners: true,
      includeAdmins: true,
      title: `Неявка у ${appointment.staff.name}`,
      lines: [
        `Запись клиента ${appointment.client.name || appointment.client.phoneE164} на ${appointmentDateTimeLabel(appointment)} у специалиста ${appointment.staff.name} отмечена как «Клиент не пришёл».`,
      ],
    });
  }

  if (input.nextStatus === AppointmentStatus.ARRIVED) {
    const notificationId: SupportedNotificationId =
      appointment.createdByType === ActorType.CLIENT
        ? 'clients.reviewRequestWidget'
        : 'clients.reviewRequestJournal';
    await sendNotificationEmail({
      notificationId,
      dispatchKey: `${notificationId}:${appointment.id}`,
      recipientEmail: appointment.client.account?.email,
      subject: 'Оставьте отзыв о визите',
      lines: [
        `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
        `Спасибо за визит ${formatDateMsk(appointment.startAt, 'DD.MM.YYYY')}.`,
        'Будем рады короткому отзыву о посещении салона.',
      ],
      meta: { appointmentId: appointment.id },
    });
  }
};

export const notifyOnAppointmentRescheduled = async (input: {
  appointmentId: string;
  previousStartAt: Date;
  previousEndAt: Date;
  previousStaffName: string;
}) => {
  const appointment = await loadAppointmentMailContext(input.appointmentId);
  if (!appointment) {
    return;
  }

  await sendNotificationEmail({
    notificationId: 'clients.bookingChanged',
    dispatchKey: `clients.bookingChanged:${appointment.id}:${appointment.updatedAt.toISOString()}`,
    recipientEmail: appointment.client.account?.email,
    subject: 'Запись изменена',
    lines: [
      `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
      `Запись перенесена с ${appointmentDateTimeLabel({
        startAt: input.previousStartAt,
        endAt: input.previousEndAt,
      })} на ${appointmentDateTimeLabel(appointment)}.`,
      `Специалист: ${appointment.staff.name}.`,
    ],
    meta: { appointmentId: appointment.id },
  });

  if (appointment.createdByType === ActorType.CLIENT) {
    const ownerRecipients = await listOwnerRecipients();
    await Promise.all(
      ownerRecipients.map((recipient) =>
        sendNotificationEmail({
          notificationId: 'admins.widgetBookingRescheduled',
          dispatchKey: `admins.widgetBookingRescheduled:${appointment.id}:${recipient.staffId}:${appointment.updatedAt.toISOString()}`,
          recipientEmail: recipient.email,
          subject: 'Перенесена запись из онлайн-виджета',
          lines: [
            `Запись клиента ${appointment.client.name || appointment.client.phoneE164} перенесена на ${appointmentDateTimeLabel(appointment)}.`,
            `Предыдущий специалист: ${input.previousStaffName}. Новый специалист: ${appointment.staff.name}.`,
          ],
          meta: { appointmentId: appointment.id, audience: 'admins' },
        }),
      ),
    );
  }

  await sendAssignedStaffNotificationEmail({
    appointmentId: appointment.id,
    staffId: appointment.staff.id,
    fallbackEmail: appointment.staff.email,
    notificationId: 'staff.bookingRescheduled',
    dispatchKey: `staff.bookingRescheduled:${appointment.id}:${appointment.staff.id}:${appointment.updatedAt.toISOString()}`,
    subject: 'Запись перенесена',
    lines: [
      `Запись клиента ${appointment.client.name || appointment.client.phoneE164} перенесена на ${appointmentDateTimeLabel(appointment)}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
    ],
    meta: { appointmentId: appointment.id, audience: 'staff' },
  });

  await sendDirectStaffPushNotification({
    notificationId: 'staff.bookingRescheduled',
    dispatchKeyPrefix: `staff.bookingRescheduled:${appointment.id}:${appointment.staff.id}:${appointment.updatedAt.toISOString()}`,
    appointmentId: appointment.id,
    staffId: appointment.staff.id,
    title: 'Запись перенесена',
    lines: [
      `Запись клиента ${appointment.client.name || appointment.client.phoneE164} перенесена на ${appointmentDateTimeLabel(appointment)}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
    ],
  });

  await sendGlobalAppointmentNotification({
    notificationId: 'staff.bookingRescheduled',
    dispatchKeyPrefix: `staff.bookingRescheduled:broadcast:${appointment.id}:${appointment.updatedAt.toISOString()}`,
    appointmentId: appointment.id,
    excludeStaffIds: [appointment.staff.id],
    includeOwners: appointment.createdByType !== ActorType.CLIENT,
    subject: `Запись перенесена у ${appointment.staff.name}`,
    lines: [
      `Запись клиента ${appointment.client.name || appointment.client.phoneE164} перенесена на ${appointmentDateTimeLabel(appointment)}.`,
      `Предыдущий специалист: ${input.previousStaffName}. Новый специалист: ${appointment.staff.name}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
    ],
  });

  await sendGlobalAppointmentPushNotification({
    notificationId: 'staff.bookingRescheduled',
    dispatchKeyPrefix: `staff.bookingRescheduled:broadcast:${appointment.id}:${appointment.updatedAt.toISOString()}`,
    appointmentId: appointment.id,
    excludeStaffIds: [appointment.staff.id],
    includeOwners: true,
    includeAdmins: true,
    title: `Запись перенесена у ${appointment.staff.name}`,
    lines: [
      `Запись клиента ${appointment.client.name || appointment.client.phoneE164} перенесена на ${appointmentDateTimeLabel(appointment)}.`,
      `Предыдущий специалист: ${input.previousStaffName}. Новый специалист: ${appointment.staff.name}.`,
      `Услуги: ${formatServiceNames(appointment)}.`,
    ],
  });
};

export const notifyOnClientCancelled = async (appointmentId: string) => {
  const appointment = await loadAppointmentMailContext(appointmentId);
  if (!appointment) {
    return;
  }

  await sendNotificationEmail({
    notificationId: 'clients.bookingCancelled',
    dispatchKey: `clients.bookingCancelled:client:${appointment.id}`,
    recipientEmail: appointment.client.account?.email,
    subject: 'Запись отменена',
    lines: [
      `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
      `Вы отменили запись на ${appointmentDateTimeLabel(appointment)}.`,
    ],
    meta: { appointmentId: appointment.id },
  });

  const ownerRecipients = await listOwnerRecipients();
  await Promise.all(
    ownerRecipients.map((recipient) =>
      sendNotificationEmail({
        notificationId: 'admins.widgetBookingCancelled',
        dispatchKey: `admins.widgetBookingCancelled:${appointment.id}:${recipient.staffId}`,
        recipientEmail: recipient.email,
        subject: 'Клиент отменил запись',
        lines: [
          `Клиент ${appointment.client.name || appointment.client.phoneE164} отменил запись на ${appointmentDateTimeLabel(appointment)}.`,
        ],
        meta: { appointmentId: appointment.id, audience: 'admins' },
      }),
    ),
  );

  await sendAssignedStaffNotificationEmail({
    appointmentId: appointment.id,
    staffId: appointment.staff.id,
    fallbackEmail: appointment.staff.email,
    notificationId: 'staff.bookingCancelled',
    dispatchKey: `staff.bookingCancelled:client:${appointment.id}:${appointment.staff.id}`,
    subject: 'Клиент отменил запись',
    lines: [
      `Клиент ${appointment.client.name || appointment.client.phoneE164} отменил запись на ${appointmentDateTimeLabel(appointment)}.`,
    ],
    meta: { appointmentId: appointment.id, audience: 'staff' },
  });

  await sendDirectStaffPushNotification({
    notificationId: 'staff.bookingCancelled',
    dispatchKeyPrefix: `staff.bookingCancelled:client:${appointment.id}:${appointment.staff.id}`,
    appointmentId: appointment.id,
    staffId: appointment.staff.id,
    title: 'Клиент отменил запись',
    lines: [
      `Клиент ${appointment.client.name || appointment.client.phoneE164} отменил запись на ${appointmentDateTimeLabel(appointment)}.`,
    ],
  });

  await sendGlobalAppointmentNotification({
    notificationId: 'staff.bookingCancelled',
    dispatchKeyPrefix: `staff.bookingCancelled:broadcast:client:${appointment.id}`,
    appointmentId: appointment.id,
    excludeStaffIds: [appointment.staff.id],
    includeOwners: false,
    subject: `Клиент отменил запись у ${appointment.staff.name}`,
    lines: [
      `Клиент ${appointment.client.name || appointment.client.phoneE164} отменил запись на ${appointmentDateTimeLabel(appointment)} у специалиста ${appointment.staff.name}.`,
    ],
  });

  await sendGlobalAppointmentPushNotification({
    notificationId: 'staff.bookingCancelled',
    dispatchKeyPrefix: `staff.bookingCancelled:broadcast:client:${appointment.id}`,
    appointmentId: appointment.id,
    excludeStaffIds: [appointment.staff.id],
    includeOwners: true,
    includeAdmins: true,
    title: `Клиент отменил запись у ${appointment.staff.name}`,
    lines: [
      `Клиент ${appointment.client.name || appointment.client.phoneE164} отменил запись на ${appointmentDateTimeLabel(appointment)} у специалиста ${appointment.staff.name}.`,
    ],
  });
};

export const notifyOnPaymentAdded = async (input: {
  appointmentId: string;
  method: PaymentMethod;
}) => {
  if (input.method !== PaymentMethod.CARD) {
    return;
  }

  const appointment = await loadAppointmentMailContext(input.appointmentId);
  if (!appointment || appointment.createdByType !== ActorType.CLIENT) {
    return;
  }

  await sendNotificationEmail({
    notificationId: 'clients.onlinePaymentSuccess',
    dispatchKey: `clients.onlinePaymentSuccess:${appointment.id}:${appointment.paymentStatus}:${appointment.paidAmount.toString()}`,
    recipientEmail: appointment.client.account?.email,
    subject: 'Онлайн-оплата прошла успешно',
    lines: [
      `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
      `Оплата записи на ${appointmentDateTimeLabel(appointment)} прошла успешно.`,
      `Оплачено: ${toNumber(appointment.paidAmount)}₽.`,
    ],
    meta: { appointmentId: appointment.id },
  });
};

export const notifyOnClientDiscountChanged = async (input: {
  before: {
    id: string;
    name: string | null;
    discountType: DiscountType;
    discountValue: Prisma.Decimal | null;
    temporaryDiscountType: DiscountType;
    temporaryDiscountValue: Prisma.Decimal | null;
    temporaryDiscountFrom: Date | null;
    temporaryDiscountTo: Date | null;
  };
  after: {
    id: string;
    name: string | null;
    discountType: DiscountType;
    discountValue: Prisma.Decimal | null;
    temporaryDiscountType: DiscountType;
    temporaryDiscountValue: Prisma.Decimal | null;
    temporaryDiscountFrom: Date | null;
    temporaryDiscountTo: Date | null;
  };
}) => {
  const client = await prisma.client.findUnique({
    where: { id: input.after.id },
    include: {
      account: {
        select: { email: true },
      },
    },
  });
  if (!client) {
    return;
  }

  const beforeLabel = getDiscountLabel(input.before);
  const afterLabel = getDiscountLabel(input.after);
  if (!afterLabel || beforeLabel === afterLabel) {
    return;
  }

  await sendNotificationEmail({
    notificationId: 'clients.newDiscount',
    dispatchKey: `clients.newDiscount:${client.id}:${afterLabel}:${input.after.temporaryDiscountTo?.toISOString() || 'permanent'}`,
    recipientEmail: client.account?.email,
    subject: 'Для вас добавлена скидка',
    lines: [
      `Здравствуйте${client.name ? `, ${client.name}` : ''}!`,
      `Для вас активирована скидка ${afterLabel}.`,
      input.after.temporaryDiscountTo
        ? `Скидка действует до ${formatDateMsk(input.after.temporaryDiscountTo)}.`
        : 'Скидка будет применяться при оформлении записи на сайте.',
    ],
    meta: { clientId: client.id, discount: afterLabel },
  });
};

const processVisitReminders = async (minNoticeMinutes: number) => {
  const from = dayjs().add(minNoticeMinutes, 'minute').startOf('minute');
  const to = from.add(1, 'minute');
  const rows = await prisma.appointment.findMany({
    where: {
      status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
      startAt: {
        gte: from.toDate(),
        lt: to.toDate(),
      },
    },
    include: {
      client: {
        include: {
          account: {
            select: { email: true },
          },
        },
      },
      staff: {
        select: { name: true },
      },
      appointmentServices: {
        orderBy: { sortOrder: 'asc' },
        select: { serviceNameSnapshot: true },
      },
    },
  });

  await Promise.all(
    rows.map((appointment) =>
      sendNotificationEmail({
        notificationId: 'clients.visitReminder',
        dispatchKey: `clients.visitReminder:${appointment.id}:${minNoticeMinutes}`,
        recipientEmail: appointment.client.account?.email,
        subject: 'Напоминание о визите',
        lines: [
          `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
          `Напоминаем о визите ${appointmentDateTimeLabel(appointment)}.`,
          `Специалист: ${appointment.staff.name}.`,
          `Услуги: ${appointment.appointmentServices.map((item) => item.serviceNameSnapshot).join(', ')}.`,
        ],
        meta: { appointmentId: appointment.id, minutesBefore: minNoticeMinutes },
      }),
    ),
  );
};

const processBirthdayGreetings = async () => {
  const today = dayjs().tz(MSK_TZ);
  const rows = await prisma.client.findMany({
    where: {
      birthday: { not: null },
      account: {
        is: {
          email: { not: null },
        },
      },
    },
    include: {
      account: {
        select: { email: true },
      },
    },
  });

  const birthdayClients = rows.filter((client) => {
    if (!client.birthday) {
      return false;
    }
    const birthday = dayjs(client.birthday).tz(MSK_TZ);
    return birthday.date() === today.date() && birthday.month() === today.month();
  });

  await Promise.all(
    birthdayClients.map((client) =>
      sendNotificationEmail({
        notificationId: 'clients.birthdayGreeting',
        dispatchKey: `clients.birthdayGreeting:${client.id}:${today.format('YYYY-MM-DD')}`,
        recipientEmail: client.account?.email,
        subject: 'С днём рождения!',
        lines: [
          `Здравствуйте${client.name ? `, ${client.name}` : ''}!`,
          'Поздравляем вас с днём рождения и желаем прекрасного настроения.',
          'Будем рады видеть вас в MARI Beauty Salon.',
        ],
        meta: { clientId: client.id },
      }),
    ),
  );
};

const processDiscountExpiry = async () => {
  const now = dayjs();
  const until = now.add(1, 'day');
  const rows = await prisma.client.findMany({
    where: {
      temporaryDiscountType: { not: DiscountType.NONE },
      temporaryDiscountTo: {
        gt: now.toDate(),
        lte: until.toDate(),
      },
      account: {
        is: {
          email: { not: null },
        },
      },
    },
    include: {
      account: {
        select: { email: true },
      },
    },
  });

  await Promise.all(
    rows.map((client) =>
      sendNotificationEmail({
        notificationId: 'clients.discountExpiring',
        dispatchKey: `clients.discountExpiring:${client.id}:${client.temporaryDiscountTo?.toISOString()}`,
        recipientEmail: client.account?.email,
        subject: 'Срок действия скидки заканчивается',
        lines: [
          `Здравствуйте${client.name ? `, ${client.name}` : ''}!`,
          `Ваша временная скидка ${getDiscountLabel(client) ?? ''} действует до ${formatDateMsk(client.temporaryDiscountTo!)}.`,
        ],
        meta: { clientId: client.id },
      }),
    ),
  );
};

const processNoShowInvites = async () => {
  const threshold = dayjs().subtract(NO_SHOW_REINVITE_DAYS, 'day').toDate();
  const rows = await prisma.appointment.findMany({
    where: {
      status: AppointmentStatus.NO_SHOW,
      startAt: { lte: threshold },
    },
    include: {
      client: {
        include: {
          account: {
            select: { email: true },
          },
        },
      },
      staff: {
        select: { name: true },
      },
    },
  });

  await Promise.all(
    rows.map((appointment) =>
      sendNotificationEmail({
        notificationId: 'clients.noShowInvite',
        dispatchKey: `clients.noShowInvite:${appointment.id}`,
        recipientEmail: appointment.client.account?.email,
        subject: 'Приглашаем выбрать новую дату визита',
        lines: [
          `Здравствуйте${appointment.client.name ? `, ${appointment.client.name}` : ''}!`,
          `Мы заметили, что визит ${formatDateMsk(appointment.startAt, 'DD.MM.YYYY')} не состоялся.`,
          'Если запись всё ещё актуальна, ответьте на письмо или оформите новый визит на сайте.',
        ],
        meta: { appointmentId: appointment.id },
      }),
    ),
  );
};

const processRepeatVisitInvites = async () => {
  const threshold = dayjs().subtract(REPEAT_VISIT_DAYS, 'day');
  const rows = await prisma.client.findMany({
    where: {
      account: {
        is: {
          email: { not: null },
        },
      },
    },
    include: {
      account: {
        select: { email: true },
      },
      appointments: {
        orderBy: { startAt: 'desc' },
        take: 5,
      },
    },
  });

  await Promise.all(
    rows.map(async (client) => {
      const lastArrived = client.appointments.find(
        (appointment) => appointment.status === AppointmentStatus.ARRIVED,
      );
      if (!lastArrived || dayjs(lastArrived.startAt).isAfter(threshold)) {
        return;
      }

      const hasFuture = client.appointments.some(
        (appointment) =>
          dayjs(appointment.startAt).isAfter(dayjs()) &&
          ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status),
      );
      if (hasFuture) {
        return;
      }

      await sendNotificationEmail({
        notificationId: 'clients.repeatVisitInvite',
        dispatchKey: `clients.repeatVisitInvite:${client.id}:${threshold.format('YYYY-MM-DD')}`,
        recipientEmail: client.account?.email,
        subject: 'Приглашаем на повторный визит',
        lines: [
          `Здравствуйте${client.name ? `, ${client.name}` : ''}!`,
          `С вашего последнего визита прошло уже больше ${REPEAT_VISIT_DAYS} дней.`,
          'Если хотите подобрать удобное время, просто оформите запись на сайте или ответьте на письмо.',
        ],
        meta: { clientId: client.id },
      });
    }),
  );
};

const processScheduleEndingSoon = async () => {
  const owners = await listOwnerRecipients();
  if (owners.length === 0) {
    return;
  }

  const masters = await prisma.staff.findMany({
    where: {
      isActive: true,
      firedAt: null,
      role: StaffRole.MASTER,
    },
    include: {
      workingHours: true,
      dailySchedules: {
        where: {
          date: {
            gte: dayjs().startOf('day').toDate(),
            lt: dayjs().add(SCHEDULE_LOOKAHEAD_DAYS, 'day').endOf('day').toDate(),
          },
        },
      },
    },
  });

  const lackingSchedule = masters.filter(
    (staff) => staff.workingHours.length === 0 && staff.dailySchedules.length === 0,
  );
  if (lackingSchedule.length === 0) {
    return;
  }

  await Promise.all(
    owners.flatMap((recipient) =>
      lackingSchedule.map((staff) =>
        sendNotificationEmail({
          notificationId: 'admins.scheduleEndingSoon',
          dispatchKey: `admins.scheduleEndingSoon:${staff.id}:${recipient.staffId}:${dayjs().format('YYYY-MM-DD')}`,
          recipientEmail: recipient.email,
          subject: 'У сотрудника нет расписания на ближайшие дни',
          lines: [
            `Для сотрудника ${staff.name} не найдено расписание на ближайшие ${SCHEDULE_LOOKAHEAD_DAYS} дней.`,
            'Проверьте раздел «График» и при необходимости заполните рабочие интервалы.',
          ],
          meta: { staffId: staff.id, audience: 'admins' },
        }),
      ),
    ),
  );
};

export const runNotificationJobs = async () => {
  if (jobsRunning) {
    return;
  }
  jobsRunning = true;
  try {
    const config = await getNotificationConfig();
    if (config.toggles['clients.visitReminder']) {
      await processVisitReminders(config.minNoticeMinutes);
    }
    if (config.toggles['clients.birthdayGreeting']) {
      await processBirthdayGreetings();
    }
    if (config.toggles['clients.discountExpiring']) {
      await processDiscountExpiry();
    }
    if (config.toggles['clients.noShowInvite']) {
      await processNoShowInvites();
    }
    if (config.toggles['clients.repeatVisitInvite']) {
      await processRepeatVisitInvites();
    }
    if (config.toggles['admins.scheduleEndingSoon']) {
      await processScheduleEndingSoon();
    }
  } finally {
    jobsRunning = false;
  }
};

export const startNotificationJobs = () => {
  if (jobsTimer || env.NODE_ENV === 'test') {
    return;
  }
  void runNotificationJobs().catch((error) => {
    console.error('[notifications] initial run failed', error);
  });
  jobsTimer = setInterval(() => {
    void runNotificationJobs().catch((error) => {
      console.error('[notifications] periodic run failed', error);
    });
  }, WORKER_INTERVAL_MS);
  jobsTimer.unref();
};
