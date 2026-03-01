import * as XLSX from 'xlsx';
import dayjs from 'dayjs';

import { prisma } from '../../db/prisma';
import { toNumber, zero } from '../../utils/money';
import { MSK_TZ, parseDateOnlyToUtc } from '../../utils/time';

const bookToBuffer = (workbook: XLSX.WorkBook): Buffer => {
  const array = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.isBuffer(array) ? array : Buffer.from(array);
};

export const exportClientsXlsx = async (): Promise<Buffer> => {
  const clients = await prisma.client.findMany({
    include: { category: true },
    orderBy: { createdAt: 'desc' }
  });

  const data = clients.map((client) => ({
    ID: client.id,
    Имя: client.name,
    Телефон: client.phoneE164,
    Категория: client.category?.name ?? '',
    Пол: client.gender,
    'Дата рождения': client.birthday ? dayjs(client.birthday).format('YYYY-MM-DD') : '',
    'Тип скидки': client.discountType,
    'Значение скидки': client.discountValue ? toNumber(client.discountValue) : '',
    Комментарий: client.comment ?? '',
    Создан: client.createdAt.toISOString()
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Clients');
  return bookToBuffer(wb);
};

export const exportServicesXlsx = async (): Promise<Buffer> => {
  const services = await prisma.service.findMany({
    include: { category: true },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
  });

  const data = services.map((service) => ({
    ID: service.id,
    ExternalID: service.externalId ?? '',
    Категория: service.category.name,
    Название: service.name,
    'Название в чеке': service.nameReceipt ?? '',
    'Название для онлайн-записи': service.nameOnline ?? '',
    Описание: service.description ?? '',
    'Длительность (сек)': service.durationSec,
    'Цена от': toNumber(service.priceMin),
    'Цена до': service.priceMax ? toNumber(service.priceMax) : '',
    Активна: service.isActive ? 'Да' : 'Нет'
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Services');
  return bookToBuffer(wb);
};

export const exportAppointmentsXlsx = async (fromDate: string, toDate: string): Promise<Buffer> => {
  const from = parseDateOnlyToUtc(fromDate);
  const to = dayjs(parseDateOnlyToUtc(toDate)).add(1, 'day').toDate();

  const appointments = await prisma.appointment.findMany({
    where: {
      startAt: {
        gte: from,
        lt: to
      }
    },
    include: {
      client: true,
      staff: true,
      appointmentServices: { orderBy: { sortOrder: 'asc' } }
    },
    orderBy: { startAt: 'asc' }
  });

  const rows: Array<Record<string, unknown>> = [];
  for (const appointment of appointments) {
    for (const service of appointment.appointmentServices) {
      rows.push({
        AppointmentID: appointment.id,
        ExternalID: appointment.externalId,
        Сотрудник: appointment.staff.name,
        Клиент: appointment.client.name,
        Телефон: appointment.client.phoneE164,
        'Время визита (MSK)': dayjs(appointment.startAt).tz(MSK_TZ).format('YYYY-MM-DD HH:mm'),
        Статус: appointment.status,
        Услуга: service.serviceNameSnapshot,
        'Стоимость, ₽': toNumber(service.priceSnapshot),
        'Стоимость с учетом скидки, ₽': toNumber(service.priceWithDiscountSnapshot),
        'База, ₽': toNumber(appointment.baseTotalPrice),
        'Скидка, ₽': toNumber(appointment.discountAmountSnapshot),
        'Итого, ₽': toNumber(appointment.finalTotalPrice),
        'Оплачено, ₽': toNumber(appointment.paidAmount),
        'Метод оплаты': appointment.paymentMethod
      });
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Appointments');
  return bookToBuffer(wb);
};
