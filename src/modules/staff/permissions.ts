export type StaffPermissionCatalogItem = {
  code: string;
  title: string;
  description: string;
  group: 'workspace' | 'finance' | 'marketing' | 'content';
};

export const STAFF_PERMISSION_CATALOG: StaffPermissionCatalogItem[] = [
  {
    code: 'VIEW_JOURNAL',
    title: 'Журнал: просмотр',
    description: 'Просмотр записей и истории клиентов',
    group: 'workspace',
  },
  {
    code: 'EDIT_JOURNAL',
    title: 'Журнал: редактирование',
    description: 'Создание и изменение записей в журнале',
    group: 'workspace',
  },
  {
    code: 'VIEW_SCHEDULE',
    title: 'График: просмотр',
    description: 'Просмотр расписания сотрудников',
    group: 'workspace',
  },
  {
    code: 'EDIT_SCHEDULE',
    title: 'График: редактирование',
    description: 'Изменение графика, выходных и блокировок',
    group: 'workspace',
  },
  {
    code: 'VIEW_CLIENTS',
    title: 'Клиенты: просмотр',
    description: 'Просмотр списка клиентов и карточек',
    group: 'workspace',
  },
  {
    code: 'EDIT_CLIENTS',
    title: 'Клиенты: редактирование',
    description: 'Изменение клиентских данных и операций',
    group: 'workspace',
  },
  {
    code: 'MANAGE_CLIENT_AVATARS',
    title: 'Клиенты: аватарки',
    description: 'Загрузка, замена и удаление аватарок клиентов',
    group: 'workspace',
  },
  {
    code: 'VIEW_SERVICES',
    title: 'Услуги: просмотр',
    description: 'Просмотр категорий и услуг',
    group: 'workspace',
  },
  {
    code: 'EDIT_SERVICES',
    title: 'Услуги: редактирование',
    description: 'Создание и изменение категорий и услуг',
    group: 'workspace',
  },
  {
    code: 'VIEW_STAFF',
    title: 'Сотрудники: просмотр',
    description: 'Просмотр списка сотрудников',
    group: 'workspace',
  },
  {
    code: 'EDIT_STAFF',
    title: 'Сотрудники: редактирование',
    description: 'Создание, изменение и увольнение сотрудников',
    group: 'workspace',
  },
  {
    code: 'EDIT_SELF_PROFILE',
    title: 'Свой профиль: редактирование',
    description: 'Изменение собственного имени, телефона, email и специализации',
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
