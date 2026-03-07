export type StaffPermissionCatalogItem = {
  code: string;
  title: string;
  description: string;
  group: 'workspace' | 'finance' | 'marketing' | 'content';
};

export const STAFF_PERMISSION_CATALOG: StaffPermissionCatalogItem[] = [
  {
    code: 'ACCESS_JOURNAL',
    title: 'Журнал записей',
    description: 'Просмотр и работа с записями клиентов',
    group: 'workspace',
  },
  {
    code: 'ACCESS_SCHEDULE',
    title: 'График работы',
    description: 'Просмотр и редактирование рабочего графика',
    group: 'workspace',
  },
  {
    code: 'ACCESS_CLIENTS',
    title: 'Клиенты',
    description: 'Доступ к списку клиентов и карточкам клиентов',
    group: 'workspace',
  },
  {
    code: 'ACCESS_SERVICES',
    title: 'Услуги',
    description: 'Доступ к категориям и услугам',
    group: 'workspace',
  },
  {
    code: 'ACCESS_STAFF',
    title: 'Сотрудники',
    description: 'Доступ к разделу сотрудников',
    group: 'workspace',
  },
  {
    code: 'VIEW_FINANCIAL_STATS',
    title: 'Аналитика и зарплаты',
    description: 'Просмотр сводной аналитики и финансовых показателей',
    group: 'finance',
  },
  {
    code: 'MANAGE_CLIENT_DISCOUNTS',
    title: 'Скидки клиентов',
    description: 'Изменение скидок и бонусных условий клиентов',
    group: 'finance',
  },
  {
    code: 'MANAGE_PROMOCODES',
    title: 'Промокоды',
    description: 'Создание и редактирование промокодов',
    group: 'marketing',
  },
  {
    code: 'MANAGE_CLIENT_FRONT',
    title: 'Клиентский сайт',
    description: 'Редактирование данных клиентского сайта',
    group: 'content',
  },
  {
    code: 'PUBLISH_CLIENT_FRONT',
    title: 'Публикация сайта',
    description: 'Публикация изменений клиентского сайта',
    group: 'content',
  },
  {
    code: 'MANAGE_MEDIA',
    title: 'Медиа-файлы',
    description: 'Загрузка и управление изображениями',
    group: 'content',
  },
];

export const STAFF_PERMISSION_DESCRIPTION_BY_CODE = new Map(
  STAFF_PERMISSION_CATALOG.map((item) => [item.code, item.description]),
);
