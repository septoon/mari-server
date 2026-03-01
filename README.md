# Beauty CRM Backend

Backend API для CRM салона красоты (без фронтенда).

## Public Overview
- REST API на `Node.js + TypeScript + Express`
- `PostgreSQL + Prisma`
- Импорт/экспорт Excel
- JWT auth (client/staff), RBAC (`OWNER/ADMIN/MASTER`)
- Лояльность: постоянные/временные скидки, промокоды

## Core Features
- Health: `GET /health`
- Клиентский и staff контуры авторизации
- Управление расписанием, записями, оплатами, скидками и промокодами
- Импорт/экспорт XLS/XLSX

## Quick Start
```bash
npm install
npm run prisma:migrate
npm run seed
npm run dev
```

## Лицензия
Внутренний проект. Условия использования определяются владельцем репозитория.
