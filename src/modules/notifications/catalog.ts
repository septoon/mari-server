export type NotificationAudience = 'clients' | 'admins' | 'staff';

export type NotificationItemDefinition = {
  id: string;
  title: string;
  defaultEnabled: boolean;
};

export type NotificationGroupDefinition = {
  id: string;
  title: string;
  items: NotificationItemDefinition[];
};

export type NotificationSectionDefinition = {
  id: NotificationAudience;
  title: string;
  groups: NotificationGroupDefinition[];
};

export const NOTIFICATION_SECTIONS: NotificationSectionDefinition[] = [
  {
    id: 'clients',
    title: 'Клиентам',
    groups: [
      {
        id: 'attendance',
        title: 'Увеличение посещаемости',
        items: [
          { id: 'clients.onlineBookingCreated', title: 'Создание записи через виджет онлайн-записи', defaultEnabled: true },
          { id: 'clients.journalBookingCreated', title: 'Создание записи через журнал записи', defaultEnabled: true },
          { id: 'clients.bookingConfirmed', title: 'Уведомление о подтверждении записи', defaultEnabled: true },
          { id: 'clients.bookingChanged', title: 'Изменение записи', defaultEnabled: true },
          { id: 'clients.confirmationRequest', title: 'Запрос подтверждения записи', defaultEnabled: false },
          { id: 'clients.visitReminder', title: 'Напоминание о визите', defaultEnabled: true },
          { id: 'clients.bookingCancelled', title: 'Отмена записи', defaultEnabled: true },
          { id: 'clients.noShowCancelled', title: 'Отмена записи с помощью статуса «Клиент не пришёл»', defaultEnabled: true },
          { id: 'clients.noShowInvite', title: 'Приглашение на визит недошедших клиентов', defaultEnabled: false },
        ],
      },
      {
        id: 'quality',
        title: 'Контроль качества',
        items: [
          { id: 'clients.reviewRequestWidget', title: 'Запрос отзыва после визита, который создан через виджет онлайн-записи', defaultEnabled: true },
          { id: 'clients.reviewRequestJournal', title: 'Запрос отзыва после визита, который создан через журнал записи', defaultEnabled: true },
        ],
      },
      {
        id: 'returnability',
        title: 'Работа с возвращаемостью',
        items: [
          { id: 'clients.birthdayGreeting', title: 'Поздравление с днём рождения', defaultEnabled: true },
          { id: 'clients.newDiscount', title: 'Новая скидка', defaultEnabled: false },
          { id: 'clients.discountExpiring', title: 'Окончание действия скидки', defaultEnabled: false },
          { id: 'clients.repeatVisitInvite', title: 'Приглашение на повторный визит', defaultEnabled: true },
        ],
      },
      {
        id: 'other',
        title: 'Другое',
        items: [
          { id: 'clients.phoneConfirmationWidget', title: 'Подтверждение номера клиента в виджете онлайн-записи', defaultEnabled: true },
          { id: 'clients.onlinePaymentSuccess', title: 'Уведомление клиента об успешной онлайн-оплате', defaultEnabled: false },
        ],
      },
    ],
  },
  {
    id: 'admins',
    title: 'Администраторам',
    groups: [
      {
        id: 'instant',
        title: '',
        items: [
          { id: 'admins.clientBookingCreated', title: 'Создание записи клиентом', defaultEnabled: true },
          { id: 'admins.adminBookingCreated', title: 'Создание записи администратором', defaultEnabled: true },
          { id: 'admins.widgetBookingRescheduled', title: 'Перенос записи, созданной через виджет онлайн-записи', defaultEnabled: true },
          { id: 'admins.widgetBookingCancelled', title: 'Отмена записи клиентом через виджет онлайн-записи', defaultEnabled: true },
          { id: 'admins.scheduleEndingSoon', title: 'Скорое завершение расписания работы сотрудников', defaultEnabled: true },
        ],
      },
    ],
  },
  {
    id: 'staff',
    title: 'Сотрудникам',
    groups: [
      {
        id: 'instant',
        title: '',
        items: [
          { id: 'staff.clientBookingCreated', title: 'Создание записи клиентом', defaultEnabled: true },
          { id: 'staff.adminBookingCreated', title: 'Создание записи администратором', defaultEnabled: true },
          { id: 'staff.bookingRescheduled', title: 'Перенос записи клиентом или администратором', defaultEnabled: true },
          { id: 'staff.bookingCancelled', title: 'Отмена записи клиентом или администратором', defaultEnabled: true },
          { id: 'staff.noShowMarked', title: 'Отмена записи администратором с помощью статуса «Клиент не пришёл»', defaultEnabled: true },
        ],
      },
    ],
  },
];

export const NOTIFICATION_IDS = NOTIFICATION_SECTIONS.flatMap((section) =>
  section.groups.flatMap((group) => group.items.map((item) => item.id)),
);

export const NOTIFICATION_ID_SET = new Set(NOTIFICATION_IDS);

export const DEFAULT_NOTIFICATION_TOGGLES = Object.fromEntries(
  NOTIFICATION_SECTIONS.flatMap((section) =>
    section.groups.flatMap((group) => group.items.map((item) => [item.id, item.defaultEnabled] as const)),
  ),
) as Record<string, boolean>;
